// Test-only SQL handle over node:sqlite with the same exec(query, ...bindings).toArray() shape the Durable Object's
// ctx.storage.sql has, so SqliteEvidenceStore runs its real statements against a real SQLite file in tests.
import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../../src/platform/clock.js";
import type { AsyncSql } from "../../src/platform/evidence-mirror.js";
import type { SqlExec } from "../../src/platform/evidence-sqlite.js";
import type { IdempotencyRecord, IdempotencyStore } from "../../src/platform/idempotency.js";
import type { HandlerOutcome } from "../../src/platform/types.js";

// node:sqlite prints one ExperimentalWarning per process; it would otherwise land as noise in every test run.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
  return (originalEmitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

type Binding = string | number | bigint | null;

export class NodeSql implements SqlExec {
  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } {
    const stmt = this.db.prepare(query);
    const args = bindings.map((b) => (b === undefined ? null : b)) as Binding[];
    if (/^\s*SELECT\b/i.test(query)) {
      const rows = stmt.all(...args) as Record<string, unknown>[];
      return { toArray: () => rows };
    }
    stmt.run(...args);
    return { toArray: () => [] };
  }
}

export const openSql = (file: string): { sql: NodeSql; close: () => void } => {
  const db = new DatabaseSync(file);
  return { sql: new NodeSql(db), close: () => db.close() };
};

/** The asynchronous shape D1 has on the farm (evidence-mirror.ts AsyncSql), over the same node:sqlite file. */
export class NodeAsyncSql implements AsyncSql {
  constructor(private readonly db: DatabaseSync) {}

  async all(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> {
    return this.db.prepare(query).all(...(bindings.map((b) => (b === undefined ? null : b)) as Binding[])) as Record<string, unknown>[];
  }

  async run(query: string, ...bindings: unknown[]): Promise<void> {
    this.db.prepare(query).run(...(bindings.map((b) => (b === undefined ? null : b)) as Binding[]));
  }
}

export const openAsyncSql = (file: string): { sql: NodeAsyncSql; raw: DatabaseSync; close: () => void } => {
  const db = new DatabaseSync(file);
  return { sql: new NodeAsyncSql(db), raw: db, close: () => db.close() };
};

/**
 * R1 (Reliability Gate, 2026-09-18 audit): the same "idempotency" table deploy/cloudflare/apf-gateway/src/store.ts's
 * SqliteIdempotencyStore creates and reads — kept as a literal string constant here (not imported from store.ts)
 * for the identical reason tests/gw-artifact-registration.test.ts's own header comment gives for TestArtifactStore:
 * store.ts's classes are typed against the ambient SqlStorage/D1Database Workers globals, which resolve only under
 * deploy/cloudflare/tsconfig.json ("types": ["@cloudflare/workers-types", "node"]), not the root tsconfig
 * tests/**\/*.ts are checked under ("types": ["node"]) — importing store.ts here fails `npm run typecheck` with
 * "Cannot find name 'SqlStorage'" (verified locally: `npx tsc --noEmit` before this workaround). `npm run
 * farm:check` (`tsc -p deploy/cloudflare/tsconfig.json`) is what actually typechecks store.ts itself.
 */
export const IDEMPOTENCY_DDL =
  "CREATE TABLE IF NOT EXISTS idempotency (dedup_key TEXT PRIMARY KEY, status TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL)";

/**
 * Test-only, real-SQL (node:sqlite) mirror of SqliteIdempotencyStore's four methods, same table, same statements,
 * same three-state (absent / RESERVED / DONE) lifecycle as InMemoryIdempotencyStore (src/platform/idempotency.ts)
 * — see IDEMPOTENCY_DDL's own comment above for why this cannot just import the real class. A passing test against
 * this class is evidence about the real one's SQL shape (identical statements, hand-kept in sync), not a substitute
 * for exercising the real class — farm:check's own tsc pass is what actually typechecks SqliteIdempotencyStore.
 */
export class TestIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly sql: NodeSql,
    private readonly clock: Clock,
  ) {}

  async peek(dedupKey: string): Promise<IdempotencyRecord | undefined> {
    const row = this.sql.exec("SELECT * FROM idempotency WHERE dedup_key = ?", dedupKey).toArray()[0];
    if (!row) return undefined;
    return {
      status: row.status as "RESERVED" | "DONE",
      fingerprint: row.fingerprint as string,
      ...(row.outcome_json ? { outcome: JSON.parse(row.outcome_json as string) as HandlerOutcome } : {}),
    };
  }

  async reserveOrGet(dedupKey: string, fingerprint: string): Promise<IdempotencyRecord | undefined> {
    const existing = await this.peek(dedupKey);
    if (existing) return existing;
    this.sql.exec(
      "INSERT INTO idempotency (dedup_key, status, fingerprint, outcome_json, created_at) VALUES (?, 'RESERVED', ?, NULL, ?)",
      dedupKey,
      fingerprint,
      this.clock.now().toISOString(),
    );
    return undefined;
  }

  async resolve(dedupKey: string, outcome: HandlerOutcome): Promise<void> {
    this.sql.exec("UPDATE idempotency SET status = 'DONE', outcome_json = ? WHERE dedup_key = ?", JSON.stringify(outcome), dedupKey);
  }

  async release(dedupKey: string): Promise<void> {
    this.sql.exec("DELETE FROM idempotency WHERE dedup_key = ?", dedupKey);
  }
}
