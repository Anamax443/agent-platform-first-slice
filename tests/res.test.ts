// RES family: crash in the middle of a write step, unavailable dependency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDmsAdapter } from "../src/adapters/dms.js";
import { FakeRegistryAdapter } from "../src/adapters/registry.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { FakeClock } from "../src/platform/clock.js";
import type { Instance, StepRecord } from "../src/platform/journal.js";
import { isRunningStepStale, maxStepDeadlineMs, type WorkflowDef } from "../src/platform/orchestrator.js";
import { InMemoryReviewTaskStore } from "../src/platform/review.js";
import { createSlice, DEFAULT_CLOCK_START, INVOICE_CZ, NEWSLETTER, putArtifact, runIntake, TENANT_A, tmpDir } from "./harness/index.js";

const reviewer = { actorId: "user-reviewer", role: "document.reviewer", tenantId: TENANT_A } as const;

describe("RES-CRASH-001 process dies in RUNNING of a write step", () => {
  it("after restart the step is recovered as UNKNOWN_OUTCOME, reconciled from the journal, and the write is not repeated", async () => {
    const dir = tmpDir();
    const journalFile = join(dir, "journal.json");
    const auditFile = join(dir, "audit.jsonl");
    // durable things survive the crash: journal file, audit file, artifact store, the DMS itself
    const artifacts = new ArtifactStore(new FakeClock(DEFAULT_CLOCK_START));
    const dms = new FakeDmsAdapter("crash-after-write");

    const before = createSlice({ journalFile, auditFile, artifacts, dms });
    const art = putArtifact(before, INVOICE_CZ);
    const started = before.orchestrator.start({ tenantId: TENANT_A, artifactId: art.artifactId, stampText: "VALIDATED INVOICE" });
    await expect(before.orchestrator.run(started.workflowId)).rejects.toThrow(/process crashed/);

    const persisted = JSON.parse(readFileSync(journalFile, "utf8")) as Instance[];
    expect(persisted[0]?.status).toBe("RUNNING");
    expect(persisted[0]?.steps.at(-1)).toMatchObject({ stepId: "stamp", status: "RUNNING" });
    expect(dms.stampCalls).toBe(1);

    dms.mode = "ok"; // the DMS was never the problem
    const after = createSlice({ journalFile, auditFile, artifacts, dms });
    const recovered = await after.orchestrator.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("SUCCEEDED");
    const stamp = recovered[0]?.steps.find((s) => s.stepId === "stamp");
    expect(stamp).toMatchObject({ status: "SUCCEEDED", attempt: 1, reconciliationAttempts: 1 });
    expect(stamp?.result?.payload).toMatchObject({ originalArtifactId: art.artifactId, stampText: "VALIDATED INVOICE", dmsRef: "dms-1" });
    expect(dms.stampCalls).toBe(1);
    expect(after.audit.byKind("reconciliation").some((r) => String(r.details?.reason).includes("recovered RUNNING write step"))).toBe(true);
    // the audit trail from before the crash is still there (append-only file)
    expect(after.audit.byKind("write-intent")).toHaveLength(1);
    expect(after.artifacts.get(String(stamp?.result?.payload?.stampedArtifactId))?.derivedFrom).toBe(art.artifactId);
  });

  it("a crash in a read-only step is simply rerun after restart", async () => {
    const dir = tmpDir();
    const journalFile = join(dir, "journal.json");
    const artifacts = new ArtifactStore(new FakeClock(DEFAULT_CLOCK_START));
    const before = createSlice({ journalFile, artifacts });
    const art = putArtifact(before, INVOICE_CZ);
    const started = before.orchestrator.start({ tenantId: TENANT_A, artifactId: art.artifactId, stampText: "VALIDATED INVOICE" });
    // simulate: journal says classify is RUNNING and the process is gone
    const inst = before.journal.get(started.workflowId) as Instance;
    inst.steps.push({
      stepId: "classify",
      capability: "document.classify",
      capabilityVersion: "1",
      sideEffects: "none",
      executionId: "exe-lost",
      attempt: 1,
      logicalAttempt: 1,
      strategyIndex: 0,
      strategy: "llm",
      idempotencyKey: `${inst.workflowId}:classify:llm:1`,
      status: "RUNNING",
      startedAt: before.clock.now().toISOString(),
    });
    before.journal.put(inst);

    const after = createSlice({ journalFile, artifacts });
    const recovered = await after.orchestrator.recover();
    expect(recovered[0]?.status).toBe("SUCCEEDED");
    expect(recovered[0]?.steps.filter((s) => s.stepId === "classify")).toHaveLength(1);
    expect(after.dms.stampCalls).toBe(1);
  });
});

