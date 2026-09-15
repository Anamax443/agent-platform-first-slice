// ZLAB-DUR-006 (docs/M0-FACT-CONTRACT-V1.md část D, D-4): a new case imports a sealed record — and its ancestry — out
// of the mirror into its own ledger, so lineage verifies locally even after the original object is gone. Three
// SQLite files play case 1's object, the shared D1 and case 2's object; case 1's file is deleted before the import.
import { sign } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/platform/artifacts.js";
import { toBase64Url } from "../src/platform/bytes.js";
import { canonicalize } from "../src/platform/canonical.js";
import { FakeClock } from "../src/platform/clock.js";
import { EVIDENCE_SCHEMA_VERSION, EvidenceLedger, evidenceSignedBytes, type Evidence, type EvidenceCandidate } from "../src/platform/evidence.js";
import { IMPORT_PRODUCER, IMPORT_RESULT, importEvidence, PLATFORM_AUTHORITY } from "../src/platform/evidence-import.js";
import { EVIDENCE_MIRROR_DDL, mirrorEvidence, SqliteEvidenceMirror } from "../src/platform/evidence-mirror.js";
import { EVIDENCE_DDL, SqliteEvidenceStore } from "../src/platform/evidence-sqlite.js";
import { generateKeyPair } from "../src/platform/signing.js";
import { tmpDir } from "./harness/index.js";
import { openAsyncSql, openSql } from "./harness/sqlite.js";

const START = "2026-09-15T08:00:00Z";
const LATER = "2026-11-01T08:00:00Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const KEY = generateKeyPair();
const SIGNING = { keyId: "platform-k1", privateKey: KEY.privateKey, publicKey: KEY.publicKey };

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT_A,
    workflowId: "wf-1",
    producerId: "cz.company.verify",
    capabilityVersion: "1",
    buildHash: "build-case1",
    inputField: "supplier.companyId",
    inputValueHash: "sha256-of-12345678",
    result: "ACTIVE",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

function caseObject(file: string) {
  const o = openSql(file);
  for (const s of EVIDENCE_DDL) o.sql.exec(s);
  const store = new SqliteEvidenceStore(o.sql);
  return { store, ledger: new EvidenceLedger(new FakeClock(START), SIGNING, store), close: o.close };
}

/** Case 1 verified an ICO (child) over an entity snapshot (parent), mirrored everything, then its object was purged. */
async function scenario() {
  const dir = tmpDir();
  const d1 = openAsyncSql(join(dir, "d1.sqlite"));
  for (const s of EVIDENCE_MIRROR_DDL) await d1.sql.run(s);
  const mirror = new SqliteEvidenceMirror(d1.sql);

  const case1File = join(dir, "case1.sqlite");
  const case1 = caseObject(case1File);
  const parent = case1.ledger.append(candidate({ producerId: "platform.entity", inputField: "invoice.line@ent-1", inputValueHash: "entity-hash-1", result: "OBSERVED", authorityDomain: PLATFORM_AUTHORITY }));
  const child = case1.ledger.append(candidate({ authorityDomain: "cz.company.registry", expiresAt: "2026-10-15T08:00:00Z", parentRefs: [parent.recordId], parentHashes: [parent.recordHash] }));
  const foreign = case1.ledger.append(candidate({ tenantId: TENANT_B, workflowId: "wf-b", authorityDomain: "cz.company.registry" }));
  await mirrorEvidence(case1.store, mirror);
  case1.close();
  rmSync(case1File, { force: true }); // case 1 purged — nothing below may depend on it

  const case2 = caseObject(join(dir, "case2.sqlite"));
  const into = { tenantId: TENANT_A, workflowId: "wf-2", now: START, buildHash: "build-case2" };
  return { mirror, d1, case2, into, parent, child, foreign };
}

