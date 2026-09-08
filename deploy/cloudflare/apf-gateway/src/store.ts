// Durable Object SQLite behind the platform's synchronous stores: journal (JournalStore), audit (AuditTrail) and
// artifacts (ArtifactWriter). Synchronous on purpose: the orchestrator and the read-only handlers run inside the object,
// where ctx.storage.sql is synchronous and every transition is durable before the next call (RES-CRASH-001).
// R2 (originals, immutable) and D1 (shared audit trail) receive asynchronous copies afterwards; the object is the source
// of truth for the instance. Binary originals (PDF, images) are the one exception: they live in R2 only (`location`) and
// the object keeps their metadata plus the text derived from them.
import type { AuditKind, AuditRecord, AuditTrail } from "../../../../src/platform/audit.js";
import { sha256, type Artifact, type ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { Clock } from "../../../../src/platform/clock.js";
import { iso } from "../../../../src/platform/clock.js";
import { newId } from "../../../../src/platform/ids.js";
import type { Instance, JournalStore } from "../../../../src/platform/journal.js";
import type { ReviewTask, ReviewTaskStore } from "../../../../src/platform/review.js";

export const DDL = [
  "CREATE TABLE IF NOT EXISTS instance (workflow_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, kind TEXT NOT NULL, correlation_id TEXT, workflow_id TEXT, json TEXT NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS artifact (artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sha256 TEXT NOT NULL, received_at TEXT NOT NULL, received_from TEXT NOT NULL, derived_from TEXT, producer TEXT, content_type TEXT, byte_length INTEGER, location TEXT, name TEXT, bytes TEXT NOT NULL, copied INTEGER NOT NULL DEFAULT 0)",
  // Found 2026-09-08 (docs/OPONENTURA-BEZPECNOST-STABILITA.md #1): ReviewService's in-memory Map meant a decision
  // could never find the task that created it on a deployed Worker — there was no decision path at all. This table
  // is that missing durability; SqliteReviewTaskStore below is the only thing that reads/writes it.
  "CREATE TABLE IF NOT EXISTS review (review_task_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL)",
];

/** Shared D1 trail: the same record shape, one row per audit record, insert-only. */
export const D1_AUDIT_DDL =
  "CREATE TABLE IF NOT EXISTS audit (audit_id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, correlation_id TEXT, workflow_id TEXT, tenant_id TEXT, actor_id TEXT, capability TEXT, json TEXT NOT NULL)";

const parseJson = <T>(row: Record<string, SqlStorageValue>): T => JSON.parse(row.json as string) as T;

export class SqliteJournal implements JournalStore {
  constructor(private readonly sql: SqlStorage) {}

  get(workflowId: string): Instance | undefined {
    const row = this.sql.exec("SELECT json FROM instance WHERE workflow_id = ?", workflowId).toArray()[0];
    return row ? parseJson<Instance>(row) : undefined;
  }

  put(instance: Instance): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO instance (workflow_id, status, updated_at, json) VALUES (?, ?, ?, ?)",
      instance.workflowId,
      instance.status,
      instance.updatedAt,
      JSON.stringify(instance),
    );
  }

  list(): Instance[] {
    return this.sql.exec("SELECT json FROM instance ORDER BY updated_at").toArray().map((r) => parseJson<Instance>(r));
  }
}

/** Insert-only. The `mirrored` flag is bookkeeping for the D1 copy; the record itself is never changed (EVD-004). */
export class SqliteAudit implements AuditTrail {
  constructor(
    private readonly sql: SqlStorage,
    private readonly clock: Clock,
  ) {}

  append(record: Omit<AuditRecord, "auditId" | "at">): AuditRecord {
    const full: AuditRecord = { auditId: newId("aud"), at: iso(this.clock.now()), ...record };
    this.sql.exec(
      "INSERT INTO audit (audit_id, at, kind, correlation_id, workflow_id, json) VALUES (?, ?, ?, ?, ?, ?)",
      full.auditId,
      full.at,
      full.kind,
      full.correlationId ?? null,
      full.workflowId ?? null,
      JSON.stringify(full),
    );
    // Console output too, not just the DO's own storage: every audit-worthy event narrated live in wrangler
    // tail / Workers Logs, so a run can be followed step by step without querying the instance afterward.
    console.log(`[apf-gateway] ${full.kind} ${full.capability ?? ""} workflowId=${full.workflowId ?? "-"} correlationId=${full.correlationId ?? "-"} :: ${JSON.stringify(full.details ?? {})}`);
    return structuredClone(full);
  }

  all(): readonly AuditRecord[] {
    return this.sql.exec("SELECT json FROM audit ORDER BY seq").toArray().map((r) => parseJson<AuditRecord>(r));
  }

  byKind(kind: AuditKind): AuditRecord[] {
    return this.all().filter((r) => r.kind === kind);
  }

  byCorrelation(correlationId: string): AuditRecord[] {
    return this.all().filter((r) => r.correlationId === correlationId);
  }

  unmirrored(): AuditRecord[] {
    return this.sql.exec("SELECT json FROM audit WHERE mirrored = 0 ORDER BY seq").toArray().map((r) => parseJson<AuditRecord>(r));
  }

  markMirrored(auditIds: string[]): void {
    for (const id of auditIds) this.sql.exec("UPDATE audit SET mirrored = 1 WHERE audit_id = ?", id);
  }
}

