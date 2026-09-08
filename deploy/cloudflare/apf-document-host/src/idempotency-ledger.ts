// Durable Object backing ExecutorHost's idempotency store on this Worker (SEVERKA.md item 2, Posudek 5/6).
// apf-document-host is otherwise stateless: ExecutorHost is rebuilt fresh on every /dispatch and its default
// in-memory IdempotencyStore dedups nothing across requests or isolates. One object per dedup key
// (idFromName in index.ts) gives the atomic check-then-reserve the design needs for free, because Cloudflare
// serializes every request to the same Durable Object instance — a genuine concurrent duplicate delivery
// cannot race past the reservation the way a stateless D1 read-then-write could.
import { DurableObject } from "cloudflare:workers";

const DDL = "CREATE TABLE IF NOT EXISTS ledger (dedup_key TEXT PRIMARY KEY, status TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL)";

export interface LedgerRecord {
  status: "RESERVED" | "DONE";
  fingerprint: string;
  outcomeJson?: string;
}

const toRecord = (row: Record<string, SqlStorageValue>): LedgerRecord => ({
  status: row.status as "RESERVED" | "DONE",
  fingerprint: row.fingerprint as string,
  ...(row.outcome_json ? { outcomeJson: row.outcome_json as string } : {}),
});

export class IdempotencyLedger extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(DDL);
  }

  /** Read-only; never reserves. Mirrors src/platform/idempotency.ts's IdempotencyStore.peek. */
  peek(dedupKey: string): LedgerRecord | undefined {
    const row = this.ctx.storage.sql.exec("SELECT * FROM ledger WHERE dedup_key = ?", dedupKey).toArray()[0];
    return row ? toRecord(row) : undefined;
  }

  /** Atomic within this object: unseen key -> reserved and returns undefined; seen key -> the existing record. */
  reserveOrGet(dedupKey: string, fingerprint: string): LedgerRecord | undefined {
    const existing = this.peek(dedupKey);
    if (existing) return existing;
    this.ctx.storage.sql.exec(
      "INSERT INTO ledger (dedup_key, status, fingerprint, outcome_json, created_at) VALUES (?, 'RESERVED', ?, NULL, ?)",
      dedupKey,
      fingerprint,
      new Date().toISOString(),
    );
    return undefined;
  }

  /** A reservation resolves to a durable, dedupable outcome (SUCCEEDED / UNKNOWN_OUTCOME). */
  resolve(dedupKey: string, outcomeJson: string): void {
    this.ctx.storage.sql.exec("UPDATE ledger SET status = 'DONE', outcome_json = ? WHERE dedup_key = ?", outcomeJson, dedupKey);
  }

  /** A reservation is abandoned (outcome was FAILED before any side effect) — a later attempt may reserve again. */
  release(dedupKey: string): void {
    this.ctx.storage.sql.exec("DELETE FROM ledger WHERE dedup_key = ?", dedupKey);
  }
}
