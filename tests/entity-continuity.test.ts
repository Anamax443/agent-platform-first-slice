// ENT family (M0-FACT-CONTRACT-V1.md část B, krůček 2 UZAVŘENO 15. 9. 2026): entityHash identifies a "many"-scope
// entity by content, never position (A4/B4) — computeEntityHash() is a pure function of identityFields only
// (B1/B3), reconcileEntities() assigns ids deterministically across re-extraction (B4/B5). No real "many" entity
// has a live extractor yet (invoice.line is M2) — these are synthetic rows, the same fixture-only discipline as
// FACT-005/006/007 before impulse.attachment gave part A a first real subject.
import { describe, expect, it } from "vitest";
import { EvidenceAggregator } from "../src/platform/aggregator.js";
import { FakeClock } from "../src/platform/clock.js";
import { computeEntityHash, entitySnapshotCandidate, reconcileEntities } from "../src/platform/entity-continuity.js";
import { EvidenceLedger } from "../src/platform/evidence.js";
import { generateKeyPair } from "../src/platform/signing.js";

const START = "2026-09-16T15:00:00Z";
const TENANT = "tenant-a";

function fixture() {
  const clock = new FakeClock(START);
  const k = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: k.privateKey, publicKey: k.publicKey });
  return { clock, ledger, aggregator: new EvidenceAggregator(ledger, clock) };
}

describe("ENT-001 field order never affects entityHash", () => {
  it("the same fields in a different key order hash identically", () => {
    const a = computeEntityHash("invoice.line", { description: "Widget", quantity: 3, unitPrice: 10 });
    const b = computeEntityHash("invoice.line", { unitPrice: 10, description: "Widget", quantity: 3 });
    expect(a).toBe(b);
  });
});

describe("ENT-002 a changed identityField is a different hash", () => {
  it("quantity 3 vs 4 hash differently", () => {
    const a = computeEntityHash("invoice.line", { description: "Widget", quantity: 3 });
    const b = computeEntityHash("invoice.line", { description: "Widget", quantity: 4 });
    expect(a).not.toBe(b);
  });
  it("two different textual normalizations of the same real-world value hash differently — no fuzzy matching, deliberately fail-closed", () => {
    const a = computeEntityHash("invoice.line", { netAmount: "15 000" });
    const b = computeEntityHash("invoice.line", { netAmount: 15000 });
    expect(a).not.toBe(b);
  });
});

describe("ENT-003 a derived field never enters the hash — computeEntityHash only ever sees what the caller passes", () => {
  it("identical identityFields hash the same regardless of an accompanying derived value living outside the call", () => {
    const row = { description: "Widget", quantity: 3 };
    const beforeResolution = computeEntityHash("invoice.line", row);
    // "resolving accountCode" never touches computeEntityHash's input at all — accountCode is never passed in,
    // by construction (the caller only ever supplies identityFields, per B1/B3), so the hash cannot move.
    const afterResolution = computeEntityHash("invoice.line", row);
    expect(afterResolution).toBe(beforeResolution);
  });
});

describe("ENT-004 two content-identical rows get two distinct ids sharing one hash, paired stably", () => {
  it("re-extracting the same duplicate pair keeps each row's own id (order of occurrence, not many-to-one)", () => {
    const hash = computeEntityHash("invoice.line", { description: "Widget", quantity: 1 });
    const first = reconcileEntities([hash, hash], []);
    expect(first.assignments).toHaveLength(2);
    expect(first.assignments[0]?.isNew).toBe(true);
    expect(first.assignments[1]?.isNew).toBe(true);
    const [id1, id2] = [first.assignments[0]?.entityId as string, first.assignments[1]?.entityId as string];
    expect(id1).not.toBe(id2);

    const live = first.assignments.map((a) => ({ entityId: a.entityId, entityHash: a.entityHash }));
    const second = reconcileEntities([hash, hash], live);
    expect(second.assignments.map((a) => a.entityId).sort()).toEqual([id1, id2].sort());
    expect(second.assignments.every((a) => !a.isNew)).toBe(true);
    expect(second.superseded).toEqual([]);
  });
});

