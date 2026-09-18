// Reliability Gate RG2-A (2026-09-18): src/platform/durable-job.ts's own tests — the shared "none/wait/retry"
// staleness-against-grace-period arithmetic both fan-out (fanout-retry.ts, tested separately in
// tests/gw-fanout-retry.test.ts) and copyOut()'s new durable job (index.ts) now delegate to, so this arithmetic is
// tested exactly once rather than twice. Style mirrors tests/gw-fanout-retry.test.ts's own fanoutRetryDecision()
// tests, minus the give-up branch this file's own type (JobRetryDecision) has no room for.
import { describe, expect, it } from "vitest";
import { jobNextWakeAt, jobRetryDecision, type JobStaleness } from "../src/platform/durable-job.js";

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