const rowToArtifact = (r: Record<string, SqlStorageValue>): Artifact => ({
  artifactId: r.artifact_id as string,
  tenantId: r.tenant_id as string,
  sha256: r.sha256 as string,
  bytes: r.bytes as string,
  receivedAt: r.received_at as string,
  receivedFrom: r.received_from as string,
  ...(r.derived_from ? { derivedFrom: r.derived_from as string } : {}),
  ...(r.producer ? { producer: r.producer as string } : {}),
  ...(r.content_type ? { contentType: r.content_type as string } : {}),
  ...(typeof r.byte_length === "number" ? { byteLength: r.byte_length } : {}),
  ...(r.location ? { location: r.location as string } : {}),
  ...(r.name ? { name: r.name as string } : {}),
});

/** A binary original that already sits in R2: the object keeps metadata only (`bytes` empty, `location` set). */
export interface ExternalOriginal {
  tenantId: string;
  receivedFrom: string;
  sha256: string;
  contentType: string;
  byteLength: number;
  location: string;
  name?: string;
}

/** Immutable originals and derivations (EVD-001): insert-only, a second write to an id is a programming error. */
export class SqliteArtifacts implements ArtifactWriter {
  constructor(
    private readonly sql: SqlStorage,
    private readonly clock: Clock,
  ) {}

  put(input: { tenantId: string; bytes: string; receivedFrom: string; contentType?: string }): Artifact {
    const a: Artifact = {
      artifactId: newId("art"),
      tenantId: input.tenantId,
      sha256: sha256(input.bytes),
      bytes: input.bytes,
      receivedAt: iso(this.clock.now()),
      receivedFrom: input.receivedFrom,
      contentType: input.contentType ?? "text/plain",
      byteLength: new TextEncoder().encode(input.bytes).byteLength,
    };
    this.store(a);
    return { ...a };
  }

  putExternal(input: ExternalOriginal): Artifact {
    const a: Artifact = {
      artifactId: newId("art"),
      tenantId: input.tenantId,
      sha256: input.sha256,
      bytes: "",
      receivedAt: iso(this.clock.now()),
      receivedFrom: input.receivedFrom,
      contentType: input.contentType,
      byteLength: input.byteLength,
      location: input.location,
      ...(input.name ? { name: input.name } : {}),
    };
    this.store(a);
    return { ...a };
  }

  derive(originalId: string, bytes: string, producer: string, contentType = "text/markdown"): Artifact {
    const orig = this.get(originalId);
    if (!orig) throw new Error(`original ${originalId} not found`);
    const a: Artifact = {
      artifactId: newId("art"),
      tenantId: orig.tenantId,
      sha256: sha256(bytes),
      bytes,
      receivedAt: iso(this.clock.now()),
      receivedFrom: producer,
      derivedFrom: originalId,
      producer,
      contentType,
      byteLength: new TextEncoder().encode(bytes).byteLength,
    };
    this.store(a);
    return { ...a };
  }

  get(artifactId: string): Artifact | undefined {
    const row = this.sql.exec("SELECT * FROM artifact WHERE artifact_id = ?", artifactId).toArray()[0];
    return row ? rowToArtifact(row) : undefined;
  }

  list(): Artifact[] {
    return this.sql.exec("SELECT * FROM artifact ORDER BY received_at, artifact_id").toArray().map(rowToArtifact);
  }

  /** Text artifacts not yet copied to R2 (binary originals are in R2 from the start, so they are stored as copied). */
  uncopied(): Artifact[] {
    return this.sql.exec("SELECT * FROM artifact WHERE copied = 0 ORDER BY received_at").toArray().map(rowToArtifact);
  }

  markCopied(artifactId: string): void {
    this.sql.exec("UPDATE artifact SET copied = 1 WHERE artifact_id = ?", artifactId);
  }

  private store(a: Artifact): void {
    if (this.get(a.artifactId)) throw new Error(`artifact ${a.artifactId} already exists: artifacts are immutable`);
    this.sql.exec(
      "INSERT INTO artifact (artifact_id, tenant_id, sha256, received_at, received_from, derived_from, producer, content_type, byte_length, location, name, bytes, copied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      a.artifactId,
      a.tenantId,
      a.sha256,
      a.receivedAt,
      a.receivedFrom,
      a.derivedFrom ?? null,
      a.producer ?? null,
      a.contentType ?? null,
      a.byteLength ?? null,
      a.location ?? null,
      a.name ?? null,
      a.bytes,
      a.location ? 1 : 0,
    );
  }
}

/** Durable backing for ReviewService (W: see DDL comment above) — one row per review task, replaced whole on every write. */
export class SqliteReviewTaskStore implements ReviewTaskStore {
  constructor(private readonly sql: SqlStorage) {}

  get(id: string): ReviewTask | undefined {
    const row = this.sql.exec("SELECT json FROM review WHERE review_task_id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.json as string) as ReviewTask) : undefined;
  }

  set(id: string, task: ReviewTask): void {
    this.sql.exec("INSERT OR REPLACE INTO review (review_task_id, workflow_id, status, json) VALUES (?, ?, ?, ?)", id, task.workflowId, task.status, JSON.stringify(task));
  }

  all(): ReviewTask[] {
    return this.sql.exec("SELECT json FROM review").toArray().map((r) => JSON.parse(r.json as string) as ReviewTask);
  }
}
