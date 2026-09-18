// RG2-E (Reliability Gate 2, last item, 18.9.2026): the pure half of the gateway's three liveness/readiness routes.
// The owner's own definitions, verbatim in spirit:
//   /live           = the process is alive. No I/O. Always 200 while the Worker can answer.
//   /ready          = "can I SAFELY accept a NEW Case right now?" 200 when yes, 503 when no, with named blockers.
//                     Bounded and cheap.
//   /health/details = why I am not ready / what is degraded. Always 200 (a report, not a gate). Honest about what
//                     is NOT observable.
// And the owner's guardrail for this item: "be careful that this does not turn into a giant monitoring project."
//
// Why its own file (same discipline as alarm-scheduler.ts/fanout-retry.ts): index.ts imports "cloudflare:workers"
// at module scope and cannot load under plain-Node vitest, so every DECISION here — what makes a probe a failure,
// how a timeout/throw becomes a result instead of a rejection, what "ready" means, what the details report
// contains — is a pure function tests/gw-readiness.test.ts drives directly. index.ts keeps only the I/O thunks
// (one D1 statement, one R2 head(), one service-binding GET, ...) and passes them in. No "cloudflare:workers"/
// "apf:*" imports here, and only type imports from ./page.js.
//
// The one probe that is NOT here and deliberately never will be: a self-test run. Argos's self-test calls real
// AI models and three other Workers — far too expensive for something a load balancer polls. /health/details
// only READS the last self-test's persisted result (index.ts's `self-test-state` D1 row) and the last watchdog
// reconcile's persisted incidents; it never triggers either.
import { DependencyTimeout, withTimeout } from "../../../../src/platform/api.js";
import type { IncidentRecord, WatchdogLevel } from "./page.js";

export interface ProbeResult {
  name: string;
  ok: boolean;
  /** A failed REQUIRED probe blocks /ready; a non-required one is reported in /health/details only. */
  required: boolean;
  /** Why it failed — the caught error's message, or exactly "timeout" when the probe overran its budget. */
  reason?: string;
  /** Wall-clock the probe took (ms), including a timeout's full budget. */
  ms: number;
  /** The budget the probe ran under — so a "timeout" reason is self-explanatory without reading the source. */
  timeoutMs: number;
}

export interface ProbeSpec {
  name: string;
  required: boolean;
  timeoutMs: number;
  /** The I/O. May throw, may reject, may hang — runProbe() turns every one of those into a ProbeResult. */
  run: () => Promise<unknown> | unknown;
}

export type BoundedRead<T> = { ok: true; value: T; ms: number } | { ok: false; reason: string; ms: number };

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run one thunk under a wall-clock budget and NEVER reject: a throw (sync or async) becomes `{ ok: false,
 * reason: <message> }`, an overrun becomes `{ ok: false, reason: "timeout" }`. withTimeout() (src/platform/api.ts,
 * the same helper every component handler already uses for its dependency calls) races without cancelling the
 * underlying operation — an accepted, already-shipped characteristic of this codebase (see index.ts's
 * ALARM_SUBSYSTEM_BUDGET_MS doc comment); for a probe that is fine, the abandoned I/O is read-only or a tiny
 * idempotent write and nothing waits on it.
 */
export async function boundedRead<T>(thunk: () => Promise<T> | T, timeoutMs: number, now: () => number = Date.now): Promise<BoundedRead<T>> {
  const t0 = now();
  try {
    const value = await withTimeout(Promise.resolve().then(thunk), timeoutMs);
    return { ok: true, value, ms: now() - t0 };
  } catch (e) {
    return { ok: false, reason: e instanceof DependencyTimeout ? "timeout" : errorMessage(e), ms: now() - t0 };
  }
}

/** boundedRead() shaped as a ProbeResult — the value itself is irrelevant, only "did it succeed within budget". */
export async function runProbe(spec: ProbeSpec, now: () => number = Date.now): Promise<ProbeResult> {
  const r = await boundedRead(spec.run, spec.timeoutMs, now);
  return r.ok
    ? { name: spec.name, ok: true, required: spec.required, ms: r.ms, timeoutMs: spec.timeoutMs }
    : { name: spec.name, ok: false, required: spec.required, reason: r.reason, ms: r.ms, timeoutMs: spec.timeoutMs };
}

