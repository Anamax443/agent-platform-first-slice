// Deterministic fact-dependency planner (SEVERKA "Planner", Posudek 17 phase 1): from a goal (namespace keys wanted) and
// what is already available (namespace keys present at intake) derive WHICH capabilities must run and in what order,
// by backward chaining over the FactCatalog's consumes/produces. No LLM, no values, no policy: the output is a list of
// capability names. Retry budgets, roles, deadlines, strategies and the WorkflowDef itself belong to a later compile
// step (plan → WorkflowDef → parseWorkflowDef()), never here. A goal no producer can reach is CAPABILITY_GAP (SEVERKA
// "Capability gap — Farmář nesmí improvizovat náhradou"), a dependency loop is CYCLE — both fail closed, the planner
// never returns a partial plan as if it were whole. Same request + same catalog = byte-identical result.
import type { CapabilityFlow, FactCatalog } from "./fact-catalog.js";

export interface PlanRequest {
  /** Keys that must be produced (facts/artifacts/evidence/effects). Keys only — a value here is an unknown key. */
  readonly goal: readonly string[];
  /** Keys already present when the plan starts (the intake's inputs). Keys only. */
  readonly available: readonly string[];
}

export interface PlanStep {
  readonly capability: string;
  readonly module: string;
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
}

export interface PlanGap {
  readonly key: string;
  /** NO_PRODUCER: nothing in the catalog produces the key. UNSATISFIABLE: every producer was tried, each needs something unreachable. */
  readonly reason: "NO_PRODUCER" | "UNSATISFIABLE";
  readonly tried: readonly string[];
}

interface PlanBase {
  readonly goal: readonly string[];
  readonly available: readonly string[];
}

export type PlanResult =
  | (PlanBase & { readonly status: "PLANNED"; readonly steps: readonly PlanStep[] })
  | (PlanBase & { readonly status: "CAPABILITY_GAP"; readonly missing: readonly PlanGap[] })
  | (PlanBase & { readonly status: "CYCLE"; readonly path: readonly string[] })
  | (PlanBase & { readonly status: "INVALID"; readonly reason: string });

export function plan(request: PlanRequest, catalog: FactCatalog): PlanResult {
  const base: PlanBase = { goal: [...request.goal], available: [...request.available] };
  if (base.goal.length === 0) return { ...base, status: "INVALID", reason: "empty goal" };
  for (const key of [...base.goal, ...base.available]) {
    if (!catalog.entry(key)) return { ...base, status: "INVALID", reason: `unknown key ${key}` };
  }

  // Search state; snapshotted and rolled back when a producer turns out to be a dead end.
  let selected = new Map<string, CapabilityFlow>();
  let produced = new Set<string>(base.available);
  let producerOf = new Map<string, string>(); // key -> capability that first produced it in this plan
  const gaps: PlanGap[] = [];
  let cycle: string[] | undefined;

  const resolve = (key: string, stack: readonly string[]): boolean => {
    if (produced.has(key)) return true;
    const at = stack.indexOf(key);
    if (at >= 0) {
      cycle = [...stack.slice(at), key];
      return false;
    }
    const producers = catalog.producersOf(key);
    if (producers.length === 0) {
      gaps.push({ key, reason: "NO_PRODUCER", tried: [] });
      return false;
    }
    const tried: string[] = [];
    const deadEnds: PlanGap[] = [];
    for (const p of producers) {
      tried.push(p.capability);
      const snapshot = { selected: new Map(selected), produced: new Set(produced), producerOf: new Map(producerOf), gaps: gaps.length };
      let ok = true;
      for (const dep of p.consumes) {
        if (!resolve(dep, [...stack, key])) {
          ok = false;
          break;
        }
      }
      if (cycle) return false;
      if (ok) {
        selected.set(p.capability, p);
        for (const out of p.produces) {
          if (!produced.has(out)) {
            produced.add(out);
            producerOf.set(out, p.capability);
          }
        }
        return true;
      }
      deadEnds.push(...gaps.splice(snapshot.gaps));
      selected = snapshot.selected;
      produced = snapshot.produced;
      producerOf = snapshot.producerOf;
    }
    gaps.push(...deadEnds, { key, reason: "UNSATISFIABLE", tried });
    return false;
  };

  for (const key of base.goal) {
    resolve(key, []);
    if (cycle) break;
  }
  if (cycle) return { ...base, status: "CYCLE", path: cycle };
  if (gaps.length > 0) return { ...base, status: "CAPABILITY_GAP", missing: gaps };
  const steps = order(selected, producerOf);
  if (!steps) return { ...base, status: "CYCLE", path: [...selected.keys()] };
  return { ...base, status: "PLANNED", steps };
}

/**
 * Dependency order (Kahn) with a fixed tie-break by capability name, so the order never depends on how a sidecar
 * happens to list its groups. Edges: the capability that produced a key -> every selected capability consuming it.
 */
function order(selected: ReadonlyMap<string, CapabilityFlow>, producerOf: ReadonlyMap<string, string>): PlanStep[] | undefined {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const name of selected.keys()) {
    indegree.set(name, 0);
    dependents.set(name, new Set());
  }
  for (const f of selected.values()) {
    for (const key of f.consumes) {
      const producer = producerOf.get(key);
      if (producer === undefined || producer === f.capability) continue;
      const deps = dependents.get(producer);
      if (deps && !deps.has(f.capability)) {
        deps.add(f.capability);
        indegree.set(f.capability, (indegree.get(f.capability) ?? 0) + 1);
      }
    }
  }
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort();
  const out: PlanStep[] = [];
  while (ready.length > 0) {
    const name = ready.shift() as string;
    const f = selected.get(name) as CapabilityFlow;
    out.push({ capability: f.capability, module: f.module, consumes: [...f.consumes], produces: [...f.produces] });
    for (const d of dependents.get(name) ?? []) {
      const left = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, left);
      if (left === 0) {
        ready.push(d);
        ready.sort();
      }
    }
  }
  return out.length === selected.size ? out : undefined;
}
