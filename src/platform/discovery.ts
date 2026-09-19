// Discovery goal (docs/M0-FACT-CONTRACT-V1.md część 0 krůček 5: "Discovery = plan({ goal: ["impulse.intent"],
// available: [...] })"; docs/SEVERKA.md: "Discovery goal je běžný plan() nad impulse.* klíči s cílem
// impulse.intent"; docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 7's own precondition) — the platform's fixed first
// question for a Case that has never been interpreted: "what does this impulse mean". Expressed the same way any
// other goal is, a plan() call over the FactCatalog — never a hardcoded "if no intent, call intent.resolve"
// special case (AR-4's own test: a second producer of impulse.intent, or a channel that needs no discovery at
// all, changes nothing here, only the catalog).
import { formatFactAddress } from "./fact-address.js";
import type { FactCatalog } from "./fact-catalog.js";
import { plan, type PlanResult } from "./planner.js";
import type { CurrentCaseProjection } from "./case-projection.js";

/** The fact key discovery resolves — also the one goal-mapping.ts reads the resolved VALUE of (its own
 * "separately-authorized path", never through this module or planner.ts, AR-1). Named/exported here since this
 * is the one place that owns "what discovery's own goal actually is". */
export const IMPULSE_INTENT_FACT_KEY = "impulse.intent";

/** The one fixed discovery goal today. A second discovery question, if one is ever needed, is added here as a
 * second entry — never as a second driver elsewhere. */
export const DISCOVERY_GOAL: readonly string[] = [IMPULSE_INTENT_FACT_KEY];

/** contracts/facts.v1.json: "boundary-fed by the mail transport... no producer of its own" — impulse.raw has no
 * capability producing it, so plan() can only ever treat it as already-available or not. The one thing a
 * Projection knows about it structurally, without walking evidence, is whether the Case's own impulse carries
 * any artifact at all (CurrentCaseProjection.availableArtifacts, AR-1: refs only). */
const IMPULSE_RAW_KEY = "impulse.raw";

/**
 * Builds `plan()`'s `available` from a CurrentCaseProjection — every AVAILABLE fact address it already reports
 * (case-projection.ts's own comment names this as the intended shape, but availableFacts is FactAddress[], not
 * strings: formatFactAddress() is the required conversion step, round-tripping CASE_SCOPE to the bare key
 * per fact-address.ts) — plus impulse.raw when the impulse carries content, and asks the deterministic planner
 * to resolve DISCOVERY_GOAL against `catalog`. PLANNED with `steps: []` means the goal is already satisfied
 * (impulse.intent already available); CAPABILITY_GAP/CYCLE/INVALID are reported by the caller, never guessed past.
 */
export function planDiscovery(projection: CurrentCaseProjection, catalog: FactCatalog): PlanResult {
  const available = projection.availableFacts.map(formatFactAddress);
  if (projection.availableArtifacts.length > 0) available.push(IMPULSE_RAW_KEY);
  return plan({ goal: DISCOVERY_GOAL, available }, catalog);
}
