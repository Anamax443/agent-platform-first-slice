// DOJ family: Dojička / EvidenceAggregator (docs/SEVERKA.md `### Tři role, ne dvě`, first concrete
// instance of Posudek 11 point 7 / Posudek 12 point 9's `invoice.verification.aggregate`). No LLM,
// no external credential, no write path into the ledger — reads Žlab evidence, composes a decision.
import { describe, expect, it } from "vitest";
import { AggregateFinding, EvidenceAggregator } from "../src/platform/aggregator.js";
import { FakeClock, iso, plus, HOUR } from "../src/platform/clock.js";
import { EvidenceLedger, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { generateKeyPair } from "../src/platform/signing.js";

const START = "2026-09-13T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function fixture() {
  const clock = new FakeClock(START);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  const aggregator = new EvidenceAggregator(ledger, clock);
  return { clock, ledger, aggregator };
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT_A,
    producerId: "cz.vat.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    schemaVersion: "1",
    inputField: "bankAccount",
    inputValueHash: "hash-of-value",
    result: "PASS",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

const REQUIRED = [
  { field: "companyId", producerId: "cz.company.verify" },
  { field: "bankAccount", producerId: "cz.vat.verify" },
];

function findingKinds(findings: AggregateFinding[]): string[] {
  return findings.map((f) => f.kind).sort();
}

describe("DOJ-001 all required evidence present and clean -> READY", () => {
  it("companyId + bankAccount both valid, same tenant, unexpired, no conflicts", () => {
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId", inputValueHash: "hash-ico" }));
    const bank = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-account" }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bank.recordId] });
    expect(result.decision).toBe("READY");
    expect(result.findings).toEqual([]);
    expect(result.evidenceRefs.sort()).toEqual([bank.recordId, company.recordId].sort());
  });
});

describe("DOJ-002 missing required evidence -> REVIEW, not a silent pass", () => {
  it("no cz.company.verify evidence submitted at all", () => {
    const { ledger, aggregator } = fixture();
    const bank = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount" }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [bank.recordId] });
    expect(result.decision).toBe("REVIEW");
    expect(findingKinds(result.findings)).toEqual(["missing"]);
    expect(result.findings[0]?.field).toBe("companyId");
  });
});

describe("DOJ-003 expired evidence is not usable, but is a recoverable REVIEW, not a REJECT", () => {
  it("bankAccount evidence is past its expiresAt", () => {
    const { ledger, clock, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bank = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", expiresAt: iso(plus(clock.now(), HOUR)) }));
    clock.advance(2 * HOUR);
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bank.recordId] });
    expect(result.decision).toBe("REVIEW");
    expect(findingKinds(result.findings)).toEqual(["expired", "missing"]);
  });
});

describe("DOJ-004 cross-tenant evidence is rejected outright, never silently reused", () => {
  it("evidence sealed for tenant B cannot certify an object for tenant A", () => {
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bank = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", tenantId: TENANT_B }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bank.recordId] });
    expect(result.decision).toBe("REJECT");
    expect(result.findings.some((f) => f.kind === "tenant_mismatch")).toBe(true);
  });
});

describe("DOJ-005 tampered evidence fails integrity, decision is REJECT not silent skip", () => {
  it("a record altered after sealing (caught by EvidenceLedger.verify) rejects the whole decision", () => {
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bank = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount" }));
    const rawStore = (ledger as unknown as { byId: Map<string, Evidence> }).byId;
    rawStore.set(bank.recordId, Object.freeze({ ...bank, result: "FAIL" }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bank.recordId] });
    expect(result.decision).toBe("REJECT");
    expect(result.findings.some((f) => f.kind === "integrity_failed")).toBe(true);
  });
});

describe("DOJ-006 two producers disagree on the same field -> REJECT, never averaged or first-wins", () => {
  it("conflicting PASS/FAIL for bankAccount from two pieces of evidence", () => {
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bankPass = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-account", result: "PASS" }));
    const bankFail = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-account", result: "FAIL" }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bankPass.recordId, bankFail.recordId] });
    expect(result.decision).toBe("REJECT");
    expect(result.findings.some((f) => f.kind === "conflict" && f.field === "bankAccount")).toBe(true);
  });
});

describe("DOJ-007 value changed after verification -> REJECT (VALUE_CHANGED_AFTER_VERIFICATION)", () => {
  it("two evidence records for bankAccount verified different inputValueHash values", () => {
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bankOld = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-of-111111" }));
    const bankNew = ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-of-999999" }));
    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bankOld.recordId, bankNew.recordId] });
    expect(result.decision).toBe("REJECT");
    expect(result.findings.some((f) => f.kind === "conflict" && /changed after verification/.test(f.reason))).toBe(true);
  });
});

describe("DOJ-008 broken lineage upstream of the referenced evidence -> REJECT", () => {
  it("an ancestor altered after the fact breaks the whole decision, not just that one record", () => {
    const { ledger, aggregator } = fixture();
    const extraction = ledger.append(candidate({ producerId: "invoice.extract", inputField: "bankAccount", inputValueHash: "hash-of-111111" }));
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const bank = ledger.append(
      candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: "hash-of-111111", parentRefs: [extraction.recordId], parentHashes: [extraction.recordHash] }),
    );
    const rawStore = (ledger as unknown as { byId: Map<string, Evidence> }).byId;
    rawStore.set(extraction.recordId, Object.freeze({ ...extraction, inputValueHash: "hash-of-999999" }));

    const result = aggregator.aggregate({ tenantId: TENANT_A, required: REQUIRED, evidenceRefs: [company.recordId, bank.recordId] });
    expect(result.decision).toBe("REJECT");
    expect(result.findings.some((f) => f.kind === "lineage_broken")).toBe(true);
  });
});

describe("DOJ-009 the aggregator has no write path into the ledger", () => {
  it("EvidenceAggregator exposes only aggregate() and never grows the ledger it reads from", () => {
    const methods = Object.getOwnPropertyNames(EvidenceAggregator.prototype).filter((m) => m !== "constructor");
    expect(methods).toEqual(["aggregate"]);
    const { ledger, aggregator } = fixture();
    const company = ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId" }));
    const before = ledger.forTenant(TENANT_A).length;
    aggregator.aggregate({ tenantId: TENANT_A, required: [], evidenceRefs: [company.recordId] });
    expect(ledger.forTenant(TENANT_A).length).toBe(before);
  });
});