describe("RES-REVIEW-001 a review decision made through a separately constructed ReviewService bound to the same store resumes the workflow", () => {
  it("found on the farm 2026-09-08: orchestratorFor() built a fresh in-memory ReviewService per HTTP request, so a decision could never find the task that created it", async () => {
    const dir = tmpDir();
    const journalFile = join(dir, "journal.json");
    const auditFile = join(dir, "audit.jsonl");
    // durable things survive across requests on the same Durable Object: journal, audit, artifacts, and now the review store
    const artifacts = new ArtifactStore(new FakeClock(DEFAULT_CLOCK_START));
    const reviewStore = new InMemoryReviewTaskStore();

    const before = createSlice({ journalFile, auditFile, artifacts, reviewStore });
    const { instance } = await runIntake(before, { bytes: NEWSLETTER });
    expect(instance.status).toBe("WAITING");
    const taskId = instance.waiting?.reviewTaskId as string;
    expect(before.review.get(taskId)).toBeDefined();

    // simulate a second HTTP request on the same Durable Object: orchestratorFor() runs again,
    // constructing a new ReviewService — but it must resolve against the same underlying store
    const after = createSlice({ journalFile, auditFile, artifacts, reviewStore });
    expect(after.review).not.toBe(before.review);
    expect(after.review.get(taskId)).toBeDefined(); // would be undefined before the fix (fresh Map)

    expect(after.review.decide(taskId, { ...reviewer, decision: "REJECT" }).ok).toBe(true);
    const done = await after.orchestrator.resumeAfterReview(instance.workflowId, taskId);
    expect(done.status).toBe("FAILED");
    expect(after.audit.byKind("review-decision").some((r) => r.details?.reviewTaskId === taskId && r.details?.decision === "REJECT")).toBe(true);
  });
});

