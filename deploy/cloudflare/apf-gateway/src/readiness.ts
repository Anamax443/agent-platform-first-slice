// RG2-E (Reliability Gate 2, last item, 18.9.2026): the pure half of the gateway's three liveness/readiness routes.
// The owner's own definitions, verbatim in spirit:
//   /live           = the process is alive. No I/O. Always 200 while the Worker can answer.
//   /ready          = "can I SAFELY accept a NEW Case right now?" 200 when yes, 503 when no, with named blockers.
//                     Bounded and cheap.
//   /health/details = why I am not ready / what is degraded. Always 200 (a report, not a gate). Honest about what
//                     is NOT observable.
// One exception to "always 200" and "503 with blockers", stated rather than hidden: index.ts's fetch() answers
// EVERY route but /live with 500 `{ error: "INSTALLATION_MISMATCH" }` when the bundled installation and the vars
// disagree — a mis-deployed bundle must serve nothing, and /ready and /health/details fail closed with it.
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
 * results), never its reservation/job tables. Everything below is therefore observable only from inside the one
 * object it belongs to (its own alarm() tick, or an operator opening its /workflow/<id> page) — not from here.
 * The last entry is the one deliberate probe gap: /ready's d1-audit probe is read-only (index.ts says why a
 * write per load-balancer poll was unacceptable), so D1 refusing writes is likewise seen first by an object.
 */
export const NOT_OBSERVABLE_GLOBALLY: readonly { fact: string; reason: string }[] = [
  { fact: "pending durable_job / fanout_job rows", reason: "per-WorkflowInstance Durable Object SQLite (store.ts durable_job/fanout_job), no instance directory to enumerate" },
  { fact: "stale RESERVED idempotency rows", reason: "per-WorkflowInstance Durable Object SQLite (store.ts idempotency), reachable only by that object's own alarm()/reconcile (RG2-D)" },
  { fact: "oldest RUNNING step", reason: "each object's own journal table; D1 mirrors state transitions per instance but no global 'currently RUNNING' index exists" },
  { fact: "dead / gave-up fan-out jobs", reason: "fanout_job rows moved to DONE with lastError live only in their own object; the audited FAILED record is per instance, not aggregated" },
  { fact: "D1 refusing writes (quota exhausted / read-only)", reason: "/ready's d1-audit probe is read-only by design (a write per poll would pin a probe row to the top of the Deník and burn D1's write quota); the first failing mirror write surfaces in its own object's copyOut() durable-job retries (RG2-A)" },
];

/**
 * Reliability Gate R4's config gap as a NON-required check, /health/details only (RG2-E adversarial review,
 * 18.9.2026). wirePlatform() deliberately never throws over it (platform-wiring.ts aresFor()/mojeDaneFor():
 * Approach B rejected — a throw would take every capability of the object down over a gap in two), so
 * checkWiringPreconditions() cannot see it and /ready must not block on it: a new Case IS safely accepted, only
 * cz.company.verify / cz.vat.verify degrade to FAILED/TRUSTED_PROVIDER_NOT_CONFIGURED. ok iff a real adapter is
 * wired OR the installation has explicitly opted into the fakes (InstallationProfile.allowUnconfiguredTrustedProviders,
 * what config/local-fakes sets on purpose). `realAdaptersWired` is index.ts's own statement about what its
 * WorkflowInstance.wiring() passes — this function only reports it, it cannot verify it.
 */
export function trustedProvidersCheck(o: { allowUnconfiguredTrustedProviders: boolean | undefined; realAdaptersWired: boolean }): ProbeResult {
  const name = "trusted-providers";
  if (o.realAdaptersWired || o.allowUnconfiguredTrustedProviders === true) return { name, ok: true, required: false, ms: 0, timeoutMs: 0 };
  return {
    name,
    ok: false,
    required: false,
    ms: 0,
    timeoutMs: 0,
    reason: "cz.company.verify / cz.vat.verify will FAIL TRUSTED_PROVIDER_NOT_CONFIGURED: no real ARES / MOJE daně adapter is wired and the installation has not opted into the fakes (profile.allowUnconfiguredTrustedProviders)",
  };
}

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
  // The row's JSON parsed (boundedRead guards that) but is not the shape recordSelfTestSummary() writes — a
  // corrupted or hand-edited row. Report it; a throw here would be the one path that 500s /health/details.
  if (!Array.isArray(read.value.fixtures)) return { at: null, reason: "self-test-state row malformed (no fixtures array)" };
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
  | { level: WatchdogLevel; effectiveLevel: WatchdogLevel; openIncidents: OpenIncident[]; asOf: string | null; source: string }
  | { level: "UNKNOWN"; effectiveLevel: "UNKNOWN"; openIncidents: []; asOf: null; reason: string; source: string };

