// Executes exactly ONE discovery plan (discovery.ts's planDiscovery()) for a Case: one plan() call, then one
// transport.dispatch() per resolved step in dependency order — no retries, no strategies, no review, no loop.
// This is deliberately narrower than the Case-level replanning loop (docs/AUTONOMOUS-RUNTIME-V1.md część 3 /
// część 6 krok 9, still TARGET — its own convergence-guard requirement, projectionHash/planHash + iteration
// budget, is explicitly NOT implemented yet, część 6's own text). What this module IS: the loop's first,
// single-round, single-goal slice — live-wired once per Case creation (deploy/cloudflare/apf-gateway/src/index.ts's
// createCase()) — never a per-intent special case: WHAT to call always comes from plan(), never an `if`.
//
// What plan() cannot give a caller: fact-catalog keys are not capability input-schema field names (planner.ts's
// own header comment) — nothing in the platform maps one to the other generically yet. A DiscoveryInputBuilder
// closes exactly that gap, one per planned capability, owned by that capability's own component (see
// src/components/intent-resolver/discovery.ts) and assembled into a registry at each composition root — the
// same place router.register() already assembles that capability's other wiring. A planned capability with no
// registered builder is reported NOT_BUILDABLE and skipped: never guessed, never silently retried.
import type { ArtifactReader } from "./artifacts.js";
import type { AuditTrail } from "./audit.js";
import type { AuthorityRegistry } from "./authorities.js";
import type { Case } from "./case.js";
import { projectCurrentCase, type CurrentCaseProjection } from "./case-projection.js";
import type { Clock } from "./clock.js";
import { iso, plus } from "./clock.js";
import { planDiscovery } from "./discovery.js";
import type { EvidenceLedger } from "./evidence.js";
import type { FactCatalog } from "./fact-catalog.js";
import { newId } from "./ids.js";
import type { LifecycleRegistry } from "./lifecycle.js";
import type { PlanStep } from "./planner.js";
import type { DispatchTransport } from "./transport.js";
import type { MessageEnvelope, ResultEnvelope } from "./types.js";

/** Builds one planned capability's dispatch payload from what's known about the Case. Returning undefined means
 * this step cannot be built (fail-closed) — e.g. the impulse carries no artifact at all despite plan() resolving
 * this far (should not happen given planDiscovery()'s own impulse.raw gate, but a builder must never guess). */
export type DiscoveryInputBuilder = (ctx: { readonly case: Case; readonly projection: CurrentCaseProjection }) => Record<string, unknown> | undefined;

export interface DiscoveryRunnerDeps {
  readonly catalog: FactCatalog;
  readonly ledger: EvidenceLedger;
  readonly artifacts: ArtifactReader;
  /** Threaded through to projectCurrentCase() — omitting either makes every authority-backed fact read as
   * unconditionally untrusted (case-projection.ts's own doc comment flags this exact trap for "the Planner
   * integration this module's header describes as TARGET": pass the installation's real registries). */
  readonly authorities?: AuthorityRegistry;
  readonly lifecycle?: LifecycleRegistry;
  readonly transport: DispatchTransport;
  readonly actorId: string;
  readonly clock: Clock;
  readonly deadlineMs: number;
  readonly audit: AuditTrail;
  readonly inputBuilders: Readonly<Record<string, DiscoveryInputBuilder>>;
}

export type DiscoveryStepOutcome = { readonly capability: string; readonly result: ResultEnvelope } | { readonly capability: string; readonly notBuildable: true };

export type DiscoveryRunResult =
  | { readonly status: "SATISFIED"; readonly projection: CurrentCaseProjection }
  | { readonly status: "EXECUTED"; readonly projection: CurrentCaseProjection; readonly steps: readonly DiscoveryStepOutcome[] }
  | { readonly status: "CAPABILITY_GAP" | "CYCLE" | "INVALID"; readonly projection: CurrentCaseProjection };

export async function runDiscovery(deps: DiscoveryRunnerDeps, c: Case): Promise<DiscoveryRunResult> {
  const now = iso(deps.clock.now());
  const projection = projectCurrentCase({ case: c, ledger: deps.ledger, artifacts: deps.artifacts, now, authorities: deps.authorities, lifecycle: deps.lifecycle });
  const planResult = planDiscovery(projection, deps.catalog);

  if (planResult.status !== "PLANNED") {
    deps.audit.append({ kind: "state", tenantId: c.tenantId, capability: "case-discovery", details: { caseId: c.caseId, status: planResult.status, plan: planResult } });
    return { status: planResult.status, projection };
  }
  if (planResult.steps.length === 0) return { status: "SATISFIED", projection };

  const steps: DiscoveryStepOutcome[] = [];
  for (const step of planResult.steps) {
    const outcome = await runStep(deps, c, projection, step, now);
    steps.push(outcome);
    deps.audit.append({
      kind: "state",
      tenantId: c.tenantId,
      capability: "case-discovery",
      details: { caseId: c.caseId, step: step.capability, status: "notBuildable" in outcome ? "NOT_BUILDABLE" : outcome.result.status },
    });
  }
  return { status: "EXECUTED", projection, steps };
}

async function runStep(deps: DiscoveryRunnerDeps, c: Case, projection: CurrentCaseProjection, step: PlanStep, now: string): Promise<DiscoveryStepOutcome> {
  const build = deps.inputBuilders[step.capability];
  const payload = build?.({ case: c, projection });
  if (!payload) return { capability: step.capability, notBuildable: true };
  // capabilityVersion "1": FactCatalog/PlanStep carries no version (fact-catalog.ts's CapabilityFlow has none) —
  // every capability this plans for has exactly one registered version today, same assumption self-test.ts's
  // runSelfTest() makes for its own bare transport.dispatch() calls.
  const message: MessageEnvelope = {
    messageId: newId("msg"),
    correlationId: newId("cor"),
    type: "command",
    capability: step.capability,
    capabilityVersion: "1",
    schemaVersion: "1",
    createdAt: now,
    idempotencyKey: newId("key"),
    notValidAfter: iso(plus(new Date(now), deps.deadlineMs)),
    payload,
  };
  const result = await deps.transport.dispatch(message, deps.actorId);
  return { capability: step.capability, result };
}
