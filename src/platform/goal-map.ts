// Intent -> Goal mapping (docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 7): deterministic, installation-level DATA —
// the exact line the ADR names as where n8n vs. Farma breaks (AR-4). A resolved impulse.intent VALUE (closed
// vocabulary, contracts/facts.v1.json's impulse.intent.resolved.resultVocabulary) maps to a business "goal"
// (FactCatalog keys a later plan() can resolve, docs/SEVERKA.md "Dva druhy goal" — the "explicitní" goal born
// from the discovery goal's own result) via config/<installation>/goal-map.json — never a switch/if in
// orchestration code. Mirrors authorities.ts's AuthorityRegistry: small, closed-vocabulary, per-installation,
// hand-written fail-closed validator (same choice authorities.json/lifecycle.json already made over full JSON
// Schema — see docs/AUTONOMOUS-RUNTIME-V1.md's own note that this file's validation style was researched
// against both precedents before picking this one).
import { FACT_KEY_PATTERN } from "./fact-catalog.js";

export interface GoalMapJson {
  schemaVersion: string;
  /** intent value -> goal (FactCatalog keys). An intent absent here has NO mapping configured — reported as
   * such (NO_MAPPING), never guessed. An intent present with `[]` is a deliberate "no further action" goal
   * (contracts/facts.v1.json's own impulse.intent description: UNKNOWN is a platform state, not an error) —
   * the two are different outcomes and this format keeps them distinguishable. */
  entries: Record<string, string[]>;
}

export class GoalMapError extends Error {
  constructor(message: string) {
    super(`goal-map.json: ${message}`);
    this.name = "GoalMapError";
  }
}

/** Closed-vocabulary intent values (contracts/facts.v1.json's own resultVocabulary entries, e.g.
 * INVOICE_RECEIVED, UNKNOWN) are SCREAMING_SNAKE_CASE — validated structurally here, not against a hardcoded
 * copy of the vocabulary (src/platform/* cannot import src/components/intent-resolver/'s INTENTS,
 * ARCH-DEP-001, and the vocabulary itself is contract data, not platform code). An entry for a value outside
 * the real vocabulary is inert (goalFor() on it just never gets asked), not a build-time error — the same
 * trade-off authorities.json's own producer names accept (cross-checked against policy capabilities where
 * that's cheap to do, not against every possible producer string). */
const INTENT_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export class GoalMapRegistry {
  private constructor(private readonly entries: ReadonlyMap<string, readonly string[]>) {}

  /** No entries at all: every intent is unmapped. The fail-closed default when an installation ships no
   * goal-map.json — same shape as AuthorityRegistry.empty(). */
  static empty(): GoalMapRegistry {
    return new GoalMapRegistry(new Map());
  }

  static build(json: unknown): GoalMapRegistry {
    const g = json as GoalMapJson;
    if (!g || typeof g !== "object") throw new GoalMapError("not an object");
    if (g.schemaVersion !== "1") throw new GoalMapError(`expected schemaVersion "1", got ${JSON.stringify(g.schemaVersion)}`);
    if (!g.entries || typeof g.entries !== "object") throw new GoalMapError('"entries" must be an object');
    const map = new Map<string, readonly string[]>();
    for (const [intent, goal] of Object.entries(g.entries)) {
      if (!INTENT_PATTERN.test(intent)) throw new GoalMapError(`${JSON.stringify(intent)} is not a SCREAMING_SNAKE_CASE intent value`);
      if (map.has(intent)) throw new GoalMapError(`${intent} listed twice`);
      if (!Array.isArray(goal)) throw new GoalMapError(`${intent}: goal must be an array of fact-catalog keys (possibly empty)`);
      for (const key of goal) {
        if (typeof key !== "string" || !FACT_KEY_PATTERN.test(key)) throw new GoalMapError(`${intent}: ${JSON.stringify(key)} is not a fact-catalog key`);
      }
      map.set(intent, [...goal]);
    }
    return new GoalMapRegistry(map);
  }

  /** The configured goal for a resolved intent value, or undefined = no mapping configured (fail-closed: never
   * guessed past). An empty array is a real, deliberate mapping ("this intent needs no further action"), not
   * the same thing as undefined. */
  goalFor(intent: string): readonly string[] | undefined {
    return this.entries.get(intent);
  }
}
