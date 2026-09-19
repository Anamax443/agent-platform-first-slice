// DISCR family: discovery-runner.ts's runDiscovery() — the live glue between a Case, the real FactCatalog and the
// real Router/Policy/ExecutorHost chain (via slice.transport, exactly what the orchestrator itself dispatches
// through). Bar: WHAT runs always comes from plan() (proven here by asserting the actual capability dispatched,
// never assumed), a planned step with no registered DiscoveryInputBuilder fails closed (NOT_BUILDABLE, never
// guessed), and a satisfied/gapped/cyclic plan is reported, never silently retried.
import { describe, expect, it } from "vitest";
import type { LlmAdapter, TokenUsage } from "../src/adapters/llm.js";
import { newCase, type Case, type NormalizedImpulse } from "../src/platform/case.js";
import { discoveryInput } from "../src/components/intent-resolver/discovery.js";
import { runDiscovery, type DiscoveryInputBuilder } from "../src/platform/discovery-runner.js";
import { AuthorityRegistry } from "../src/platform/authorities.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
import { LifecycleRegistry } from "../src/platform/lifecycle.js";
import type { EvidenceCandidate } from "../src/platform/evidence.js";
import { createSlice, ORCHESTRATOR, TENANT_A, putArtifact, type Slice } from "./harness/index.js";
import { realCatalog } from "./harness/facts.js";

const CATALOG = realCatalog();

class FakeIntentModel implements LlmAdapter {
  readonly modelId = "fake-intent-model-1";
  readonly promptVersion = "test-1";
  calls = 0;
  constructor(private readonly answer: string) {}
  async complete(_prompt: string, onUsage?: (u: TokenUsage) => void): Promise<string> {
    this.calls += 1;
    onUsage?.({ inputTokens: 10, outputTokens: 1 });
    return this.answer;
  }
}

function sliceWithIntentModel(answer = "GENERAL_QUESTION"): Slice {
  return createSlice({ models: { llm: new FakeIntentModel(answer) } });
}

function caseWithContent(slice: Slice, text: string, caseId = "case-discr-a"): Case {
  const artifact = putArtifact(slice, text, TENANT_A);
  const impulse: NormalizedImpulse = { impulseId: "imp-1", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], content: { artifactId: artifact.artifactId }, metadata: {} };
  return newCase({ caseId, impulse });
}

function deps(slice: Slice, overrides: Partial<Parameters<typeof runDiscovery>[0]> = {}) {
  return {
    catalog: CATALOG,
    ledger: slice.evidence,
    artifacts: slice.artifacts,
    authorities: slice.installation.authorities,
    lifecycle: slice.installation.lifecycle,
    transport: slice.transport,
    actorId: ORCHESTRATOR,
    clock: slice.clock,
    deadlineMs: 60_000,
    audit: slice.audit,
    inputBuilders: { "intent.resolve": discoveryInput } as Readonly<Record<string, DiscoveryInputBuilder>>,
    ...overrides,
  };
}

describe("DISCR-000 a Case whose impulse carries content: plan resolves and intent.resolve actually runs", () => {
  it("EXECUTED, one step, SUCCEEDED, and impulse.intent.resolved is really sealed in the ledger", async () => {
    const slice = sliceWithIntentModel("GENERAL_QUESTION");
    const c = caseWithContent(slice, "jake bude zitra pocasi?");
    const result = await runDiscovery(deps(slice), c);
    expect(result.status).toBe("EXECUTED");
    if (result.status !== "EXECUTED") return;
    expect(result.steps).toHaveLength(1);
    const step = result.steps[0];
    expect(step?.capability).toBe("intent.resolve");
    if (!step || "notBuildable" in step) throw new Error("expected a dispatched step");
    expect(step.result.status).toBe("SUCCEEDED");
    // subject.key names the FACT this evidence attests (impulse.intent), never the evidence key itself
    // (impulse.intent.resolved) — handler.ts's own doc comment, mirrored by facts.v1.json's "for": "impulse.intent".
    expect(slice.evidence.forTenant(TENANT_A).some((e) => e.subject.key === "impulse.intent" && e.originCaseId === c.caseId)).toBe(true);
  });

  it("threads caseId into the dispatched payload (input.schema.json's own anticipated caller)", async () => {
    const slice = sliceWithIntentModel("GENERAL_QUESTION");
    const c = caseWithContent(slice, "some impulse text");
    let seenPayload: Record<string, unknown> | undefined;
    const builder: DiscoveryInputBuilder = (ctx) => {
      seenPayload = discoveryInput(ctx);
      return seenPayload;
    };
    await runDiscovery(deps(slice, { inputBuilders: { "intent.resolve": builder } }), c);
    expect(seenPayload).toMatchObject({ caseId: c.caseId });
  });
});

