// ZLAB-DUR-004/005 (docs/M0-FACT-CONTRACT-V1.md část D, D-3): the cross-case mirror. Two separate SQLite files play
// the object's store and the shared D1: records are copied out idempotently, a copied row is never trusted on its
// own (only the signature is), and a lookup is tenant-scoped, expiry-aware and returns references without values.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/platform/clock.js";
import { EvidenceLedger, verifyEvidence, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { EVIDENCE_MIRROR_DDL, mirrorEvidence, SQLITE_MIRROR_STATEMENTS, SqliteEvidenceMirror } from "../src/platform/evidence-mirror.js";
import { EVIDENCE_DDL, SqliteEvidenceStore } from "../src/platform/evidence-sqlite.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
import { generateKeyPair } from "../src/platform/signing.js";
import { tmpDir } from "./harness/index.js";
import { openAsyncSql, openSql } from "./harness/sqlite.js";

const START = "2026-09-15T08:00:00Z";
const LATER = "2026-10-20T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const ICO_HASH = "sha256-of-12345678";

function candidate(overrides: Partial<EvidenceCandidate> & { inputField?: string } = {}): EvidenceCandidate {
  const { inputField, ...rest } = overrides;
  return {
    tenantId: TENANT_A,
    producerId: "cz.company.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    subject: { key: inputField ?? "supplier.companyId", scope: CASE_SCOPE },
    inputValueHash: ICO_HASH,
    result: "ACTIVE",
    parentRefs: [],
    parentHashes: [],
    ...rest,
  };
}

async function farm() {
  const dir = tmpDir();
  const keyPair = generateKeyPair();
  const object = openSql(join(dir, "object.sqlite"));
  for (const s of EVIDENCE_DDL) object.sql.exec(s);
  const store = new SqliteEvidenceStore(object.sql);
  const ledger = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }, store);
  const d1 = openAsyncSql(join(dir, "d1.sqlite"));
  for (const s of EVIDENCE_MIRROR_DDL) await d1.sql.run(s);
  const mirror = new SqliteEvidenceMirror(d1.sql);
  return { store, ledger, mirror, d1, publicKey: keyPair.publicKey, close: () => (object.close(), d1.close()) };
}

describe("ZLAB-DUR-004 the mirror is a copy, never trusted storage — the signature is", () => {
  it("mirroring copies pending records once, is idempotent on rerun, and a copied record verifies through the ledger", async () => {
    const f = await farm();
    const a = f.ledger.append(candidate({ authorityDomain: "cz.company.registry", expiresAt: "2026-10-15T08:00:00Z" }));
    const b = f.ledger.append(candidate({ inputField: "supplier.vatId", inputValueHash: "sha256-of-dic" }));
    expect(await mirrorEvidence(f.store, f.mirror)).toBe(2);
    expect(f.store.unmirrored()).toEqual([]);
    expect(await mirrorEvidence(f.store, f.mirror)).toBe(0);
    expect((await f.d1.sql.all("SELECT COUNT(*) AS n FROM evidence_mirror"))[0]?.n).toBe(2);

    const copied = (await f.mirror.get(a.recordId)) as Evidence;
    expect(copied).toEqual(a);
    expect(f.ledger.verify(copied)).toEqual({ ok: true });
    expect(await f.mirror.get(b.recordId)).toEqual(b);
    f.close();
  });

  it("a crash between insert and markMirrored replays safely: the record is not duplicated and ends up marked", async () => {
    const f = await farm();
    const a = f.ledger.append(candidate());
    await f.mirror.insert(a); // copied out, but the object crashed before markMirrored()
    expect(f.store.unmirrored().map((r) => r.recordId)).toEqual([a.recordId]);
    expect(await mirrorEvidence(f.store, f.mirror)).toBe(1);
    expect((await f.d1.sql.all("SELECT COUNT(*) AS n FROM evidence_mirror WHERE record_id = ?", a.recordId))[0]?.n).toBe(1);
    expect(f.store.unmirrored()).toEqual([]);
    f.close();
  });

  it("a row edited in the mirror (result flipped, hash left alone) fails verify(); a forged row with a recomputed hash fails too", async () => {
    const f = await farm();
    const a = f.ledger.append(candidate());
    await mirrorEvidence(f.store, f.mirror);
    // Someone with D1 access edits the copy in place — outside the class, straight in the table.
    f.d1.raw.prepare("UPDATE evidence_mirror SET json = ? WHERE record_id = ?").run(JSON.stringify({ ...a, result: "CEASED" }), a.recordId);
    const edited = (await f.mirror.get(a.recordId)) as Evidence;
    expect(edited.result).toBe("CEASED");
    const r = f.ledger.verify(edited);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/altered after sealing/);
    // The original in the object's own store is untouched.
    expect(f.ledger.verify(f.ledger.get(a.recordId) as Evidence)).toEqual({ ok: true });

    // A forged row: someone recomputes recordHash for the tampered content but cannot sign it.
    const otherKey = generateKeyPair();
    const forger = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: otherKey.privateKey, publicKey: otherKey.publicKey });
    const forged = forger.append(candidate({ result: "CEASED" }));
    await f.mirror.insert(forged);
    expect(f.ledger.verify((await f.mirror.get(forged.recordId)) as Evidence).ok).toBe(false);
    f.close();
  });

  it("a reader holding only the platform's PUBLIC key tells the one edited D1 row from all the others, by id", async () => {
    const f = await farm();
    const keep = f.ledger.append(candidate());
    const edited = f.ledger.append(candidate({ inputField: "supplier.vatId", inputValueHash: "sha256-of-dic" }));
    await mirrorEvidence(f.store, f.mirror);
    f.d1.raw.prepare("UPDATE evidence_mirror SET json = json_set(json, '$.result', 'CEASED') WHERE record_id = ?").run(edited.recordId);
    const publicOnly = { keyId: "platform-k1", publicKey: f.publicKey }; // no private key anywhere here
    const rows = await f.d1.sql.all("SELECT record_id, json FROM evidence_mirror ORDER BY observed_at");
    const invalid = rows.filter((r) => !verifyEvidence(JSON.parse(r.json as string) as Evidence, publicOnly).ok).map((r) => r.record_id);
    expect(rows).toHaveLength(2);
    expect(invalid).toEqual([edited.recordId]);
    expect(verifyEvidence(JSON.parse((rows.find((r) => r.record_id === keep.recordId) as { json: string }).json) as Evidence, publicOnly)).toEqual({ ok: true });
    f.close();
  });

  it("the mirror's complete statement set has no UPDATE and no DELETE at all — a mirrored record never changes", () => {
    for (const [name, statement] of Object.entries(SQLITE_MIRROR_STATEMENTS)) {
      expect(statement, name).toMatch(/^(CREATE|INSERT OR IGNORE|SELECT)\b/);
      expect(statement, name).not.toMatch(/\b(UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)\b/i);
    }
    const methods = Object.getOwnPropertyNames(SqliteEvidenceMirror.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["get", "insert", "lookup"]);
  });
});

