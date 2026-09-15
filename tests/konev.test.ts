// KONEV family: BusinessObjectSealer (docs/SEVERKA.md `### Tři role, ne dvě`) — the Dojička's
// sealed, immutable output. Chains EvidenceLedger -> EvidenceAggregator -> BusinessObjectSealer,
// the same three-stage pipeline SEVERKA names Žlab -> Dojička -> Konev.
import { describe, expect, it } from "vitest";
import { EvidenceAggregator, type RequiredEvidence } from "../src/platform/aggregator.js";
import { sha256 } from "../src/platform/artifacts.js";
import { canonicalize } from "../src/platform/canonical.js";
import { FakeClock } from "../src/platform/clock.js";
import { EvidenceLedger, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { BusinessObjectSealer, type CertifiedBusinessObject } from "../src/platform/konev.js";
import { generateKeyPair } from "../src/platform/signing.js";

const START = "2026-09-13T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const REQUIRED: RequiredEvidence[] = [
  { field: "companyId", producerId: "cz.company.verify" },
  { field: "bankAccount", producerId: "cz.vat.verify" },
];

// Real values + their sha256(canonicalize()) hashes, the same composition evidence.ts/konev.ts use
// everywhere else — seal() now recomputes this from businessPayload, so fixtures need it to actually
// hold, not a placeholder string like the pre-P0 "hash-ico"/"hash-account" fixtures used.
const COMPANY_ID = "12345678";
const BANK_ACCOUNT = "CZ0000000000000000000000";
const COMPANY_ID_HASH = sha256(canonicalize(COMPANY_ID));
const BANK_ACCOUNT_HASH = sha256(canonicalize(BANK_ACCOUNT));

function fixture() {
  const clock = new FakeClock(START);
  const keyPair = generateKeyPair();
  const signing = { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
  const ledger = new EvidenceLedger(clock, signing);
  const aggregator = new EvidenceAggregator(ledger, clock);
  const sealer = new BusinessObjectSealer(ledger, clock, signing);
  return { clock, ledger, aggregator, sealer, signing };
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT_A,
    producerId: "cz.vat.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    inputField: "bankAccount",
    inputValueHash: "hash-of-value",
    result: "PASS",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

function readyChain(f: ReturnType<typeof fixture>) {
  const company = f.ledger.append(candidate({ producerId: "cz.company.verify", inputField: "companyId", inputValueHash: COMPANY_ID_HASH }));
  const bank = f.ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", inputValueHash: BANK_ACCOUNT_HASH }));
  const result = f.aggregator.aggregate({
    tenantId: TENANT_A,
    fieldHashes: { companyId: COMPANY_ID_HASH, bankAccount: BANK_ACCOUNT_HASH },
    required: REQUIRED,
    evidenceRefs: [company.recordId, bank.recordId],
  });
  return { company, bank, result };
}

/** The object those two fields actually certify — businessPayload passed to seal() in the READY-chain
 * tests below must carry these exact values (plus whatever unverified fields the domain wants) or the
 * new BUSINESS_OBJECT_CHANGED_AFTER_AGGREGATION check refuses to seal. */
const CERTIFIED_PAYLOAD = { companyId: COMPANY_ID, bankAccount: BANK_ACCOUNT };

describe("KONEV-001 a READY decision seals into a valid, verifiable Konev", () => {
  it("seal() succeeds and verify() confirms it clean", () => {
    const f = fixture();
    const { result } = readyChain(f);
    expect(result.decision).toBe("READY");
    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: CERTIFIED_PAYLOAD });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.object.certifiedObjectId).toMatch(/^obj-/);
    expect(f.sealer.verify(sealed.object)).toEqual({ ok: true });
    expect(f.sealer.get(sealed.object.certifiedObjectId)).toEqual(sealed.object);
  });
});

describe("KONEV-002 only a READY decision can be sealed, structurally", () => {
  it("a REVIEW or REJECT AggregateResult is refused, never sealed", () => {
    const f = fixture();
    const bank = f.ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount" }));
    const review = f.aggregator.aggregate({ tenantId: TENANT_A, fieldHashes: { bankAccount: "hash-of-value" }, required: REQUIRED, evidenceRefs: [bank.recordId] });
    expect(review.decision).toBe("REVIEW");
    const sealed = f.sealer.seal({ result: review, tenantId: TENANT_A, objectType: "invoice", businessPayload: {} });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.reason).toMatch(/only READY may become a Konev/);
  });
});

describe("KONEV-003 sealed objects are immutable, reads return independent copies", () => {
  it("mutating a returned object never changes what the sealer holds", () => {
    const f = fixture();
    const { result } = readyChain(f);
    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: { ...CERTIFIED_PAYLOAD, amount: 18500 } });
    if (!sealed.ok) throw new Error("expected seal to succeed");
    (sealed.object as { businessPayload: Record<string, unknown> }).businessPayload = { amount: 999999 };
    expect(f.sealer.get(sealed.object.certifiedObjectId)?.businessPayload).toEqual({ ...CERTIFIED_PAYLOAD, amount: 18500 });
  });
});

