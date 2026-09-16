// EntityHash + continuity (M0-FACT-CONTRACT-V1.md část B, krůček 2 UZAVŘENO 15. 9. 2026): how a "many"-scope
// entity (fact-catalog.ts's EntityDecl, e.g. a future invoice.line) is identified across re-extraction. Pure,
// platform-only logic — a cow never computes or claims an entityHash (B1), the same trust shape as EvidenceWriter
// stamping authorityDomain a cow cannot self-assert. No live producer calls this yet (no "many" entity has a real
// extractor — invoice.line is M2); this is the tested mechanism the first real one will wire into, the same order
// FactAddress (część A) was built before impulse.attachment gave it a first real subject.
import { sha256 } from "./artifacts.js";
import { canonicalize } from "./canonical.js";
import type { EvidenceCandidate } from "./evidence.js";
import type { EntityId } from "./fact-address.js";
import { newEntityId } from "./fact-address.js";

/**
 * sha256(canonicalize({ type, fields })) over only the entity's identityFields values (B1) — never derived
 * facts (accountCode, dimensionCode, bcNumber), so resolving a derived value never changes the hash and never
 * invalidates evidence built on it (B3). `fields` keys are identityField names; values are the cow's already
 * F2-normalized output (numbers as numbers) — canonicalize() sorts keys, so field order never matters (B4/ENT-001).
 */
export function computeEntityHash(type: string, fields: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalize({ type, fields }));
}

export interface EntitySnapshot {
  readonly entityId: EntityId;
  readonly entityHash: string;
}

export interface EntityAssignment extends EntitySnapshot {
  /** false when this row's hash matched a still-live entity from `liveEntities` and reused its id. */
  readonly isNew: boolean;
}

export interface ReconcileResult {
  /** One per entry of `newHashes`, same order — the id each new row should carry. */
  readonly assignments: readonly EntityAssignment[];
  /** Previously-live entities with no matching hash among the new rows — append a SUPERSEDED record for each (B5, ENT-005). */
  readonly superseded: readonly EntitySnapshot[];
}

/**
 * Assigns an EntityId to each freshly-extracted row (B4: deterministic function of content + order of
 * occurrence, never position — A4/B-adv-1). A new hash that matches a still-live entity's hash inherits its id;
 * duplicate hashes are paired in order of occurrence, one-for-one, never many-to-one (B-adv-3: two rows with
 * identical content are two entities, two ids, not one id reused twice). A live entity that matches nothing in
 * `newHashes` is reported as superseded — the caller appends its SUPERSEDED record (this function never writes
 * to the ledger itself, same read/decide-only shape as EvidenceAggregator).
 */
export function reconcileEntities(newHashes: readonly string[], liveEntities: readonly EntitySnapshot[]): ReconcileResult {
  const pool = new Map<string, EntityId[]>();
  for (const e of liveEntities) {
    const queue = pool.get(e.entityHash) ?? [];
    queue.push(e.entityId);
    pool.set(e.entityHash, queue);
  }
  const assignments: EntityAssignment[] = [];
  for (const entityHash of newHashes) {
    const queue = pool.get(entityHash);
    const reused = queue?.shift();
    assignments.push(reused !== undefined ? { entityHash, entityId: reused, isNew: false } : { entityHash, entityId: newEntityId(), isNew: true });
  }
  const superseded: EntitySnapshot[] = [];
  for (const [entityHash, remaining] of pool) for (const entityId of remaining) superseded.push({ entityId, entityHash });
  return { assignments, superseded };
}

/**
 * The EvidenceCandidate for a platform entity snapshot (M0 část B "Snapshot entity jako platformní záznam v
 * Žlabu" — no new mechanism, this is an ordinary Evidence record with a fixed shape). `inputField` is
 * `<type>@<entityId>` — deliberately NOT routed through fact-address.ts's parseFactAddress/formatFactAddress:
 * `type` here is an entity type name (fact-catalog.ts EntityDecl.type), not a dictionary fact key, so it is not
 * itself a FactCatalog entry and would fail FactAddress's UNKNOWN_KEY check. The textual shape matches on
 * purpose (same `key@entityId` grammar, journal/audit readers don't need a second parser) without claiming it
 * validates against the fact namespace.
 */
export function entitySnapshotCandidate(input: {
  tenantId: string;
  workflowId?: string;
  operationId?: string;
  buildHash: string;
  type: string;
  entityId: EntityId;
  entityHash: string;
  /** The artifact/extraction evidence this snapshot is derived from (verifyLineage walks these, unchanged). */
  parentRefs?: readonly string[];
  parentHashes?: readonly string[];
}): EvidenceCandidate {
  return {
    tenantId: input.tenantId,
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    producerId: "platform.entity",
    capabilityVersion: "1",
    buildHash: input.buildHash,
    authorityDomain: "platform",
    inputField: `${input.type}@${input.entityId}`,
    inputValueHash: input.entityHash,
    result: "OBSERVED",
    parentRefs: [...(input.parentRefs ?? [])],
    parentHashes: [...(input.parentHashes ?? [])],
  };
}
