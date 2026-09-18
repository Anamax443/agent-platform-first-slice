// Regression test for the two P0 gaps found by external review 18.9.2026 (M0-FACT-CONTRACT-V1.md část C follow-up):
//
//   Gap 2: platform-wiring.ts's wirePlatform() (the LIVE composition, deploy/cloudflare/apf-gateway) registered
//   document.classify WITHOUT `...writerFor(CLASSIFY)` — unlike src/slice.ts's createSlice() (the TEST-ONLY
//   composition), which has always wired an EvidenceWriter into document.classify unconditionally. Because every
//   one of the (then) 649 tests drove capabilities through createSlice(), none of them ever exercised the actual
//   wirePlatform() function, so a live document.classify silently never sealed document.type.invoiceConfirmed
//   evidence — even though invoice-extractor/facts.json's own consumes.evidence gate (owner's Commit 1, 18.9.2026)
//   made invoice.extract depend on exactly that evidence existing.
//
//   Gap 3: the only FactCatalog loader that existed (tests/harness/facts.ts's realCatalog()) uses node:fs
//   (readdirSync/existsSync) and is explicitly commented "tests only; the platform never reads files" — it cannot
//   run in the Cloudflare Workers runtime, so the live deploy had no Workers-safe way to build a FactCatalog at
//   all. deploy/cloudflare/apf-gateway/src/fact-catalog-bundle.ts fixes this with static JSON imports (the same
//   `with { type: "json" }` pattern src/platform/workflow.ts already uses for WORKFLOW_DEFINITIONS).
//
// This file drives BOTH real, non-test-only pieces together — platform-wiring.ts's actual wirePlatform() function
// and fact-catalog-bundle.ts's actual FACT_CATALOG constant — through src/platform/attachment-fanout.ts's real
// fanOutAttachments(), never through src/slice.ts's createSlice()/tests/harness/facts.ts's realCatalog(). Verified
// by temporarily reverting both fixes locally: with the old (broken) platform-wiring.ts, "seals
// document.type.invoiceConfirmed..." below fails (no evidence is sealed, sealed is undefined); with FACT_CATALOG
// removed/broken it cannot even build. Both were confirmed failing before the fixes in this change, and pass now.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeRegistryAdapter } from "../src/adapters/registry.js";
import type { Artifact } from "../src/platform/artifacts.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { Audit } from "../src/platform/audit.js";
import { fanOutAttachments } from "../src/platform/attachment-fanout.js";
import { FakeClock } from "../src/platform/clock.js";
import { MemoryEvidenceStore } from "../src/platform/evidence.js";
import { newEntityId } from "../src/platform/fact-address.js";
import { Journal } from "../src/platform/journal.js";
import { Orchestrator } from "../src/platform/orchestrator.js";
import { plan } from "../src/platform/planner.js";
import { ReviewService } from "../src/platform/review.js";
import { workflowDef } from "../src/platform/workflow.js";
import { FACT_CATALOG } from "../deploy/cloudflare/apf-gateway/src/fact-catalog-bundle.js";
import { CLASSIFY, wirePlatform, type Wiring } from "../deploy/cloudflare/apf-gateway/src/platform-wiring.js";
import { CONTRACT_CZ, FAKE_SECRETS, INVOICE_CZ, LOCAL_FAKES, ORCHESTRATOR, TENANT_A } from "./harness/index.js";
import type { WorkersAiBinding } from "../src/adapters/workers-ai.js";
import type { ResultEnvelope, MessageEnvelope } from "../src/platform/types.js";

/**
 * The REAL live composition (deploy/cloudflare/apf-gateway/src/index.ts's own wiring() method builds the exact
 * same call, just with SQLite-backed stores instead of these in-memory ones — same Installation, same
 * wirePlatform(), same evidence-writer wiring). No fake/mocked classifier or evidence writer: `models` comes from
 * LOCAL_FAKES's own installation profile (provider "fake" -> FakeLlmAdapter/KeywordClassifierAdapter, the same
 * adapters createSlice() uses), and `evidence` is a real EvidenceLedger over a real (in-memory) EvidenceStore.
 */
