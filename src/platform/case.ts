// Case (M0-FACT-CONTRACT-V1.md část 0 "Impuls a Case", krůček 5 UZAVŘENO 16. 9. 2026; implementation část E):
// a container over one NormalizedImpulse — one impulse, one Žlab, N workflow instances over time (discovery,
// then processing, possibly re-processing). Replaces today's WorkflowInstance-is-the-object simplification
// (src/platform/journal.ts's Instance = exactly one workflow) — but only the type and its append-only instance
// list, additive, alongside the existing Instance/Journal, exactly as this project has built every other M0
// part today (mechanism first, live wiring once a real producer exists). apf-gateway's intake paths
// (index.ts:672/1317/1746, channel -> workflow) still create a bare Instance directly; nothing here is wired
// into them yet — that migration is its own future step, not part of E-1.
import type { Instance, InstanceStatus } from "./journal.js";

/** A minimal pointer to an already-stored Artifact (artifacts.ts) — one impulse may carry several (attachments). */
export interface ArtifactRef {
  readonly artifactId: string;
}

/**
 * The single shape every ingress channel normalizes into (part 0's hard invariant: the channel carries the
 * impulse, it never determines intent/goal/workflow). Structurally has no workflow/goal/intent field — an
 * ingress adapter cannot smuggle a routing decision through it even by mistake (same defense as EvidenceClaim
 * having no tenantId field for a cow to fill in).
 */
export interface NormalizedImpulse {
  readonly impulseId: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly sender?: string;
  readonly receivedAt: string;
  readonly text?: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly thread?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * One impulse, one Žlab, N workflow instances in time. `instances` holds workflowIds only (journal.ts's
 * Journal is still the source of truth for each Instance's own state) — append-only, oldest first, exactly the
 * "discovery, then processing, possibly re-processing" shape part 0 describes.
 *
 * Deliberately NOT included here: a `ledger` field. Today's EvidenceLedger is tenant-scoped
 * (evidence.ts/evidence-sqlite.ts), not case-scoped — part 0's sketch of "one Žlab per Case" is a future
 * durable-store partitioning decision, not something this type should pretend already exists by embedding a
 * runtime object reference in what is otherwise a plain, journal-serializable record.
 *
 * `status` mirrors the InstanceStatus of the single instance a migrated Case wraps (M0 today's shape: exactly
 * one instance). A Case that genuinely outlives one instance (re-processing after correction) needs its own
 * status lifecycle — not decided yet, out of scope for E-1.
 */
export interface Case {
  readonly caseId: string;
  readonly tenantId: string;
  readonly impulse: NormalizedImpulse;
  readonly instances: readonly string[];
  readonly status: InstanceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class CaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseError";
  }
}

/** A fresh Case around one impulse and its first workflow instance. tenantId must agree — a Case can never span tenants (same boundary as every other tenant-scoped record). */
export function newCase(input: { caseId: string; impulse: NormalizedImpulse; instance: Pick<Instance, "workflowId" | "tenantId" | "status" | "createdAt" | "updatedAt"> }): Case {
  if (input.impulse.tenantId !== input.instance.tenantId) {
    throw new CaseError(`impulse tenantId ${input.impulse.tenantId} does not match instance tenantId ${input.instance.tenantId} — a Case cannot span tenants`);
  }
  return {
    caseId: input.caseId,
    tenantId: input.instance.tenantId,
    impulse: input.impulse,
    instances: [input.instance.workflowId],
    status: input.instance.status,
    createdAt: input.instance.createdAt,
    updatedAt: input.instance.updatedAt,
  };
}

/**
 * Appends a new workflow instance to an existing Case (re-processing after a correction, or a second explicit
 * goal derived from the same impulse) — never removes or reorders `instances` (append-only, same discipline as
 * the Žlab and Audit). Refuses a workflowId already present (idempotency: adding the same instance twice would
 * silently duplicate history) and a tenantId mismatch.
 */
export function addInstance(c: Case, instance: Pick<Instance, "workflowId" | "tenantId" | "status" | "updatedAt">): Case {
  if (instance.tenantId !== c.tenantId) throw new CaseError(`instance tenantId ${instance.tenantId} does not match case tenantId ${c.tenantId}`);
  if (c.instances.includes(instance.workflowId)) throw new CaseError(`workflowId ${instance.workflowId} is already part of case ${c.caseId} — instances is append-only, never re-added`);
  return { ...c, instances: [...c.instances, instance.workflowId], status: instance.status, updatedAt: instance.updatedAt };
}
