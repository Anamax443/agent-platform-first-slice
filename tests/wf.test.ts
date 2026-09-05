// WF family: unknown outcome, reconciliation, review expiry and authorization, workflow version pinning.
import { describe, expect, it } from "vitest";
import { FakeDmsAdapter } from "../src/adapters/dms.js";
import { DAY_MS } from "./harness/time.js";
import { Orchestrator } from "../src/platform/orchestrator.js";
import type { Instance } from "../src/platform/journal.js";
import { createSlice, INVOICE_CZ, NEWSLETTER, ORCHESTRATOR, putArtifact, runIntake, TENANT_A, TENANT_B } from "./harness/index.js";

const reviewer = { actorId: "user-reviewer", role: "document.reviewer", tenantId: TENANT_A } as const;
const operator = { actorId: "user-operator", role: "document.operator", tenantId: TENANT_A } as const;

describe("WF-UNK unknown outcome (F5, F6)", () => {
  it("WF-UNK-001 a lost DMS answer becomes UNKNOWN_OUTCOME, reconciliation finds the write, no resend", async () => {
    const dms = new FakeDmsAdapter("unknown-once");
    const slice = createSlice({ dms });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    const stamp = instance.steps.find((s) => s.stepId === "stamp");
    expect(stamp?.status).toBe("SUCCEEDED");
    expect(stamp?.attempt).toBe(1);
    expect(stamp?.reconciliationAttempts).toBe(1);
    expect(dms.stampCalls).toBe(1);
    expect(slice.audit.byKind("write-intent")).toHaveLength(1);
    expect(slice.audit.byKind("write-done")[0]?.details?.status).toBe("UNKNOWN_OUTCOME");
    expect(slice.audit.byKind("reconciliation").length).toBeGreaterThanOrEqual(1);
    const derived = slice.artifacts.get(String(stamp?.result?.payload?.stampedArtifactId));
    expect(derived?.derivedFrom).toBe(String(stamp?.result?.payload?.originalArtifactId));
  });

  it("WF-UNK-002 reconciliation that stays unknown for reconciliationBudget attempts ends in WAITING(REVIEW) with a deadline, never a loop", async () => {
    const dms = new FakeDmsAdapter("unknown-always", "unknown");
    const slice = createSlice({ dms });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("WAITING");
    expect(instance.waiting?.reason).toBe("REVIEW");
    expect(instance.waiting?.deadline).toBeDefined();
    const stamp = instance.steps.find((s) => s.stepId === "stamp");
    expect(stamp?.reconciliationAttempts).toBe(3);
    expect(dms.stampCalls).toBe(1);
    const task = slice.review.get(String(instance.waiting?.reviewTaskId));
    expect(task?.requiredRole).toBe("document.operator");
    expect(task?.reasonCode).toBe("UNKNOWN_OUTCOME_UNRESOLVED");
    expect(task?.allowedDecisions).toEqual(["APPROVE", "REJECT"]);

    // operator confirms in the DMS portal that the write happened
    const decided = slice.review.decide(task?.reviewTaskId as string, { ...operator, decision: "APPROVE", correction: { dmsRef: "dms-1", confirmedInPortal: true } });
    expect(decided.ok).toBe(true);
    const after = await slice.orchestrator.resumeAfterReview(instance.workflowId, task?.reviewTaskId as string);
    expect(after.status).toBe("SUCCEEDED");
    expect(after.steps.find((s) => s.stepId === "stamp")?.result?.payload).toMatchObject({ dmsRef: "dms-1", confirmedBy: operator.actorId });
    expect(dms.stampCalls).toBe(1);
  });

  it("WF-UNK-002 REJECT after unresolved reconciliation ends the instance as FAILED, still no resend", async () => {
    const dms = new FakeDmsAdapter("unknown-always", "unknown");
    const slice = createSlice({ dms });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    const taskId = instance.waiting?.reviewTaskId as string;
    slice.review.decide(taskId, { ...operator, decision: "REJECT" });
    const after = await slice.orchestrator.resumeAfterReview(instance.workflowId, taskId);
    expect(after.status).toBe("FAILED");
    expect(dms.stampCalls).toBe(1);
  });

  it("WF-UNK-003 the published state is UNKNOWN_OUTCOME with a sub-state during reconciliation and review, never FAILED or SUCCEEDED early", async () => {
    const dms = new FakeDmsAdapter("unknown-always", "unknown");
    const slice = createSlice({ dms });
    const seen: Instance["published"][] = [];
    const hostReconciler = slice.host.reconcilerFor("document.stamp");
    const orchestrator = new Orchestrator({
      workflow: slice.workflow,
      gateway: slice.gateway,
      router: slice.router,
      journal: slice.journal,
      review: slice.review,
      audit: slice.audit,
      clock: slice.clock,
      actorId: ORCHESTRATOR,
      reconcilers: {
        "document.stamp": async (ref, step, inst) => {
          seen.push(slice.journal.get(inst.workflowId)?.published as Instance["published"]);
          return hostReconciler(ref, step, inst);
        },
      },
    });
    const art = putArtifact(slice, INVOICE_CZ);
    const inst = orchestrator.start({ tenantId: TENANT_A, artifactId: art.artifactId, stampText: "VALIDATED INVOICE" });
    const done = await orchestrator.run(inst.workflowId);
    expect(seen).toHaveLength(3);
    for (const p of seen) expect(p).toEqual({ status: "UNKNOWN_OUTCOME", reconciliation: "IN_PROGRESS" });
    expect(done.published).toEqual({ status: "UNKNOWN_OUTCOME", reconciliation: "AWAITING_REVIEW" });
    expect(done.status).toBe("WAITING");
  });
});

