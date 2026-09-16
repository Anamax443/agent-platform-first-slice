// FactAddress (M0-FACT-CONTRACT-V1.md část A, R1, krůček 1 UZAVŘENO 15. 9. 2026): how one fact is addressed.
// A key alone for the reserved CASE_SCOPE (one value per Case); key + platform-issued EntityId for a "many"
// scope like "invoice.line" (docs/M0-FACT-CONTRACT-V1.md's own example — not a real entity yet, see fact-catalog.ts's
// EntityDecl). No index form exists (A4): a row's position in a re-extracted list is never its identity, only
// its EntityHash is (část B). entityId is opaque and platform-issued (newEntityId(), same newId() family as every
// other platform id) — a cow can only ever return one back, never invent one (A3), same trust shape as tenantId
// in EvidenceClaim.
import { newId } from "./ids.js";
import type { FactCatalog } from "./fact-catalog.js";
import { CASE_SCOPE } from "./fact-catalog.js";

export type EntityId = string;

/** Platform-only prefix+time+random id family (ids.ts) — never a cow's own value, never positional. */
export const ENTITY_ID_PATTERN = /^ent-[a-z0-9]+$/;

export interface FactAddress {
  readonly key: string;
  /** Always present after normalization — CASE_SCOPE when the fact declares no scope of its own. */
  readonly scope: string;
  /** Present iff scope's multiplicity is "many". */
  readonly entityId?: EntityId;
}

/** Exactly 0 or 1 "@"; the part before is the dictionary key, the part after (if any) matches ENTITY_ID_PATTERN. */
const CANONICAL = /^([^@]+)(?:@([^@]+))?$/;

export type FactAddressErrorCode = "MALFORMED" | "UNKNOWN_KEY" | "INVALID_ENTITY_ID" | "ENTITY_ID_REQUIRED" | "ENTITY_ID_FORBIDDEN";

export class FactAddressError extends Error {
  constructor(
    readonly code: FactAddressErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FactAddressError";
  }
}

/** A fresh, opaque, platform-issued entity id — never derived from or influenced by business content (A3). */
export function newEntityId(): EntityId {
  return newId("ent");
}

/**
 * Parses the canonical textual form used by the journal, Konev.fieldHashes and Evidence.inputField/audit —
 * "supplier.companyId" (CASE_SCOPE) or "invoice.line.accountCode@ent-…" (a "many" scope, exactly one "@").
 * Validated against a FactCatalog so a malformed or unknown key never silently becomes an address (A1/A2).
 */
export function parseFactAddress(text: string, catalog: FactCatalog): FactAddress {
  const m = CANONICAL.exec(text);
  if (!m) throw new FactAddressError("MALFORMED", `${JSON.stringify(text)} has more than one "@" — a fact address names exactly one entity, never a path`);
  const key = m[1] as string;
  const entityId = m[2];
  const scope = catalog.scopeOf(key);
  if (scope === undefined) throw new FactAddressError("UNKNOWN_KEY", `${JSON.stringify(key)} is not in the fact namespace`);
  const decl = catalog.entityOf(scope);
  const isMany = decl !== undefined;
  if (entityId !== undefined && !ENTITY_ID_PATTERN.test(entityId)) throw new FactAddressError("INVALID_ENTITY_ID", `${JSON.stringify(text)}: ${JSON.stringify(entityId)} is not a platform entity id`);
  if (isMany && entityId === undefined) throw new FactAddressError("ENTITY_ID_REQUIRED", `${key}: scope ${JSON.stringify(scope)} has multiplicity "many" — an address without an entityId is ambiguous`);
  if (!isMany && entityId !== undefined) throw new FactAddressError("ENTITY_ID_FORBIDDEN", `${key}: scope ${JSON.stringify(scope)} is a singleton (${scope === CASE_SCOPE ? "the reserved case scope" : 'multiplicity "one"'}) — it never takes an entityId`);
  return entityId === undefined ? { key, scope } : { key, scope, entityId };
}

/** Inverse of parseFactAddress — round-trips (FACT-006): key for CASE_SCOPE/"one", key@entityId for "many". */
export function formatFactAddress(addr: FactAddress): string {
  return addr.entityId === undefined ? addr.key : `${addr.key}@${addr.entityId}`;
}
