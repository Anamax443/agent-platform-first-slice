// Reliability Gate RG2-A (2026-09-18): src/platform/durable-job.ts's own tests — the shared "none/wait/retry"
// staleness-against-grace-period arithmetic both fan-out (fanout-retry.ts, tested separately in
// tests/gw-fanout-retry.test.ts) and copyOut()'s new durable job (index.ts) now delegate to, so this arithmetic is
// tested exactly once rather than twice. Style mirrors tests/gw-fanout-retry.test.ts's own fanoutRetryDecision()
// tests, minus the give-up branch this file's own type (JobRetryDecision) has no room for.
import { describe, expect, it } from "vitest";
import { jobNextWakeAt, jobRetryDecision, nextCopyoutJobRecord, type DurableJobRecord, type JobStaleness } from "../src/platform/durable-job.js";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const GRACE_MS = 60_000;

const job = (overrides: Partial<JobStaleness> = {}): JobStaleness => ({
  status: "PENDING",
  updatedAt: new Date(NOW - 10 * GRACE_MS).toISOString(), // stale by default, unless a test overrides it
  ...overrides,
});

describe("jobRetryDecision — none/wait/retry, no give-up branch", () => {
  it("no job at all -> none", () => {
    expect(jobRetryDecision(undefined, NOW, { graceMs: GRACE_MS })).toBe("none");
  });

  it("a DONE job -> none, regardless of how stale updatedAt is", () => {
    expect(jobRetryDecision(job({ status: "DONE", updatedAt: new Date(0).toISOString() }), NOW, { graceMs: GRACE_MS })).toBe("none");
  });

  it("PENDING and touched inside the grace period -> wait (another pass may still be legitimately in flight)", () => {
    const fresh = job({ updatedAt: new Date(NOW - GRACE_MS / 2).toISOString() });
    expect(jobRetryDecision(fresh, NOW, { graceMs: GRACE_MS })).toBe("wait");
  });

  it("PENDING and touched exactly at the grace boundary -> retry (>=, not >, matches fanoutRetryDecision's own boundary)", () => {
    const atBoundary = job({ updatedAt: new Date(NOW - GRACE_MS).toISOString() });
    expect(jobRetryDecision(atBoundary, NOW, { graceMs: GRACE_MS })).toBe("retry");
  });

  it("PENDING and stale past the grace period -> retry", () => {
    const stale = job({ updatedAt: new Date(NOW - GRACE_MS * 2).toISOString() });
    expect(jobRetryDecision(stale, NOW, { graceMs: GRACE_MS })).toBe("retry");
  });

  it("never gives up, no matter how stale — the whole reason this function has no `attempts`/`maxAttempts` input at all: a job kind that must retry forever (copyOut(), index.ts) can call this directly with no cap to accidentally trip", () => {
    const veryStale = job({ updatedAt: new Date(0).toISOString() }); // 1970 — decades stale
    expect(jobRetryDecision(veryStale, NOW, { graceMs: GRACE_MS })).toBe("retry");
    // Contrast: fanoutRetryDecision() (fanout-retry.ts) DOES have a `maxAttempts` input specifically to be able to
    // return "give-up" for an equally-stale, equally-PENDING row once attempts run out — this function's own
    // return type (JobRetryDecision = "none" | "wait" | "retry") makes that outcome unrepresentable here, not
    // merely unreached.
  });
});

describe("jobNextWakeAt — the shared wake-time half of fanoutNextWakeAt(), no cap input", () => {
  it("no job -> undefined", () => {
    expect(jobNextWakeAt(undefined, { graceMs: GRACE_MS })).toBeUndefined();
  });

  it("a DONE job -> undefined, no matter how recently it was touched", () => {
    expect(jobNextWakeAt(job({ status: "DONE", updatedAt: new Date(NOW).toISOString() }), { graceMs: GRACE_MS })).toBeUndefined();
  });

  it("a PENDING job -> updatedAt + graceMs, exactly (the backoff pacing that keeps a retrying job from hammering D1/R2 every tick)", () => {
    const updatedAt = NOW - 5_000;
    const wake = jobNextWakeAt(job({ updatedAt: new Date(updatedAt).toISOString() }), { graceMs: GRACE_MS });
    expect(wake).toBe(updatedAt + GRACE_MS);
  });

  it("a PENDING job with an enormous `attempts`-like history still contributes a wake time — there is no attempts field on JobStaleness at all to cap against", () => {
    // JobStaleness only carries {status, updatedAt} — DurableJobRecord's `attempts` is a wider structural type that
    // still satisfies it, proving jobNextWakeAt() cannot see (and so cannot be tripped by) that field.
    const wideRecord = { status: "PENDING" as const, updatedAt: new Date(NOW).toISOString(), attempts: 999_999 };
    expect(jobNextWakeAt(wideRecord, { graceMs: GRACE_MS })).toBe(NOW + GRACE_MS);
  });
});

