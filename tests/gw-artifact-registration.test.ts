// GW-ARTIFACT-REG family: apf-gateway's counterpart to the notify-step production bug (found live on farm-bass443,
// every mail-intake instance, all day 2026-09-17 — see tests/dh.test.ts's DH-ARTIFACT-RELAY-001 for the
// apf-document-host side). document.stamp's derived artifact was never registered back with the gateway at all, so
// email.send's GET /workflow/:id/artifact/:stampedArtifactId always 404d and resourceTenant() failed closed with
// RESOURCE_TENANT_UNRESOLVED. The fix adds a write path for that registration (POST /workflow/:id/artifact ->
// WorkflowInstance.registerDerivedArtifact -> registerDerived below -> SqliteArtifacts.putExternal); this file proves
// registerDerived's decision logic, including the defense-in-depth ownership checks a remote host must not be able
// to bypass.
//
// registerDerived (deploy/cloudflare/apf-gateway/src/artifact-registration.ts) is deliberately split out of store.ts
// so it can be imported here at all: store.ts's SqliteArtifacts is typed against the ambient SqlStorage global
// throughout the file, which only resolves under deploy/cloudflare/tsconfig.json, not the root one this test file is
// checked under. TestArtifactStore below is a small real-SQL (node:sqlite) mirror of SqliteArtifacts' relevant
// get()/putExternal() surface — same insert-only-immutable contract, same column set — standing in for it so this
// still runs against genuine SQL (tests/zlab-durable.test.ts's direct-against-a-real-SQLite-file pattern), not a bare
// mock that could pass while the real query shape is wrong.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/platform/artifacts.js";
import { registerDerived, type ArtifactLookup, type DerivedArtifactRegistration } from "../deploy/cloudflare/apf-gateway/src/artifact-registration.js";
import { tmpDir } from "./harness/index.js";
import { openSql, type NodeSql } from "./harness/sqlite.js";

const ARTIFACT_DDL =
  "CREATE TABLE IF NOT EXISTS artifact (artifact_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sha256 TEXT NOT NULL, derived_from TEXT, content_type TEXT, byte_length INTEGER, location TEXT, received_from TEXT NOT NULL, name TEXT)";

/** Mirrors SqliteArtifacts (store.ts): insert-only, a second write to an existing id throws (EVD-001). */
class TestArtifactStore implements ArtifactLookup {
  constructor(private readonly sql: NodeSql) {
    this.sql.exec(ARTIFACT_DDL);
  }

  get(artifactId: string): Artifact | undefined {
    const row = this.sql.exec("SELECT * FROM artifact WHERE artifact_id = ?", artifactId).toArray()[0];
    if (!row) return undefined;
    return {
      artifactId: row.artifact_id as string,
      tenantId: row.tenant_id as string,
      sha256: row.sha256 as string,
      bytes: "",
      receivedAt: "",
      receivedFrom: row.received_from as string,
      ...(row.derived_from ? { derivedFrom: row.derived_from as string } : {}),
      ...(row.content_type ? { contentType: row.content_type as string } : {}),
      ...(typeof row.byte_length === "number" ? { byteLength: row.byte_length } : {}),
      ...(row.location ? { location: row.location as string } : {}),
      ...(row.name ? { name: row.name as string } : {}),
    };
  }

  putExternal(input: DerivedArtifactRegistration): Artifact {
    if (this.get(input.artifactId)) throw new Error(`artifact ${input.artifactId} already exists: artifacts are immutable`);
    this.sql.exec(
      "INSERT INTO artifact (artifact_id, tenant_id, sha256, derived_from, content_type, byte_length, location, received_from, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.artifactId,
      input.tenantId,
      input.sha256,
      input.derivedFrom ?? null,
      input.contentType,
      input.byteLength,
      input.location,
      input.receivedFrom,
      input.name ?? null,
    );
    return this.get(input.artifactId) as Artifact;
  }

  /** Seeds an original directly, as if this instance's own intake() had put() it (no registration path involved). */
  seedOriginal(artifactId: string, tenantId: string): void {
    this.sql.exec(
      "INSERT INTO artifact (artifact_id, tenant_id, sha256, derived_from, content_type, byte_length, location, received_from, name) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)",
      artifactId,
      tenantId,
      "sha-original",
      "text/plain",
      7,
      "originals/tenant-a/sha-original",
      "gateway",
    );
  }
}

const registration = (overrides: Partial<DerivedArtifactRegistration> = {}): DerivedArtifactRegistration => ({
  artifactId: "art-stamped-001",
  tenantId: "tenant-a",
  sha256: "sha-stamped",
  contentType: "text/plain; charset=utf-8",
  byteLength: 42,
  location: "derived/tenant-a/sha-stamped",
  receivedFrom: "apf-document-host",
  derivedFrom: "art-original-001",
  ...overrides,
});

