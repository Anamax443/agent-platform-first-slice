// RG2-D (2026-09-18, "stale RESERVED reconciliation"): the focused unit test for mail-ingest/handler.ts's new
// `reconcile` field — the domain half of RG2-D (the wiring half, platform-wiring.ts's Wiring.reconcilers ->
// index.ts's orchestratorFor(), is proven end-to-end in tests/gw-platform-wiring-fanout.test.ts's own RG2-D block).
//
// Why a reconciler that ALWAYS answers UNKNOWN deserves its own test: it is the honest, deliberate "cannot
// establish truth" rung of the owner's recovery ladder (release on proven-not-happened / resolve-as-DONE on
// proven-happened / escalate on cannot-establish), not a placeholder — see the field's own doc comment in
// src/components/mail-ingest/handler.ts for the full reasoning (no independent witness like email-executor's
// SMTP status query; artifacts.ts's put()/derive() mint a fresh artifactId per call, no content-addressed lookup
// exists, and building one is separate architectural work). These tests pin that contract so a future edit
// cannot quietly turn it into a guess (SUCCEEDED "because the mail is probably there", FAILED "because it's old")
// — either of which the owner explicitly rejected in favor of a visible ReviewService task.
import { describe, expect, it } from "vitest";
import { FakeExtractor } from "../src/adapters/extract.js";
import { createIngestHandler, INGEST_HANDLER_ID } from "../src/components/mail-ingest/handler.js";
import { ArtifactStore, type Artifact } from "../src/platform/artifacts.js";
import { Audit } from "../src/platform/audit.js";
import { FakeClock, iso, plus } from "../src/platform/clock.js";
import { CredentialResolver } from "../src/platform/credentials.js";
import { ProcessCrash } from "../src/platform/errors.js";
import { ExecutorHost } from "../src/platform/executor-host.js";
import { InMemoryIdempotencyStore } from "../src/platform/idempotency.js";
import { newId } from "../src/platform/ids.js";
import type { Instance, StepRecord } from "../src/platform/journal.js";
import type { MessageEnvelope, TrustedContext } from "../src/platform/types.js";
import { INVOICE_MAIL, TENANT_A } from "./harness/index.js";

const START = "2026-09-18T08:00:00Z";

function ingestMessage(clock: FakeClock, idempotencyKey: string, rawMail = INVOICE_MAIL): MessageEnvelope {
  const now = clock.now();
  return {
    messageId: newId("msg"),
    correlationId: newId("cor"),
    workflowId: "wf-rg2d-unit",
    stepId: "ingest",
    type: "command",
    capability: "mail.ingest",
    capabilityVersion: "1",
    schemaVersion: "1",
    createdAt: iso(now),
    notValidAfter: iso(plus(now, 600_000)),
    idempotencyKey,
    payload: { rawMail, receivedFrom: "test-harness" },
  };
}

function context(clock: FakeClock): TrustedContext {
  return {
    dispatchId: newId("disp"),
    tenantId: TENANT_A,
    actorId: "svc-test",
    actorType: "service",
    scopes: ["mail.ingest"],
    sourceComponent: "test",
    authStrength: "client-credentials",
    authenticatedAt: iso(clock.now()),
    expiresAt: iso(plus(clock.now(), 30 * 60_000)),
  };
}