/** All probes concurrently — /ready's total wall-clock is the slowest single budget, not their sum. */
export async function runProbes(specs: readonly ProbeSpec[], now: () => number = Date.now): Promise<ProbeResult[]> {
  return Promise.all(specs.map((s) => runProbe(s, now)));
}

/** Which of `required` are absent (undefined/null) on `bindings` — a pure presence check, no call on any binding. */
export function missingBindings(bindings: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((name) => bindings[name] === undefined || bindings[name] === null);
}

export const KILL_SWITCH_PROBE = "KILL_SWITCH";

export interface ReadinessReport {
  ready: boolean;
  /** `<probe name>: <reason>` per failed REQUIRED probe (plus KILL_SWITCH when it is on) — empty when ready. */
  blockers: string[];
  checks: ProbeResult[];
  gitSha: string;
  installation: string;
}

/**
 * ready iff every REQUIRED probe passed AND the kill switch is off. The kill switch is folded in as its own
 * synthetic check (name KILL_SWITCH) so a reader of /ready sees it in the same list as everything else: intake
 * already refuses every new Case with `{ ok: false, code: "KILL_SWITCH" }` while it is on (index.ts), so a
 * load balancer must not route new work here either. Non-required checks never affect `ready`, only `checks`.
 */
export function assessReadiness(checks: readonly ProbeResult[], opts: { killSwitch: boolean; gitSha: string; installation: string }): ReadinessReport {
  const all: ProbeResult[] = [
    { name: KILL_SWITCH_PROBE, ok: !opts.killSwitch, required: true, ms: 0, timeoutMs: 0, ...(opts.killSwitch ? { reason: "KILL_SWITCH=true: intake refuses every new Case" } : {}) },
    ...checks,
  ];
  const blockers = all.filter((c) => c.required && !c.ok).map((c) => `${c.name}: ${c.reason ?? "failed"}`);
  return { ready: blockers.length === 0, blockers, checks: all, gitSha: opts.gitSha, installation: opts.installation };
}

/**
 * The known blind spots, stated rather than silently reported as "zero problems". Per-instance state lives in
 * each WorkflowInstance Durable Object's OWN SQLite (store.ts's DDL: journal, idempotency, durable_job,
 * fanout_job) and there is NO directory of instances — index.ts's rearmAlarm() doc comment says it verbatim:
 * "there is no directory of 'every WorkflowInstance currently WAITING(REVIEW)', each one is its own Durable
 * Object". The shared D1 audit trail only ever receives what each object chose to mirror (state transitions,
 * results), never its reservation/job tables. Anything below is therefore observable only from inside the one
 * object it belongs to (its own alarm() tick, or an operator opening its /workflow/<id> page) — not from here.
 */
export const NOT_OBSERVABLE_GLOBALLY: readonly { fact: string; reason: string }[] = [
  { fact: "pending durable_job / fanout_job rows", reason: "per-WorkflowInstance Durable Object SQLite (store.ts durable_job/fanout_job), no instance directory to enumerate" },
  { fact: "stale RESERVED idempotency rows", reason: "per-WorkflowInstance Durable Object SQLite (store.ts idempotency), reachable only by that object's own alarm()/reconcile (RG2-D)" },
  { fact: "oldest RUNNING step", reason: "each object's own journal table; D1 mirrors state transitions per instance but no global 'currently RUNNING' index exists" },
  { fact: "dead / gave-up fan-out jobs", reason: "fanout_job rows moved to DONE with lastError live only in their own object; the audited FAILED record is per instance, not aggregated" },
];

/** Minimal shape of index.ts's SelfTestSummary (the `self-test-state` D1 row) this file needs — kept structural
 * so readiness.ts never imports index.ts. */
export interface SelfTestSummaryLike {
  updatedAt: string;
  fixtures: readonly { ok: boolean; skipped?: string }[];
}

export type LastSelfTest = { at: string; passed: number; failed: number; skipped: number } | { at: null; reason: string };

/** Pass/fail counts over the merged last-known fixture state — skipped fixtures count toward neither, matching
 * index.ts's selfTestAggregates() and the self-test report header. */