function buildRealWiring() {
  const clock = new FakeClock("2026-09-18T08:00:00Z");
  const artifacts = new ArtifactStore(clock);
  const audit = new Audit(clock);
  const journal = new Journal();
  const notWired = async (_m: MessageEnvelope, _actorId: string): Promise<ResultEnvelope> => {
    throw new Error("capability not wired in this test");
  };
  // Never actually called: LOCAL_FAKES's models are all provider "fake" (config/local-fakes/profile.json), so
  // buildAdapters()/buildExtractAdapters() only ever construct FakeLlmAdapter/FakeInvoiceExtractorAdapter here.
  const ai: WorkersAiBinding = { run: async () => { throw new Error("WorkersAiBinding.run() not expected in this test"); } };
  const wiring: Wiring = wirePlatform({
    installation: LOCAL_FAKES,
    secrets: FAKE_SECRETS,
    ai,
    artifacts,
    audit,
    clock,
    keyId: "test-k1",
    signingKeyPem: undefined, // LOCAL_FAKES.profile.channels.apiHost === null -> ephemeral key allowed
    registry: new FakeRegistryAdapter(),
    notWired,
    evidence: { store: new MemoryEvidenceStore(), buildHash: "test-build" },
  });
  const review = new ReviewService(clock, audit);
  const orchestratorFor = (def: ReturnType<typeof workflowDef>) => new Orchestrator({ workflow: def, transport: wiring.transport, journal, review, audit, clock, actorId: ORCHESTRATOR });
  return { wiring, artifacts, audit, journal, orchestratorFor };
}

describe("wirePlatform() (the LIVE composition) actually seals document.type.invoiceConfirmed evidence — Gap 2", () => {
  it("classifying an INVOICE-shaped artifact through the REAL wired document.classify handler seals the evidence", async () => {
    const { wiring, artifacts, orchestratorFor } = buildRealWiring();
    if (!wiring.evidence) throw new Error("test setup: evidence ledger missing");
    const artifact: Artifact = artifacts.put({ tenantId: TENANT_A, bytes: INVOICE_CZ, receivedFrom: "test-harness" });

    // P0 fact-scope-multi-doc pass (docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit): document.classify's
    // seal() now skips sealing entirely when no attachmentEntityId flows through (see handler.ts's own doc comment on
    // seal() for why) — this test drives the "attachment-classify" workflow directly, bypassing fanOutAttachments()'s
    // own entityId threading, so it must supply one itself, exactly as attachment-classify.v1.json's real caller does.
    const attachmentEntityId = newEntityId();
    const classifyOrchestrator = orchestratorFor(workflowDef("attachment-classify"));
    const started = classifyOrchestrator.start({ tenantId: TENANT_A, artifactId: artifact.artifactId, attachmentEntityId });
    const instance = await classifyOrchestrator.run(started.workflowId);

    expect(instance.status).toBe("SUCCEEDED");
    const documentType = instance.steps.find((s) => s.stepId === "classify")?.result?.payload?.documentType as { value: string } | undefined;
    expect(documentType?.value).toBe("INVOICE");

    // This is exactly what Gap 2 broke: without `...writerFor(CLASSIFY)` in platform-wiring.ts, this list is
    // empty — the handler ran, classified INVOICE, and produced a correct payload, but never wrote to the Žlab.
    const sealed = wiring.evidence.forTenant(TENANT_A).find((e) => e.workflowId === instance.workflowId && e.producerId === CLASSIFY);
    expect(sealed).toMatchObject({ inputField: `document.type@${attachmentEntityId}`, result: "INVOICE" });
    expect(sealed?.subject).toEqual({ key: "document.type", scope: "impulse.attachment", entityId: attachmentEntityId });
  });

  it("a CONTRACT classification through the same real wiring seals nothing (the evidence gate is asymmetric on purpose)", async () => {
    const { wiring, artifacts, orchestratorFor } = buildRealWiring();
    if (!wiring.evidence) throw new Error("test setup: evidence ledger missing");
    const artifact: Artifact = artifacts.put({ tenantId: TENANT_A, bytes: CONTRACT_CZ, receivedFrom: "test-harness" });
    const classifyOrchestrator = orchestratorFor(workflowDef("attachment-classify"));
    const started = classifyOrchestrator.start({ tenantId: TENANT_A, artifactId: artifact.artifactId });
    const instance = await classifyOrchestrator.run(started.workflowId);
    expect(instance.status).toBe("SUCCEEDED");
    expect(wiring.evidence.forTenant(TENANT_A).some((e) => e.workflowId === instance.workflowId)).toBe(false);
  });
});

