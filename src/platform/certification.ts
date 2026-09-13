import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";

/**
 * Full Admission Gate vocabulary (docs/SEVERKA.md `## Vrstvy` → Admission Gate row, Posudek 8/9/
 * 10/11/12 independently naming the same gap: today's `LifecycleRegistry` only knows `ACTIVE`/
 * `QUARANTINED`). `TESTING` is intentionally not tracked as a stored state here — it is whatever a
 * live test run is doing *before* `certify()` is called, transient by nature; a module with no
 * CertificationRecord for its current build is simply `NEW`. `DEGRADED` requires a live health
 * signal (a future Argos/Safety Executor integration, docs/SEVERKA.md `## Vrstvy` Argos row) this
 * module deliberately doesn't produce itself — `deriveLifecycleStatus` only reports it when told.
 */
export type LifecycleStatus = "NEW" | "TESTING" | "CERTIFIED" | "ACTIVE" | "DEGRADED" | "QUARANTINED";

export interface CertificationRecord {
  recordId: string;
  module: string;
  capability: string;
  /** The exact build this record certifies — never carries forward to a different build (Posudek 12 bod 6). */
  buildHash: string;
  riskProfile: string;
  requiredTests: string[];
  actualResults: Record<string, "PASS" | "FAIL">;
  /** Derived by certify() itself, never trusted from the caller — see certify()'s doc comment. */
  decision: "PASS" | "FAIL";
  certifiedAt: string;
}

export type CertificationInput = Pick<CertificationRecord, "module" | "capability" | "buildHash" | "riskProfile" | "requiredTests" | "actualResults">;

export type ActivationCheck = { ok: true; record: CertificationRecord } | { ok: false; reason: string };

/**
 * Build-bound certification (docs/SEVERKA.md `### Admission Gate`, Posudek 12 bod 6 / Posudek 14
 * point 6's priority list item 1: "`ACTIVE` musí být vázané na `CertificationRecord` konkrétního
 * `buildHash`"). Records are keyed by (module, buildHash) — an upgrade from v1.7 to v1.8 starts at
 * `NEW` for v1.8, never inherits v1.7's certification just because the module name is the same
 * (Milan's own example: "v1.8 NEW, nikoliv v1.8 ACTIVE protože moduleName je ACTIVE").
 *
 * **Not yet wired into `LifecycleRegistry`/`Router`** — this answers "is module+buildHash
 * certified", it does not gate a live dispatch on the deployed farm. Wiring it in changes
 * `Router.route()`'s fail-closed behavior on production traffic and needs the owner's decision
 * about `DEGRADED`'s dispatch semantics first (does DEGRADED still serve traffic, downgraded, or
 * fail closed like QUARANTINED?) — deliberately left as a separate, later step, same as Žlab/
 * Dojička/Konev are each "not yet wired into any real capability" on their own.
 */
export class CertificationRegistry {
  private readonly records = new Map<string, CertificationRecord>();

  constructor(private readonly clock: Clock) {}

  /**
   * Records a certification attempt. `decision` is derived here, not trusted from the caller:
   * `PASS` only if every name in `requiredTests` has `actualResults[name] === "PASS"` — a test
   * missing from `actualResults` counts as not passed, the same "absent fails the same as failed"
   * rule `policy.ts`'s `checkEffectFieldValidators()` already applies to evidence fields. A module
   * cannot certify itself as PASS by simply not running (or not reporting) an inconvenient test.
   */
  certify(input: CertificationInput): CertificationRecord {
    const decision: "PASS" | "FAIL" = input.requiredTests.every((t) => input.actualResults[t] === "PASS") ? "PASS" : "FAIL";
    const record: CertificationRecord = Object.freeze({
      recordId: newId("cert"),
      module: input.module,
      capability: input.capability,
      buildHash: input.buildHash,
      riskProfile: input.riskProfile,
      requiredTests: input.requiredTests,
      actualResults: input.actualResults,
      decision,
      certifiedAt: iso(this.clock.now()),
    });
    this.records.set(this.key(input.module, input.buildHash), record);
    return structuredClone(record);
  }

  get(module: string, buildHash: string): CertificationRecord | undefined {
    const r = this.records.get(this.key(module, buildHash));
    return r ? structuredClone(r) : undefined;
  }

  /** May `module` run at `runningBuildHash` as ACTIVE? Only with a PASS certification for exactly that build — never for a different build of the same module, however recently it was ACTIVE. */
  canActivate(module: string, runningBuildHash: string): ActivationCheck {
    const record = this.records.get(this.key(module, runningBuildHash));
    if (!record) return { ok: false, reason: `no certification record for ${module}@${runningBuildHash}` };
    if (record.decision !== "PASS") return { ok: false, reason: `certification for ${module}@${runningBuildHash} is FAIL, not PASS` };
    return { ok: true, record: structuredClone(record) };
  }

  private key(module: string, buildHash: string): string {
    return `${module}@${buildHash}`;
  }
}

/**
 * Pure derivation of the full lifecycle vocabulary from a certification lookup plus two live
 * signals this module doesn't itself produce: `admitted` (an operator or a future automated
 * verification runner explicitly moved a certified build into service — certification alone never
 * auto-activates, same "PASS doesn't mean deployed" distinction as CI green not meaning released)
 * and `degraded` (a future Argos/Safety Executor health signal). `quarantined` always wins — fail
 * closed regardless of certification history, same invariant `LifecycleRegistry` already enforces.
 */
export function deriveLifecycleStatus(input: { certification: CertificationRecord | undefined; admitted: boolean; degraded: boolean; quarantined: boolean }): LifecycleStatus {
  if (input.quarantined) return "QUARANTINED";
  if (!input.certification) return "NEW";
  if (input.certification.decision === "FAIL") return "QUARANTINED";
  if (!input.admitted) return "CERTIFIED";
  return input.degraded ? "DEGRADED" : "ACTIVE";
}
