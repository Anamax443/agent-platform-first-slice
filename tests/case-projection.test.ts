// PROJ family: CurrentCaseProjection (docs/AUTONOMOUS-RUNTIME-V1.md część 4, src/platform/case-projection.ts).
// Owner's review of this contract, 2026-09-18, before this file existed, set the bar these tests hold it to:
// a Projection may carry identity/address/state/provenance/references — never a fact's value; entity-scope
// ambiguity is always "unavailable", never resolved by a "latest wins" heuristic; output is deterministic
// regardless of ledger record order; and the function itself performs no writes anywhere.
import { describe, expect, it } from "vitest";
import { AuthorityRegistry } from "../src/platform/authorities.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { newCase, type Case, type NormalizedImpulse } from "../src/platform/case.js";
import { PROJECTION_SCHEMA_VERSION, projectCurrentCase, type ProjectCurrentCaseInput } from "../src/platform/case-projection.js";
import { FakeClock, iso, plus, HOUR } from "../src/platform/clock.js";
import { EvidenceLedger, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
import { LifecycleRegistry } from "../src/platform/lifecycle.js";
import { generateKeyPair } from "../src/platform/signing.js";

const START = "2026-09-18T08:00:00Z";
const TENANT = "tenant-42";
const CASE_A = "case-a";
const CASE_B = "case-b";

function fixture(now = START) {
  const clock = new FakeClock(now);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  const artifacts = new ArtifactStore(clock);
  return { clock, ledger, artifacts };
}

const impulse = (overrides: Partial<NormalizedImpulse> = {}): NormalizedImpulse => ({
  impulseId: "imp-1",
  tenantId: TENANT,
  channel: "mail",
  receivedAt: START,
  artifacts: [],
  metadata: {},
  ...overrides,
});

function caseOf(caseId: string, overrides: Partial<NormalizedImpulse> = {}): Case {
  return newCase({ caseId, impulse: impulse(overrides) });
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT,
    originCaseId: CASE_A,
    producerId: "cz.company.verify",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    subject: { key: "companyId", scope: CASE_SCOPE },
    inputValueHash: "hash-of-27074358",
    result: "ACTIVE",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

function input(over: Partial<ProjectCurrentCaseInput> & { case: Case; ledger: EvidenceLedger; artifacts: ArtifactStore }): ProjectCurrentCaseInput {
  return { now: START, ...over };
}

describe("PROJ-000 schema version and empty-Case shape", () => {
  it("a Case with no evidence at all projects to an empty, but well-formed, projection", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const p = projectCurrentCase(input({ case: c, ledger, artifacts, now: START }));
    expect(p).toEqual({
      projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
      caseId: CASE_A,
      tenantId: TENANT,
      availableArtifacts: [],
      availableFacts: [],
      facts: [],
      pendingCapabilities: [],
    });
  });
});

describe("PROJ-001 two documents of the same type in one Case never merge — distinct entityId, distinct facts", () => {
  it("document.type.invoiceConfirmed for two different attachments stays two separate available facts", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ subject: { key: "document.type.invoiceConfirmed", scope: "impulse.attachment", entityId: "ent-1" }, producerId: "document-classifier", result: "INVOICE" }));
    ledger.append(candidate({ subject: { key: "document.type.invoiceConfirmed", scope: "impulse.attachment", entityId: "ent-2" }, producerId: "document-classifier", result: "INVOICE" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.availableFacts).toHaveLength(2);
    expect(p.availableFacts).toEqual(
      expect.arrayContaining([
        { key: "document.type.invoiceConfirmed", scope: "impulse.attachment", entityId: "ent-1" },
        { key: "document.type.invoiceConfirmed", scope: "impulse.attachment", entityId: "ent-2" },
      ]),
    );
  });
});

describe("PROJ-002 two invoices in one Case have separated entity facts, never conflated by key alone", () => {
  it("invoice.number for two entities projects as two independent AVAILABLE facts, each with its own recordId", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const r1 = ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-17" }, inputValueHash: "hash-inv-17" }));
    const r2 = ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-42" }, inputValueHash: "hash-inv-42" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    const byEntity = new Map(p.facts.map((f) => [f.address.entityId, f]));
    expect(byEntity.get("inv-17")).toMatchObject({ availability: "AVAILABLE", recordId: r1.recordId });
    expect(byEntity.get("inv-42")).toMatchObject({ availability: "AVAILABLE", recordId: r2.recordId });
  });
});

