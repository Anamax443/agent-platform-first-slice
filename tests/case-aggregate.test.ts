// Commit 3 (Case wiring, owner's "Commit 3 — Case wiring", 18.9.2026): unit tests for the new Case-level
// aggregate status function (case.ts's aggregateCaseStatus() — the follow-up to E-1's own "not decided yet, out
// of scope" on Case.status), the new CaseStore/MemoryCaseStore, and a scenario driving the REAL grouping
// primitives (newCase()/addInstance() from case.ts, the REAL fanOutAttachments() from attachment-fanout.ts, over
// a real Orchestrator/Journal from tests/harness's createSlice()) together end to end.
//
// index.ts's own createCaseForMailIntake()/growCaseWithFanout() cannot be imported or driven from this suite at
// all: they live inside the WorkflowInstance Durable Object class, which imports "cloudflare:workers" at module
// scope — the exact same constraint tests/gw-platform-wiring-fanout.test.ts's own last describe() documents for
// mailIntake()/fanOutAttachmentsIfAny(). What CAN be proven here, and is: every primitive that DO-level code
// calls — newCase(), addInstance(), fanOutAttachments(), aggregateCaseStatus() — actually composes into a
// correctly-grouped, correctly-aggregated Case when driven together for real, not mocked.
import { describe, expect, it } from "vitest";
import { addInstance, aggregateCaseStatus, CaseError, MemoryCaseStore, newCase, type NormalizedImpulse } from "../src/platform/case.js";
import { fanOutAttachments } from "../src/platform/attachment-fanout.js";
import { newEntityId } from "../src/platform/fact-address.js";
import type { InstanceStatus } from "../src/platform/journal.js";
import { realCatalog } from "./harness/facts.js";
import { CONTRACT_CZ, createSlice, INVOICE_CZ, INVOICE_MAIL, putArtifact, runMailIntake, TENANT_A } from "./harness/index.js";

