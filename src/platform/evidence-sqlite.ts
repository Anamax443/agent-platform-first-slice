// Durable Žlab storage (docs/M0-FACT-CONTRACT-V1.md část D, step D-2): an EvidenceStore over a synchronous SQLite
// connection. Structurally typed against the one call the Durable Object's ctx.storage.sql actually offers
// (exec(query, ...bindings).toArray()), so the very same class runs unchanged inside workerd (SqlStorage), under
// node:sqlite in tests, and later on the on-prem farm — with no Cloudflare import in src/platform (ARCH-DEP-001).
//
// Append-only by construction (D1 invariant): the complete statement set is exported below and consists of
// CREATE / INSERT / SELECT plus exactly one UPDATE that touches the `mirrored` bookkeeping flag and no other column
// (ZLAB-DUR-002 asserts this over the statement text, the same way ZLAB-005 asserts the ledger's own surface).
// `INSERT`, never `INSERT OR REPLACE`: a second row with an existing record_id must fail, not overwrite.
import type { Evidence, EvidenceStore } from "./evidence.js";

/** The subset of a synchronous SQL handle this store needs. Cloudflare's SqlStorage satisfies it structurally. */
export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export const SQLITE_EVIDENCE_STATEMENTS = {
  ddl:
    "CREATE TABLE IF NOT EXISTS evidence (seq INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, workflow_id TEXT, producer_id TEXT NOT NULL, input_field TEXT NOT NULL, input_value_hash TEXT NOT NULL, authority_domain TEXT, expires_at TEXT, json TEXT NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0)",
  /** The cross-case lookup shape of part D (D-3): tenant + address + value hash + authority, filtered by expiry. */
  ddlIndex: "CREATE INDEX IF NOT EXISTS evidence_lookup ON evidence (tenant_id, input_field, input_value_hash, authority_domain, expires_at)",
  insert:
    "INSERT INTO evidence (record_id, tenant_id, workflow_id, producer_id, input_field, input_value_hash, authority_domain, expires_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  get: "SELECT json FROM evidence WHERE record_id = ?",
  forTenant: "SELECT json FROM evidence WHERE tenant_id = ? ORDER BY seq",
  unmirrored: "SELECT json FROM evidence WHERE mirrored = 0 ORDER BY seq",
  markMirrored: "UPDATE evidence SET mirrored = 1 WHERE record_id = ?",
} as const;

/** Run once at store construction time by whoever owns the connection (the Durable Object's DDL pass, a test). */
export const EVIDENCE_DDL: readonly string[] = [SQLITE_EVIDENCE_STATEMENTS.ddl, SQLITE_EVIDENCE_STATEMENTS.ddlIndex];

const parse = (row: Record<string, unknown>): Evidence => JSON.parse(row.json as string) as Evidence;

export class SqliteEvidenceStore implements EvidenceStore {
  constructor(private readonly sql: SqlExec) {}

  put(record: Evidence): void {
    this.sql.exec(
      SQLITE_EVIDENCE_STATEMENTS.insert,
      record.recordId,
      record.tenantId,
      record.workflowId ?? null,
      record.producerId,
      record.inputField,
      record.inputValueHash,
      record.authorityDomain ?? null,
      record.expiresAt ?? null,
      JSON.stringify(record),
    );
  }

  get(recordId: string): Evidence | undefined {
    const row = this.sql.exec(SQLITE_EVIDENCE_STATEMENTS.get, recordId).toArray()[0];
    return row ? parse(row) : undefined;
  }

  forTenant(tenantId: string): Evidence[] {
    return this.sql.exec(SQLITE_EVIDENCE_STATEMENTS.forTenant, tenantId).toArray().map(parse);
  }

  /** D1 mirror bookkeeping (part D, D-3): records not yet copied out, in write order. The records themselves never change. */
  unmirrored(): Evidence[] {
    return this.sql.exec(SQLITE_EVIDENCE_STATEMENTS.unmirrored).toArray().map(parse);
  }

  markMirrored(recordIds: readonly string[]): void {
    for (const id of recordIds) this.sql.exec(SQLITE_EVIDENCE_STATEMENTS.markMirrored, id);
  }
}