describe("ZLAB-DUR-006 imported evidence verifies locally, ancestry included, after the original object is gone", () => {
  it("the record and its ancestor land in the new case verbatim, lineage holds locally, and an IMPORTED marker ties the reuse to this workflow", async () => {
    const s = await scenario();
    const r = await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, s.into);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toEqual([s.parent.recordId, s.child.recordId]); // ancestors first
    expect(r.alreadyPresent).toBe(false);
    expect(s.case2.ledger.get(s.child.recordId)).toEqual(s.child);
    expect(s.case2.ledger.get(s.parent.recordId)).toEqual(s.parent);
    expect(s.case2.ledger.verifyLineage(s.child.recordId)).toEqual({ ok: true });

    expect(r.marker).toMatchObject({
      tenantId: TENANT_A,
      workflowId: "wf-2",
      producerId: IMPORT_PRODUCER,
      result: IMPORT_RESULT,
      authorityDomain: PLATFORM_AUTHORITY,
      inputField: "supplier.companyId",
      inputValueHash: "sha256-of-12345678",
      parentRefs: [s.child.recordId],
      parentHashes: [s.child.recordHash],
      buildHash: "build-case2",
    });
    expect(s.case2.ledger.verifyLineage(r.marker.recordId)).toEqual({ ok: true });
    expect(s.case2.ledger.forTenant(TENANT_A).map((e) => e.recordId)).toEqual([s.parent.recordId, s.child.recordId, r.marker.recordId]);
    s.case2.close();
    s.d1.close();
  });

  it("importing the same record again is idempotent: no duplicate rows, the same marker, alreadyPresent", async () => {
    const s = await scenario();
    const first = await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, s.into);
    const second = await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, s.into);
    expect(second.ok && first.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.alreadyPresent).toBe(true);
    expect(second.imported).toEqual([]);
    expect(second.marker.recordId).toBe(first.marker.recordId);
    expect(s.case2.ledger.forTenant(TENANT_A)).toHaveLength(3);
    s.case2.close();
    s.d1.close();
  });

  it("another tenant's record is refused before anything is verified or written", async () => {
    const s = await scenario();
    const r = await importEvidence(s.case2.ledger, s.mirror, s.foreign.recordId, s.into);
    expect(r).toMatchObject({ ok: false, reason: "TENANT_MISMATCH", recordId: s.foreign.recordId });
    expect(s.case2.ledger.get(s.foreign.recordId)).toBeUndefined();
    expect(s.case2.ledger.forTenant(TENANT_A)).toEqual([]);
    s.case2.close();
    s.d1.close();
  });

  it("a record edited in the mirror, an expired root and an unknown id are refused with nothing written", async () => {
    const s = await scenario();
    s.d1.raw.prepare("UPDATE evidence_mirror SET json = ? WHERE record_id = ?").run(JSON.stringify({ ...s.child, result: "CEASED" }), s.child.recordId);
    expect(await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, s.into)).toMatchObject({ ok: false, reason: "INTEGRITY_FAILED", recordId: s.child.recordId });
    expect(s.case2.ledger.forTenant(TENANT_A)).toEqual([]); // not even the (clean) parent was written

    s.d1.raw.prepare("UPDATE evidence_mirror SET json = ? WHERE record_id = ?").run(JSON.stringify(s.child), s.child.recordId); // restore
    expect(await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, { ...s.into, now: LATER })).toMatchObject({ ok: false, reason: "EXPIRED" });
    expect(await importEvidence(s.case2.ledger, s.mirror, "evd-does-not-exist", s.into)).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(s.case2.ledger.forTenant(TENANT_A)).toEqual([]);
    s.case2.close();
    s.d1.close();
  });

  it("a different sealed record already holding the same id in the new case is an ID_CONFLICT, never an overwrite", async () => {
    const s = await scenario();
    // A validly signed record under case 2's own key with the *same* recordId but other content (sealed by hand).
    const unsigned = { ...candidate({ result: "CEASED", workflowId: "wf-2" }), recordId: s.child.recordId, observedAt: START, schemaVersion: EVIDENCE_SCHEMA_VERSION };
    const recordHash = sha256(canonicalize(unsigned));
    const twin: Evidence = { ...unsigned, recordHash, keyId: "platform-k1", platformSignature: toBase64Url(sign(null, evidenceSignedBytes(recordHash), KEY.privateKey)) };
    expect(s.case2.ledger.importSealed(twin)).toBe("IMPORTED");

    const r = await importEvidence(s.case2.ledger, s.mirror, s.child.recordId, s.into);
    expect(r).toMatchObject({ ok: false, reason: "ID_CONFLICT", recordId: s.child.recordId });
    expect(s.case2.ledger.get(s.child.recordId)?.result).toBe("CEASED"); // the earlier record stays exactly as it was
    s.case2.close();
    s.d1.close();
  });

  it("importSealed refuses a record that does not verify under this ledger's key", () => {
    const other = new EvidenceLedger(new FakeClock(START), { keyId: "platform-k1", privateKey: generateKeyPair().privateKey, publicKey: KEY.publicKey });
    const mine = new EvidenceLedger(new FakeClock(START), SIGNING);
    expect(() => mine.importSealed(other.append(candidate()))).toThrow(/refusing to import unverifiable evidence/);
    expect(mine.forTenant(TENANT_A)).toEqual([]);
  });
});
