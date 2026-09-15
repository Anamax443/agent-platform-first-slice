// Test-only SQL handle over node:sqlite with the same exec(query, ...bindings).toArray() shape the Durable Object's
// ctx.storage.sql has, so SqliteEvidenceStore runs its real statements against a real SQLite file in tests.
import { DatabaseSync } from "node:sqlite";
import type { AsyncSql } from "../../src/platform/evidence-mirror.js";
import type { SqlExec } from "../../src/platform/evidence-sqlite.js";

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