describe("PROJ-003 disagreeing valid evidence at the same address is ambiguous, never resolved by recency", () => {
  it("two currently-valid records with different inputValueHash are BOTH reported BLOCKED, neither AVAILABLE", () => {
    const { clock, ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    // One CASE_ONLY (this case), one TENANT_WIDE (sealed from a different case, reusable here) — exactly the
    // shape the owner's own example names: TENANT_WIDE evidence must not be trusted blind when it disagrees.
    ledger.append(candidate({ originCaseId: CASE_A, reusePolicy: "CASE_ONLY", inputValueHash: "hash-A" }));
    clock.advance(HOUR);
    ledger.append(candidate({ originCaseId: CASE_B, reusePolicy: "TENANT_WIDE", inputValueHash: "hash-B" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts, now: iso(plus(clock.now(), HOUR)) }));
    expect(p.availableFacts).toEqual([]);
    expect(p.facts).toHaveLength(2);
    for (const f of p.facts) {
      expect(f.availability).toBe("BLOCKED");
      expect(f.reason).toMatch(/disagree on their verified value/);
    }
  });

  it("two records that AGREE on inputValueHash are both simply available — agreement is not ambiguity", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ inputValueHash: "hash-same" }));
    ledger.append(candidate({ inputValueHash: "hash-same" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.availableFacts).toHaveLength(1);
    expect(p.facts.every((f) => f.availability === "AVAILABLE")).toBe(true);
  });
});

describe("PROJ-004 expired evidence is not AVAILABLE", () => {
  it("a record past its expiresAt projects as EXPIRED, absent from availableFacts", () => {
    const { clock, ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ expiresAt: iso(plus(clock.now(), HOUR)) }));
    const later = iso(plus(clock.now(), 2 * HOUR));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts, now: later }));
    expect(p.availableFacts).toEqual([]);
    expect(p.facts).toEqual([expect.objectContaining({ availability: "EXPIRED" })]);
    expect(p.facts[0]?.reason).toContain("expired at");
  });
});

describe("PROJ-005 evidence of a different entity is never AVAILABLE for the one being asked about", () => {
  it("querying facts, an entity's own record never satisfies a lookup keyed to a different entityId", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-17" } }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    const forOtherEntity = p.availableFacts.find((a) => a.entityId === "inv-99");
    expect(forOtherEntity).toBeUndefined();
    expect(p.availableFacts.find((a) => a.entityId === "inv-17")).toBeDefined();
  });
});

describe("PROJ-006 a CASE_ONLY record from a different Case never leaks in — forCase()'s own boundary, trusted not re-implemented", () => {
  it("evidence sealed CASE_ONLY under a different caseId is invisible to this Case's projection", () => {
    const { ledger, artifacts } = fixture();
    ledger.append(candidate({ originCaseId: CASE_B, reusePolicy: "CASE_ONLY" }));
    const p = projectCurrentCase(input({ case: caseOf(CASE_A), ledger, artifacts }));
    expect(p.facts).toEqual([]);
    expect(p.availableFacts).toEqual([]);
  });
});

describe("PROJ-007 corrupted/unverifiable evidence is never AVAILABLE", () => {
  it("a record whose signature no longer matches its content projects as INVALID_EVIDENCE", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const sealed = ledger.append(candidate());
    // Simulate storage-level tampering, same technique as ZLAB-003 — bypasses append() to corrupt in place.
    const rawStore = (ledger as unknown as { store: { byId: Map<string, Evidence> } }).store.byId;
    rawStore.set(sealed.recordId, { ...sealed, result: "TAMPERED" });
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.availableFacts).toEqual([]);
    expect(p.facts).toEqual([expect.objectContaining({ availability: "INVALID_EVIDENCE" })]);
    expect(p.facts[0]?.reason).toMatch(/integrity check failed/);
  });
});

