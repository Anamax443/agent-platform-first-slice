// R2R3 integration (Reliability Gate, owner's explicit merge spec, 2026-09-18): R2 (automatic recovery wake-up,
// branch r2-automatic-recovery @ 1162773) and R3 (durable fan-out outbox, branch r3-durable-outbox-fanout @
// 7ea5d6e) independently modified the SAME two methods on index.ts's WorkflowInstance — `alarm()` and (then still
// named) `rearmReviewAlarm()` — for different, both-legitimate reasons. This file is the ONE thing that had to be
// designed fresh to combine them: a single, central alarm scheduler, rather than three independent mechanisms
// fighting over the Durable Object's one setAlarm() slot. It is deliberately its own file, not private
// WorkflowInstance methods, for the same reason fanout-retry.ts (R3) and orchestrator.ts's isRunningStepStale/
// maxStepDeadlineMs (R2) already are: index.ts imports "cloudflare:workers" and cannot be loaded under plain-Node
// vitest, and the owner's own spec for this integration explicitly asked for COMBINATION tests proving the
// scheduler's cross-subsystem behaviour, not just more isolated-function tests — only reachable if the decision
// logic itself is a pure function a test can call directly (tests/gw-alarm-scheduler.test.ts).
//
// Two genuinely separate concerns live here, both pure, both used by index.ts's rearmAlarm()/alarm():
//   - nextAlarmWakeMs(): the owner's own spec, verbatim — "nextWake = min(nearestReviewDeadline,
//     nearestStuckStepDeadline, nearestFanoutRetryAt)". The one central authority for what a Durable Object's
//     single pending alarm should be armed to next (a DO holds exactly one; setAlarm() always replaces it —
//     confirmed against the durable-objects skill, already cited this way in R2's own rearmReviewAlarm() rename).
//   - runAlarmTick(): the owner's own spec for `alarm()`'s body, verbatim — NOT one shared try/catch around
//     recover();fanout();reviews();, but each subsystem isolated in its own try, its own failure recorded, so
//     that "one subsystem's failure must never prevent another from getting its own chance this same tick" is a
//     structural property of this function, not a convention index.ts has to keep re-proving by hand.
import type { FanoutJobRecord } from "./fanout-retry.js";
import { fanoutNextWakeAt } from "./fanout-retry.js";
import { jobNextWakeAt, type JobStaleness } from "../../../../src/platform/durable-job.js";
import { withTimeout } from "../../../../src/platform/api.js";

export interface AlarmSchedulerState {
  /** Every currently-OPEN review task's own `expiresAt`, already `Date.parse()`d — WF-REV-003's pre-existing
   * source, unchanged by this integration. */
  openReviewDeadlinesMs: readonly number[];
  /** The current RUNNING step's own deadline (its durable `notValidAfter`, or the pessimistic pre-arm override
   * given before dispatch has written that field yet — see index.ts's rearmAlarm()) — undefined when nothing in
   * this instance is RUNNING right now. R2's contribution. */
  stuckStepDeadlineMs?: number;
  /** This instance's own durable fanout_job row, if one exists — R3's contribution. Passed through unchanged to
   * fanoutNextWakeAt() (fanout-retry.ts) rather than re-deriving its own wake-time logic here a second time. */
  fanoutJob?: FanoutJobRecord;
  /** This instance's own durable copyout-job row (RG2-A, 2026-09-18, kind "copyout" — store.ts's `durable_job`
   * table), if one exists. Generalizes the same "keep the alarm armed for outstanding background durability work"
   * idea R3's fanoutJob above already established, via the shared, cap-less jobNextWakeAt() (durable-job.ts):
   * unlike fanoutJob, a PENDING copyout job never expires into "give up", so this field alone is what stops
   * rearmAlarm() from deleting the alarm out from under an instance whose last-ever copyOut() hit a D1 failure
   * (Reliability Gate C5 — see index.ts's copyOut() doc comment for the exact P0 this closes). */
  copyoutJob?: JobStaleness;
}

export interface AlarmSchedulerOpts {
  fanoutGraceMs: number;
  fanoutMaxAttempts: number;
  /** Grace period between alarm-driven retries of a PENDING copyout job (RG2-A) — same backoff-pacing role as
   * fanoutGraceMs above, so an instance stuck on copyOut() failures does not hammer D1/R2 every single tick. */
  copyoutGraceMs: number;
}

