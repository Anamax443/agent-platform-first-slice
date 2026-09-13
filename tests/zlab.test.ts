// ZLAB family: Žlab / Evidence primitive (docs/SEVERKA.md `### Tři role, ne dvě`, docs/POSUDKY.md
// Posudek 12 point 11) — a tenant-scoped, append-only, hash-chained, platform-signed evidence
// store. Not yet wired into any real capability/ExecutorHost step; these tests exercise the
// primitive itself (same pattern as tests/evd.test.ts EVD-004 for Audit's own append-only guarantee).
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/platform/clock.js";
import { EvidenceLedger, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { generateKeyPair } from "../src/platform/signing.js";

const START = "2026-09-13T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function ledgerFixture() {
  const clock = new FakeClock(START);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  return { clock, ledger, keyPair };
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT_A,
    producerId: "cz.vat.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    schemaVersion: "1",
    inputField: "bankAccount",
    inputValueHash: "sha256-of-account-value",
    result: "PASS",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

describe("ZLAB-001 append seals a record the platform can verify", () => {
  it("a freshly appended record verifies clean and carries the platform's keyId", () => {
    const { ledger } = ledgerFixture();
    const record = ledger.append(candidate());
    expect(record.recordId).toMatch(/^evd-/);
    expect(record.keyId).toBe("platform-k1");
    expect(ledger.verify(record)).toEqual({ ok: true });
    expect(ledger.get(record.recordId)).toEqual(record);
  });
});

describe("ZLAB-002 records returned by the ledger are copies, storage is immune to caller mutation", () => {
  it("mutating a returned record does not change what the ledger holds (same discipline as Audit/EVD-004)", () => {
    const { ledger } = ledgerFixture();
    const record = ledger.append(candidate());
    const copy = ledger.get(record.recordId) as Evidence;
    (copy as { result: string }).result = "FAIL";
    expect(ledger.get(record.recordId)?.result).toBe("PASS");
    // The instance appended into is frozen; every read returns an independent structuredClone of it.
    (record as { result: string }).result = "FAIL";
    expect(ledger.get(record.recordId)?.result).toBe("PASS");
  });
});

describe("ZLAB-003 tampering with content invalidates the record — changing one field breaks integrity", () => {
  it("verify() rejects a record whose content was altered after sealing, even though recordHash/signature are still present", () => {
    const { ledger } = ledgerFixture();
    const record = ledger.append(candidate());
    const tampered: Evidence = { ...record, result: "FAIL" };
    const check = ledger.verify(tampered);
    expect(check.ok).toBe(false);
    expect((check as { reason: string }).reason).toMatch(/altered after sealing/);
  });
});

describe("ZLAB-004 a hash-only forgery (no access to the platform's private key) is caught", () => {
  it("recomputing recordHash for tampered content does not produce a record that passes signature verification", () => {
    const { ledger } = ledgerFixture();
    const record = ledger.append(candidate());
    // Attacker can edit storage and even recompute recordHash, but cannot re-sign without privateKey.
    const forgedButHashConsistent: Evidence = { ...record, result: "FAIL", recordHash: "forged-hash-pretending-to-match" };
    expect(ledger.verify(forgedButHashConsistent).ok).toBe(false);

    const otherKeyPair = generateKeyPair();
    const otherLedger = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: otherKeyPair.privateKey, publicKey: otherKeyPair.publicKey });
    // Same keyId, different actual key material — this ledger's own append() would sign correctly,
    // but a record signed by a *different* private key under the trusted keyId must not verify.
    expect(ledger.verify(otherLedger.append(candidate())).ok).toBe(false);
  });
});

describe("ZLAB-005 append-only: no update/delete surface exists on the class", () => {
  it("EvidenceLedger has no method that could mutate or remove a sealed record", () => {
    const methods = Object.getOwnPropertyNames(EvidenceLedger.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["append", "forTenant", "get", "verify", "verifyLineage"]);
    expect(methods.some((m) => /update|delete|remove|clear|set|edit|purge|truncate|overwrite/i.test(m))).toBe(false);
  });
});

describe("ZLAB-006 hash graph: a broken ancestor invalidates everything built on top of it", () => {
  it("verifyLineage passes for a clean chain and fails at the exact ancestor that was altered", () => {
    const { ledger } = ledgerFixture();
    const extraction = ledger.append(candidate({ producerId: "invoice.extract", inputField: "bankAccount", inputValueHash: "hash-of-111111" }));
    const aresCheck = ledger.append(
      candidate({ producerId: "cz.company.verify", inputField: "companyId", parentRefs: [extraction.recordId], parentHashes: [extraction.recordHash] }),
    );
    expect(ledger.verifyLineage(aresCheck.recordId)).toEqual({ ok: true });

    // Simulate storage-level tampering with the ancestor (e.g. someone with DB access "fixes" a value in place).
    const rawStore = (ledger as unknown as { byId: Map<string, Evidence> }).byId;
    rawStore.set(extraction.recordId, Object.freeze({ ...extraction, inputValueHash: "hash-of-999999" }));

    const lineage = ledger.verifyLineage(aresCheck.recordId);
    expect(lineage.ok).toBe(false);
    expect((lineage as { brokenAt: string }).brokenAt).toBe(extraction.recordId);
  });
});

describe("ZLAB-007 Žlab is tenant-scoped: forTenant never returns another tenant's records", () => {
  it("records for tenant A are invisible to a forTenant(B) read", () => {
    const { ledger } = ledgerFixture();
    ledger.append(candidate({ tenantId: TENANT_A }));
    ledger.append(candidate({ tenantId: TENANT_A }));
    ledger.append(candidate({ tenantId: TENANT_B }));
    expect(ledger.forTenant(TENANT_A)).toHaveLength(2);
    expect(ledger.forTenant(TENANT_B)).toHaveLength(1);
    expect(ledger.forTenant(TENANT_A).every((r) => r.tenantId === TENANT_A)).toBe(true);
  });
});