describe("PROJ-008 output never carries a value — identity/address/state/provenance/reference only", () => {
  it("no field, key or reason string anywhere in the projection contains a fact's actual value", () => {
    const { clock, ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    // Poison values planted in every field a leak could plausibly come from.
    ledger.append(candidate({ inputValueHash: "hash-of-18450-czk-secret-balance", result: "SECRET_ACCOUNT_NUMBER_998877" }));
    ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-1" }, expiresAt: iso(plus(clock.now(), -HOUR)), result: "SECRET_LINE_ITEM_VALUE" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("18450");
    expect(serialized).not.toContain("SECRET_ACCOUNT_NUMBER");
    expect(serialized).not.toContain("SECRET_LINE_ITEM_VALUE");
    // Structural: no ProjectedFact carries a key named value/payload/rawText/params/result/inputValueHash.
    for (const f of p.facts) {
      expect(Object.keys(f)).toEqual(expect.not.arrayContaining(["value", "payload", "rawText", "params", "result", "inputValueHash"]));
    }
  });
});

describe("PROJ-009 workflow SUCCEEDED alone creates no fact — only sealed evidence does", () => {
  it("a Case with a SUCCEEDED instance but zero evidence records projects to zero facts", () => {
    const { ledger, artifacts } = fixture();
    const c = newCase({ caseId: CASE_A, impulse: impulse(), instance: { workflowId: "wf-1", tenantId: TENANT, status: "SUCCEEDED", createdAt: START, updatedAt: START } });
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.facts).toEqual([]);
    expect(p.availableFacts).toEqual([]);
  });
});

describe("PROJ-010 output is independent of ledger record order", () => {
  it("appending records entityId-descending still projects facts/availableFacts sorted address-ascending", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    // Insertion order is deliberately the reverse of address order (inv-2, then inv-1, then inv-0) — the
    // ledger's own iteration order (insertion order, MemoryEvidenceStore's Map) must never leak into the
    // projection's own output order.
    ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-2" } }));
    ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-1" } }));
    ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-0" } }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.availableFacts.map((a) => a.entityId)).toEqual(["inv-0", "inv-1", "inv-2"]);
    expect(p.facts.map((f) => f.address.entityId)).toEqual(["inv-0", "inv-1", "inv-2"]);
  });

  it("two independently-built ledgers holding the same facts in opposite append order agree on fact content, ignoring only the platform-random recordId each append() mints", () => {
    const stripRecordIds = (p: ReturnType<typeof projectCurrentCase>) => ({ ...p, facts: p.facts.map(({ recordId, ...rest }) => rest) });

    const fx1 = fixture();
    fx1.ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-1" } }));
    fx1.ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-2" } }));
    const p1 = projectCurrentCase(input({ case: caseOf(CASE_A), ledger: fx1.ledger, artifacts: fx1.artifacts }));

    const fx2 = fixture();
    fx2.ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-2" } }));
    fx2.ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "inv-1" } }));
    const p2 = projectCurrentCase(input({ case: caseOf(CASE_A), ledger: fx2.ledger, artifacts: fx2.artifacts }));

    expect(stripRecordIds(p1)).toEqual(stripRecordIds(p2));
  });
});

describe("PROJ-011 identical input produces byte-for-byte identical output, every time", () => {
  it("calling projectCurrentCase twice with the same case+ledger+now gives deep-equal results", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate());
    const i = input({ case: c, ledger, artifacts });
    expect(projectCurrentCase(i)).toEqual(projectCurrentCase(i));
  });
});

describe("PROJ-012 no network, model or provider call — the function is plain, synchronous and pure", () => {
  it("projectCurrentCase's return value is not a Promise — nothing here can await an external call", () => {
    const { ledger, artifacts } = fixture();
    const result = projectCurrentCase(input({ case: caseOf(CASE_A), ledger, artifacts }));
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });
});

describe("PROJ-013 projection performs no writes anywhere — not to the Žlab, not to Case, not to the artifact store", () => {
  it("the ledger holds exactly the records it held before projecting, and the Case object is untouched", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate());
    const before = ledger.forCase(TENANT, CASE_A);
    const caseSnapshot = JSON.stringify(c);
    projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(ledger.forCase(TENANT, CASE_A)).toEqual(before);
    expect(JSON.stringify(c)).toBe(caseSnapshot);
  });
});

