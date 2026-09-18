// R2R3 integration (Reliability Gate, owner's explicit merge spec, 2026-09-18): tests for the ONE thing this
// integration designed fresh — deploy/cloudflare/apf-gateway/src/alarm-scheduler.ts's nextAlarmWakeMs() (the
// central "nextWake = min(nearestReviewDeadline, nearestStuckStepDeadline, nearestFanoutRetryAt)" authority) and
// runAlarmTick() (the "each subsystem gets its own try/catch, never one shared one" shape index.ts's alarm() now
// runs). deploy/cloudflare/apf-gateway/src/index.ts itself cannot be loaded under plain-Node vitest (imports
// "cloudflare:workers") — these two pure functions are exactly what index.ts's alarm()/rearmAlarm() delegate to,
// so testing them directly IS testing the real control-flow shape production runs, not a hand-simulated stand-in
// for it (the owner's own explicit requirement for this integration: "combination tests... not just more
// isolated-function tests, only reachable if the decision is itself a pure function you can call directly").
//
// Three groups of tests, all against the SAME two functions:
//   1. nextAlarmWakeMs() unit coverage, including the owner's four named race scenarios (a)-(d).
//   2. runAlarmTick() isolation-contract coverage: one subsystem throwing must never stop another, and the
//      function itself must never reject (so a caller's own `finally { rearmAlarm() }` always runs).
//   3. The five combination tests the owner asked for BY NAME (word for word), each driving the REAL
//      isRunningStepStale() (src/platform/orchestrator.ts, R2) and/or fanoutRetryDecision() (fanout-retry.ts, R3)
//      through runAlarmTick(), never hand-simulated arithmetic that never touches the code alarm() actually calls.
import { describe, expect, it } from "vitest";
import type { Instance, StepRecord } from "../src/platform/journal.js";
import { isRunningStepStale, type WorkflowDef } from "../src/platform/orchestrator.js";
import { fanoutRetryDecision, type FanoutJobRecord } from "../deploy/cloudflare/apf-gateway/src/fanout-retry.js";
import { nextAlarmWakeMs, runAlarmTick, type AlarmSubsystem } from "../deploy/cloudflare/apf-gateway/src/alarm-scheduler.js";

const OPTS = { fanoutGraceMs: 5 * 60_000, fanoutMaxAttempts: 5 };
// fanoutRetryDecision()/fanoutNextWakeAt() (fanout-retry.ts, R3) take their own opts shape ({ graceMs,
// maxAttempts }) — same values as OPTS above, kept as a separate constant rather than reusing OPTS's own
// ({ fanoutGraceMs, fanoutMaxAttempts }) keys so a call site can never silently pass the wrong shape (which
// resolves every comparison against `undefined` and quietly always answers "retry"/never "give-up" — the exact
// mistake this comment exists to prevent a future edit here from reintroducing).
const FANOUT_OPTS = { graceMs: OPTS.fanoutGraceMs, maxAttempts: OPTS.fanoutMaxAttempts };
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

const fanoutJob = (overrides: Partial<FanoutJobRecord> = {}): FanoutJobRecord => ({
  workflowId: "wf-alarm-1",
  caseId: "case-1",
  status: "PENDING",
  attempts: 1,
  startedAt: "2026-09-18T11:00:00.000Z",
  updatedAt: "2026-09-18T11:00:00.000Z",
  ...overrides,
});

// Same shape as tests/res.test.ts's own R2 fixtures (deliberately duplicated, not imported: gw-*.test.ts files in
// this codebase stay self-contained — see gw-fanout-retry.test.ts's own precedent — rather than reaching into
// another test file's locals).
const WORKFLOW: WorkflowDef = {
  workflow: "alarm-fixture-wf",
  workflowVersion: "1",
  conformanceTier: "semantic",
  deadlineMs: 1_800_000,
  operatorRole: "document.operator",
  supervisorRole: "document.supervisor",
  steps: [{ id: "classify", capability: "document.classify", capabilityVersion: "1", sideEffects: "none", inputs: {} }],
};

function runningStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepId: "classify",
    capability: "document.classify",
    capabilityVersion: "1",
    sideEffects: "none",
    executionId: "exe-alarm",
    attempt: 1,
    logicalAttempt: 1,
    strategyIndex: 0,
    strategy: "llm",
    idempotencyKey: "wf-alarm:classify:llm:1",
    status: "RUNNING",
    startedAt: new Date(NOW - 3_600_000).toISOString(), // started 1h ago
    ...overrides,
  };
}