export function summarizeSelfTest(read: BoundedRead<SelfTestSummaryLike | undefined>): LastSelfTest {
  if (!read.ok) return { at: null, reason: `self-test-state row unreadable: ${read.reason}` };
  if (!read.value) return { at: null, reason: "self-test never ran on this farm (no self-test-state row)" };
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const f of read.value.fixtures) {
    if (f.skipped) skipped += 1;
    else if (f.ok) passed += 1;
    else failed += 1;
  }
  return { at: read.value.updatedAt, passed, failed, skipped };
}

export type OpenIncident = Pick<IncidentRecord, "key" | "level" | "text" | "firstSeenAt" | "lastSeenAt" | "occurrences"> & { acknowledgedAt?: string };

export type WatchdogSummary =
  | { level: WatchdogLevel; openIncidents: OpenIncident[]; asOf: string | null; source: string }
  | { level: "UNKNOWN"; openIncidents: []; asOf: null; reason: string; source: string };

const WATCHDOG_SOURCE =
  "persisted watchdog-incident rows (D1) written by the last reconcile — every GET /farm render and every self-test cron tick; NOT recomputed here (computeWatchdog() needs the full FarmModel: ~17 D1/service-binding reads plus one Durable Object round trip per recent instance)";

/**
 * Argos's last persisted verdict, cheaply: the same INCIDENT/DEGRADED/HEALTHY rule computeWatchdog() (page.ts)
 * applies to live findings, applied to the still-open incidents reconcileIncidents() persisted from those
 * findings. Zero rows of any kind is honestly UNKNOWN (reconcile never ran), not HEALTHY. `asOf` is the newest
 * timestamp any row carries — the closest thing to "when Argos last looked" the rows can prove.
 */
export function summarizeWatchdog(read: BoundedRead<readonly IncidentRecord[]>): WatchdogSummary {
  if (!read.ok) return { level: "UNKNOWN", openIncidents: [], asOf: null, reason: `watchdog-incident rows unreadable: ${read.reason}`, source: WATCHDOG_SOURCE };
  if (read.value.length === 0) return { level: "UNKNOWN", openIncidents: [], asOf: null, reason: "no watchdog-incident rows yet: Argos's reconcile has never run on this farm", source: WATCHDOG_SOURCE };
  const open = read.value.filter((i) => !i.resolvedAt).map(({ key, level, text, firstSeenAt, lastSeenAt, occurrences, acknowledgedAt }) => ({ key, level, text, firstSeenAt, lastSeenAt, occurrences, ...(acknowledgedAt ? { acknowledgedAt } : {}) }));
  const level: WatchdogLevel = open.some((i) => i.level === "INCIDENT") ? "INCIDENT" : open.length > 0 ? "DEGRADED" : "HEALTHY";
  const asOf = read.value.map((i) => i.resolvedAt ?? i.lastSeenAt).reduce<string | null>((max, at) => (max === null || at > max ? at : max), null);
  return { level, openIncidents: open, asOf, source: WATCHDOG_SOURCE };
}

export interface HealthDetails {
  ready: boolean;
  blockers: string[];
  checks: ProbeResult[];
  watchdog: WatchdogSummary;
  lastSelfTest: LastSelfTest;
  /** Best-effort bounded GET of each bound Worker's own /health — reported, never a readiness blocker (see
   * index.ts's remoteHostProbes() doc comment for why). */
  remoteHosts: ProbeResult[];
  notObservableGlobally: readonly { fact: string; reason: string }[];
  gitSha: string;
  installation: string;
}

/** One plain object from injected observations — no I/O, always includes NOT_OBSERVABLE_GLOBALLY. */
export function buildHealthDetails(o: { readiness: ReadinessReport; watchdog: WatchdogSummary; lastSelfTest: LastSelfTest; remoteHosts: readonly ProbeResult[] }): HealthDetails {
  return {
    ready: o.readiness.ready,
    blockers: o.readiness.blockers,
    checks: o.readiness.checks,
    watchdog: o.watchdog,
    lastSelfTest: o.lastSelfTest,
    remoteHosts: [...o.remoteHosts],
    notObservableGlobally: NOT_OBSERVABLE_GLOBALLY,
    gitSha: o.readiness.gitSha,
    installation: o.readiness.installation,
  };
}