describe("WF-REV human review (§5.8)", () => {
  it("WF-REV-003 an expired review task escalates by policy up to maxEscalationDepth and then ends the instance explicitly", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: NEWSLETTER });
    expect(instance.status).toBe("WAITING");
    const first = slice.review.get(instance.waiting?.reviewTaskId as string);
    expect(first).toMatchObject({ requiredRole: "document.reviewer", expiryPolicy: "ESCALATE", escalateTo: "document.supervisor", escalationDepth: 0 });

    slice.clock.advance(3 * DAY_MS + 60_000);
    expect(slice.orchestrator.applyReviewExpiries()).toEqual([{ workflowId: instance.workflowId, transition: "ESCALATED" }]);
    let inst = slice.journal.get(instance.workflowId) as Instance;
    const second = slice.review.get(inst.waiting?.reviewTaskId as string);
    expect(second?.reviewTaskId).not.toBe(first?.reviewTaskId);
    expect(second).toMatchObject({ requiredRole: "document.supervisor", escalationDepth: 1, status: "OPEN" });
    expect(inst.status).toBe("WAITING");

    slice.clock.advance(3 * DAY_MS + 60_000);
    expect(slice.orchestrator.applyReviewExpiries()[0]?.transition).toBe("ESCALATED");
    inst = slice.journal.get(instance.workflowId) as Instance;
    expect(slice.review.get(inst.waiting?.reviewTaskId as string)?.escalationDepth).toBe(2);

    slice.clock.advance(3 * DAY_MS + 60_000);
    expect(slice.orchestrator.applyReviewExpiries()[0]?.transition).toBe("FAILED_MAX_ESCALATION");
    inst = slice.journal.get(instance.workflowId) as Instance;
    expect(inst.status).toBe("FAILED");
    expect(inst.waiting).toBeUndefined();
    expect(slice.review.open()).toHaveLength(0);
    expect(slice.audit.byKind("review-expired")).toHaveLength(3);
    expect(slice.audit.byKind("state").at(-1)?.details).toMatchObject({ status: "FAILED", reason: "FAILED_MAX_ESCALATION" });
    expect(slice.dms.stampCalls).toBe(0);
  });

  it("WF-REV-004 a decision without the right role, outside allowedDecisions, from another tenant, or bound to another task is denied and audited", async () => {
    const slice = createSlice();
    const a = await runIntake(slice, { bytes: NEWSLETTER });
    const b = await runIntake(slice, { bytes: NEWSLETTER });
    const taskA = a.instance.waiting?.reviewTaskId as string;
    const taskB = b.instance.waiting?.reviewTaskId as string;

    expect(slice.review.decide(taskA, { actorId: "user-x", role: "document.viewer", tenantId: TENANT_A, decision: "APPROVE" })).toEqual({ ok: false, code: "APPROVAL_MISMATCH" });
    expect(slice.review.decide(taskA, { ...reviewer, tenantId: TENANT_B, decision: "APPROVE" })).toEqual({ ok: false, code: "TENANT_SCOPE_MISMATCH" });
    expect(slice.review.decide("rev-does-not-exist", { ...reviewer, decision: "APPROVE" })).toEqual({ ok: false, code: "APPROVAL_MISMATCH" });
    expect(slice.audit.byKind("security").filter((r) => r.details?.reviewTaskId === taskA)).toHaveLength(2);

    // a decision on task B cannot move instance A
    expect(slice.review.decide(taskB, { ...reviewer, decision: "RECLASSIFY", correction: { documentType: "INVOICE" } }).ok).toBe(true);
    await expect(slice.orchestrator.resumeAfterReview(a.instance.workflowId, taskB)).rejects.toThrow(/APPROVAL_MISMATCH/);
    expect(slice.journal.get(a.instance.workflowId)?.status).toBe("WAITING");

    // the proper decision moves instance A: reclassified, revalidated as human-corrected, stamped
    expect(slice.review.decide(taskA, { ...reviewer, decision: "RECLASSIFY", correction: { documentType: "INVOICE" } }).ok).toBe(true);
    const done = await slice.orchestrator.resumeAfterReview(a.instance.workflowId, taskA);
    expect(done.status).toBe("SUCCEEDED");
    const validate = done.steps.find((s) => s.stepId === "validate" && s.status === "SUCCEEDED");
    expect(validate?.strategy).toBe("human-corrected");
    expect(validate?.idempotencyKey).toBe(`${done.workflowId}:validate:human-corrected:2`);
    expect(validate?.result?.payload?.documentType).toMatchObject({ value: "INVOICE", source: "human", trustLevel: "human-corrected" });
    expect(slice.audit.byKind("review-decision").some((r) => r.actorId === reviewer.actorId && r.details?.decision === "RECLASSIFY")).toBe(true);
    expect(slice.dms.stampCalls).toBe(1);
  });

  it("a decided task cannot be decided again (REVIEW_EXPIRED semantics for closed tasks)", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: NEWSLETTER });
    const taskId = instance.waiting?.reviewTaskId as string;
    expect(slice.review.decide(taskId, { ...reviewer, decision: "REJECT" }).ok).toBe(true);
    expect(slice.review.decide(taskId, { ...reviewer, decision: "APPROVE" })).toEqual({ ok: false, code: "REVIEW_EXPIRED" });
  });
});

describe("WF-VER-001 running instances pin their workflow version", () => {
  it("an orchestrator with v2 refuses a v1 instance; the v1 orchestrator finishes it", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: NEWSLETTER });
    const v2 = new Orchestrator({
      workflow: { ...slice.workflow, workflowVersion: "2" },
      gateway: slice.gateway,
      router: slice.router,
      journal: slice.journal,
      review: slice.review,
      audit: slice.audit,
      clock: slice.clock,
      actorId: ORCHESTRATOR,
    });
    await expect(v2.run(instance.workflowId)).rejects.toThrow(/WF-VER-001/);
    expect(slice.journal.get(instance.workflowId)?.workflowVersion).toBe("1");

    const taskId = instance.waiting?.reviewTaskId as string;
    slice.review.decide(taskId, { ...reviewer, decision: "REJECT" });
    const done = await slice.orchestrator.resumeAfterReview(instance.workflowId, taskId);
    expect(done.status).toBe("FAILED");
    expect(done.workflowVersion).toBe("1");
  });
});