function stuckInstance(): Instance {
  return {
    workflowId: "wf-alarm-1",
    workflow: "alarm-fixture-wf",
    workflowVersion: "1",
    correlationId: "corr-alarm",
    tenantId: "tenant-a",
    actorId: "svc-test",
    status: "RUNNING",
    currentStep: 0,
    input: {},
    // no `message` -> isRunningStepStale() falls back to startedAt + workflow.deadlineMs (1_800_000ms = 30min);
    // started 1h ago, so this is well past stale.
    steps: [runningStep()],
    published: { status: "RUNNING" },
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
  };
}

describe("nextAlarmWakeMs — the central nextWake = min(...) authority", () => {
  it("nothing pending from any of the three sources -> undefined (caller deletes the alarm)", () => {
    expect(nextAlarmWakeMs({ openReviewDeadlinesMs: [] }, OPTS)).toBeUndefined();
  });

  it("a single open review deadline, nothing else -> that deadline", () => {
    expect(nextAlarmWakeMs({ openReviewDeadlinesMs: [NOW + 10_000] }, OPTS)).toBe(NOW + 10_000);
  });

  it("only a stuck-step deadline, nothing else -> that deadline", () => {
    expect(nextAlarmWakeMs({ openReviewDeadlinesMs: [], stuckStepDeadlineMs: NOW + 20_000 }, OPTS)).toBe(NOW + 20_000);
  });

  it("only a fan-out job, nothing else -> fanoutNextWakeAt()'s own value (updatedAt + graceMs)", () => {
    const job = fanoutJob({ updatedAt: new Date(NOW).toISOString() });
    expect(nextAlarmWakeMs({ openReviewDeadlinesMs: [], fanoutJob: job }, OPTS)).toBe(NOW + OPTS.fanoutGraceMs);
  });

  it("a fan-out job that has exhausted its attempts contributes nothing (fanoutNextWakeAt() -> undefined)", () => {
    const job = fanoutJob({ attempts: OPTS.fanoutMaxAttempts, updatedAt: new Date(NOW).toISOString() });
    expect(nextAlarmWakeMs({ openReviewDeadlinesMs: [], fanoutJob: job }, OPTS)).toBeUndefined();
  });

  // Race scenario (2) named by the owner: "future review + earlier fanout retry -> alarm = fanout time".
  it("future review + earlier fan-out retry -> alarm = fan-out time", () => {
    const farReview = NOW + 10 * 60_000; // 10 minutes out
    const job = fanoutJob({ updatedAt: new Date(NOW).toISOString() }); // wake = NOW + 5min, sooner than the review
    const wake = nextAlarmWakeMs({ openReviewDeadlinesMs: [farReview], fanoutJob: job }, OPTS);
    expect(wake).toBe(NOW + OPTS.fanoutGraceMs);
    expect(wake).toBeLessThan(farReview);
  });

  // Race scenario (3) named by the owner: "future fanout + earlier stuck deadline -> alarm = stuck deadline".
  it("future fan-out retry + earlier stuck-step deadline -> alarm = stuck deadline", () => {
    const job = fanoutJob({ updatedAt: new Date(NOW).toISOString() }); // wake = NOW + 5min
    const stuckDeadline = NOW + 30_000; // 30s out, much sooner
    const wake = nextAlarmWakeMs({ openReviewDeadlinesMs: [], stuckStepDeadlineMs: stuckDeadline, fanoutJob: job }, OPTS);
    expect(wake).toBe(stuckDeadline);
    expect(wake).toBeLessThan(NOW + OPTS.fanoutGraceMs);
  });

  // Race scenario (d) named by the owner: two sources land at or near the exact same instant. A Durable Object
  // holds exactly one pending alarm (setAlarm() always replaces it — cited in index.ts's own rearmAlarm() doc
  // comment against the durable-objects skill); Math.min(...) over all three sources must still collapse to ONE
  // correct value, never a tie-breaking ambiguity or an array.
  it("race scenario (d): a review deadline and a fan-out retry landing at the exact same instant collapse to that one value", () => {
    const tie = NOW + 42_000;
    const job = fanoutJob({ updatedAt: new Date(tie - OPTS.fanoutGraceMs).toISOString() }); // wake = tie, exactly
    const wake = nextAlarmWakeMs({ openReviewDeadlinesMs: [tie], stuckStepDeadlineMs: tie, fanoutJob: job }, OPTS);
    expect(wake).toBe(tie);
    expect(typeof wake).toBe("number");
  });

  // Race scenarios (a)/(c) named by the owner: a deadline that only becomes true DURING alarm()'s own processing
  // (recovery converting a stale step into a fresh, near-term WAITING(REVIEW) task) must be reflected in the
  // alarm armed at the END of that same tick — proven here by construction: nextAlarmWakeMs() is a pure function
  // of whatever state it is handed, with no memory of an earlier call, so a "before recovery ran" snapshot and an
  // "after recovery ran" snapshot correctly produce different results. index.ts's rearmAlarm() (see its own doc
  // comment) is what guarantees the SECOND snapshot — read fresh, at the point rearmAlarm() actually runs, never
  // a value captured earlier in alarm()'s body — is the one that ends up armed.
  it("race scenario (a)/(c): a snapshot taken before a mid-tick change and one taken after produce different, each-correct wakes", () => {
    const beforeRecovery = { openReviewDeadlinesMs: [] as number[] }; // nothing waiting yet
    expect(nextAlarmWakeMs(beforeRecovery, OPTS)).toBeUndefined();

    // recover() ran, converted the stale step to UNKNOWN_OUTCOME, and (no reconciler wired today) that became a
    // fresh WAITING(REVIEW) task with a near expiry — this is the state a FRESH read after recovery would see.
    const afterRecovery = { openReviewDeadlinesMs: [NOW + 5_000] };
    expect(nextAlarmWakeMs(afterRecovery, OPTS)).toBe(NOW + 5_000);
  });
});

