// Cross-case evidence import (docs/M0-FACT-CONTRACT-V1.md část D, step D-4): a NEW case that found, by reference
// (evidence-mirror.ts lookup), that a fact was already verified elsewhere pulls the sealed record — and every
// ancestor its lineage points at — out of the mirror into its own ledger, then appends an IMPORTED marker that
// records the reuse as a fact of this case. From then on verify()/verifyLineage() run purely locally: the original
// object may be evicted or purged, the mirror may be lost — the case still holds the whole signed chain.
//
// Fail-closed at every step, in this order: tenant (never even verify another tenant's record), integrity (the
// mirror is not trusted storage — only the signature is), expiry of the root, id conflict. Nothing is written
// unless everything passes; ancestors are imported before the record that references them.
//
// Not decided here: whether a Dojička accepts an imported record whose own workflowId is the OLD case (today's
// aggregator compares workflowId when the evidence declares one — Posudek 16 P1-8). That is the goal-contract
// rule of milestone M5, not storage.
import type { Evidence, EvidenceLedger } from "./evidence.js";
import type { EvidenceMirror } from "./evidence-mirror.js";

export const IMPORT_PRODUCER = "platform.import";
export const IMPORT_RESULT = "IMPORTED";
export const PLATFORM_AUTHORITY = "platform";

export interface ImportTarget {
  tenantId: string;
  workflowId: string;
  /** ISO instant from the caller's Clock — an expired root is not worth importing. */
  now: string;
  /** The importing deployable's build, stamped on the marker like on any platform-produced evidence. */
  buildHash: string;
}

export type ImportFailure = "NOT_FOUND" | "TENANT_MISMATCH" | "INTEGRITY_FAILED" | "EXPIRED" | "ID_CONFLICT";

export type ImportResult =
  | { ok: true; original: Evidence; marker: Evidence; imported: string[]; alreadyPresent: boolean }
  | { ok: false; reason: ImportFailure; recordId: string; detail: string };

export async function importEvidence(ledger: EvidenceLedger, mirror: EvidenceMirror, recordId: string, into: ImportTarget): Promise<ImportResult> {
  // 1. Resolve the whole ancestry from the mirror first — nothing is written until every record passed.
  const chain = new Map<string, Evidence>(); // insertion order = ancestors first
  const resolve = async (id: string, isRoot: boolean): Promise<ImportResult | undefined> => {
    if (chain.has(id)) return undefined;
    const record = await mirror.get(id);
    if (!record) return { ok: false, reason: "NOT_FOUND", recordId: id, detail: isRoot ? "not in the mirror" : `ancestor of ${recordId} not in the mirror` };
    if (record.tenantId !== into.tenantId) return { ok: false, reason: "TENANT_MISMATCH", recordId: id, detail: `record belongs to another tenant` };
    const check = ledger.verify(record);
    if (!check.ok) return { ok: false, reason: "INTEGRITY_FAILED", recordId: id, detail: check.reason };
    if (isRoot && record.expiresAt !== undefined && record.expiresAt <= into.now) {
      return { ok: false, reason: "EXPIRED", recordId: id, detail: `expired ${record.expiresAt}, now ${into.now}` };
    }
    for (const parentId of record.parentRefs) {
      const failure = await resolve(parentId, false);
      if (failure) return failure;
    }
    chain.set(id, record);
    return undefined;
  };
  const failure = await resolve(recordId, true);
  if (failure) return failure;
  const original = chain.get(recordId) as Evidence;

  // 2. Reuse an existing marker rather than stacking one per call: the reuse of this record by this case is one fact.
  const existingMarker = ledger
    .forTenant(into.tenantId)
    .find((r) => r.producerId === IMPORT_PRODUCER && r.workflowId === into.workflowId && r.parentRefs[0] === recordId && r.parentHashes[0] === original.recordHash);

  // 3. Store the chain, ancestors first. importSealed is idempotent for identical records and refuses id conflicts.
  const imported: string[] = [];
  for (const record of chain.values()) {
    let outcome: "IMPORTED" | "ALREADY_PRESENT";
    try {
      outcome = ledger.importSealed(record);
    } catch (e) {
      return { ok: false, reason: "ID_CONFLICT", recordId: record.recordId, detail: String((e as Error).message) };
    }
    if (outcome === "IMPORTED") imported.push(record.recordId);
  }
  const alreadyPresent = !imported.includes(recordId);

  if (existingMarker) return { ok: true, original, marker: existingMarker, imported, alreadyPresent };
  const marker = ledger.append({
    tenantId: into.tenantId,
    workflowId: into.workflowId,
    producerId: IMPORT_PRODUCER,
    capabilityVersion: "1",
    buildHash: into.buildHash,
    authorityDomain: PLATFORM_AUTHORITY,
    inputField: original.inputField,
    inputValueHash: original.inputValueHash,
    result: IMPORT_RESULT,
    parentRefs: [original.recordId],
    parentHashes: [original.recordHash],
  });
  return { ok: true, original, marker, imported, alreadyPresent };
}