/**
 * nextWake = min(nearestReviewDeadline, nearestStuckStepDeadline, nearestFanoutRetryAt, nearestCopyoutRetryAt) —
 * the owner's own spec, 2026-09-18, verbatim, plus RG2-A's copyoutJob term folded in the same way fanoutJob
 * already was (same day, later finding). Returns undefined when none of the four sources has anything pending at
 * all, which is the caller's own cue to delete rather than arm the alarm (index.ts's rearmAlarm()).
 *
 * The critical property this integration depends on — proven by construction, not by any hidden state in this
 * function — is that it is PURE and holds no memory of a previous call: index.ts's rearmAlarm() must call this
 * with freshly-read `state` at the point it is called (never a value captured earlier in the same alarm() tick),
 * or a deadline that only became true partway through a tick (recovery creating a fresh WAITING(REVIEW) task, a
 * fan-out retry that just ran and moved its own row's `updatedAt` forward) would not be reflected in the alarm
 * armed at the end of that same tick. See tests/gw-alarm-scheduler.test.ts's "race scenario" describe block for
 * the four scenarios the owner named explicitly, demonstrated against this exact function plus fanOutAttachments's
 * own already-tested fanoutRetryDecision()/fanoutNextWakeAt().
 */
export function nextAlarmWakeMs(state: AlarmSchedulerState, opts: AlarmSchedulerOpts): number | undefined {
  const candidates: number[] = [...state.openReviewDeadlinesMs];
  if (state.stuckStepDeadlineMs !== undefined) candidates.push(state.stuckStepDeadlineMs);
  const fanoutWakeAt = fanoutNextWakeAt(state.fanoutJob, { graceMs: opts.fanoutGraceMs, maxAttempts: opts.fanoutMaxAttempts });
  if (fanoutWakeAt !== undefined) candidates.push(fanoutWakeAt);
  const copyoutWakeAt = jobNextWakeAt(state.copyoutJob, { graceMs: opts.copyoutGraceMs });
  if (copyoutWakeAt !== undefined) candidates.push(copyoutWakeAt);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

export type AlarmSubsystem = "recovery" | "fanout" | "reviews";

export interface AlarmTickOpts {
  /**
   * Follow-up fix (adversarial review, 18.9.2026 — see index.ts's ALARM_SUBSYSTEM_BUDGET_MS doc comment for the
   * full "why"): upper bound, in ms, on how long `recover()` and `retryFanout()` below may each run before
   * runAlarmTick() gives up waiting and treats them the same as a thrown failure. Neither cascade
   * (orchestrator.ts's `run()` loop; `fanOutAttachmentsIfAny()`'s per-attachment loop, both real
   * `transport.dispatch()` calls) has a time budget of its own — without this, a hang in either could starve
   * `applyReviewExpiries()` (and the caller's own `finally { rearmAlarm() }`) of a turn in the SAME tick, for as
   * long as the cascade kept running, up to and including the isolate's own CPU/wall-clock limit. Deliberately
   * NOT applied to `applyReviewExpiries()`: that step is synchronous, local SQLite work with no dispatch()
   * cascade of its own (WF-REV-003's `review.expire()` + journal writes), so it cannot hang the way the other two
   * can, and bounding it would add risk (of interrupting a real transition mid-way) for no benefit.
   *
   * Optional and undefined by default so existing callers/tests that only care about the throw-isolation contract
   * (not the hang case) are unaffected — index.ts's alarm() is the one real caller that supplies it.
   */
  subsystemBudgetMs?: number;
}

/** Race `work` against `budgetMs` when given; otherwise just await it — the shared bound behind both `recover`
 * and `retryFanout` in runAlarmTick() below, so the "apply a budget, or don't" decision lives in exactly one
 * place. `Promise.resolve(...)` normalizes a subsystem callback's `Promise<void> | void` return into a real
 * promise before withTimeout() (src/platform/api.ts) races it — a callback that returns synchronously (the
 * common case in this file's own tests) is therefore never delayed by this wrapper, only a genuinely slow one is
 * ever at risk of timing out. */
async function bounded(work: Promise<void> | void, budgetMs: number | undefined): Promise<void> {
  const promise = Promise.resolve(work);
  return budgetMs === undefined ? promise : withTimeout(promise, budgetMs);
}

export interface AlarmTickSubsystems {
  /** Step 1: recover stuck workflow state (R2). */
  recover: () => Promise<void> | void;
  /** Step 2: process a due durable fan-out job (R3). */
  retryFanout: () => Promise<void> | void;
  /** Step 3: process review/deadline transitions (the existing, live WF-REV-003 path). */
  applyReviewExpiries: () => Promise<void> | void;
  /** Called once per subsystem that threw/rejected, never rethrown — index.ts's alarm() uses this to write its
   * own `kind: "reconciliation"` audit record naming which subsystem failed, the same discipline R2's own
   * pre-integration recover() catch already held. */
  onFailure: (subsystem: AlarmSubsystem, err: unknown) => void;
}

/**
 * The owner's own spec for `alarm()`'s body, verbatim (2026-09-18):
 *
 *   Ne (not this — one shared try/catch around everything):
 *     recover(); fanout(); reviews();
 *   Spíš (instead, each its own):
 *     try recovery / record failure
 *     try fanout / record failure
 *     try reviews / record failure
 *     finally rearmAlarm()
 *
 * This function is exactly that shape for the three subsystem steps, extracted out of index.ts so the ISOLATION
 * contract itself — "a recovery failure must not prevent fan-out from being attempted in the same tick", "a
 * fan-out failure must not disturb anything recovery already did", "every subsystem gets its own boundary, not
 * just the ones that already happen to have one internally" — is something a plain-Node test can prove directly
 * (tests/gw-alarm-scheduler.test.ts), not just something claimed in a doc comment next to code that cannot be
 * loaded under vitest. index.ts's alarm() calls this with its three real subsystem calls, then persists/audits
 * (ctx.waitUntil(copyOut())) and calls the renamed rearmAlarm() in its own `finally`, exactly as the order above
 * requires — this function's own contract is only "never throw", so wrapping its call in try/finally in index.ts
 * is a belt worn over an already-fastened one, not load-bearing on its own.
 *
 * `opts.subsystemBudgetMs`, when given, additionally guarantees `recover()`/`retryFanout()` each YIELD their turn
 * within that budget even if they never settle at all (a hang, not just a throw) -- see AlarmTickOpts's own doc
 * comment above for the full "why". This is what makes this function's "never throw" contract also cover "never
 * hang past a bound", the property index.ts's alarm() actually needs for its own `finally { rearmAlarm() }` to
 * be a real guarantee rather than one that only holds when nothing happens to be slow.
 */
export async function runAlarmTick(subsystems: AlarmTickSubsystems, opts: AlarmTickOpts = {}): Promise<void> {
  try {
    await bounded(subsystems.recover(), opts.subsystemBudgetMs);
  } catch (err) {
    subsystems.onFailure("recovery", err);
  }
  try {
    await bounded(subsystems.retryFanout(), opts.subsystemBudgetMs);
  } catch (err) {
    subsystems.onFailure("fanout", err);
  }
  try {
    await subsystems.applyReviewExpiries();
  } catch (err) {
    subsystems.onFailure("reviews", err);
  }
}

/**
 * RG2-B (Reliability Gate, 2026-09-18): closes a narrower, adjacent gap in this SAME alarm/rearm machinery, one
 * level up from runAlarmTick() above. index.ts's real alarm() body used to be:
 *
 *   const inst = this.journal.list()[0];
 *   if (!inst) return;                                          // BUG 1
 *   const wiring = this.wiring();                                // BUG 2 (can throw: bad/missing signing key)
 *   const orchestrator = this.orchestratorFor(workflowDef(inst.workflow), wiring); // BUG 2b
 *   try { await runAlarmTick(...); } finally { ctx.waitUntil(copyOut()); await rearmAlarm(); }
 *
 * BUG 1: the early `if (!inst) return` exits before the try/finally entirely. RG2-A already gave the journal-less
 * self-test Durable Object (SELF_TEST_WORKFLOW_ID) its own durable copyout job (copyOut()'s own
 * `workflowId = inst?.workflowId ?? SELF_TEST_WORKFLOW_ID` fallback) — but if THAT instance's alarm ever fires
 * (e.g. because copyOut()'s own rearmAlarm() call armed one for a still-PENDING job), this early return meant the
 * alarm fired, did nothing, and — Durable Object alarms are consumed once fired and are not rescheduled unless
 * setAlarm() is called again — the instance silently lost its own only remaining wake-up. The exact same class of
 * bug RG2-A's own adversarial review already found and fixed INSIDE copyOut() itself (an early `if (!inst) return`
 * there used to skip its ordering-safe path for this same journal-less instance).
 *
 * BUG 2/2b: `wiring()`/`orchestratorFor()`/`workflowDef()` ran BEFORE the try block. A thrown signing-key/config
 * error there skipped the `finally` entirely, so `rearmAlarm()` never ran — a Case would silently stop getting
 * woken up until something unrelated happened to call rearmAlarm() again.
 *
 * The invariant this function exists to hold, and the ONLY thing it changes relative to the code above — a throw
 * anywhere in bootstrap-or-tick must never skip the final `copyOut(); rearm();` step:
 *
 *   try   { const s = buildTick(); if (s) await runAlarmTick(s, tickOpts); }   // bootstrap + tick, one boundary
 *   catch { onBootstrapFailure(err); }                                        // never rethrown
 *   finally {
 *     try   { await copyOut(); }
 *     catch { onCopyOutFailure(err); }                                        // never rethrown
 *     finally { await rearm(); }                                              // unconditional, always last
 *   }
 *
 * `buildTick()` returning `undefined` (no journal instance — the journal-less self-test object) simply skips
 * runAlarmTick() for this tick; it does NOT skip copyOut()/rearm() below, which is the actual fix for BUG 1 above.
 * A throw from `buildTick()` itself (BUG 2/2b) is caught by the SAME `catch` runAlarmTick()'s own failures would
 * hit if it ever somehow threw despite its "never throw" contract (belt over an already-fastened one) — either way
 * `onBootstrapFailure` fires and copyOut()/rearm() still run, fixing BUG 2/2b.
 *
 * `rearm()` itself is deliberately NOT try/caught here: if it throws, this function's own returned promise rejects
 * rather than swallowing the failure — there is nothing left downstream to durably record it to at that point
 * (copyOut() has already been attempted, one way or the other, by the time rearm() runs). This mirrors
 * runAlarmTick()'s own "never throw" contract being a promise about ITS three subsystems specifically, not a
 * blanket guarantee that literally nothing in this file can ever reject.
 *
 * Deliberate, small behavior change from the pre-RG2-B code (index.ts's alarm() is the only call site this
 * affects): alarm()'s own copyOut() call used to go through `this.ctx.waitUntil(this.copyOut())` — fire-and-forget
 * — immediately followed by `await this.rearmAlarm()`, so alarm()'s own rearm could run BEFORE its own copyOut()
 * actually finished. index.ts now supplies `copyOut: () => this.copyOut()` here, which this function `await`s
 * directly, so alarm()'s own final rearm() reflects copyOut()'s truly-finished state. Safe specifically because
 * alarm() is a background handler with no HTTP response to protect — unlike intake()/mailIntake()/decideReview(),
 * which genuinely need to return a response without waiting for copyOut() and so keep their own
 * `ctx.waitUntil(this.copyOut())` + own `rearmAlarm()` call sites completely unchanged (copyOut()'s own trailing
 * `await this.rearmAlarm()`, added by RG2-A, stays load-bearing for THOSE call sites, where copyOut() may finish
 * well after the request that triggered it already returned). In the alarm()-triggered case specifically, this
 * makes copyOut()'s own internal rearm() call and this function's `rearm()` call a harmless, idempotent double-call
 * back to back — rearmAlarm() is cheap and always recomputes from fresh durable state by design (see its own doc
 * comment), so calling it twice in a row here is safe, not a bug to fix.
 */
export interface AlarmCycleDeps {
  /** Build this tick's subsystems (wiring, orchestrator, the three AlarmTickSubsystems callbacks). Returns
   * `undefined` when there is no journal instance to run a tick for (the journal-less self-test object) —
   * runAlarmTick() is then simply skipped, but copyOut()/rearm() below still always run. May THROW (a bad signing
   * key, a workflowDef() lookup failure, etc.) — that throw must not prevent copyOut()/rearm() from still
   * running. */
  buildTick: () => AlarmTickSubsystems | undefined;
  tickOpts: AlarmTickOpts;
  /** Called once if buildTick() itself throws, or (belt over an already-fastened one) if runAlarmTick() itself
   * somehow throws despite its own per-subsystem isolation — never rethrown. */
  onBootstrapFailure: (err: unknown) => void;
  copyOut: () => Promise<void>;
  /** Called if copyOut() throws — never rethrown. copyOut() already keeps its own durable job PENDING on failure
   * (RG2-A); this exists purely so an unexpected rejection here can never skip rearm() below. */
  onCopyOutFailure: (err: unknown) => void;
  rearm: () => Promise<void>;
}

export async function runAlarmCycle(deps: AlarmCycleDeps): Promise<void> {
  try {
    const subsystems = deps.buildTick();
    if (subsystems) await runAlarmTick(subsystems, deps.tickOpts);
  } catch (err) {
    deps.onBootstrapFailure(err);
  } finally {
    try {
      await deps.copyOut();
    } catch (err) {
      deps.onCopyOutFailure(err);
    } finally {
      await deps.rearm();
    }
  }
}