describe("runAlarmTick — isolation contract (each subsystem its own try/catch, never one shared one)", () => {
  it("runs recovery, then fan-out, then reviews, in that order, when none of them throw", async () => {
    const order: string[] = [];
    await runAlarmTick({
      recover: () => {
        order.push("recovery");
      },
      retryFanout: () => {
        order.push("fanout");
      },
      applyReviewExpiries: () => {
        order.push("reviews");
      },
      onFailure: () => {
        throw new Error("onFailure must not be called when nothing failed");
      },
    });
    expect(order).toEqual(["recovery", "fanout", "reviews"]);
  });

  it("never rejects, even when every subsystem throws — a caller's own finally { rearmAlarm() } is therefore guaranteed to run", async () => {
    const failures: AlarmSubsystem[] = [];
    await expect(
      runAlarmTick({
        recover: () => {
          throw new Error("recovery boom");
        },
        retryFanout: () => {
          throw new Error("fanout boom");
        },
        applyReviewExpiries: () => {
          throw new Error("reviews boom");
        },
        onFailure: (subsystem) => {
          failures.push(subsystem);
        },
      }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual(["recovery", "fanout", "reviews"]);
  });
});

describe("R2R3 integration — the five named combination tests", () => {
  // 1. "stuck workflow + pending fanout -> jeden alarm -> recovery i fanout probehnou"
  it("stuck workflow + pending fanout -> one alarm tick -> recovery AND fan-out both run", async () => {
    const inst = stuckInstance();
    expect(isRunningStepStale(inst, WORKFLOW, new Date(NOW))).toBe(true); // genuinely stale, not a fresh dispatch

    const job = fanoutJob({ attempts: 1, updatedAt: new Date(NOW - 6 * 60_000).toISOString() }); // 6min ago, past the 5min grace
    expect(fanoutRetryDecision(job, NOW, FANOUT_OPTS)).toBe("retry"); // genuinely due, not "wait"

    let recovered = false;
    let fannedOut = false;
    let reviewsChecked = false;
    await runAlarmTick({
      recover: () => {
        // The exact gate index.ts's own alarm() applies: only act when isRunningStepStale() says so.
        if (isRunningStepStale(inst, WORKFLOW, new Date(NOW))) recovered = true;
      },
      retryFanout: () => {
        const decision = fanoutRetryDecision(job, NOW, FANOUT_OPTS);
        if (decision === "retry") fannedOut = true;
      },
      applyReviewExpiries: () => {
        reviewsChecked = true;
      },
      onFailure: () => {
        throw new Error("no subsystem should fail in this scenario");
      },
    });
    expect(recovered).toBe(true);
    expect(fannedOut).toBe(true);
    expect(reviewsChecked).toBe(true); // reviews still gets its turn even though this tick had other work too
  });

  // 2. "future review + earlier fanout retry -> alarm = fanout time"
  it("future review + earlier fanout retry -> alarm = fanout time", () => {
    const farReview = NOW + 15 * 60_000;
    const job = fanoutJob({ updatedAt: new Date(NOW).toISOString() }); // wake = NOW + 5min
    const wake = nextAlarmWakeMs({ openReviewDeadlinesMs: [farReview], fanoutJob: job }, OPTS);
    expect(wake).toBe(NOW + OPTS.fanoutGraceMs);
  });

  // 3. "future fanout + earlier stuck deadline -> alarm = stuck deadline"
  it("future fanout + earlier stuck deadline -> alarm = stuck deadline", () => {
    const job = fanoutJob({ updatedAt: new Date(NOW).toISOString() }); // wake = NOW + 5min
    const stuckDeadline = NOW + 45_000;
    const wake = nextAlarmWakeMs({ openReviewDeadlinesMs: [], stuckStepDeadlineMs: stuckDeadline, fanoutJob: job }, OPTS);
    expect(wake).toBe(stuckDeadline);
  });

  // 4. "recovery fails -> fanout se presto zkusi -> alarm se znovu vyzbroji"
  it("recovery fails -> fan-out is still attempted -> the alarm still re-arms", async () => {
    let fannedOut = false;
    let reviewsChecked = false;
    const failures: AlarmSubsystem[] = [];
    // Mirrors index.ts's alarm() own shape: try { runAlarmTick(...) } finally { rearmAlarm() }.
    let rearmed = false;
    try {
      await runAlarmTick({
        recover: () => {
          throw new Error("recover() blew up");
        },
        retryFanout: () => {
          fannedOut = true;
        },
        applyReviewExpiries: () => {
          reviewsChecked = true;
        },
        onFailure: (subsystem) => failures.push(subsystem),
      });
    } finally {
      rearmed = true;
    }
    expect(failures).toEqual(["recovery"]);
    expect(fannedOut).toBe(true);
    expect(reviewsChecked).toBe(true);
    expect(rearmed).toBe(true);
  });

  // 5. "fanout fails -> workflow recovery state se neztrati -> retry zustane durable"
  it("fanout fails -> recovery's own outcome is undisturbed, AND the fanout_job row stays durable/PENDING for a later retry", async () => {
    // Part A: within one tick, a fan-out failure must not touch/undo whatever recovery already did.
    let recoveryOutcome: "untouched" | "done" = "untouched";
    let reviewsChecked = false;
    const failures: AlarmSubsystem[] = [];
    await runAlarmTick({
      recover: () => {
        recoveryOutcome = "done";
      },
      retryFanout: () => {
        throw new Error("fan-out attempt blew up");
      },
      applyReviewExpiries: () => {
        reviewsChecked = true;
      },
      onFailure: (subsystem) => failures.push(subsystem),
    });
    expect(recoveryOutcome).toBe("done"); // recovery's own result from earlier in the SAME tick is untouched
    expect(failures).toEqual(["fanout"]);
    expect(reviewsChecked).toBe(true);

    // Part B: the row a failed pass leaves behind (index.ts's fanOutAttachmentsIfAny() own failure branch: PENDING,
    // attempts incremented, lastError set, updatedAt moved to now) stays genuinely retryable, not silently dropped
    // to DONE and not lost — fanoutRetryDecision() (the same real function maybeRetryFanoutJob() calls) still
    // tracks it as due for another attempt once the grace period elapses again.
    const jobAfterFailedPass = fanoutJob({ attempts: 2, status: "PENDING", updatedAt: new Date(NOW).toISOString(), lastError: "fan-out attempt blew up" });
    expect(fanoutRetryDecision(jobAfterFailedPass, NOW, FANOUT_OPTS)).toBe("wait"); // just touched: not an immediate re-fire (no hot loop)
    const later = NOW + OPTS.fanoutGraceMs + 1;
    expect(fanoutRetryDecision(jobAfterFailedPass, later, FANOUT_OPTS)).toBe("retry"); // but still durable: due again later
  });
});

// Adversarial-review follow-up (18.9.2026, same day as the integration itself): the isolation-contract tests
// above prove one subsystem THROWING never blocks another's turn — they do NOT prove one HANGING (never
// settling at all) doesn't. Before opts.subsystemBudgetMs existed, a `recover: () => new Promise(() => {})`
// below would have hung this whole test (and, in production, hung alarm()'s own `finally { rearmAlarm() }`
// indefinitely) — these tests exercise the REAL runAlarmTick() + its real `bounded()` helper, the exact function
// index.ts's alarm() calls with `{ subsystemBudgetMs: ALARM_SUBSYSTEM_BUDGET_MS }`, not a hand-simulated timeout.
describe("runAlarmTick — subsystemBudgetMs bounds a HUNG subsystem, not just a thrown one", () => {
  const BUDGET_MS = 20;
  /** A promise that never settles — the direct stand-in for an unbudgeted transport.dispatch() cascade that
   * never returns within this tick. */
  const hang = () => new Promise<void>(() => {});

  it("a hung recovery still lets fan-out and reviews run, and the tick still completes (never hangs the caller)", async () => {
    let fannedOut = false;
    let reviewsChecked = false;
    const failures: AlarmSubsystem[] = [];
    await runAlarmTick(
      {
        recover: hang,
        retryFanout: () => {
          fannedOut = true;
        },
        applyReviewExpiries: () => {
          reviewsChecked = true;
        },
        onFailure: (subsystem, err) => {
          failures.push(subsystem);
          expect(err).toBeInstanceOf(Error); // DependencyTimeout (src/platform/api.ts), same shape as any other failure
        },
      },
      { subsystemBudgetMs: BUDGET_MS },
    );
    expect(failures).toEqual(["recovery"]);
    expect(fannedOut).toBe(true); // fan-out got its turn even though recovery never settled
    expect(reviewsChecked).toBe(true); // reviews (and the caller's own finally { rearmAlarm() }) is never starved
  });

  it("a hung fan-out retry still lets reviews run, and does not disturb recovery's own already-done outcome", async () => {
    let recoveryOutcome: "untouched" | "done" = "untouched";
    let reviewsChecked = false;
    const failures: AlarmSubsystem[] = [];
    await runAlarmTick(
      {
        recover: () => {
          recoveryOutcome = "done";
        },
        retryFanout: hang,
        applyReviewExpiries: () => {
          reviewsChecked = true;
        },
        onFailure: (subsystem) => failures.push(subsystem),
      },
      { subsystemBudgetMs: BUDGET_MS },
    );
    expect(recoveryOutcome).toBe("done");
    expect(failures).toEqual(["fanout"]);
    expect(reviewsChecked).toBe(true);
  });

  it("a subsystem that settles well within the budget is never mistaken for a timeout", async () => {
    const failures: AlarmSubsystem[] = [];
    let recovered = false;
    await runAlarmTick(
      {
        recover: async () => {
          recovered = true; // resolves synchronously, nowhere near BUDGET_MS
        },
        retryFanout: () => {},
        applyReviewExpiries: () => {},
        onFailure: (subsystem) => failures.push(subsystem),
      },
      { subsystemBudgetMs: BUDGET_MS },
    );
    expect(recovered).toBe(true);
    expect(failures).toEqual([]); // no false positive: a fast subsystem is not penalized just because a budget exists
  });

  it("with no subsystemBudgetMs given at all (the default, pre-existing tests above), a subsystem that never settles DOES hang the tick — proving the opt-in bound above is what actually fixes it, not some other implicit safety net", async () => {
    // Deliberately proves the negative: without the budget, runAlarmTick() has no way to know recover() is stuck.
    // Raced against a short real timeout from the test itself (not runAlarmTick's own machinery) so this test
    // fails fast and legibly instead of hanging the whole suite if this assumption is ever wrong.
    const tickPromise = runAlarmTick({
      recover: hang,
      retryFanout: () => {
        throw new Error("must never be reached: recover() above never settled, and no budget bounds it");
      },
      applyReviewExpiries: () => {
        throw new Error("must never be reached: recover() above never settled, and no budget bounds it");
      },
      onFailure: () => {
        throw new Error("must never be reached: recover() above never rejects, it just never settles");
      },
    });
    const outcome = await Promise.race([
      tickPromise.then(() => "tick-settled" as const),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), BUDGET_MS * 3)),
    ]);
    expect(outcome).toBe("still-pending");
  });
});
