// ZLAB family: Žlab / Evidence primitive (docs/SEVERKA.md `### Tři role, ne dvě`, docs/POSUDKY.md
// Posudek 12 point 11) — a tenant-scoped, append-only, hash-chained, platform-signed evidence
// store. Not yet wired into any real capability/ExecutorHost step; these tests exercise the
// primitive itself (same pattern as tests/evd.test.ts EVD-004 for Audit's own append-only guarantee).
import { sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/platform/artifacts.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/platform/bytes.js";
import { canonicalize } from "../src/platform/canonical.js";
import { FakeClock } from "../src/platform/clock.js";
import { EVIDENCE_SCHEMA_VERSION, EvidenceLedger, evidenceSignedBytes, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
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

/** `inputField` is a convenience for callers below — translated into `subject` (CASE_SCOPE, no entityId) so every
 * existing override site keeps reading exactly as it did before EvidenceCandidate replaced inputField with subject. */
function candidate(overrides: Partial<EvidenceCandidate> & { inputField?: string } = {}): EvidenceCandidate {
  const { inputField, ...rest } = overrides;
  return {
    tenantId: TENANT_A,
    producerId: "cz.vat.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    subject: { key: inputField ?? "bankAccount", scope: CASE_SCOPE },
    inputValueHash: "sha256-of-account-value",
    result: "PASS",
    parentRefs: [],
    parentHashes: [],
    ...rest,
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
    // importSealed (M0 D-4) accepts only records this platform already sealed, verbatim — still no update/delete.
    // forCase (docs/AUTONOMOUS-RUNTIME-V1.md część 2) is a read, same as forTenant/get — still no update/delete.
    expect(methods.sort()).toEqual(["append", "forCase", "forTenant", "get", "importSealed", "verify", "verifyLineage"]);
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
    const rawStore = (ledger as unknown as { store: { byId: Map<string, Evidence> } }).store.byId;
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

// ZLAB-CASE family (docs/AUTONOMOUS-RUNTIME-V1.md część 2, ADR 18.9.2026): forCase() applies the CASE_ONLY-unless-
// TENANT_WIDE filter — the primitive-level proof behind attachment-fanout.ts's classifiedAsInvoice() now reading
// through forCase() instead of an unfiltered forTenant() scan.
describe("ZLAB-CASE-001 forCase(): CASE_ONLY-unless-TENANT_WIDE filter", () => {
  it("evidence sealed CASE_ONLY for case A is NOT returned by a case-scoped lookup for case B", () => {
    const { ledger } = ledgerFixture();
    const a = ledger.append(candidate({ originCaseId: "case-a" }));
    expect(a.reusePolicy).toBe("CASE_ONLY"); // the default, not explicitly set above
    expect(ledger.forCase(TENANT_A, "case-a").map((r) => r.recordId)).toEqual([a.recordId]);
    expect(ledger.forCase(TENANT_A, "case-b")).toEqual([]);
  });

  it("evidence sealed reusePolicy TENANT_WIDE IS returned regardless of which case asks", () => {
    const { ledger } = ledgerFixture();
    const shared = ledger.append(candidate({ originCaseId: "case-a", reusePolicy: "TENANT_WIDE" }));
    expect(ledger.forCase(TENANT_A, "case-a").map((r) => r.recordId)).toEqual([shared.recordId]);
    expect(ledger.forCase(TENANT_A, "case-b").map((r) => r.recordId)).toEqual([shared.recordId]);
    expect(ledger.forCase(TENANT_A, "case-c").map((r) => r.recordId)).toEqual([shared.recordId]);
  });

  it("evidence with no originCaseId at all (sealed before its Case existed) and the CASE_ONLY default is never returned by any case-scoped lookup — the ADR's safe default, not a gap", () => {
    const { ledger } = ledgerFixture();
    const unattributed = ledger.append(candidate());
    expect(unattributed.originCaseId).toBeUndefined();
    expect(unattributed.reusePolicy).toBe("CASE_ONLY");
    expect(ledger.forCase(TENANT_A, "case-a")).toEqual([]);
    expect(ledger.forCase(TENANT_A, "case-b")).toEqual([]);
  });

  it("forCase() never returns another tenant's records, same discipline as forTenant()", () => {
    const { ledger } = ledgerFixture();
    ledger.append(candidate({ tenantId: TENANT_B, originCaseId: "case-a", reusePolicy: "TENANT_WIDE" }));
    expect(ledger.forCase(TENANT_A, "case-a")).toEqual([]);
  });
});

// M0 část D, R4 (docs/M0-FACT-CONTRACT-V1.md) + docs/AUTONOMOUS-RUNTIME-V1.md część 2: v3 record shape — the ledger
// owns schemaVersion, signs with a domain prefix (Posudek 16 P1-12) and refuses v1/v2 records instead of silently
// accepting them.
describe("ZLAB-DUR-007 v3 evidence: ledger-owned schemaVersion, domain-separated signature, v1/v2 refused", () => {
  it("append() stamps schemaVersion 3 and signs EVIDENCE:v3:<recordHash>, never the bare hash", () => {
    const { ledger, keyPair } = ledgerFixture();
    const record = ledger.append(candidate());
    expect(record.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(EVIDENCE_SCHEMA_VERSION).toBe("3");
    const sig = fromBase64Url(record.platformSignature);
    expect(verify(null, evidenceSignedBytes(record.recordHash), keyPair.publicKey, sig)).toBe(true);
    expect(verify(null, utf8Bytes(record.recordHash), keyPair.publicKey, sig)).toBe(false);
  });

  it("a v1-shaped record signed over the bare hash with the trusted key is refused, never silently accepted", () => {
    const { ledger, keyPair } = ledgerFixture();
    const v1Unsigned = { ...candidate(), inputField: "bankAccount", reusePolicy: "CASE_ONLY" as const, recordId: "evd-v1", observedAt: START, schemaVersion: "1" };
    const recordHash = sha256(canonicalize(v1Unsigned));
    const platformSignature = toBase64Url(sign(null, utf8Bytes(recordHash), keyPair.privateKey));
    const v1: Evidence = { ...v1Unsigned, recordHash, keyId: "platform-k1", platformSignature };
    const r = ledger.verify(v1);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/schemaVersion/);
  });

  // Task 2 requirement (c): mirrors the v1-rejection test's shape exactly, one schema version later — a v2 record
  // (inputField only, no subject/reusePolicy/originCaseId, signed "EVIDENCE:v2:<recordHash>") is refused the same
  // fail-closed way, not silently accepted just because it happens to still verify structurally against v2's own
  // domain-separated signature.
  it("a v2-shaped record (pre-subject/reusePolicy, signed EVIDENCE:v2:<recordHash>) is refused, never silently accepted", () => {
    const { ledger, keyPair } = ledgerFixture();
    const { subject: _subject, reusePolicy: _reusePolicy, originCaseId: _originCaseId, ...v2Fields } = candidate();
    const v2Unsigned = { ...v2Fields, inputField: "bankAccount", recordId: "evd-v2", observedAt: START, schemaVersion: "2" };
    const recordHash = sha256(canonicalize(v2Unsigned));
    const platformSignature = toBase64Url(sign(null, utf8Bytes(`EVIDENCE:v2:${recordHash}`), keyPair.privateKey));
    const v2 = { ...v2Unsigned, recordHash, keyId: "platform-k1", platformSignature } as unknown as Evidence;
    const r = ledger.verify(v2);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/schemaVersion/);
  });

  it("authorityDomain is sealed content: tampering it breaks verification; a record without it survives a JSON round trip", () => {
    const { ledger } = ledgerFixture();
    const stamped = ledger.append(candidate({ authorityDomain: "cz.vat.registry" }));
    expect(stamped.authorityDomain).toBe("cz.vat.registry");
    expect(ledger.verify(stamped)).toEqual({ ok: true });
    expect(ledger.verify({ ...stamped, authorityDomain: "tenant.human-review" }).ok).toBe(false);
    const plain = ledger.append(candidate());
    expect(plain.authorityDomain).toBeUndefined();
    expect(ledger.verify(JSON.parse(JSON.stringify(plain)) as Evidence)).toEqual({ ok: true });
  });
});