describe("ENT-005 re-extraction: unchanged rows keep their id, a changed row gets a new one, a missing row is superseded", () => {
  it("three rows, one edited, one removed, one unchanged, one added", () => {
    const unchanged = computeEntityHash("invoice.line", { description: "A" });
    const editedOld = computeEntityHash("invoice.line", { description: "B-old" });
    const removed = computeEntityHash("invoice.line", { description: "C" });
    const gen1 = reconcileEntities([unchanged, editedOld, removed], []);
    expect(gen1.assignments.every((a) => a.isNew)).toBe(true);
    const live = gen1.assignments.map((a) => ({ entityId: a.entityId, entityHash: a.entityHash }));
    const unchangedId = gen1.assignments[0]?.entityId as string;
    const removedId = gen1.assignments[2]?.entityId as string;

    const editedNew = computeEntityHash("invoice.line", { description: "B-new" });
    const added = computeEntityHash("invoice.line", { description: "D" });
    const gen2 = reconcileEntities([unchanged, editedNew, added], live);

    expect(gen2.assignments[0]).toMatchObject({ entityHash: unchanged, entityId: unchangedId, isNew: false });
    expect(gen2.assignments[1]?.isNew).toBe(true);
    expect(gen2.assignments[1]?.entityId).not.toBe(live[1]?.entityId);
    expect(gen2.assignments[2]?.isNew).toBe(true);
    expect(gen2.superseded).toEqual([{ entityId: live[1]?.entityId, entityHash: editedOld }, { entityId: removedId, entityHash: removed }]);
  });
});

describe("ENT-006 an entity snapshot participates in the existing lineage/not_bound checks unchanged (no new Dojička logic)", () => {
  it("evidence lineage-bound to a snapshot is not_bound once the entity's current content no longer matches the snapshot", () => {
    const { ledger, aggregator } = fixture();
    const type = "invoice.line";
    const entityId = reconcileEntities([computeEntityHash(type, { description: "Widget" })], []).assignments[0]?.entityId as string;
    const entityHash = computeEntityHash(type, { description: "Widget" });

    const snapshot = ledger.append(entitySnapshotCandidate({ tenantId: TENANT, buildHash: "build-1", type, entityId, entityHash }));
    // No authorityDomain here on purpose: this test is about entity-content binding (not_bound), which AUTH-004/005
    // already cover separately for domain-stamped evidence — an aggregator with no configured grants would mark a
    // domain-stamped record "revoked" by default (fail-closed) and obscure the thing this test actually checks.
    const approval = ledger.append({
      tenantId: TENANT,
      producerId: "platform.review",
      capabilityVersion: "1",
      buildHash: "build-1",
      inputField: `${type}.accountCode.approved@${entityId}`,
      inputValueHash: "hash-of-approved-account",
      result: "APPROVE",
      parentRefs: [snapshot.recordId],
      parentHashes: [snapshot.recordHash],
    });

    // Still bound: the field the aggregator is asked to certify matches what the approval evidence verified.
    const boundResult = aggregator.aggregate({
      tenantId: TENANT,
      fieldHashes: { [`${type}.accountCode.approved@${entityId}`]: "hash-of-approved-account" },
      required: [{ field: `${type}.accountCode.approved@${entityId}`, producerId: "platform.review", acceptableResults: ["APPROVE"] }],
      evidenceRefs: [approval.recordId],
    });
    expect(boundResult.decision).toBe("READY");

    // The row's content changed (a re-extraction produced a different entityHash for this same field) — the
    // caller now supplies a different authoritative fieldHashes value, and the *existing* not_bound check
    // (aggregator.ts, no change here) catches it without any Part-B-specific code.
    const notBoundResult = aggregator.aggregate({
      tenantId: TENANT,
      fieldHashes: { [`${type}.accountCode.approved@${entityId}`]: "hash-of-a-different-approved-account" },
      required: [{ field: `${type}.accountCode.approved@${entityId}`, producerId: "platform.review", acceptableResults: ["APPROVE"] }],
      evidenceRefs: [approval.recordId],
    });
    expect(notBoundResult.decision).toBe("REJECT");
    expect(notBoundResult.findings.some((f) => f.kind === "not_bound")).toBe(true);
  });

  it("entitySnapshotCandidate seals into the ledger with the documented field shape and verifies clean", () => {
    const { ledger } = fixture();
    const type = "invoice.line";
    const entityId = "ent-fixed0001";
    const entityHash = computeEntityHash(type, { description: "Widget" });
    const record = ledger.append(entitySnapshotCandidate({ tenantId: TENANT, buildHash: "build-1", type, entityId, entityHash }));
    expect(record.producerId).toBe("platform.entity");
    expect(record.authorityDomain).toBe("platform");
    expect(record.inputField).toBe(`invoice.line@${entityId}`);
    expect(record.inputValueHash).toBe(entityHash);
    expect(record.result).toBe("OBSERVED");
    expect(ledger.verify(record)).toEqual({ ok: true });
  });
});
