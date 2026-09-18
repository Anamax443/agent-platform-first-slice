// Reliability Gate RG2-A (2026-09-18, following the same day's R0-R4 audit that produced r2-refcount.ts and
// deploy/cloudflare/apf-gateway/src/fanout-retry.ts): a general durable job/outbox primitive for REQUIRED
// background durability work, first wired up for apf-gateway's copyOut() (index.ts) — see that method's own doc
// comment for the P0 this closes (a D1 failure on the LAST-EVER copyOut() of an instance whose alarm then gets
// deleted leaves its r2_ref claim unregistered forever, so a sibling Case's purge() can delete a blob this
// instance still points at).
//
// This file holds only the "none/wait/retry" staleness-against-grace-period arithmetic fanout-retry.ts's own
// fanoutRetryDecision() already had — factored out here so a second job kind (copyOut(), below) does not need a
// second copy of the same Date.parse()/subtraction. fanoutRetryDecision() and fanoutNextWakeAt() (fanout-retry.ts)
// now delegate to jobRetryDecision()/jobNextWakeAt() below for that shared half, then layer fan-out's own
// attempts-cap "give-up" branch on top — which is exactly the one thing this file's own decision type,
// JobRetryDecision, deliberately has no room for.
//
// Explicitly NOT a migration of fanout_job/FanoutJobRecord (store.ts, fanout-retry.ts) onto a shared table: that
// file's own doc comment explains why a generic multi-kind job table was not built for fan-out (transitional,
// soon superseded by a future Case/goal loop — see docs/AUTONOMOUS-RUNTIME-V1.md część 7). copyOut() is the
// opposite of transitional — permanent core-durability work (R2 blob lifecycle, audit mirror, evidence mirror) —
// so THIS file's shape is deliberately generic/kind-tagged even though fan-out itself stays on its own table;
// only copyOut() is actually stored through DurableJobRecord (store.ts's `durable_job` table, its own DDL comment).
//
// Every ordering/durability decision anywhere in this batch of work resolves against one invariant, verbatim (the
// owner's own words, 18.9.2026, restated on index.ts's copyOut() and purge()):
//
//   "An orphaned reference-claim, or a blob nobody deletes because a stale claim says it's still used, is a
//   bounded, cosmetic leak. A live reference pointing at a blob some OTHER Case's purge() has already deleted is
//   unbounded, undetectable data loss. Every ordering decision in this file resolves in favor of the leak."

/** One row of the durable job table (store.ts's `durable_job`, PK `(workflow_id, kind)` — multi-kind-ready on
 * purpose, see this file's own header, even though `kind` is only ever `"copyout"` as of this change). Shaped like
 * fanout-retry.ts's FanoutJobRecord (same field names/meaning) minus the fan-out-only `caseId`, so a reader who
 * already knows that record shape needs nothing new here. */
export interface DurableJobRecord {
  workflowId: string;
  /** Which kind of durable job this row tracks — `"copyout"` today; the column exists so a future job kind
   * (a mirror job, a notification retry, a dependency retry — see this file's header) can share the same table
   * without a schema change. */
  kind: string;
  status: "PENDING" | "DONE";
  /** How many passes have touched this row — observability only (same status as FanoutJobRecord.attempts:
   * fanout-retry.ts's own doc comment), never read by jobRetryDecision()/jobNextWakeAt() below. A copyout job in
   * particular has no cap to compare this against — see the "never give up" contract on those two functions. */
  attempts: number;
  startedAt: string;
  updatedAt: string;
  lastError?: string;
}

/** The structural subset jobRetryDecision()/jobNextWakeAt() actually need — satisfied by DurableJobRecord above
 * AND by fanout-retry.ts's own FanoutJobRecord (which carries extra fields neither function reads), so the two
 * job kinds can share this arithmetic without either file importing the other's concrete record type. */
export interface JobStaleness {
  status: "PENDING" | "DONE";
  updatedAt: string;
}

export type JobRetryDecision = "none" | "wait" | "retry";

/**
 * Shared half of fanoutRetryDecision() (fanout-retry.ts): PENDING-but-fresh waits (something may still be
 * legitimately in flight, same isolate or another one not yet evicted); PENDING-and-stale is safe to retry;
 * missing or DONE is nothing to do. Deliberately has NO cap/give-up branch — a job kind that must never give up
 * (copyOut()'s durable job, index.ts) can call this directly; fanoutRetryDecision() wraps it with its own
 * attempts-cap check for the one job kind that IS allowed to give up.
 */
export function jobRetryDecision(job: JobStaleness | undefined, nowMs: number, opts: { graceMs: number }): JobRetryDecision {
  if (!job || job.status === "DONE") return "none";
  const staleMs = nowMs - Date.parse(job.updatedAt);
  return staleMs < opts.graceMs ? "wait" : "retry";
}

/**
 * Shared half of fanoutNextWakeAt() (fanout-retry.ts) — when an alarm should next check on a job purely to see if
 * it is due for another pass. undefined for a missing or DONE job (nothing to wait for); otherwise
 * `updatedAt + graceMs`, the same backoff/grace-period pacing fan-out already uses so a PENDING job's alarm does
 * not hammer D1/R2 on every single tick. No cap input here at all (contrast fanoutNextWakeAt(), which also stops
 * contributing a wake-up past `maxAttempts`) — a job using this function directly is, by construction, one that
 * never gives up, so there is no attempts value that should ever silence its wake-up.
 */
export function jobNextWakeAt(job: JobStaleness | undefined, opts: { graceMs: number }): number | undefined {
  if (!job || job.status === "DONE") return undefined;
  return Date.parse(job.updatedAt) + opts.graceMs;
}