describe("DISCR-001 a Case with no impulse content cannot be planned", () => {
  it("CAPABILITY_GAP, no dispatch, and the gap is audited", async () => {
    const slice = sliceWithIntentModel();
    const impulse: NormalizedImpulse = { impulseId: "imp-1", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], metadata: {} };
    const c = newCase({ caseId: "case-discr-gap", impulse });
    const before = slice.audit.byKind("state").length;
    const result = await runDiscovery(deps(slice), c);
    expect(result.status).toBe("CAPABILITY_GAP");
    expect(slice.audit.byKind("state").length).toBeGreaterThan(before);
  });
});

describe("DISCR-002 a planned capability with no registered input builder fails closed", () => {
  it("NOT_BUILDABLE — never guesses a payload shape", async () => {
    const slice = sliceWithIntentModel();
    const c = caseWithContent(slice, "text");
    const result = await runDiscovery(deps(slice, { inputBuilders: {} }), c);
    expect(result.status).toBe("EXECUTED");
    if (result.status !== "EXECUTED") return;
    expect(result.steps[0]).toEqual({ capability: "intent.resolve", notBuildable: true });
  });
});

describe("DISCR-003 a Case whose intent is already resolved needs no dispatch at all", () => {
  it("SATISFIED — runs plan() again but executes nothing (never re-resolves what's already available)", async () => {
    const slice = sliceWithIntentModel("GENERAL_QUESTION");
    const c = caseWithContent(slice, "text");
    const first = await runDiscovery(deps(slice), c);
    expect(first.status).toBe("EXECUTED");
    const modelCallsAfterFirst = (slice.models.llm as FakeIntentModel).calls;
    const second = await runDiscovery(deps(slice), c);
    expect(second.status).toBe("SATISFIED");
    expect((slice.models.llm as FakeIntentModel).calls).toBe(modelCallsAfterFirst);
  });
});

describe("DISCR-004 authorities/lifecycle are genuinely load-bearing, not passed through unobserved", () => {
  // Adversarial verification (2026-09-19) flagged that DISCR-000..003 never exercise an authority-gated
  // producer, so a regression that silently dropped/swapped runDiscovery()'s authorities/lifecycle deps would
  // pass unnoticed — same trap case-projection.ts's own ProjectCurrentCaseInput doc comment warns about
  // (mirrors tests/case-projection.test.ts's PROJ-014, one level up the stack).
  function sealedIntentCandidate(caseId: string): EvidenceCandidate {
    return {
      tenantId: TENANT_A,
      originCaseId: caseId,
      producerId: "intent.resolve",
      capabilityVersion: "1",
      buildHash: "test",
      subject: { key: "impulse.intent", scope: CASE_SCOPE },
      inputValueHash: "hash-of-content",
      result: "GENERAL_QUESTION",
      authorityDomain: "test.discovery-gate",
      parentRefs: [],
      parentHashes: [],
    };
  }

  it("an authority-gated impulse.intent record projects BLOCKED (not AVAILABLE) without the real grant+ACTIVE lifecycle — plan() re-attempts intent.resolve instead of SATISFIED", async () => {
    const slice = sliceWithIntentModel("GENERAL_QUESTION");
    const c = caseWithContent(slice, "text", "case-discr-gate-a");
    slice.evidence.append(sealedIntentCandidate(c.caseId));
    // No grant for "test.discovery-gate" anywhere in authorities/lifecycle below: AuthorityRegistry.empty()/a
    // fresh LifecycleRegistry() are case-projection.ts's own defaults for an omitted authorities/lifecycle —
    // used here explicitly to prove the check actually runs, not to rely on runDiscovery()'s own defaulting.
    const result = await runDiscovery(deps(slice, { authorities: AuthorityRegistry.empty(), lifecycle: new LifecycleRegistry() }), c);
    expect(result.status).toBe("EXECUTED");
    if (result.status !== "EXECUTED") return;
    expect(result.steps[0]?.capability).toBe("intent.resolve");
  });

  it("the same record is AVAILABLE (SATISFIED, no dispatch) once the real grant + ACTIVE lifecycle are threaded through", async () => {
    const slice = sliceWithIntentModel("GENERAL_QUESTION");
    const c = caseWithContent(slice, "text", "case-discr-gate-b");
    slice.evidence.append(sealedIntentCandidate(c.caseId));
    const authorities = AuthorityRegistry.build({ schemaVersion: "1", domains: { "test.discovery-gate": { producers: ["intent.resolve"], facts: ["*"], maxEvidenceTtl: null } } });
    // LifecycleRegistry keys by producerId (the capability name, "intent.resolve"), not the module name
    // ("intent-resolver") — same convention tests/case-projection.test.ts's PROJ-014 uses.
    const lifecycle = new LifecycleRegistry({ "intent.resolve": "ACTIVE" });
    const result = await runDiscovery(deps(slice, { authorities, lifecycle }), c);
    expect(result.status).toBe("SATISFIED");
  });
});
