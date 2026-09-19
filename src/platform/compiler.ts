// plan -> WorkflowDef compiler (SEVERKA "M3 No-n8n Gate", docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 8): the
// mechanical last step between Planner's PlanResult (capability names + order, no values, AR-1) and Orchestrator's
// WorkflowDef (an executable definition — still no values, only $input/$steps refs). Never inspects goal or
// capability CONTENT and never switches on a name (AR-4): every knob a WorkflowDef needs beyond the plan itself
// (deadline, roles, conformance tier, the compiler's own output-format version) comes from CompilerPolicy, a
// per-installation config value. A goal no producer can reach, a dependency cycle, an invalid request, or a
// planned capability with no usable registry record all fail closed with a named status — never a partial or
// guessed WorkflowDef. Same input -> byte-identical output (COMP-006), inherited directly from plan()'s own
// determinism plus a fixed, content-derived workflow name (never a counter, never wall-clock).
//
// Field-naming gap, consciously out of scope here (mirrors goal-mapping.ts's own "no real goal exists yet"
// honesty about (188)/(189)): a compiled step's `inputs` are keyed by a mechanical flattening of FactCatalog keys
// (factFieldName() below), never by the real, hand-authored JSON-schema field names today's capabilities actually
// expect (e.g. document.classify wants "artifactId"/"sha256", not "document_original" — those plumbing fields
// are not FactCatalog keys at all). Reconciling FactCatalog keys with a capability's real input schema is a
// separate mapping layer this milestone does not build. Execution (WorkflowDef -> Orchestrator) is out of scope
// regardless (część 6 krok 8 only computes; running the result is a later step), so a compiled WorkflowDef is not
// yet guaranteed to pass a real capability's own input validation if ever dispatched — that gap does not block
// this milestone's own contract: plan -> immutable, schema-valid, deterministic WorkflowDef.
//
// Pure and unaudited on purpose, same layering as plan() itself (planner.ts's own header: "no LLM, no values, no
// policy"): compileWorkflow() takes no AuditTrail and has no side effect. Auditing a compiled result is a live
// call site's job, exactly as resolveCaseGoal() (goal-mapping.ts) sits one layer above the pure GoalMapRegistry
// lookup — that call site does not exist yet (see HANDOFF's own "vědomě mimo rozsah" for this milestone: no real
// non-empty MAPPED goal exists today to drive it, and the gateway's own capability view is honestly incomplete
// across its in-process + 2 remote-Worker topology, so wiring a live caller now would mean auditing against a
// registry that can wrongly report a real, remotely-dispatched capability as CAPABILITY_UNUSABLE).
import { sha256 } from "./artifacts.js";
import type { CurrentCaseProjection } from "./case-projection.js";
import type { CompilerPolicy } from "./compiler-policy.js";
import { formatFactAddress } from "./fact-address.js";
import type { FactCatalog } from "./fact-catalog.js";
import type { StepDef, WorkflowDef } from "./orchestrator.js";
import { plan, type PlanGap } from "./planner.js";
import type { CapabilityRecord } from "./registry.js";
import { parseWorkflowDef } from "./workflow.js";

/** Read-only lookup a compiler needs from whatever registered a capability — never a second source of
 * authorization (registry.ts's own invariant: "Router.route() alone decides what may execute"). A compiler only
 * ever reads what Router.register() already validated; it never grants anything and never runs anything. */
export interface CapabilityLookup {
  recordFor(capability: string): CapabilityRecord | undefined;
}

export interface CompileInput {
  readonly projection: CurrentCaseProjection;
  /** FactCatalog keys the compiled workflow must produce — a MAPPED, non-empty GoalMappingResult.goal. */
  readonly goal: readonly string[];
  readonly factCatalog: FactCatalog;
  readonly capabilities: CapabilityLookup;
  readonly policy: CompilerPolicy;
}

export type CompileResult =
  | { readonly status: "COMPILED"; readonly workflow: WorkflowDef }
  | { readonly status: "CAPABILITY_GAP"; readonly missing: readonly PlanGap[] }
  | { readonly status: "CYCLE"; readonly path: readonly string[] }
  | { readonly status: "INVALID"; readonly reason: string }
  | { readonly status: "CAPABILITY_UNUSABLE"; readonly capability: string; readonly reason: string }
  | { readonly status: "NOTHING_TO_DO" };

/** Mechanical, reversible flattening of a dotted FactCatalog key into a single flat identifier — the compiler's
 * own field-naming convention for StepDef.inputs (see file header). "_" never appears in a FactCatalog key
 * (FACT_KEY_PATTERN is dotted lowerCamel segments only), so distinct keys can never collide onto one name, and
 * the result never itself contains a "." — required so Orchestrator.resolveRef()'s own naive `.split(".")` walk
 * of "$steps.<id>.payload.<field>" treats it as exactly one path segment, not a further nested lookup. */
function factFieldName(key: string): string {
  return key.replace(/\./g, "_");
}

/** Mechanical, collision-safe step id: capability names (workflow-definition.schema.json's own capabilityName
 * pattern) are dotted lowerCamel segments and never contain "-", so replacing "." with "-" is an injective map
 * onto the schema's step-id alphabet (^[a-z][a-z0-9-]*$). */
function stepId(capability: string): string {
  return capability.replace(/\./g, "-");
}

