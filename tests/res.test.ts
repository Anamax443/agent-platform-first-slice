// RES family: crash in the middle of a write step, unavailable dependency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDmsAdapter } from "../src/adapters/dms.js";
import { FakeRegistryAdapter } from "../src/adapters/registry.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { FakeClock } from "../src/platform/clock.js";
import type { Instance } from "../src/platform/journal.js";
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