describe("fact-catalog-bundle.ts's FACT_CATALOG (the Workers-safe, non-fs catalog) actually gates invoice.extract on that evidence — Gap 3", () => {
  it("without document.type.invoiceConfirmed available, plan() over the REAL bundled catalog refuses invoice.extract", () => {
    const goal = [...(FACT_CATALOG.flowOf("invoice.extract")?.produces ?? [])];
    expect(goal.length).toBeGreaterThan(0);
    expect(plan({ goal, available: ["document.original"] }, FACT_CATALOG).status).toBe("CAPABILITY_GAP");
  });

  it("with it available, plan() over the REAL bundled catalog selects invoice.extract", () => {
    const goal = [...(FACT_CATALOG.flowOf("invoice.extract")?.produces ?? [])];
    const r = plan({ goal, available: ["document.original", "document.type.invoiceConfirmed"] }, FACT_CATALOG);
    expect(r.status).toBe("PLANNED");
    if (r.status === "PLANNED") expect(r.steps.map((s) => s.capability)).toEqual(["invoice.extract"]);
  });
});

describe("end-to-end through the REAL wirePlatform() + REAL FACT_CATALOG together, via fanOutAttachments() — Gaps 1+2+3 combined", () => {
  it("an INVOICE attachment classifies, seals evidence, plan() selects invoice.extract, and extract actually runs and derives an artifact", async () => {
    const { wiring, artifacts, orchestratorFor } = buildRealWiring();
    if (!wiring.evidence) throw new Error("test setup: evidence ledger missing");
    const invoice = artifacts.put({ tenantId: TENANT_A, bytes: INVOICE_CZ, receivedFrom: "test-harness" });

    const outcomes = await fanOutAttachments(
      {
        classifyOrchestrator: orchestratorFor(workflowDef("attachment-classify")),
        extractOrchestrator: orchestratorFor(workflowDef("attachment-extract")),
        catalog: FACT_CATALOG,
        evidence: wiring.evidence,
      },
      { tenantId: TENANT_A, caseId: "case-e2e-1", attachments: [{ artifactId: invoice.artifactId, entityId: newEntityId() }] },
    );

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome?.classify.status).toBe("SUCCEEDED");
    expect(outcome?.plan?.status).toBe("PLANNED");
    expect(outcome?.extract?.status).toBe("SUCCEEDED");
    const extractPayload = outcome?.extract?.steps.find((s) => s.stepId === "extract")?.result?.payload as { extractedArtifactId?: string } | undefined;
    expect(extractPayload?.extractedArtifactId).toBeTruthy();
    expect(artifacts.get(extractPayload?.extractedArtifactId as string)).toMatchObject({ derivedFrom: invoice.artifactId, producer: "invoice-extractor" });
  });

  it("a CONTRACT attachment classifies but invoice.extract never runs, through the same real wiring+catalog (CAPABILITY_GAP, not a crash)", async () => {
    const { wiring, artifacts, orchestratorFor } = buildRealWiring();
    if (!wiring.evidence) throw new Error("test setup: evidence ledger missing");
    const contract = artifacts.put({ tenantId: TENANT_A, bytes: CONTRACT_CZ, receivedFrom: "test-harness" });
    const outcomes = await fanOutAttachments(
      {
        classifyOrchestrator: orchestratorFor(workflowDef("attachment-classify")),
        extractOrchestrator: orchestratorFor(workflowDef("attachment-extract")),
        catalog: FACT_CATALOG,
        evidence: wiring.evidence,
      },
      { tenantId: TENANT_A, caseId: "case-e2e-2", attachments: [{ artifactId: contract.artifactId, entityId: newEntityId() }] },
    );
    expect(outcomes[0]?.classify.status).toBe("SUCCEEDED");
    expect(outcomes[0]?.plan?.status).toBe("CAPABILITY_GAP");
    expect(outcomes[0]?.extract).toBeUndefined();
  });
});

