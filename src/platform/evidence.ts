import { sign, verify, type KeyObject } from "node:crypto";
import { sha256 } from "./artifacts.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import { canonicalize } from "./canonical.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";

/**
 * Žlab (SEVERKA.md `### Tři role, ne dvě`): the tenant-scoped, append-only, hash-chained,
 * platform-signed evidence store a Dojička reads from instead of trusting a bare `field: PASS`
 * (docs/POSUDKY.md Posudek 12 point 11). A cow supplies the claim; only the platform (holder of
 * `signing.privateKey`, never a cow) computes `recordHash` and `platformSignature` — the same
 * separation ArtifactStore already applies to `sha256` (the caller never gets to assert its own
 * hash). `tenantId` here is caller-supplied, same trust boundary as `Audit.append()`: this class is
 * a storage primitive, not the trust boundary itself — the caller (an ExecutorHost step, once wired)
 * is responsible for sourcing `tenantId` from the TrustedContext, never from a cow's payload.
 */
export interface Evidence {
  recordId: string;
  tenantId: string;
  workflowId?: string;
  operationId?: string;
  /** Capability that produced this record, e.g. "cz.vat.verify". */
  producerId: string;
  capabilityVersion: string;
  /** Ties to the future CertificationRecord (docs/SEVERKA.md `### Admission Gate`): which build produced this. */
  buildHash: string;
  schemaVersion: string;
  /** Which field of which business object this record verifies, e.g. "bankAccount". */
  inputField: string;
  /** Hash of the value being verified at the moment of verification (SEVERKA's `valueHash`). */
  inputValueHash: string;
  /** Capability-specific vocabulary (PASS/FAIL/NENALEZEN/...), kept as a string on purpose — the ledger doesn't judge outcomes. */
  result: string;
  /** Prior Žlab records this one was derived from or depends on (the "hashový graf" — SEVERKA `### Kontrola musí být svázaná...`). */
  parentRefs: string[];
  /** parentRefs[i]'s recordHash *at the time this record was written* — verifyLineage() catches drift if a parent is later found altered. */
  parentHashes: string[];
  observedAt: string;
  expiresAt?: string;
  /** sha256(canonicalize(every field above)) — changing any one field breaks this. */
  recordHash: string;
  keyId: string;
  /** Ed25519 signature over recordHash, produced by the platform key. A record with a valid recordHash but no valid
   * signature from a key this ledger trusts was never actually written by the platform (or was altered after signing
   * by someone who could edit storage but not sign — Milan's "attacker recomputes the hash but doesn't have the key"). */
  platformSignature: string;
}

export type EvidenceCandidate = Omit<Evidence, "recordId" | "observedAt" | "recordHash" | "keyId" | "platformSignature">;

export type EvidenceVerification = { ok: true } | { ok: false; reason: string };

export type LineageVerification = { ok: true } | { ok: false; brokenAt: string; reason: string };

/**
 * Platform-only signing identity for the ledger (never handed to a cow). Same Ed25519 primitive as
 * signing.ts's Signer/verifyBinding, generalized to sign an arbitrary recordHash instead of one
 * fixed message+context shape — kept separate from Signer on purpose (that class's `sign()` type is
 * pinned to MessageEnvelope/TrustedContext, a different signed object with a different lifetime).
 */
export interface EvidenceSigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export class EvidenceLedger {
  private readonly byId = new Map<string, Evidence>();
  private readonly byTenant = new Map<string, string[]>();

  constructor(
    private readonly clock: Clock,
    private readonly signing: EvidenceSigningKey,
  ) {}

  /**
   * The only write path (no update/delete method exists anywhere on this class — ZLAB-005 asserts
   * that by reflection, same discipline as Audit/EVD-004). Computes recordHash and
   * platformSignature itself; a caller cannot supply either, so a compromised cow calling through
   * this API can lie about `result`/`inputValueHash`/etc. (that's Dojička/policy's job to catch
   * against other evidence) but cannot produce a record that verify() will accept without having
   * gone through this exact method with the real private key.
   */
  append(candidate: EvidenceCandidate): Evidence {
    const recordId = newId("evd");
    const observedAt = iso(this.clock.now());
    const unsigned = { ...candidate, recordId, observedAt };
    const recordHash = sha256(canonicalize(unsigned));
    const platformSignature = toBase64Url(sign(null, utf8Bytes(recordHash), this.signing.privateKey));
    const record: Evidence = Object.freeze({ ...unsigned, recordHash, keyId: this.signing.keyId, platformSignature });
    this.byId.set(recordId, record);
    const list = this.byTenant.get(candidate.tenantId) ?? [];
    list.push(recordId);
    this.byTenant.set(candidate.tenantId, list);
    return structuredClone(record);
  }

  get(recordId: string): Evidence | undefined {
    const r = this.byId.get(recordId);
    return r ? structuredClone(r) : undefined;
  }

  /** Tenant-scoped read (Žlab is tenant-scoped by design, SEVERKA `### Tři role, ne dvě`) — never returns another tenant's records. */
  forTenant(tenantId: string): Evidence[] {
    return (this.byTenant.get(tenantId) ?? []).map((id) => structuredClone(this.byId.get(id) as Evidence));
  }

  /**
   * Recompute recordHash from content and verify platformSignature over it — proves the record is
   * exactly what the platform sealed, not edited since (Milan's "change one dot -> integrity
   * breaks" analogy) and not a hash-only forgery by someone who could edit storage but never held
   * `signing.privateKey`.
   */
  verify(record: Evidence): EvidenceVerification {
    const { recordHash, keyId, platformSignature, ...rest } = record;
    const expectedHash = sha256(canonicalize(rest));
    if (expectedHash !== recordHash) return { ok: false, reason: "recordHash does not match record content — record was altered after sealing" };
    if (keyId !== this.signing.keyId) return { ok: false, reason: `signed by unknown key ${keyId}, this ledger trusts ${this.signing.keyId}` };
    const sigOk = verify(null, utf8Bytes(recordHash), this.signing.publicKey, fromBase64Url(platformSignature));
    return sigOk ? { ok: true } : { ok: false, reason: "platformSignature does not match recordHash — forged or corrupted" };
  }

  /**
   * Walks parentRefs recursively: each parent must still exist, verify() clean, and its *current*
   * recordHash must equal the parentHashes entry the child recorded at write time. Implements the
   * "hashový graf" (SEVERKA `### Kontrola musí být svázaná s konkrétní hodnotou`): a downstream edit
   * to any ancestor breaks trust in everything built on top of it, not just the ancestor itself.
   */
  verifyLineage(recordId: string): LineageVerification {
    const record = this.byId.get(recordId);
    if (!record) return { ok: false, brokenAt: recordId, reason: "record not found" };
    const self = this.verify(record);
    if (!self.ok) return { ok: false, brokenAt: recordId, reason: self.reason };
    const parents: Array<[string, string]> = record.parentRefs.map((parentId, i) => [parentId, record.parentHashes[i] ?? ""]);
    for (const [parentId, expectedParentHash] of parents) {
      const parent = this.byId.get(parentId);
      if (!parent) return { ok: false, brokenAt: parentId, reason: "parent record not found" };
      if (parent.recordHash !== expectedParentHash) {
        return { ok: false, brokenAt: parentId, reason: `parent recordHash changed since ${recordId} referenced it — lineage broken` };
      }
      const upstream = this.verifyLineage(parentId);
      if (!upstream.ok) return upstream;
    }
    return { ok: true };
  }
}