describe("KONEV-004 tampering with the sealed object's own content breaks verify()", () => {
  it("changing businessPayload after sealing invalidates rootHash", () => {
    const f = fixture();
    const { result } = readyChain(f);
    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: { ...CERTIFIED_PAYLOAD, amount: 18500 } });
    if (!sealed.ok) throw new Error("expected seal to succeed");
    const tampered: CertifiedBusinessObject = { ...sealed.object, businessPayload: { amount: 999999 } };
    const check = f.sealer.verify(tampered);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/altered after sealing/);
  });
});

describe("KONEV-005 tampering with underlying evidence *after* sealing breaks verify() even though the object itself is untouched", () => {
  it("an evidence record altered post-seal is caught the moment the Konev is re-verified", () => {
    const f = fixture();
    const { bank, result } = readyChain(f);
    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: { ...CERTIFIED_PAYLOAD, amount: 18500 } });
    if (!sealed.ok) throw new Error("expected seal to succeed");
    expect(f.sealer.verify(sealed.object)).toEqual({ ok: true });

    const rawStore = (f.ledger as unknown as { byId: Map<string, Evidence> }).byId;
    rawStore.set(bank.recordId, Object.freeze({ ...bank, result: "FAIL" }));

    const check = f.sealer.verify(sealed.object);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/failed integrity check/);
  });
});

describe("KONEV-006 seal() re-verifies evidence itself, not just the AggregateResult's say-so", () => {
  it("evidence tampered between aggregate() and seal() is refused at seal time, not sealed and only caught later", () => {
    const f = fixture();
    const { bank, result } = readyChain(f);
    const rawStore = (f.ledger as unknown as { byId: Map<string, Evidence> }).byId;
    rawStore.set(bank.recordId, Object.freeze({ ...bank, result: "FAIL" }));

    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: { ...CERTIFIED_PAYLOAD, amount: 18500 } });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.reason).toMatch(/failed integrity check at seal time/);
  });
});

describe("KONEV-007 the sealer independently checks tenant, not just trusting the caller's evidenceRefs", () => {
  it("an AggregateResult whose evidenceRefs (however obtained) belong to another tenant is refused", () => {
    const f = fixture();
    const foreignBank = f.ledger.append(candidate({ producerId: "cz.vat.verify", inputField: "bankAccount", tenantId: TENANT_B }));
    const fakeReadyResult = { decision: "READY" as const, findings: [], evidenceRefs: [foreignBank.recordId], fieldHashes: {} };
    const sealed = f.sealer.seal({ result: fakeReadyResult, tenantId: TENANT_A, objectType: "invoice", businessPayload: {} });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.reason).toMatch(/belongs to tenant tenant-b/);
  });
});

describe("KONEV-008 no update/delete surface exists on the sealer", () => {
  it("BusinessObjectSealer has no method that could mutate or remove a sealed object", () => {
    const methods = Object.getOwnPropertyNames(BusinessObjectSealer.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["get", "seal", "verify"]);
    expect(methods.some((m) => /update|delete|remove|clear|edit|purge|truncate|overwrite/i.test(m))).toBe(false);
  });
});

describe("KONEV-009 businessPayload must be the exact object the Dojička certified (external review 2026-09-14, P0)", () => {
  it("a businessPayload field swapped after aggregate() got READY is refused, never sealed", () => {
    const f = fixture();
    const { result } = readyChain(f);
    expect(result.decision).toBe("READY");
    // Same evidence, same READY decision — but the caller now hands seal() a different bankAccount
    // than the one cz.vat.verify's evidence actually verified. Evidence integrity/tenant/lineage all
    // still check out; only the new businessPayload-vs-fieldHashes check catches this.
    const sealed = f.sealer.seal({
      result,
      tenantId: TENANT_A,
      objectType: "invoice",
      businessPayload: { ...CERTIFIED_PAYLOAD, bankAccount: "CZ9999999999999999999999" },
    });
    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.reason).toMatch(/BUSINESS_OBJECT_CHANGED_AFTER_AGGREGATION/);
    expect(sealed.reason).toMatch(/bankAccount/);
  });

  it("a field the Dojička never verified (not in fieldHashes) is not checked and does not block sealing", () => {
    const f = fixture();
    const { result } = readyChain(f);
    // "amount" is real data on the invoice but was never a required/verified field in REQUIRED — the
    // fieldHashes-binding check has no opinion on it (that gap is a domain/policy choice — which fields
    // to require evidence for — not something this platform primitive can force).
    const sealed = f.sealer.seal({ result, tenantId: TENANT_A, objectType: "invoice", businessPayload: { ...CERTIFIED_PAYLOAD, amount: 999999 } });
    expect(sealed.ok).toBe(true);
  });
});