describe("mailIntake() actually reaches fanOutAttachments() now (Gap 1) — source-level wiring trap", () => {
  // A runtime DO-class test would need the Cloudflare Workers pool for vitest (@cloudflare/vitest-pool-workers);
  // this repo's vitest.config.ts runs plain Node (tests/**/*.test.ts, no workers pool configured anywhere in
  // package.json), and index.ts imports "cloudflare:workers" at module scope, which does not resolve under plain
  // Node — so index.ts cannot be imported or instantiated from this suite at all. The three describe() blocks
  // above already prove every piece fanOutAttachments() itself needs (real wiring, real catalog, real fan-out
  // outcome) actually works; this final check closes the one remaining gap the task calls out explicitly: that
  // mailIntake() itself was actually wired to call it, not just that the pieces work in isolation. It is
  // deliberately a source-level assertion, not a runtime one — documented as such rather than dressed up as an
  // integration test it is not.
  //
  // Commit 3 (Case wiring) factored the mail.ingest journal read that used to sit inline in fanOutAttachmentsIfAny()
  // out into its own mailIngestPayload() helper, shared with the new createCaseForMailIntake() — so the read
  // itself is checked in mailIngestPayload()'s own body below, and fanOutAttachmentsIfAny()'s body is checked for
  // calling into it (`this.mailIngestPayload(`) instead of containing the read inline.
  it("mailIntake()'s method body calls fanOutAttachments(...) and reads mail.ingest's own journaled step", () => {
    const src = readFileSync(join(__dirname, "..", "deploy", "cloudflare", "apf-gateway", "src", "index.ts"), "utf8");
    const start = src.indexOf("async mailIntake(");
    expect(start, "mailIntake() method not found in index.ts").toBeGreaterThan(-1);

    const mailIngestPayloadStart = src.indexOf("\n  private mailIngestPayload(", start);
    expect(mailIngestPayloadStart, "mailIngestPayload() not found after mailIntake()").toBeGreaterThan(start);
    const mailIngestPayloadEnd = src.indexOf("\n  /**", mailIngestPayloadStart + 1);
    const mailIngestPayloadBody = src.slice(mailIngestPayloadStart, mailIngestPayloadEnd > 0 ? mailIngestPayloadEnd : undefined);
    expect(mailIngestPayloadBody).toContain('s.capability === "mail.ingest"');
    expect(mailIngestPayloadBody).toContain("attachmentArtifactIds");

    const nextMethod = src.indexOf("\n  private async fanOutAttachmentsIfAny(", start);
    expect(nextMethod, "fanOutAttachmentsIfAny() not found after mailIntake()").toBeGreaterThan(start);
    const mailIntakeBody = src.slice(start, nextMethod);
    expect(mailIntakeBody).toContain("this.fanOutAttachmentsIfAny(");
    // Commit 3: mailIntake() also creates the Case synchronously, before the fan-out background task starts.
    expect(mailIntakeBody).toContain("this.createCaseForMailIntake(");

    const fanOutMethodEnd = src.indexOf("\n  /**", nextMethod + 1);
    const fanOutBody = src.slice(nextMethod, fanOutMethodEnd > 0 ? fanOutMethodEnd : undefined);
    expect(fanOutBody).toContain("this.mailIngestPayload(");
    expect(fanOutBody).toContain("fanOutAttachments(");
    expect(fanOutBody).toContain("FACT_CATALOG");
    // Commit 3: every attachment-classify/attachment-extract instance actually started gets grouped into the Case.
    expect(fanOutBody).toContain("this.growCaseWithFanout(");
  });
});
