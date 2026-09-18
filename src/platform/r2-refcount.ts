// Cross-Case R2 reference count (Reliability Gate item R0 — see docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 4's
// prerequisite list; NOT the same "R0" as docs/SEVERKA.md's unrelated riskClass enum "R0–R4 read-public →
// business-critical-write → ...", a name collision found while writing this module — a future ADR/docs entry for
// this Gate item should disambiguate the two by spelling this one out as "Reliability Gate R0" rather than bare
// "R0"). Found 2026-09-18 at commit 1d465dd, during the project owner's second/deeper audit ("can this run for
// months with near-zero human attention", verdict: operational resilience — recovery, idempotency, durable
// scheduling, storage lifecycle, independent monitoring — lags the security/semantic foundation): purge()
// (deploy/cloudflare/apf-gateway/src/index.ts) deletes every R2 object an instance's artifacts point to,
// unconditionally, with zero check for another Case sharing the same content-addressed key. That sharing is real
// and by design — the same `${derived/originals}/${tenantId}/${sha256}` key formula is independently computed at
// purge(), at copyOut(), at startIntake() (pre-DO, confirming cross-Case dedup already happens before any Durable
// Object exists) and in apf-document-host/src/artifact-relay.ts's relayDerivedArtifact() — so two Cases that ever
// receive byte-identical content (a forwarded email, a resent PDF) can come to share one R2 object; purging one of
// them today would silently delete the other's evidence out from under it. Repo-wide grep for an existing guard
// (refCount, reference count) at this commit: zero hits — nothing catches this today.
//
// Shape modeled deliberately on evidence-mirror.ts (AsyncSql, a Sqlite*Mirror class, a DDL constant, a pure
// idempotent orchestration function), not on artifact-registration.ts: that split-module exists only because it
// needs SqliteArtifacts' *synchronous* SqlStorage-typed methods (see its own header comment) — this feature is a
// cross-DO *asynchronous* D1 mirror, the exact shape evidence-mirror.ts already is, already wired into store.ts
// (a `xOf(db: D1Database)` factory) and index.ts, and already unit-tested against node:sqlite via
// tests/harness/sqlite.ts's existing openAsyncSql() (see tests/zlab-mirror.test.ts). Reusing that primitive here
// means this module needs zero new test infrastructure.
//
// Semantics (Approach A from the judged patch plan; Approach B — keying R2 objects by artifactId instead of
// content hash — was rejected: it touches 6+ read call sites and forfeits real production storage-dedup economics,
// independently reconfirmed against this commit's source, not just carried over from a prior pass's claim):
// every artifact copyOut() has ever seen registers an (r2Key, workflowId) row; purge() releases this instance's own
// row and only deletes the R2 object when no row for that key remains anywhere. A single composite PRIMARY KEY
// (r2Key, workflowId) does double duty: INSERT OR IGNORE makes re-registration on every copyOut() cycle a no-op
// (no unbounded row growth, no separate "already registered" bookkeeping needed), and SQLite indexes a composite
// PK on its leftmost column for free, so `WHERE r2_key = ?` (hasAny) is already covered — unlike evidence_mirror's
// table, this one needs no separate index.
import type { AsyncSql } from "./evidence-mirror.js";

/** Shared D1 table: one row per (R2 key, owning workflow). Insert-only except for the one DELETE release() issues. */
export const R2_REF_DDL = "CREATE TABLE IF NOT EXISTS r2_ref (r2_key TEXT NOT NULL, workflow_id TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (r2_key, workflow_id))";

export interface R2RefCounter {
  /** Idempotent: registering the same (r2Key, workflowId) twice — one Case's own duplicate attachment, or a second copyOut() cycle on the same object — is a no-op. */
  addRef(r2Key: string, workflowId: string, tenantId: string): Promise<void>;
  /** Removes this workflow's own claim on r2Key. Releasing a claim that was never registered (or already released) is also a no-op. */
  release(r2Key: string, workflowId: string): Promise<void>;
  /** Whether any workflow still claims r2Key. */
  hasAny(r2Key: string): Promise<boolean>;
}

export class SqliteR2RefCounter implements R2RefCounter {
  constructor(private readonly sql: AsyncSql) {}

  async addRef(r2Key: string, workflowId: string, tenantId: string): Promise<void> {
    await this.sql.run("INSERT OR IGNORE INTO r2_ref (r2_key, workflow_id, tenant_id) VALUES (?, ?, ?)", r2Key, workflowId, tenantId);
  }

  async release(r2Key: string, workflowId: string): Promise<void> {
    await this.sql.run("DELETE FROM r2_ref WHERE r2_key = ? AND workflow_id = ?", r2Key, workflowId);
  }

  async hasAny(r2Key: string): Promise<boolean> {
    const rows = await this.sql.all("SELECT 1 AS present FROM r2_ref WHERE r2_key = ? LIMIT 1", r2Key);
    return rows.length > 0;
  }
}

/**
 * Registers every given (r2Key, workflowId, tenantId) claim. Called from copyOut() with `this.artifacts.list()`
 * (ALL held artifacts) rather than `.uncopied()`: binary/external originals are inserted already `copied = 1`
 * (SqliteArtifacts.store(), store.ts) because they arrive already in R2 (location set) — so a loop keyed off
 * `.uncopied()` would never see them and a purged Case's shared binary original would look unreferenced from the
 * first moment, defeating the whole point of this module. Sequential await-in-a-loop, not `env.AUDIT.batch()`, to
 * match mirrorEvidence()'s own idiom (evidence-mirror.ts) exactly rather than introduce a second, inconsistent
 * bulk-write pattern for what is already a background/non-latency-sensitive path (copyOut() runs under
 * ctx.waitUntil()).
 */
export async function registerR2Refs(entries: readonly { r2Key: string; workflowId: string; tenantId: string }[], counter: R2RefCounter): Promise<number> {
  for (const e of entries) await counter.addRef(e.r2Key, e.workflowId, e.tenantId);
  return entries.length;
}

/**
 * The release-then-check-remaining-refs purge() needs: drop this workflow's own claim, then report whether any
 * other Case still claims the same key. `safeToDelete: false` means at least one other workflow_id row remains for
 * r2Key — purge() must skip the R2 delete. `safeToDelete: true` covers two cases purge() cannot tell apart from
 * this return value alone (see tests/artifact-refcount.test.ts's own doc comment on this, and Residual risk in the
 * commit this module ships with): a key that really is now unreferenced by anyone, AND a key some other Case has
 * written to R2 and registered in *its own* artifact table but whose copyOut() has not yet reached D1 (the
 * ctx.waitUntil() timing race — copyOut() runs after its own request already returned, typically well under a
 * second later, but not zero) — deliberately left open (see this commit's message) rather than closed by making
 * artifact registration synchronous inside intake()/mailIntake()'s own request path.
 */
export async function releaseR2Ref(r2Key: string, workflowId: string, counter: R2RefCounter): Promise<{ safeToDelete: boolean }> {
  await counter.release(r2Key, workflowId);
  return { safeToDelete: !(await counter.hasAny(r2Key)) };
}