describe("ZLAB-DUR-005 lookup is tenant-scoped, expiry-aware and returns references only", () => {
  it("same tenant + field + value hash + authority finds the record; another tenant, another authority, an expired record or another value find nothing", async () => {
    const f = await farm();
    const granted = f.ledger.append(candidate({ authorityDomain: "cz.company.registry", expiresAt: "2026-10-15T08:00:00Z" }));
    f.ledger.append(candidate()); // inferred: no authority domain
    f.ledger.append(candidate({ tenantId: TENANT_B, authorityDomain: "cz.company.registry" }));
    await mirrorEvidence(f.store, f.mirror);

    const base = { tenantId: TENANT_A, inputField: "supplier.companyId", inputValueHash: ICO_HASH, now: START };
    const hit = await f.mirror.lookup({ ...base, authorityDomain: "cz.company.registry" });
    expect(hit).toHaveLength(1);
    expect(hit[0]).toEqual({
      recordId: granted.recordId,
      tenantId: TENANT_A,
      inputField: "supplier.companyId",
      inputValueHash: ICO_HASH,
      authorityDomain: "cz.company.registry",
      observedAt: granted.observedAt,
      expiresAt: "2026-10-15T08:00:00Z",
      recordHash: granted.recordHash,
    });
    for (const ref of hit) {
      expect(ref).not.toHaveProperty("result");
      expect(ref).not.toHaveProperty("json");
      expect(ref).not.toHaveProperty("producerId");
    }

    expect(await f.mirror.lookup({ ...base, tenantId: TENANT_B, authorityDomain: "cz.company.registry" })).toHaveLength(1);
    expect((await f.mirror.lookup({ ...base, tenantId: TENANT_B, authorityDomain: "cz.company.registry" }))[0]?.tenantId).toBe(TENANT_B);
    expect(await f.mirror.lookup({ ...base, tenantId: "tenant-c", authorityDomain: "cz.company.registry" })).toEqual([]);
    expect(await f.mirror.lookup({ ...base, authorityDomain: "tenant.businessCentral" })).toEqual([]);
    expect(await f.mirror.lookup({ ...base, authorityDomain: "cz.company.registry", now: LATER })).toEqual([]);
    expect(await f.mirror.lookup({ ...base, inputValueHash: "sha256-of-another-ico", authorityDomain: "cz.company.registry" })).toEqual([]);
    f.close();
  });

  it("without an authority filter the lookup also returns inferred evidence, still only for the asking tenant", async () => {
    const f = await farm();
    f.ledger.append(candidate({ authorityDomain: "cz.company.registry" }));
    f.ledger.append(candidate());
    f.ledger.append(candidate({ tenantId: TENANT_B }));
    await mirrorEvidence(f.store, f.mirror);
    const any = await f.mirror.lookup({ tenantId: TENANT_A, inputField: "supplier.companyId", inputValueHash: ICO_HASH, now: START });
    expect(any).toHaveLength(2);
    expect(any.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(any.map((r) => r.authorityDomain).sort()).toEqual([undefined, "cz.company.registry"].sort());
    f.close();
  });
});