describe("mail.ingest reconcile — honestly, deliberately always UNKNOWN (RG2-D)", () => {
  it("returns {status:'UNKNOWN'} for any idempotencyKey and any payload, never SUCCEEDED, never FAILED", async () => {
    const clock = new FakeClock(START);
    const spec = createIngestHandler({ artifacts: new ArtifactStore(clock), clock, extractor: new FakeExtractor() });
    expect(spec.reconcile, "mail.ingest's HostHandlerSpec must now carry a reconcile function").toBeTypeOf("function");
    const reconcile = spec.reconcile as NonNullable<typeof spec.reconcile>;

    const inputs = [
      { idempotencyKey: "wf-1:ingest:default:1", payload: { rawMail: INVOICE_MAIL, receivedFrom: "test-harness" } },
      { idempotencyKey: "", payload: {} },
      { idempotencyKey: "anything at all", payload: { rawMail: "not even a mail", receivedFrom: "x", extra: { nested: true } } },
      { idempotencyKey: "wf-2:ingest:human-corrected:2", payload: { artifactId: "art-someone-guessed" } },
    ];
    for (const input of inputs) expect(await reconcile(input)).toEqual({ status: "UNKNOWN" });
  });

  it("stays UNKNOWN even when the mail demonstrably WAS ingested (the artifact exists in the store) — there is no lookup from idempotencyKey to that artifact, and this reconciler does not pretend there is", async () => {
    const clock = new FakeClock(START);
    const artifacts = new ArtifactStore(clock);
    const credentials = new CredentialResolver({ [INGEST_HANDLER_ID]: {} }, new Audit(clock));
    const spec = createIngestHandler({ artifacts, clock, extractor: new FakeExtractor() });
    const key = "wf-1:ingest:default:1";
    const message = ingestMessage(clock, key);

    const outcome = await credentials.runAs(INGEST_HANDLER_ID, () => spec.run({ message, context: context(clock) }));
    expect(outcome.status).toBe("SUCCEEDED");
    const originalArtifactId = (outcome as { payload?: { originalArtifactId?: string } }).payload?.originalArtifactId as string;
    expect(artifacts.get(originalArtifactId)).toMatchObject({ tenantId: TENANT_A });

    // The truth is "it happened" — and the reconciler still cannot establish it from its inputs alone, so it says so.
    const reconcile = spec.reconcile as NonNullable<typeof spec.reconcile>;
    expect(await reconcile({ idempotencyKey: key, payload: message.payload })).toEqual({ status: "UNKNOWN" });
  });

  it("through the real ExecutorHost.reconcilerFor(): a RESERVED row left by a mid-run crash is neither resolved nor released (no TTL, no guess) — it stays RESERVED for the orchestrator to escalate to a human", async () => {
    const clock = new FakeClock(START);
    const audit = new Audit(clock);
    const idempotency = new InMemoryIdempotencyStore();
    class CrashOnceArtifactStore extends ArtifactStore {
      crashed = false;
      override put(input: { tenantId: string; bytes: string; receivedFrom: string }): Artifact {
        if (!this.crashed) {
          this.crashed = true;
          throw new ProcessCrash("mail.ingest:artifacts.put");
        }
        return super.put(input);
      }
    }
    const credentials = new CredentialResolver({ [INGEST_HANDLER_ID]: {} }, audit);
    const host = ExecutorHost.forTests({ hostId: "mail-ingest-test-host", clock, audit, credentials, idempotency });
    host.register(createIngestHandler({ artifacts: new CrashOnceArtifactStore(clock), clock, extractor: new FakeExtractor() }));

    const key = "wf-rg2d-unit:ingest:default:1";
    const message = ingestMessage(clock, key);
    const ctx = context(clock);
    // executor-host.ts execute(): step 8 reserves, step 9 runs the handler, the crash propagates by name and the
    // reservation is never resolved/released — the exact durable state RG2-D is about.
    await expect(host.handlerFor("mail.ingest")({ message, context: ctx })).rejects.toThrow(/process crashed/);
    const dedupKey = `${TENANT_A} ${INGEST_HANDLER_ID} ${key}`;
    expect((await idempotency.peek(dedupKey))?.status).toBe("RESERVED");

    // What the orchestrator's reconcile() would hand the host: the step (ref = its own idempotency key) + instance.
    const step: StepRecord = {
      stepId: "ingest",
      capability: "mail.ingest",
      capabilityVersion: "1",
      sideEffects: "internal-write",
      executionId: "exe-1",
      attempt: 1,
      logicalAttempt: 1,
      strategyIndex: 0,
      strategy: "default",
      idempotencyKey: key,
      status: "UNKNOWN_OUTCOME",
      startedAt: iso(clock.now()),
      message,
      reconciliationRef: key,
    };
    const instance: Instance = {
      workflowId: "wf-rg2d-unit",
      workflow: "mail-intake",
      workflowVersion: "3",
      correlationId: message.correlationId,
      tenantId: TENANT_A,
      actorId: "svc-test",
      status: "RUNNING",
      currentStep: 0,
      input: {},
      steps: [step],
      published: { status: "UNKNOWN_OUTCOME", reconciliation: "IN_PROGRESS" },
      createdAt: iso(clock.now()),
      updatedAt: iso(clock.now()),
    };
    const reconciler = host.reconcilerFor("mail.ingest");
    clock.advance(24 * 3_600_000); // a full day later: age changes nothing, there is no TTL anywhere in this path
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await reconciler(key, step, instance)).toEqual({ status: "UNKNOWN" });
      expect((await idempotency.peek(dedupKey))?.status).toBe("RESERVED");
    }
    // The host audits each consult, capability-tagged, with the honest result — this is what makes "the reconciler
    // was actually tried" visible after the fact (and what the end-to-end test keys its "not skipped" proof on).
    const consults = audit.byKind("reconciliation").filter((r) => r.capability === "mail.ingest");
    expect(consults).toHaveLength(3);
    for (const r of consults) expect(r.details).toMatchObject({ ref: key, idempotencyKey: key, result: "UNKNOWN" });
    // Never a resend: the handler's run() was not re-executed by reconciliation (one write-intent, from the crash).
    expect(audit.byKind("write-intent")).toHaveLength(1);
  });
});
