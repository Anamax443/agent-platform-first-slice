// Durable Object SQLite behind the platform's synchronous stores: journal (JournalStore), audit (AuditTrail) and
// artifacts (ArtifactWriter). Synchronous on purpose: the orchestrator and the read-only handlers run inside the object,
// where ctx.storage.sql is synchronous and every transition is durable before the next call (RES-CRASH-001).
// R2 (originals, immutable) and D1 (shared audit trail) receive asynchronous copies afterwards; the object is the source
// of truth for the instance. Binary originals (PDF, images) are the one exception: they live in R2 only (`location`) and
// the object keeps their metadata plus the text derived from them.
import type { AuditKind, AuditRecord, AuditTrail } from "../../../../src/platform/audit.js";
import { sha256, type Artifact, type ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { Case, CaseStore } from "../../../../src/platform/case.js";
import type { Clock } from "../../../../src/platform/clock.js";
import { iso } from "../../../../src/platform/clock.js";
import { newId } from "../../../../src/platform/ids.js";
import { EVIDENCE_MIRROR_DDL, SqliteEvidenceMirror, type AsyncSql } from "../../../../src/platform/evidence-mirror.js";
import { EVIDENCE_DDL, SqliteEvidenceStore } from "../../../../src/platform/evidence-sqlite.js";
import { R2_REF_DDL, SqliteR2RefCounter } from "../../../../src/platform/r2-refcount.js";
import type { IdempotencyRecord, IdempotencyStore } from "../../../../src/platform/idempotency.js";
import type { Instance, JournalStore } from "../../../../src/platform/journal.js";
import type { ReviewTask, ReviewTaskStore } from "../../../../src/platform/review.js";
import type { HandlerOutcome } from "../../../../src/platform/types.js";

/**
 * Durable Žlab (docs/M0-FACT-CONTRACT-V1.md část D, D-2): the platform's SqliteEvidenceStore runs unchanged over
 * ctx.storage.sql — this factory exists so `farm:check` proves at compile time that SqlStorage satisfies the platform's
 * structural SqlExec. Nothing writes evidence live yet (EvidenceWriter wiring is D-5); the table is created by the
 * object's DDL pass so a deployed object is ready for it.
 */
export const evidenceStoreOf = (sql: SqlStorage): SqliteEvidenceStore => new SqliteEvidenceStore(sql);

/** Shared D1 copy of the Žlab (part D, D-3): insert-only, lookup by reference. Same database as the audit trail, its own table. */
export const D1_EVIDENCE_DDL: readonly string[] = EVIDENCE_MIRROR_DDL;

/** D1 behind the platform's AsyncSql: prepare().bind().all()/run(). */
export const d1Sql = (db: D1Database): AsyncSql => ({
  all: async (query, ...bindings) => (await db.prepare(query).bind(...bindings).all<Record<string, unknown>>()).results,
  run: async (query, ...bindings) => {
    await db.prepare(query).bind(...bindings).run();
  },
});

export const evidenceMirrorOf = (db: D1Database): SqliteEvidenceMirror => new SqliteEvidenceMirror(d1Sql(db));

/**
 * Shared D1 reference count for R2 objects two Cases can come to share by content hash (Reliability Gate R0, found
 * 2026-09-18 at commit 1d465dd: purge() deleted a shared R2 object with zero reference check — see
 * src/platform/r2-refcount.ts's own header for the full finding and why this module is modeled on evidenceMirrorOf
 * just above rather than on artifact-registration.ts's ambient-type split). Same one-line factory pattern.
 */
export const D1_R2_REF_DDL: string = R2_REF_DDL;
export const r2RefCounterOf = (db: D1Database): SqliteR2RefCounter => new SqliteR2RefCounter(d1Sql(db));

export const DDL = [
  ...EVIDENCE_DDL,
  "CREATE TABLE IF NOT EXISTS instance (workflow_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)",
  // Case (Commit 3, M0-FACT-CONTRACT-V1.md część 0/E follow-up): DO-local SQLite only, same simpler pattern as
  // `instance` above — unlike Audit/Evidence, Instance has no D1 mirror, and a Case is 1:1 with the same object
  // that already holds its member instances' own journal rows, so there is nothing to reconcile across objects
  // that a mirror would earn its keep on. `case_instance_index` is the workflowId -> caseId lookup CaseStore's
  // own interface calls for (byWorkflowId()) — kept as its own tiny table rather than a query over `json` so the
  // lookup stays an indexed point read, not a per-call JSON scan.
  "CREATE TABLE IF NOT EXISTS case_record (case_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS case_instance_index (workflow_id TEXT PRIMARY KEY, case_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, kind TEXT NOT NULL, correlation_id TEXT, workflow_id TEXT, json TEXT NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS artifact (artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sha256 TEXT NOT NULL, received_at TEXT NOT NULL, received_from TEXT NOT NULL, derived_from TEXT, producer TEXT, content_type TEXT, byte_length INTEGER, location TEXT, name TEXT, bytes TEXT NOT NULL, copied INTEGER NOT NULL DEFAULT 0)",
  // Found 2026-09-08 (docs/OPONENTURA-BEZPECNOST-STABILITA.md #1): ReviewService's in-memory Map meant a decision
  // could never find the task that created it on a deployed Worker — there was no decision path at all. This table
  // is that missing durability; SqliteReviewTaskStore below is the only thing that reads/writes it.
  "CREATE TABLE IF NOT EXISTS review (review_task_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL)",
  // R1 of the 2026-09-18 Reliability Gate audit (owner's second, deeper pass after the P0 semantic-primitive
  // pass at 1d465dd — "než dáme Farmě větší autonomii, musí se nejdřív sama umět bezpečně probudit, zopakovat,
  // usmířit neznámý výsledek..."): executor-host.ts:90 (`opts.idempotency ?? new InMemoryIdempotencyStore()`)
  // meant every ExecutorHost this object builds — including the one behind mail.ingest — fell back to an
  // in-memory Map that is lost on every restart/eviction of this very Durable Object, so a RESERVED reservation
  // (a write intent in flight, not yet resolved) simply vanished if the object was evicted mid-attempt. This
  // table is that missing durability, same role as `review` above: SqliteIdempotencyStore below is the only
  // thing that reads/writes it. Shaped like apf-document-host/src/idempotency-ledger.ts's own `ledger` table
  // (dedup_key/status/fingerprint/outcome_json/created_at) so the two stay recognizably the same design — one
  // in-process (per Durable Object, keyed by orchestrator.ts:245's `${workflowId}:${stepId}:${strategy}:${n}`),
  // the other cross-object (one IdempotencyLedger DO per dedup key) — rather than diverging for no reason.
  // Deliberately NOT what this fixes: two independent deliveries of the same physical e-mail still mint two
  // different workflowIds (index.ts's `startMailIntake()` calls `newId("wf")` before any dedup key exists), so
  // no per-instance table, however durable, can see across that boundary — that is IdempotencyLedger's job
  // (Approach B), a deliberately separate, out-of-scope gap tracked as the next Reliability Gate item, not
  // built here (2026-09-18 judged patch plan: smallest change that closes THIS item's own stated gap — "loses
  // dedup reservations on restart" — reusing ctx.storage.sql exactly as the tables above already do, no new
  // Durable Object class, binding or migration on a Worker that is processing live mail right now).
  "CREATE TABLE IF NOT EXISTS idempotency (dedup_key TEXT PRIMARY KEY, status TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL)",
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

/**
 * Durable Case store (Commit 3), exactly mirroring SqliteJournal's own constructor/pattern above: one object,
 * one SQLite connection, no cross-object reconciliation. `put()` re-indexes every one of `c.instances` into
 * `case_instance_index` on every call — c.instances is small (mail-intake plus a handful of fanned-out
 * attachment-classify/attachment-extract instances, not hundreds), so re-writing the whole index on each growth
 * step is simpler than diffing against what was indexed last time, and INSERT OR REPLACE makes it idempotent.
 */
export class SqliteCaseStore implements CaseStore {
  constructor(private readonly sql: SqlStorage) {}

  get(caseId: string): Case | undefined {
    const row = this.sql.exec("SELECT json FROM case_record WHERE case_id = ?", caseId).toArray()[0];
    return row ? parseJson<Case>(row) : undefined;
  }

  put(c: Case): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO case_record (case_id, tenant_id, status, updated_at, json) VALUES (?, ?, ?, ?, ?)",
      c.caseId,
      c.tenantId,
      c.status,
      c.updatedAt,
      JSON.stringify(c),
    );
    for (const workflowId of c.instances) {
      this.sql.exec("INSERT OR REPLACE INTO case_instance_index (workflow_id, case_id) VALUES (?, ?)", workflowId, c.caseId);
    }
  }

  list(): Case[] {
    return this.sql.exec("SELECT json FROM case_record ORDER BY updated_at").toArray().map((r) => parseJson<Case>(r));
  }

  byWorkflowId(workflowId: string): Case | undefined {
    const row = this.sql.exec("SELECT case_id FROM case_instance_index WHERE workflow_id = ?", workflowId).toArray()[0];
    if (!row) return undefined;
    return this.get(row.case_id as string);
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

/**
 * A binary original that already sits in R2: the object keeps metadata only (`bytes` empty, `location` set). Also
 * reused for an artifact a remote executor host derived out-of-process (apf-document-host's document.stamp) and
 * copied to R2 itself — that caller already minted `artifactId` (it returned it to the workflow step, e.g.
 * document.stamp's stampedArtifactId) and knows which original it derived it from (`derivedFrom`), so both are
 * optional inputs here rather than always freshly assigned (RESOURCE_TENANT_UNRESOLVED notify-step bug, found live
 * on farm-bass443 2026-09-17: a derived artifact nobody ever registered back here could never be found by
 * GET /workflow/:id/artifact/:id, so email.send's resourceTenant() 404d every single time).
 */
export interface ExternalOriginal {
  tenantId: string;
  receivedFrom: string;
  sha256: string;
  contentType: string;
  byteLength: number;
  location: string;
  name?: string;
  /** Pre-assigned by the caller (a remote host that already returned this id to a workflow step); minted here when absent. */
  artifactId?: string;
  derivedFrom?: string;
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
      artifactId: input.artifactId ?? newId("art"),
      tenantId: input.tenantId,
      sha256: input.sha256,
      bytes: "",
      receivedAt: iso(this.clock.now()),
      receivedFrom: input.receivedFrom,
      contentType: input.contentType,
      byteLength: input.byteLength,
      location: input.location,
      ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
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

const rowToIdempotency = (r: Record<string, SqlStorageValue>): IdempotencyRecord => ({
  status: r.status as "RESERVED" | "DONE",
  fingerprint: r.fingerprint as string,
  ...(r.outcome_json ? { outcome: JSON.parse(r.outcome_json as string) as HandlerOutcome } : {}),
});

/**
 * Durable backing for ExecutorHost's dedup (R1, see the `idempotency` DDL comment above for the full citation
 * trail). One row per dedup key, `INSERT`ed as RESERVED by `reserveOrGet()` and later `UPDATE`d to DONE by
 * `resolve()` or removed by `release()` — the same three-state lifecycle InMemoryIdempotencyStore already has
 * (src/platform/idempotency.ts), just durable across this object's own restart instead of living in a Map.
 * Every method is declared `async` even though the body underneath is synchronous SQL (ctx.storage.sql, like
 * every other Sqlite*Store in this file): `IdempotencyStore` is a Promise-typed interface, because it is also
 * implemented by a `DurableIdempotencyStore`-shaped adapter in apf-document-host/apf-email-executor that calls
 * across a DO stub (a genuine network hop) — JournalStore/CaseStore/ReviewTaskStore above have no such sibling
 * and so stayed synchronous; this class's signature has to match the interface it implements, not its own body.
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly clock: Clock,
  ) {}

  async peek(dedupKey: string): Promise<IdempotencyRecord | undefined> {
    const row = this.sql.exec("SELECT * FROM idempotency WHERE dedup_key = ?", dedupKey).toArray()[0];
    return row ? rowToIdempotency(row) : undefined;
  }

  async reserveOrGet(dedupKey: string, fingerprint: string): Promise<IdempotencyRecord | undefined> {
    const existing = await this.peek(dedupKey);
    if (existing) return existing;
    // `created_at` is written but not yet read by anything (no TTL/expiry pass exists for a RESERVED row that is
    // never resolved or released — flagged explicitly in the 2026-09-18 audit as a follow-up, not this change):
    // kept now so that follow-up is a read/cleanup pass later, not a second schema migration on a live object.
    this.sql.exec(
      "INSERT INTO idempotency (dedup_key, status, fingerprint, outcome_json, created_at) VALUES (?, 'RESERVED', ?, NULL, ?)",
      dedupKey,
      fingerprint,
      iso(this.clock.now()),
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
