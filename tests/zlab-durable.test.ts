// ZLAB-DUR family (docs/M0-FACT-CONTRACT-V1.md část D): the Žlab on durable storage. D-2 = SqliteEvidenceStore over a
// real SQLite file (node:sqlite here, ctx.storage.sql in the Durable Object — same statements, same class): records
// survive a restart, the store is append-only at the SQL level, and the D1 mirror bookkeeping never touches a record.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/platform/clock.js";
import { EvidenceLedger, MemoryEvidenceStore, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { EVIDENCE_DDL, SQLITE_EVIDENCE_STATEMENTS, SqliteEvidenceStore } from "../src/platform/evidence-sqlite.js";
import { generateKeyPair } from "../src/platform/signing.js";
import { tmpDir } from "./harness/index.js";
import { openSql } from "./harness/sqlite.js";

const START = "2026-09-15T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT_A,
    producerId: "cz.company.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    inputField: "supplier.companyId",
    inputValueHash: "sha256-of-ico",
    result: "ACTIVE",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

/** One "process": a SQLite file opened, DDL applied, a ledger over it with the given platform key. */
function boot(file: string, keyPair: ReturnType<typeof generateKeyPair>) {
  const { sql, close } = openSql(file);
  for (const stmt of EVIDENCE_DDL) sql.exec(stmt);
  const store = new SqliteEvidenceStore(sql);
  const ledger = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }, store);
  return { store, ledger, close };
}

describe("ZLAB-DUR-001 evidence survives a restart of the object that wrote it", () => {
  it("a parent/child pair written before the restart is readable, verifies and keeps its lineage after it", () => {
    const file = join(tmpDir(), "zlab.sqlite");
    const keyPair = generateKeyPair();

    const before = boot(file, keyPair);
    const parent = before.ledger.append(candidate());
    const child = before.ledger.append(candidate({ inputField: "supplier.vatId", parentRefs: [parent.recordId], parentHashes: [parent.recordHash] }));
    before.ledger.append(candidate({ tenantId: TENANT_B }));
    before.close(); // the object is evicted; only the file remains

    const after = boot(file, keyPair);
    expect(after.ledger.get(child.recordId)).toEqual(child);
    expect(after.ledger.verify(after.ledger.get(child.recordId) as Evidence)).toEqual({ ok: true });
    expect(after.ledger.verifyLineage(child.recordId)).toEqual({ ok: true });
    expect(after.ledger.forTenant(TENANT_A).map((r) => r.recordId)).toEqual([parent.recordId, child.recordId]);
    expect(after.ledger.forTenant(TENANT_B)).toHaveLength(1);
    expect(after.ledger.forTenant("tenant-c")).toEqual([]);
    after.close();
  });

  it("the durable store and the memory store agree on what a ledger reads back", () => {
    const keyPair = generateKeyPair();
    const durable = boot(join(tmpDir(), "parity.sqlite"), keyPair);
    const memory = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }, new MemoryEvidenceStore());
    const d = durable.ledger.append(candidate({ authorityDomain: "cz.company.registry", expiresAt: "2026-10-15T08:00:00Z" }));
    const m = memory.append(candidate({ authorityDomain: "cz.company.registry", expiresAt: "2026-10-15T08:00:00Z" }));
    const strip = (r: Evidence) => ({ ...r, recordId: "", recordHash: "", platformSignature: "" });
    expect(strip(durable.ledger.get(d.recordId) as Evidence)).toEqual(strip(memory.get(m.recordId) as Evidence));
    expect(durable.ledger.verify(durable.ledger.get(d.recordId) as Evidence)).toEqual({ ok: true });
    durable.close();
  });
});

describe("ZLAB-DUR-002 the durable store is append-only at the SQL level", () => {
  it("the complete statement set is CREATE/INSERT/SELECT plus one UPDATE limited to the mirrored flag", () => {
    for (const [name, statement] of Object.entries(SQLITE_EVIDENCE_STATEMENTS)) {
      if (name === "markMirrored") {
        expect(statement).toBe("UPDATE evidence SET mirrored = 1 WHERE record_id = ?");
        continue;
      }
      expect(statement, name).toMatch(/^(CREATE|INSERT|SELECT)\b/);
      expect(statement, name).not.toMatch(/\b(UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });

  it("a second put() of an existing recordId fails and leaves the stored record untouched", () => {
    const keyPair = generateKeyPair();
    const { store, ledger, close } = boot(join(tmpDir(), "dup.sqlite"), keyPair);
    const record = ledger.append(candidate());
    expect(() => store.put({ ...record, result: "CEASED" })).toThrow();
    expect(ledger.get(record.recordId)).toEqual(record);
    expect(ledger.verify(ledger.get(record.recordId) as Evidence)).toEqual({ ok: true });
    close();
  });

  it("the store exposes put/get/forTenant plus mirror bookkeeping — no update, no delete", () => {
    const methods = Object.getOwnPropertyNames(SqliteEvidenceStore.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["forTenant", "get", "markMirrored", "put", "unmirrored"]);
    const memoryMethods = Object.getOwnPropertyNames(MemoryEvidenceStore.prototype).filter((m) => m !== "constructor");
    expect(memoryMethods.sort()).toEqual(["forTenant", "get", "put"]);
  });
});

describe("ZLAB-DUR-003 mirror bookkeeping is idempotent and never changes a record", () => {
  it("unmirrored() drains in write order, marking twice or marking an unknown id is harmless, records stay byte-identical", () => {
    const keyPair = generateKeyPair();
    const { store, ledger, close } = boot(join(tmpDir(), "mirror.sqlite"), keyPair);
    const a = ledger.append(candidate());
    const b = ledger.append(candidate({ inputField: "supplier.vatId" }));
    const c = ledger.append(candidate({ tenantId: TENANT_B }));
    expect(store.unmirrored().map((r) => r.recordId)).toEqual([a.recordId, b.recordId, c.recordId]);

    store.markMirrored([a.recordId, b.recordId]);
    expect(store.unmirrored().map((r) => r.recordId)).toEqual([c.recordId]);
    store.markMirrored([a.recordId]);
    expect(() => store.markMirrored(["evd-does-not-exist"])).not.toThrow();
    expect(store.unmirrored().map((r) => r.recordId)).toEqual([c.recordId]);

    expect(ledger.get(a.recordId)).toEqual(a);
    expect(ledger.verify(ledger.get(a.recordId) as Evidence)).toEqual({ ok: true });
    expect(ledger.verify(ledger.get(b.recordId) as Evidence)).toEqual({ ok: true });
    close();
  });
});