describe("GW-ARTIFACT-REG-001 registerDerived rejects a remote host's own artifactId/derivedFrom/tenantId claims that don't check out", () => {
  it("INSTANCE_NOT_FOUND: rejects when the targeted instance doesn't exist, and never touches the store", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);

    const result = registerDerived(store, undefined, registration());
    expect(result).toEqual({ ok: false, reason: "INSTANCE_NOT_FOUND" });
    expect(store.get("art-stamped-001")).toBeUndefined();
  });

  it("DERIVED_FROM_NOT_OWNED: rejects when derivedFrom names an artifact this instance never held, and never registers it (the actual defense-in-depth: a remote host cannot attribute a derived artifact to an original it doesn't already know this instance owns)", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);
    // Deliberately do NOT seed "art-original-001" — it is not this instance's artifact.

    const result = registerDerived(store, "tenant-a", registration({ derivedFrom: "art-original-001" }));
    expect(result).toEqual({ ok: false, reason: "DERIVED_FROM_NOT_OWNED" });
    expect(store.get("art-stamped-001")).toBeUndefined();
  });

  it("registers the artifact under the id the remote host already minted, carrying derivedFrom, once every check passes — this is what makes GET /workflow/:id/artifact/:stampedArtifactId resolve where it 404d before (the notify-step bug itself)", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);
    store.seedOriginal("art-original-001", "tenant-a");

    const result = registerDerived(store, "tenant-a", registration());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.artifact.artifactId).toBe("art-stamped-001"); // the caller's own pre-assigned id, not a fresh one
    expect(result.artifact.derivedFrom).toBe("art-original-001");
    expect(result.artifact.tenantId).toBe("tenant-a");
    expect(result.artifact.location).toBe("derived/tenant-a/sha-stamped");

    // And it is now genuinely retrievable — the property GET /workflow/:id/artifact/:id depends on.
    expect(store.get("art-stamped-001")).toMatchObject({ artifactId: "art-stamped-001", derivedFrom: "art-original-001", tenantId: "tenant-a" });
  });

  it("derivedFrom omitted skips the ownership check entirely (a registration that is not claiming to derive from anything this instance holds), but the tenantId check still runs", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);

    const result = registerDerived(store, "tenant-a", registration({ derivedFrom: undefined }));
    expect(result.ok).toBe(true);
  });

  // GW-ARTIFACT-REG-001, majors 2 and 3 of the 2026-09-17 review of this exact fix: the ownership check verified
  // derivedFrom was owned by the instance, but never cross-checked the caller's claimed tenantId against the
  // instance's real tenant (or the owned original's real tenant) — mirroring auditClaimContradicts()'s check on the
  // /audit route (page.ts / index.ts) for the identical "a compromised or buggy remote host claims an arbitrary
  // tenantId" threat, which this endpoint had not closed.
  it("TENANT_MISMATCH: rejects when the claimed tenantId contradicts the instance's real tenant, even with derivedFrom omitted (a caller cannot plant a record under a tenant this instance doesn't belong to just by not claiming a derivedFrom)", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);

    const result = registerDerived(store, "tenant-a", registration({ tenantId: "tenant-evil", derivedFrom: undefined }));
    expect(result).toEqual({ ok: false, reason: "TENANT_MISMATCH" });
    expect(store.get("art-stamped-001")).toBeUndefined();
  });

  it("TENANT_MISMATCH: rejects even when derivedFrom legitimately names an artifact this instance owns — owning the original does not license claiming an unrelated tenantId for the derived record (the exact spoof the review found: a caller could pass a derivedFrom it owns together with an arbitrary tenantId)", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);
    store.seedOriginal("art-original-001", "tenant-a");

    const result = registerDerived(store, "tenant-a", registration({ tenantId: "tenant-evil" }));
    expect(result).toEqual({ ok: false, reason: "TENANT_MISMATCH" });
    expect(store.get("art-stamped-001")).toBeUndefined();
  });

  it("DERIVED_FROM_NOT_OWNED: rejects when the owned original's real tenantId disagrees with the instance's own tenant, even though the claimed tenantId matches the instance (second, independent leg of the ownership check — owned.tenantId !== instanceTenantId, catching a mismatch the first tenantId check alone would miss)", () => {
    const file = join(tmpDir(), "artifacts.sqlite");
    const { sql } = openSql(file);
    const store = new TestArtifactStore(sql);
    store.seedOriginal("art-original-001", "tenant-a"); // the "original" actually belongs to tenant-a...

    // ...but this instance is tenant-b, and the caller correctly claims tenant-b for the derived artifact (passes
    // the first, instance-vs-claim check) — only the second, artifact-vs-instance check catches the inconsistency.
    const result = registerDerived(store, "tenant-b", registration({ tenantId: "tenant-b" }));
    expect(result).toEqual({ ok: false, reason: "DERIVED_FROM_NOT_OWNED" });
    expect(store.get("art-stamped-001")).toBeUndefined();
  });
});
