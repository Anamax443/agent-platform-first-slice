// Reads a Case's resolved impulse.intent and maps it to a business goal via GoalMapRegistry (goal-map.ts,
// część 6 krok 7) — the "separately-authorized path" AR-1 allows once a fact is already decided AVAILABLE:
// this never re-derives trust/ambiguity (case-projection.ts's checkRecord()/resolveGroup() already did that),
// it only follows the recordId a CurrentCaseProjection already vouched for to EvidenceLedger.get() and reads
// that ONE record's .result — never a raw ledger scan, never through planner.ts/discovery.ts (which stay
// value-free, AR-1, on purpose). Computes the goal; does NOT execute it — the część 6 krok 8 compiler is what
// will eventually turn a mapped goal into something plan()/Orchestrator can run. That boundary is deliberate:
// today's discovery driver already shows what a *shortcut* execution path looks like (direct
// transport.dispatch(), no journal/instance) and business goals need the real compiler, not a second shortcut.
import type { AuditTrail } from "./audit.js";
import type { CurrentCaseProjection } from "./case-projection.js";
import { IMPULSE_INTENT_FACT_KEY } from "./discovery.js";
import type { EvidenceLedger } from "./evidence.js";
import { CASE_SCOPE } from "./fact-catalog.js";
import type { GoalMapRegistry } from "./goal-map.js";

export type GoalMappingResult =
  | { readonly status: "NOT_RESOLVED" }
  | { readonly status: "NO_MAPPING"; readonly intent: string }
  | { readonly status: "MAPPED"; readonly intent: string; readonly goal: readonly string[] };

export interface GoalMappingDeps {
  readonly ledger: EvidenceLedger;
  readonly goalMap: GoalMapRegistry;
  readonly audit: AuditTrail;
}

/**
 * `projection` must be freshly computed (after any discovery attempt that might just have sealed
 * impulse.intent.resolved) — a stale, pre-dispatch projection would correctly report NOT_RESOLVED even right
 * after a successful resolution, since it cannot see evidence sealed after it was built.
 */
export function resolveCaseGoal(deps: GoalMappingDeps, projection: CurrentCaseProjection): GoalMappingResult {
  const fact = projection.facts.find((f) => f.address.key === IMPULSE_INTENT_FACT_KEY && f.address.scope === CASE_SCOPE && f.availability === "AVAILABLE");
  if (!fact) return { status: "NOT_RESOLVED" };

  const record = deps.ledger.get(fact.recordId);
  // AVAILABLE per the projection but the record itself didn't come back — the ledger has no delete API, so this
  // should never happen; fail closed exactly like NOT_RESOLVED rather than assume a value that isn't there.
  if (!record) return { status: "NOT_RESOLVED" };

  const intent = record.result;
  const goal = deps.goalMap.goalFor(intent);
  deps.audit.append({
    kind: "state",
    tenantId: projection.tenantId,
    capability: "case-goal-mapping",
    details: { caseId: projection.caseId, intent, status: goal === undefined ? "NO_MAPPING" : "MAPPED", ...(goal !== undefined ? { goal } : {}) },
  });
  return goal === undefined ? { status: "NO_MAPPING", intent } : { status: "MAPPED", intent, goal };
}