describe("PROJ-014 a revoked/quarantined authority blocks its evidence, same fail-closed check as Dojička", () => {
  it("evidence whose producer's grant no longer matches, or whose producer is quarantined, projects as BLOCKED", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ authorityDomain: "cz.company.registry" }));
    const authorities = AuthorityRegistry.build({
      schemaVersion: "1",
      domains: { "cz.company.registry": { producers: ["cz.company.verify"], facts: ["*"], maxEvidenceTtl: null } },
    });
    // Deliberately NOT marking cz.company.verify ACTIVE (LifecycleRegistry defaults unknown producers to QUARANTINED).
    const p = projectCurrentCase({ ...input({ case: c, ledger, artifacts }), authorities, lifecycle: new LifecycleRegistry() });
    expect(p.availableFacts).toEqual([]);
    expect(p.facts[0]).toMatchObject({ availability: "BLOCKED" });
    expect(p.facts[0]?.reason).toMatch(/no longer holds an active grant/);
  });

  it("the same evidence is AVAILABLE once the producer actually holds the grant and is ACTIVE", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    ledger.append(candidate({ authorityDomain: "cz.company.registry" }));
    const authorities = AuthorityRegistry.build({
      schemaVersion: "1",
      domains: { "cz.company.registry": { producers: ["cz.company.verify"], facts: ["*"], maxEvidenceTtl: null } },
    });
    const lifecycle = new LifecycleRegistry({ "cz.company.verify": "ACTIVE" });
    const p = projectCurrentCase({ ...input({ case: c, ledger, artifacts }), authorities, lifecycle });
    expect(p.availableFacts).toHaveLength(1);
  });
});

// PROJ-015/016/017 regression tests: adversarial verification (18.9.2026) found these three live in the
// first cut of case-projection.ts, before any of them shipped past this repo. All three fixed same-day.

describe("PROJ-015 addressKey() never lets two genuinely different (scope, key) pairs collide onto one string", () => {
  it("scope \"a::b\"+key \"c\" and scope \"a\"+key \"b::c\" — both would concatenate to the same \"a::b::c\" under a naive \"::\"-joined key — stay two separate, independently AVAILABLE facts", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const r1 = ledger.append(candidate({ subject: { key: "c", scope: "a::b", entityId: "d" }, inputValueHash: "hash-AAA" }));
    const r2 = ledger.append(candidate({ subject: { key: "b::c", scope: "a", entityId: "d" }, inputValueHash: "hash-BBB" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.facts).toHaveLength(2);
    const f1 = p.facts.find((f) => f.recordId === r1.recordId);
    const f2 = p.facts.find((f) => f.recordId === r2.recordId);
    expect(f1).toMatchObject({ availability: "AVAILABLE", address: { scope: "a::b", key: "c", entityId: "d" } });
    expect(f2).toMatchObject({ availability: "AVAILABLE", address: { scope: "a", key: "b::c", entityId: "d" } });
    expect(p.availableFacts).toHaveLength(2);
  });
});

describe("PROJ-016 an address with no entityId and one with entityId \"\" (empty string) are not the same address", () => {
  it("both stay independently AVAILABLE — undefined and \"\" are structurally different entityId values, not interchangeable", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const r1 = ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice" }, inputValueHash: "hash-no-entity" }));
    const r2 = ledger.append(candidate({ subject: { key: "invoice.number", scope: "invoice", entityId: "" }, inputValueHash: "hash-empty-entity" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.facts).toHaveLength(2);
    expect(p.facts.find((f) => f.recordId === r1.recordId)).toMatchObject({ availability: "AVAILABLE" });
    expect(p.facts.find((f) => f.recordId === r2.recordId)).toMatchObject({ availability: "AVAILABLE" });
  });
});

describe("PROJ-017 a malformed subject can never smuggle an extra property into the output — address is allowlisted, never spread", () => {
  it("an Evidence record whose subject carries an out-of-contract extra field never surfaces that field on ProjectedFact.address or in availableFacts", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf(CASE_A);
    const poisoned = { key: "companyId", scope: CASE_SCOPE, leakedResult: "SECRET_ACCOUNT_NUMBER_998877" } as unknown as EvidenceCandidate["subject"];
    ledger.append(candidate({ subject: poisoned, result: "SECRET_ACCOUNT_NUMBER_998877" }));
    const p = projectCurrentCase(input({ case: c, ledger, artifacts }));
    expect(p.availableFacts).toHaveLength(1);
    expect(Object.keys(p.facts[0]!.address).sort()).toEqual(["key", "scope"]);
    expect(JSON.stringify(p)).not.toContain("SECRET_ACCOUNT_NUMBER");
  });
});