const WATCHDOG_SOURCE =
  "persisted watchdog-incident rows (D1) written by the last reconcile — every GET /farm render and every self-test cron tick; NOT recomputed here (computeWatchdog() needs the full FarmModel: ~17 D1/service-binding reads plus one Durable Object round trip per recent instance). `level` is the raw rule over every open incident (computeWatchdog(), what reconcile/alerting track); `effectiveLevel` ignores acknowledged ones (page.ts effectiveWatchdogLevel(), what a human sees on /farm)";

/** The INCIDENT/DEGRADED/HEALTHY rule shared by computeWatchdog() and effectiveWatchdogLevel() (page.ts). */
const levelOf = (open: readonly { level: OpenIncident["level"] }[]): WatchdogLevel => (open.some((i) => i.level === "INCIDENT") ? "INCIDENT" : open.length > 0 ? "DEGRADED" : "HEALTHY");

/**
 * Argos's last persisted verdict, cheaply: the same INCIDENT/DEGRADED/HEALTHY rule computeWatchdog() (page.ts)
 * applies to live findings, applied to the still-open incidents reconcileIncidents() persisted from those
 * findings. Zero rows of any kind is honestly UNKNOWN (reconcile never ran), not HEALTHY. `asOf` is the newest
 * timestamp any row carries — the closest thing to "when Argos last looked" the rows can prove.
 *
 * Two levels, because the farm itself has two: `level` counts every open incident, acknowledged or not (the raw
 * truth reconcileIncidents()/sendArgosAlerts() track); `effectiveLevel` drops acknowledged ones, exactly like
 * page.ts's effectiveWatchdogLevel() that the /farm rollup shows — so a reader comparing this report with /farm
 * is not left wondering why one says INCIDENT and the other DEGRADED. Same rule as page.ts, restated here
 * (one line) rather than imported: readiness.ts keeps only type imports from page.js.
 */
export function summarizeWatchdog(read: BoundedRead<readonly IncidentRecord[]>): WatchdogSummary {
  if (!read.ok) return { level: "UNKNOWN", effectiveLevel: "UNKNOWN", openIncidents: [], asOf: null, reason: `watchdog-incident rows unreadable: ${read.reason}`, source: WATCHDOG_SOURCE };
  if (read.value.length === 0) return { level: "UNKNOWN", effectiveLevel: "UNKNOWN", openIncidents: [], asOf: null, reason: "no watchdog-incident rows yet: Argos's reconcile has never run on this farm", source: WATCHDOG_SOURCE };
  const open = read.value.filter((i) => !i.resolvedAt).map(({ key, level, text, firstSeenAt, lastSeenAt, occurrences, acknowledgedAt }) => ({ key, level, text, firstSeenAt, lastSeenAt, occurrences, ...(acknowledgedAt ? { acknowledgedAt } : {}) }));
  const asOf = read.value.map((i) => i.resolvedAt ?? i.lastSeenAt).reduce<string | null>((max, at) => (max === null || at > max ? at : max), null);
  return { level: levelOf(open), effectiveLevel: levelOf(open.filter((i) => !i.acknowledgedAt)), openIncidents: open, asOf, source: WATCHDOG_SOURCE };
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
  /** Reliability Gate R4's config gap (trustedProvidersCheck above) — reported, never a readiness blocker. */
  trustedProviders: ProbeResult;
  notObservableGlobally: readonly { fact: string; reason: string }[];
  gitSha: string;
  installation: string;
}

/** One plain object from injected observations — no I/O, always includes NOT_OBSERVABLE_GLOBALLY. */
export function buildHealthDetails(o: { readiness: ReadinessReport; watchdog: WatchdogSummary; lastSelfTest: LastSelfTest; remoteHosts: readonly ProbeResult[]; trustedProviders: ProbeResult }): HealthDetails {
  return {
    ready: o.readiness.ready,
    blockers: o.readiness.blockers,
    checks: o.readiness.checks,
    watchdog: o.watchdog,
    lastSelfTest: o.lastSelfTest,
    remoteHosts: [...o.remoteHosts],
    trustedProviders: o.trustedProviders,
    notObservableGlobally: NOT_OBSERVABLE_GLOBALLY,
    gitSha: o.readiness.gitSha,
    installation: o.readiness.installation,
  };
}
