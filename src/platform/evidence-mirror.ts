// Cross-case evidence mirror (docs/M0-FACT-CONTRACT-V1.md část D, step D-3): an insert-only copy of sealed evidence
// in a shared, asynchronous SQL database — Cloudflare D1 on the farm, node:sqlite in tests — so a NEW case can
// discover that a fact was already verified, by reference only. The mirror is a copy, never the source of truth
// (invariant D3): a row's existence proves nothing, only verify() over the full record does; losing the mirror loses
// the lookup, not integrity. Same pattern as the object's audit → D1 copy (deploy store.ts), same discipline as
// evidence-sqlite.ts: the complete statement set is exported and contains no UPDATE and no DELETE at all — a mirrored
// record never changes, and mirroring twice is a no-op (INSERT OR IGNORE on record_id), so a crash between "copied"
// and "marked as copied" in the object can be replayed safely.
import type { Evidence } from "./evidence.js";

/** The subset of an asynchronous SQL handle the mirror needs. D1 (prepare().bind().all()/run()) is adapted to it in deploy. */
export interface AsyncSql {
  all(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]>;
  run(query: string, ...bindings: unknown[]): Promise<void>;
}

/** What a lookup returns: enough to reference and later import (D-4) a record — never its result, never a value. */
export interface EvidenceRef {
  recordId: string;
  tenantId: string;
  inputField: string;
  inputValueHash: string;
  authorityDomain?: string;
  observedAt: string;
  expiresAt?: string;
  recordHash: string;
}

export interface EvidenceLookup {
  tenantId: string;
  inputField: string;
  inputValueHash: string;
  /** When given, only evidence stamped with exactly this authority domain; when absent, any (including inferred). */
  authorityDomain?: string;
  /** ISO instant from the caller's Clock — the platform never reads the system clock (VERIFICATION-CONTRACT §8.1). */
  now: string;
}

export interface EvidenceMirror {
  /** Idempotent on recordId: a second insert of the same record is a no-op, never an overwrite. */
  insert(record: Evidence): Promise<void>;
  /** Tenant-scoped by construction: tenantId is a mandatory part of every query, never optional. */
  lookup(q: EvidenceLookup): Promise<EvidenceRef[]>;
  /** The full sealed record for import (D-4). The caller must verify() it — the mirror is not trusted storage. */
  get(recordId: string): Promise<Evidence | undefined>;
}

const REF_COLUMNS = "record_id, tenant_id, input_field, input_value_hash, authority_domain, observed_at, expires_at, record_hash";

export const SQLITE_MIRROR_STATEMENTS = {
  ddl:
    "CREATE TABLE IF NOT EXISTS evidence_mirror (record_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, input_field TEXT NOT NULL, input_value_hash TEXT NOT NULL, authority_domain TEXT, observed_at TEXT NOT NULL, expires_at TEXT, record_hash TEXT NOT NULL, json TEXT NOT NULL)",
  ddlIndex: "CREATE INDEX IF NOT EXISTS evidence_mirror_lookup ON evidence_mirror (tenant_id, input_field, input_value_hash, authority_domain, expires_at)",
  insert:
    "INSERT OR IGNORE INTO evidence_mirror (record_id, tenant_id, input_field, input_value_hash, authority_domain, observed_at, expires_at, record_hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  get: "SELECT json FROM evidence_mirror WHERE record_id = ?",
  lookup: `SELECT ${REF_COLUMNS} FROM evidence_mirror WHERE tenant_id = ? AND input_field = ? AND input_value_hash = ? AND authority_domain = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY observed_at DESC, record_id`,
  lookupAnyAuthority: `SELECT ${REF_COLUMNS} FROM evidence_mirror WHERE tenant_id = ? AND input_field = ? AND input_value_hash = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY observed_at DESC, record_id`,
} as const;

export const EVIDENCE_MIRROR_DDL: readonly string[] = [SQLITE_MIRROR_STATEMENTS.ddl, SQLITE_MIRROR_STATEMENTS.ddlIndex];

const toRef = (row: Record<string, unknown>): EvidenceRef => ({
  recordId: row.record_id as string,
  tenantId: row.tenant_id as string,
  inputField: row.input_field as string,
  inputValueHash: row.input_value_hash as string,
  ...(row.authority_domain != null ? { authorityDomain: row.authority_domain as string } : {}),
  observedAt: row.observed_at as string,
  ...(row.expires_at != null ? { expiresAt: row.expires_at as string } : {}),
  recordHash: row.record_hash as string,
});

export class SqliteEvidenceMirror implements EvidenceMirror {
  constructor(private readonly sql: AsyncSql) {}

  async insert(record: Evidence): Promise<void> {
    await this.sql.run(
      SQLITE_MIRROR_STATEMENTS.insert,
      record.recordId,
      record.tenantId,
      record.inputField,
      record.inputValueHash,
      record.authorityDomain ?? null,
      record.observedAt,
      record.expiresAt ?? null,
      record.recordHash,
      JSON.stringify(record),
    );
  }

  async lookup(q: EvidenceLookup): Promise<EvidenceRef[]> {
    const rows =
      q.authorityDomain === undefined
        ? await this.sql.all(SQLITE_MIRROR_STATEMENTS.lookupAnyAuthority, q.tenantId, q.inputField, q.inputValueHash, q.now)
        : await this.sql.all(SQLITE_MIRROR_STATEMENTS.lookup, q.tenantId, q.inputField, q.inputValueHash, q.authorityDomain, q.now);
    return rows.map(toRef);
  }

  async get(recordId: string): Promise<Evidence | undefined> {
    const row = (await this.sql.all(SQLITE_MIRROR_STATEMENTS.get, recordId))[0];
    return row ? (JSON.parse(row.json as string) as Evidence) : undefined;
  }
}

/** The object-side half of mirroring: what SqliteEvidenceStore offers (evidence-sqlite.ts), structurally. */
export interface MirrorSource {
  unmirrored(): Evidence[];
  markMirrored(recordIds: readonly string[]): void;
}

/**
 * Copies every not-yet-mirrored record out of the object's store into the mirror, then marks them. Safe to rerun:
 * a crash after insert but before markMirrored() re-inserts nothing (INSERT OR IGNORE) and marks on the next pass.
 * Returns how many records this run copied.
 */
export async function mirrorEvidence(source: MirrorSource, mirror: EvidenceMirror): Promise<number> {
  const pending = source.unmirrored();
  for (const record of pending) await mirror.insert(record);
  source.markMirrored(pending.map((r) => r.recordId));
  return pending.length;
}
