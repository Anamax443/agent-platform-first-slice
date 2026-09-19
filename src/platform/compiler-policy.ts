// Per-installation compiler output policy (config/<installation>/compiler.json, część 6 krok 8): the workflow-level
// knobs a compiled WorkflowDef needs (deadline, conformance tier, review roles, the compiler's own output-format
// version) that have no safe universal default. Unlike AuthorityRegistry/GoalMapRegistry there is deliberately no
// empty(): a guessed deadline of 0 or an invented role would be worse than refusing to compile, so an installation
// without compiler.json simply cannot compile — the caller (runCaseDiscovery()) decides what to do with that
// (SKIPPED, audited, same shape as "no evidence ledger wired"), this file never invents a fallback. Mirrors
// authorities.ts/goal-map.ts's own hand-written, closed-vocabulary, fail-closed validator style.
import type { WorkflowDef } from "./orchestrator.js";

export interface CompilerPolicyJson {
  schemaVersion: string;
  /** The compiler's own output-format version, stamped as every compiled WorkflowDef's workflowVersion — not
   * goal- or plan-specific (that lives in the workflow name itself, compiler.ts's own content hash). Bump this
   * only when compiler.ts's translation rules themselves change. */
  workflowVersion: string;
  deadlineMs: number;
  conformanceTier: WorkflowDef["conformanceTier"];
  operatorRole: string;
  supervisorRole: string;
}

export class CompilerPolicyError extends Error {
  constructor(message: string) {
    super(`compiler.json: ${message}`);
    this.name = "CompilerPolicyError";
  }
}

const CONFORMANCE_TIERS: readonly WorkflowDef["conformanceTier"][] = ["exact", "semantic", "property", "ai-eval"];
/** Same shape as workflow-definition.schema.json's own "workflowVersion"/"role" patterns — a compiled WorkflowDef
 * must satisfy the identical schema a hand-written one does, so this validates against the same alphabet. */
const VERSION_PATTERN = /^[0-9]+$/;
const ROLE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

export class CompilerPolicy {
  private constructor(
    readonly workflowVersion: string,
    readonly deadlineMs: number,
    readonly conformanceTier: WorkflowDef["conformanceTier"],
    readonly operatorRole: string,
    readonly supervisorRole: string,
  ) {}

  static build(json: unknown): CompilerPolicy {
    const p = json as CompilerPolicyJson;
    if (!p || typeof p !== "object") throw new CompilerPolicyError("not an object");
    if (p.schemaVersion !== "1") throw new CompilerPolicyError(`expected schemaVersion "1", got ${JSON.stringify(p.schemaVersion)}`);
    if (typeof p.workflowVersion !== "string" || !VERSION_PATTERN.test(p.workflowVersion)) {
      throw new CompilerPolicyError(`workflowVersion must be a numeric string, got ${JSON.stringify(p.workflowVersion)}`);
    }
    if (typeof p.deadlineMs !== "number" || !Number.isInteger(p.deadlineMs) || p.deadlineMs < 1) {
      throw new CompilerPolicyError(`deadlineMs must be a positive integer, got ${JSON.stringify(p.deadlineMs)}`);
    }
    if (!CONFORMANCE_TIERS.includes(p.conformanceTier)) {
      throw new CompilerPolicyError(`conformanceTier must be one of ${CONFORMANCE_TIERS.join(", ")}, got ${JSON.stringify(p.conformanceTier)}`);
    }
    if (typeof p.operatorRole !== "string" || !ROLE_PATTERN.test(p.operatorRole)) throw new CompilerPolicyError(`operatorRole ${JSON.stringify(p.operatorRole)} is not a valid role`);
    if (typeof p.supervisorRole !== "string" || !ROLE_PATTERN.test(p.supervisorRole)) throw new CompilerPolicyError(`supervisorRole ${JSON.stringify(p.supervisorRole)} is not a valid role`);
    return new CompilerPolicy(p.workflowVersion, p.deadlineMs, p.conformanceTier, p.operatorRole, p.supervisorRole);
  }
}