describe("RES-DEP-001 unavailable dependency", () => {
  it("bounded technical retries, then FAILED/DEPENDENCY_UNAVAILABLE retryable, instance FAILED, no infinite loop", async () => {
    const registry = new FakeRegistryAdapter("unavailable");
    const slice = createSlice({ registry });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("FAILED");
    const validate = instance.steps.find((s) => s.stepId === "validate");
    expect(validate?.attempt).toBe(3);
    expect(validate?.result?.error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", class: "DEPENDENCY", retryable: true });
    expect(registry.calls).toBe(3);
    expect(slice.dms.stampCalls).toBe(0);
    expect(slice.audit.byKind("state").at(-1)?.details).toMatchObject({ status: "FAILED", step: "validate", code: "DEPENDENCY_UNAVAILABLE" });
  });
});

/**
 * R2 (2026-09-18 reliability audit, "recover() exists but the live gateway never calls it"): recover() (RES-CRASH-001
 * above) is safe to call from a fresh process boot with nothing else concurrently running — its only tested callers
 * so far — but not safe to call unconditionally from a live, always-on Durable Object's alarm(), where a RUNNING step
 * can be genuinely, legitimately still mid-dispatch. isRunningStepStale()/maxStepDeadlineMs() (src/platform/
 * orchestrator.ts) are the pure staleness gate deploy/cloudflare/apf-gateway/src/index.ts's alarm() now checks before
 * ever calling recover() outside a boot/test context; these are exactly the pure-function tests that stand in for a
 * DO/miniflare harness (deploy/cloudflare/apf-gateway has no test suite today — see the R2 patch-plan write-up for why
 * the wiring itself is left to a manual smoke test instead of a new harness this batch).
 */
describe("R2 recovery staleness gate (isRunningStepStale / maxStepDeadlineMs)", () => {
  // Deliberately not one of the real workflows/*.json files: a literal fixture here means this suite can't start
  // silently passing or failing because someone edited an unrelated real workflow's deadlineMs.
  const WORKFLOW: WorkflowDef = {
    workflow: "r2-fixture-wf",
    workflowVersion: "1",
    conformanceTier: "semantic",
    deadlineMs: 1_800_000, // 30 min, same order of magnitude as the real workflows (mail-intake.v3.json:6)
    operatorRole: "document.operator",
    supervisorRole: "document.supervisor",
    steps: [{ id: "classify", capability: "document.classify", capabilityVersion: "1", sideEffects: "none", inputs: {} }],
  };
  const WORKFLOW_STEP_DEF = WORKFLOW.steps[0]!;

  function runningStep(overrides: Partial<StepRecord> = {}): StepRecord {
    return {
      stepId: "classify",
      capability: "document.classify",
      capabilityVersion: "1",
      sideEffects: "none",
      executionId: "exe-r2",
      attempt: 1,
      logicalAttempt: 1,
      strategyIndex: 0,
      strategy: "llm",
      idempotencyKey: "wf-r2:classify:llm:1",
      status: "RUNNING",
      startedAt: DEFAULT_CLOCK_START,
      ...overrides,
    };
  }

  function instanceWith(steps: StepRecord[]): Instance {
    return {
      workflowId: "wf-r2",
      workflow: "r2-fixture-wf",
      workflowVersion: "1",
      correlationId: "corr-r2",
      tenantId: TENANT_A,
      actorId: "svc-test",
      status: "RUNNING",
      currentStep: 0,
      input: {},
      steps,
      published: { status: "RUNNING" },
      createdAt: DEFAULT_CLOCK_START,
      updatedAt: DEFAULT_CLOCK_START,
    };
  }

  it("no RUNNING step (only SUCCEEDED/WAITING) -> false", () => {
    const inst = instanceWith([runningStep({ status: "SUCCEEDED" }), runningStep({ stepId: "validate", status: "WAITING" })]);
    expect(isRunningStepStale(inst, WORKFLOW, new Date(DEFAULT_CLOCK_START))).toBe(false);
  });

  it("RUNNING step whose message.notValidAfter has not yet elapsed -> false, and elapsed -> true (off-by-one at the boundary)", () => {
    const notValidAfter = "2026-09-06T08:30:00Z"; // DEFAULT_CLOCK_START + 30min
    const inst = instanceWith([
      runningStep({
        message: {
          messageId: "msg-1",
          correlationId: "corr-r2",
          workflowId: "wf-r2",
          stepId: "classify",
          type: "command",
          capability: "document.classify",
          capabilityVersion: "1",
          schemaVersion: "1",
          idempotencyKey: "wf-r2:classify:llm:1",
          createdAt: DEFAULT_CLOCK_START,
          notValidAfter,
          payload: {},
        },
      }),
    ]);
    const boundaryMs = Date.parse(notValidAfter);
    // one millisecond before the deadline: still legitimately RUNNING, must not be recoverable
    expect(isRunningStepStale(inst, WORKFLOW, new Date(boundaryMs - 1))).toBe(false);
    // exactly at the deadline: now stale, recover() may act on it (this is the property alarm() gates on)
    expect(isRunningStepStale(inst, WORKFLOW, new Date(boundaryMs))).toBe(true);
    // comfortably after: still stale
    expect(isRunningStepStale(inst, WORKFLOW, new Date(boundaryMs + 60_000))).toBe(true);
  });

  it("RUNNING step with no message (message.notValidAfter absent) falls back to startedAt + step/workflow deadlineMs", () => {
    // Same shape as RES-CRASH-001's "a crash in a read-only step is simply rerun after restart" fixture above
    // (tests/res.test.ts:58-71): a RUNNING step recorded with no `message` at all — buildMessage() never ran for
    // it, so there is no durable notValidAfter to read, only startedAt + the workflow's own deadline policy.
    const inst = instanceWith([runningStep()]); // no `message` override -> field is simply absent
    const fallbackMs = Date.parse(DEFAULT_CLOCK_START) + WORKFLOW.deadlineMs; // no step-level deadlineMs override in WORKFLOW
    expect(isRunningStepStale(inst, WORKFLOW, new Date(fallbackMs - 1))).toBe(false);
    expect(isRunningStepStale(inst, WORKFLOW, new Date(fallbackMs))).toBe(true);
  });

  it("maxStepDeadlineMs: workflow deadline when no step overrides it", () => {
    expect(maxStepDeadlineMs(WORKFLOW)).toBe(1_800_000);
  });

  it("maxStepDeadlineMs: the larger of the two when a step override exceeds the workflow deadline", () => {
    const wf: WorkflowDef = {
      ...WORKFLOW,
      deadlineMs: 1_800_000,
      steps: [{ ...WORKFLOW_STEP_DEF, deadlineMs: 3_600_000 }],
    };
    expect(maxStepDeadlineMs(wf)).toBe(3_600_000);
  });

  it("maxStepDeadlineMs: the workflow deadline when it is larger than every step override", () => {
    const wf: WorkflowDef = {
      ...WORKFLOW,
      deadlineMs: 1_800_000,
      steps: [{ ...WORKFLOW_STEP_DEF, deadlineMs: 600_000 }],
    };
    expect(maxStepDeadlineMs(wf)).toBe(1_800_000);
  });
});