/**
 * Deterministic content identity for a compiled plan: two Cases whose plans select the exact same capabilities in
 * the exact same order get the same name (safe to treat as the same workflow definition); any different plan gets
 * a different one. This is what keeps Orchestrator.recover()'s own `inst.workflow === this.opts.workflow.workflow`
 * filter safe by construction even though execution/journal resumption of a compiled plan is not wired yet
 * (część 6 krok 9's job): identity is never just the goal, which two Cases can share while resolving to different
 * plans (M3's own killer test — availability changes the plan without editing a single workflow file).
 */
function workflowName(steps: readonly StepDef[]): string {
  const fingerprint = steps.map((s) => ({ capability: s.capability, capabilityVersion: s.capabilityVersion }));
  return `cwf-${sha256(JSON.stringify(fingerprint)).slice(0, 16)}`;
}

export function compileWorkflow(input: CompileInput): CompileResult {
  const available = input.projection.availableFacts.map(formatFactAddress);
  const result = plan({ goal: input.goal, available }, input.factCatalog);
  if (result.status === "CAPABILITY_GAP") return { status: "CAPABILITY_GAP", missing: result.missing };
  if (result.status === "CYCLE") return { status: "CYCLE", path: result.path };
  if (result.status === "INVALID") return { status: "INVALID", reason: result.reason };
  // A goal already fully satisfied by `available` is PLANNED with zero steps (plan() has nothing left to do) — a
  // legitimate, reachable input (e.g. discovery re-triggered on a Case that already has everything), not an error.
  // workflow-definition.schema.json requires steps.minItems=1 (no such thing as a valid empty WorkflowDef), so this
  // must be its own named outcome rather than reaching parseWorkflowDef() below with nothing to run (adversarial
  // verification, część 6 krok 8: this used to throw an unnamed schema error instead of failing closed by name).
  if (result.steps.length === 0) return { status: "NOTHING_TO_DO" };

  // Which selected step first produces a key — plan()'s own resolve() only ever selects a capability once every
  // key it consumes is already satisfied (available or an earlier producer), so this is populated in dependency
  // order as `result.steps` (already Kahn-sorted) is walked; see the INVALID fallback below for the alternative.
  const producedBy = new Map<string, string>();
  for (const step of result.steps) for (const key of step.produces) if (!producedBy.has(key)) producedBy.set(key, step.capability);
  const availableSet = new Set(available);

  const steps: StepDef[] = [];
  for (const step of result.steps) {
    const record = input.capabilities.recordFor(step.capability);
    if (!record) return { status: "CAPABILITY_UNUSABLE", capability: step.capability, reason: "not registered" };
    // typeof first, on purpose (adversarial verification, część 6 krok 8): RegExp.test() coerces its argument to a
    // string, so a record built from loosely-typed data (e.g. a hand-rolled CapabilityLookup over parsed JSON) with
    // a numeric version like 1 would pass /^[0-9]+$/.test(1) === true and silently reach StepDef.capabilityVersion
    // as a number, only to fail an unrelated, unnamed schema check later — never a graceful CAPABILITY_UNUSABLE.
    if (typeof record.version !== "string" || !/^[0-9]+$/.test(record.version)) {
      return { status: "CAPABILITY_UNUSABLE", capability: step.capability, reason: `invalid capabilityVersion ${JSON.stringify(record.version)}` };
    }
    const sideEffects = record.sideEffects;
    if (sideEffects !== "none" && sideEffects !== "internal-write" && sideEffects !== "external-write") {
      return { status: "CAPABILITY_UNUSABLE", capability: step.capability, reason: `invalid sideEffects ${JSON.stringify(record.sideEffects)}` };
    }

    const inputs: Record<string, unknown> = {};
    for (const key of step.consumes) {
      if (availableSet.has(key)) {
        inputs[factFieldName(key)] = `$input.${factFieldName(key)}`;
        continue;
      }
      const producer = producedBy.get(key);
      // Would mean plan() selected a step whose dependency neither "available" nor any selected producer
      // satisfies — a planner bug, not a caller mistake; fail closed rather than emit a dangling $steps ref
      // parseWorkflowDef() would refuse anyway.
      if (!producer) return { status: "INVALID", reason: `planner produced a step consuming ${key} with no available fact or earlier producer (unreachable)` };
      inputs[factFieldName(key)] = `$steps.${stepId(producer)}.payload.${factFieldName(key)}`;
    }

    steps.push({ id: stepId(step.capability), capability: step.capability, capabilityVersion: record.version, sideEffects, inputs });
  }

  const workflow: WorkflowDef = {
    workflow: workflowName(steps),
    workflowVersion: input.policy.workflowVersion,
    conformanceTier: input.policy.conformanceTier,
    deadlineMs: input.policy.deadlineMs,
    operatorRole: input.policy.operatorRole,
    supervisorRole: input.policy.supervisorRole,
    steps,
  };
  // Self-check, not a fail-closed-on-caller-input branch: every step id is unique by construction (plan() forbids
  // two selected steps sharing a capability) and every $steps ref names an earlier step by construction (built
  // above from `producedBy`, itself populated by walking `result.steps` in its own already-topological order) —
  // a throw here means compiler.ts itself is broken, never that the caller's goal/projection was bad.
  return { status: "COMPILED", workflow: Object.freeze(parseWorkflowDef(workflow)) };
}