/**
 * Adversarial-review fix (2026-09-18, finding 5 against RG2-A): nextCopyoutJobRecord() is the actual give-up
 * decision index.ts's WorkflowInstance.recordCopyoutOutcome() delegates to — extracted here specifically so it has
 * a direct test. Before this extraction, no test anywhere called it (it lived inline in index.ts, which imports
 * "cloudflare:workers" and cannot be loaded under vitest at all), so a hypothetical regression reintroducing a
 * give-up/cap branch directly into that decision would have passed the whole suite; the "never gives up" tests
 * above only cover jobRetryDecision()/jobNextWakeAt(), which the FAN-OUT job uses, not this one.
 */
describe("nextCopyoutJobRecord — the copyout job's own give-up decision (never gives up, unlike fan-out's)", () => {
  const NOW_ISO = new Date(NOW).toISOString();
  const existingRow = (overrides: Partial<DurableJobRecord> = {}): DurableJobRecord => ({
    workflowId: "wf-A",
    kind: "copyout",
    status: "PENDING",
    attempts: 3,
    startedAt: new Date(NOW - 5 * GRACE_MS).toISOString(),
    updatedAt: new Date(NOW - GRACE_MS).toISOString(),
    ...overrides,
  });

  it("nothing outstanding, no existing row -> undefined (a fully clean instance never gets a row at all)", () => {
    const result = nextCopyoutJobRecord(undefined, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: false,
      outstandingWork: false,
    });
    expect(result).toBeUndefined();
  });

  it("nothing outstanding, an existing PENDING row -> flips to DONE, attempts untouched", () => {
    const existing = existingRow();
    const result = nextCopyoutJobRecord(existing, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: false,
      outstandingWork: false,
    });
    expect(result).toEqual({ ...existing, status: "DONE", updatedAt: NOW_ISO });
  });

  it("outstandingWork alone (an uncopied artifact, no failure this pass) -> stays PENDING, attempts increments, no lastError", () => {
    const existing = existingRow({ attempts: 7 });
    const result = nextCopyoutJobRecord(existing, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: false,
      outstandingWork: true,
    });
    expect(result).toEqual({ workflowId: "wf-A", kind: "copyout", status: "PENDING", attempts: 8, startedAt: existing.startedAt, updatedAt: NOW_ISO });
    expect(result?.lastError).toBeUndefined();
  });

  it("anyRefClaimFailed -> PENDING with the r2_ref-specific lastError message, even though outstandingWork is false", () => {
    const result = nextCopyoutJobRecord(undefined, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: true,
      passFailed: false,
      outstandingWork: false,
    });
    expect(result).toEqual({ workflowId: "wf-A", kind: "copyout", status: "PENDING", attempts: 1, startedAt: NOW_ISO, updatedAt: NOW_ISO, lastError: "r2_ref claim failed for at least one artifact this pass" });
  });

  it("finding 3: passFailed alone (e.g. a D1 outage in ensureD1R2Ref(), thrown before any ref claim could even run) forces PENDING even though outstandingWork and anyRefClaimFailed are both false — this is the exact case that used to compute DONE and let rearmAlarm() delete the instance's last alarm", () => {
    const result = nextCopyoutJobRecord(undefined, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: true,
      passFailedError: "D1 unavailable",
      outstandingWork: false,
    });
    expect(result?.status).toBe("PENDING");
    expect(result?.lastError).toBe("copyOut pass failed: D1 unavailable");
  });

  it("finding 2: passFailed populates lastError even when it is the only signal (no ref-claim failure, no outstandingWork) — no longer indistinguishable from healthy backoff", () => {
    const existing = existingRow({ attempts: 40, lastError: undefined });
    const result = nextCopyoutJobRecord(existing, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: true,
      passFailedError: "AUDIT.batch rejected",
      outstandingWork: false,
    });
    expect(result?.attempts).toBe(41);
    expect(result?.lastError).toBe("copyOut pass failed: AUDIT.batch rejected");
  });

  it("anyRefClaimFailed takes precedence over passFailed's lastError text when both are true in the same pass", () => {
    const result = nextCopyoutJobRecord(undefined, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: true,
      passFailed: true,
      passFailedError: "some other error",
      outstandingWork: false,
    });
    expect(result?.lastError).toBe("r2_ref claim failed for at least one artifact this pass");
  });

  it("never gives up no matter how large `attempts` already is — there is no cap branch here at all, unlike fanoutRetryDecision()'s FANOUT_MAX_ATTEMPTS", () => {
    const existing = existingRow({ attempts: 999_999 });
    const result = nextCopyoutJobRecord(existing, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: false,
      passFailed: true,
      passFailedError: "still failing",
      outstandingWork: true,
    });
    expect(result?.status).toBe("PENDING"); // never "DONE" purely because attempts is huge, and there is no "gave up" status to return
    expect(result?.attempts).toBe(1_000_000);
  });

  it("startedAt is preserved from the existing row, never reset, across repeated PENDING passes", () => {
    const existing = existingRow({ startedAt: "2020-01-01T00:00:00.000Z" });
    const result = nextCopyoutJobRecord(existing, "wf-A", "copyout", NOW_ISO, {
      anyRefClaimFailed: true,
      passFailed: false,
      outstandingWork: false,
    });
    expect(result?.startedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