describe("CASE-AGG-001 aggregateCaseStatus() — pure Case-level generalization of InstanceStatus (case.ts)", () => {
  it("all instances still RUNNING -> in-flight aggregate RUNNING", () => {
    expect(aggregateCaseStatus(["RUNNING", "RUNNING", "RUNNING"])).toBe("RUNNING");
  });

  it("all instances SUCCEEDED -> complete aggregate SUCCEEDED", () => {
    expect(aggregateCaseStatus(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"])).toBe("SUCCEEDED");
  });

  it("a mix of SUCCEEDED and FAILED, all terminal -> needs-attention aggregate PARTIAL (owner's '2 of 3 classified fine, one genuinely failed' example, one level up from summarizeFanoutOutcomes())", () => {
    expect(aggregateCaseStatus(["SUCCEEDED", "FAILED", "SUCCEEDED"])).toBe("PARTIAL");
  });

  it("a Case with only its first instance so far (before any fan-out has run) stays coherent — the N=1 case of the same rules, for every status", () => {
    expect(aggregateCaseStatus(["RUNNING"])).toBe("RUNNING");
    expect(aggregateCaseStatus(["WAITING"])).toBe("WAITING");
    expect(aggregateCaseStatus(["SUCCEEDED"])).toBe("SUCCEEDED");
    expect(aggregateCaseStatus(["FAILED"])).toBe("FAILED");
    expect(aggregateCaseStatus(["CANCELLED"])).toBe("CANCELLED");
  });

  it("RUNNING dominates even with an already-FAILED sibling — the Case is still in flight, the terminal verdict waits until nothing is left running", () => {
    expect(aggregateCaseStatus(["FAILED", "RUNNING"])).toBe("RUNNING");
  });

  it("WAITING (blocked on human review) dominates once nothing is left running, distinct from RUNNING", () => {
    expect(aggregateCaseStatus(["SUCCEEDED", "WAITING"])).toBe("WAITING");
  });

  it("every instance terminal and NONE ever SUCCEEDED -> FAILED, even when some are CANCELLED rather than FAILED", () => {
    expect(aggregateCaseStatus(["FAILED", "FAILED"])).toBe("FAILED");
    expect(aggregateCaseStatus(["FAILED", "CANCELLED"])).toBe("FAILED");
  });

  it("every single instance CANCELLED -> CANCELLED, a deliberate stop kept distinct from FAILED", () => {
    expect(aggregateCaseStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
  });

  it("zero instances -> UNSTARTED (this change, 18.9.2026 — the old 'a Case always has at least one instance' invariant no longer holds now that newCase() can be called without an instance; see case.ts's aggregateCaseStatus() doc comment)", () => {
    expect(aggregateCaseStatus([])).toBe("UNSTARTED");
  });
});

describe("CASE-STORE-001 MemoryCaseStore", () => {
  const impulse: NormalizedImpulse = { impulseId: "imp-1", tenantId: TENANT_A, channel: "mail", receivedAt: "2026-09-18T08:00:00Z", artifacts: [], metadata: {} };

  it("put()/get() round-trip, and byWorkflowId() resolves every instance ever added, re-indexed as the Case grows", () => {
    const store = new MemoryCaseStore();
    const c1 = newCase({ caseId: "case-1", impulse, instance: { workflowId: "wf-1", tenantId: TENANT_A, status: "RUNNING", createdAt: "t0", updatedAt: "t0" } });
    store.put(c1);
    expect(store.get("case-1")).toEqual(c1);
    expect(store.byWorkflowId("wf-1")).toEqual(c1);
    expect(store.byWorkflowId("wf-2")).toBeUndefined();
    expect(store.get("case-does-not-exist")).toBeUndefined();

    const c2 = addInstance(c1, { workflowId: "wf-2", tenantId: TENANT_A, status: "SUCCEEDED", updatedAt: "t1" });
    store.put(c2);
    // wf-1 now resolves to the GROWN Case, not the stale one-instance snapshot store.put(c1) first indexed it under.
    expect(store.byWorkflowId("wf-1")).toEqual(c2);
    expect(store.byWorkflowId("wf-2")).toEqual(c2);
    expect(store.list()).toEqual([c2]); // put() replaces the same caseId, never duplicates
  });
});

describe("CASE-GROUP-001 a mail-intake instance plus its fanned-out attachment instances end up correctly grouped under one Case, through REAL non-test-only code", () => {
  it("an INVOICE attachment classifies, seals evidence, plan() selects invoice.extract, and the resulting Case (mail-intake + classify + extract) aggregates to SUCCEEDED", async () => {
    const slice = createSlice();
    if (!slice.evidence) throw new Error("test setup: evidence ledger missing");
    const mailIntake = await runMailIntake(slice, { rawMail: INVOICE_MAIL });
    expect(mailIntake.status).toBe("SUCCEEDED");

    // The NormalizedImpulse createCaseForMailIntake() would build for this mail (mirrored here): the INVOICE_MAIL
    // fixture carries no attachments, so an empty artifacts[] is exactly right — same shape a plain,
    // attachment-less e-mail's impulse would have.
    const impulse: NormalizedImpulse = { impulseId: "imp-1", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], metadata: {} };
    let c = newCase({
      caseId: "case-1",
      impulse,
      instance: { workflowId: mailIntake.workflowId, tenantId: mailIntake.tenantId, status: mailIntake.status, createdAt: mailIntake.createdAt, updatedAt: mailIntake.updatedAt },
    });
    expect(c.instances).toEqual([mailIntake.workflowId]);
    expect(c.status).toBe("SUCCEEDED");

    // A separately-ingested invoice attachment (independent of the mail fixture, for direct control over the
    // fan-out outcome) fanned out through the REAL driver — same call growCaseWithFanout()'s caller (index.ts's
    // fanOutAttachmentsIfAny()) makes.
    const invoice = putArtifact(slice, INVOICE_CZ);
    const outcomes = await fanOutAttachments(
      { classifyOrchestrator: slice.orchestrators["attachment-classify"] as (typeof slice.orchestrators)[string], extractOrchestrator: slice.orchestrators["attachment-extract"] as (typeof slice.orchestrators)[string], catalog: realCatalog(), evidence: slice.evidence },
      { tenantId: TENANT_A, caseId: c.caseId, attachments: [{ artifactId: invoice.artifactId, entityId: newEntityId() }] },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.classify.status).toBe("SUCCEEDED");
    expect(outcomes[0]?.plan?.status).toBe("PLANNED");
    expect(outcomes[0]?.extract?.status).toBe("SUCCEEDED");

    // growCaseWithFanout()'s own loop, real addInstance() calls, one per started classify/extract instance.
    for (const outcome of outcomes) {
      for (const member of [outcome.classify, outcome.extract]) {
        if (!member) continue;
        c = addInstance(c, { workflowId: member.workflowId, tenantId: member.tenantId, status: member.status, updatedAt: member.updatedAt });
      }
    }
    expect(c.instances).toEqual([mailIntake.workflowId, outcomes[0]?.classify.workflowId, outcomes[0]?.extract?.workflowId]);

    // growCaseWithFanout()'s own final step: re-read every member instance's CURRENT status from the journal and
    // aggregate — not trust addInstance()'s own last-touched-instance status.
    const finalStatuses = c.instances.map((wid) => slice.journal.get(wid)?.status as InstanceStatus);
    expect(finalStatuses).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    expect(aggregateCaseStatus(finalStatuses)).toBe("SUCCEEDED");
  });

  it("mixing a SUCCEEDED attachment with a not-found one (BUSINESS failure -> onFailed 'review', a genuine WAITING instance) grows a real Case whose aggregate is WAITING — needs a person, not silently SUCCEEDED", async () => {
    const slice = createSlice();
    if (!slice.evidence) throw new Error("test setup: evidence ledger missing");
    const mailIntake = await runMailIntake(slice, { rawMail: INVOICE_MAIL });
    const impulse: NormalizedImpulse = { impulseId: "imp-2", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], metadata: {} };
    let c = newCase({
      caseId: "case-2",
      impulse,
      instance: { workflowId: mailIntake.workflowId, tenantId: mailIntake.tenantId, status: mailIntake.status, createdAt: mailIntake.createdAt, updatedAt: mailIntake.updatedAt },
    });

    const invoice = putArtifact(slice, INVOICE_CZ);
    const outcomes = await fanOutAttachments(
      { classifyOrchestrator: slice.orchestrators["attachment-classify"] as (typeof slice.orchestrators)[string], extractOrchestrator: slice.orchestrators["attachment-extract"] as (typeof slice.orchestrators)[string], catalog: realCatalog(), evidence: slice.evidence },
      { tenantId: TENANT_A, caseId: c.caseId, attachments: [{ artifactId: invoice.artifactId, entityId: newEntityId() }, { artifactId: "art-does-not-exist", entityId: newEntityId() }] },
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.classify.status).toBe("SUCCEEDED");
    expect(outcomes[0]?.extract?.status).toBe("SUCCEEDED");
    expect(outcomes[1]?.classify.status).toBe("WAITING"); // document.classify's ARTIFACT_NOT_FOUND is BUSINESS -> onFailed routes to review
    expect(outcomes[1]?.extract).toBeUndefined(); // never reached — classify itself never got to SUCCEEDED

    for (const outcome of outcomes) {
      for (const member of [outcome.classify, outcome.extract]) {
        if (!member) continue;
        c = addInstance(c, { workflowId: member.workflowId, tenantId: member.tenantId, status: member.status, updatedAt: member.updatedAt });
      }
    }
    const finalStatuses = c.instances.map((wid) => slice.journal.get(wid)?.status as InstanceStatus);
    expect(finalStatuses).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED", "WAITING"]);
    expect(aggregateCaseStatus(finalStatuses)).toBe("WAITING");
  });

  it("addInstance() refusing a duplicate workflowId for one attachment never drops instances already grouped from others — best-effort-per-attachment holds at the Case level too (growCaseWithFanout()'s own discipline)", async () => {
    const slice = createSlice();
    if (!slice.evidence) throw new Error("test setup: evidence ledger missing");
    const mailIntake = await runMailIntake(slice, { rawMail: INVOICE_MAIL });
    const impulse: NormalizedImpulse = { impulseId: "imp-3", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], metadata: {} };
    let c = newCase({
      caseId: "case-3",
      impulse,
      instance: { workflowId: mailIntake.workflowId, tenantId: mailIntake.tenantId, status: mailIntake.status, createdAt: mailIntake.createdAt, updatedAt: mailIntake.updatedAt },
    });

    const invoice = putArtifact(slice, INVOICE_CZ);
    const contract = putArtifact(slice, CONTRACT_CZ);
    const outcomes = await fanOutAttachments(
      { classifyOrchestrator: slice.orchestrators["attachment-classify"] as (typeof slice.orchestrators)[string], extractOrchestrator: slice.orchestrators["attachment-extract"] as (typeof slice.orchestrators)[string], catalog: realCatalog(), evidence: slice.evidence },
      { tenantId: TENANT_A, caseId: c.caseId, attachments: [{ artifactId: invoice.artifactId, entityId: newEntityId() }, { artifactId: contract.artifactId, entityId: newEntityId() }] },
    );
    expect(outcomes).toHaveLength(2);

    // Simulates growCaseWithFanout()'s try/catch: re-adding outcomes[0]'s classify instance a second time (as if
    // it had, impossibly, already been added) must throw CaseError but must not stop outcomes[1] from being added.
    c = addInstance(c, { workflowId: (outcomes[0] as (typeof outcomes)[number]).classify.workflowId, tenantId: TENANT_A, status: (outcomes[0] as (typeof outcomes)[number]).classify.status, updatedAt: (outcomes[0] as (typeof outcomes)[number]).classify.updatedAt });
    let secondAddThrew = false;
    try {
      addInstance(c, { workflowId: (outcomes[0] as (typeof outcomes)[number]).classify.workflowId, tenantId: TENANT_A, status: "SUCCEEDED", updatedAt: "irrelevant" });
    } catch (e) {
      secondAddThrew = e instanceof CaseError;
    }
    expect(secondAddThrew).toBe(true);
    // The other attachment's instance still gets added — the one throw above did not stop this loop.
    c = addInstance(c, { workflowId: (outcomes[1] as (typeof outcomes)[number]).classify.workflowId, tenantId: TENANT_A, status: (outcomes[1] as (typeof outcomes)[number]).classify.status, updatedAt: (outcomes[1] as (typeof outcomes)[number]).classify.updatedAt });
    expect(c.instances).toEqual([mailIntake.workflowId, (outcomes[0] as (typeof outcomes)[number]).classify.workflowId, (outcomes[1] as (typeof outcomes)[number]).classify.workflowId]);
  });
});
