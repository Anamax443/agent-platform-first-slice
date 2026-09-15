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
  /** Evidence record schema — set by the ledger itself (EVIDENCE_SCHEMA_VERSION), never by a caller. */
  schemaVersion: string;
  /**
   * Who is entitled to assert this fact (docs/M0-FACT-CONTRACT-V1.md část C): an installation-granted authority
   * domain such as "cz.company.registry" or "tenant.human-review". Stamped by the platform (EvidenceWriter, from the
   * installation's authority grant), absent = "inferred" — the producer holds no grant for this fact. Part of the
   * signed content, so it can never be raised after sealing.
   */
  authorityDomain?: string;
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

export type EvidenceCandidate = Omit<Evidence, "recordId" | "observedAt" | "schemaVersion" | "recordHash" | "keyId" | "platformSignature">;

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

/**
 * Evidence record schema this ledger writes and accepts (docs/M0-FACT-CONTRACT-V1.md část D, R4). v1 records
 * (bare-hash signature, no authorityDomain) are refused by verify() — never silently accepted.
 */
export const EVIDENCE_SCHEMA_VERSION = "2";
/**
 * Domain separation (docs/POSUDKY.md Posudek 16 P1-12): the platform signs "EVIDENCE:v2:<recordHash>", never the
 * bare hash, so an Evidence signature can never be replayed as a Konev (or any other) signature over the same bytes.
 */
export const EVIDENCE_SIGNATURE_DOMAIN = `EVIDENCE:v${EVIDENCE_SCHEMA_VERSION}:`;
export const evidenceSignedBytes = (recordHash: string) => utf8Bytes(EVIDENCE_SIGNATURE_DOMAIN + recordHash);

/**
 * Verification needs only the platform's PUBLIC key (M0 část D, D3: trust comes from the signature, never from the
 * row). Standalone so any reader of a copy — the D1 mirror check on /farm, a future auditor with just the public
 * key — can prove a record is exactly what the platform sealed without ever holding the private key. Order of
 * checks: schema version (a v1 record is refused, never silently accepted), content hash (any edited field), key id,
 * signature over the domain-separated hash (a hash-only forgery by someone who could edit storage but never held
 * the private key).
 */
export function verifyEvidence(record: Evidence, trusted: { keyId: string; publicKey: KeyObject }): EvidenceVerification {
  const { recordHash, keyId, platformSignature, ...rest } = record;
  if (rest.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported evidence schemaVersion ${JSON.stringify(rest.schemaVersion)} — only v${EVIDENCE_SCHEMA_VERSION} records are accepted (older records are refused, never silently accepted)` };
  }
  const expectedHash = sha256(canonicalize(rest));
  if (expectedHash !== recordHash) return { ok: false, reason: "recordHash does not match record content — record was altered after sealing" };
  if (keyId !== trusted.keyId) return { ok: false, reason: `signed by unknown key ${keyId}, trusted key is ${trusted.keyId}` };
  const sigOk = verify(null, evidenceSignedBytes(recordHash), trusted.publicKey, fromBase64Url(platformSignature));
  return sigOk ? { ok: true } : { ok: false, reason: "platformSignature does not match recordHash — forged or corrupted" };
}

/**
 * Storage behind the ledger (docs/M0-FACT-CONTRACT-V1.md část D). Deliberately three read/write calls and nothing
 * else: no update, no delete — the store's surface is as append-only as the ledger's. The ledger seals (hash + sign)
 * before `put()`, so a store never sees an unsigned record, and it verifies after `get()`, so a store is never trusted
 * on its own (D3: trust comes from the signature, never from the row existing).
 */
export interface EvidenceStore {
  put(record: Evidence): void;
  get(recordId: string): Evidence | undefined;
  /** Records of one tenant in write order. */
  forTenant(tenantId: string): Evidence[];
}

/** Default store: process memory. Tests and the in-process slice; a deployed farm uses a durable store (evidence-sqlite.ts). */
export class MemoryEvidenceStore implements EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  private readonly byTenant = new Map<string, string[]>();

  put(record: Evidence): void {
    if (this.byId.has(record.recordId)) throw new Error(`evidence ${record.recordId} already exists — the Žlab is append-only`);
    this.byId.set(record.recordId, record);
    const list = this.byTenant.get(record.tenantId) ?? [];
    list.push(record.recordId);
    this.byTenant.set(record.tenantId, list);
  }

  get(recordId: string): Evidence | undefined {
    return this.byId.get(recordId);
  }

  forTenant(tenantId: string): Evidence[] {
    return (this.byTenant.get(tenantId) ?? []).map((id) => this.byId.get(id) as Evidence);
  }
}

export class EvidenceLedger {
  constructor(
    private readonly clock: Clock,
    private readonly signing: EvidenceSigningKey,
    private readonly store: EvidenceStore = new MemoryEvidenceStore(),
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
    const unsigned = { ...candidate, recordId, observedAt, schemaVersion: EVIDENCE_SCHEMA_VERSION };
    const recordHash = sha256(canonicalize(unsigned));
    const platformSignature = toBase64Url(sign(null, evidenceSignedBytes(recordHash), this.signing.privateKey));
    const record: Evidence = Object.freeze({ ...unsigned, recordHash, keyId: this.signing.keyId, platformSignature });
    this.store.put(record);
    return structuredClone(record);
  }

  /**
   * Accepts a record this platform already sealed elsewhere (another case's object, read back from the mirror —
   * docs/M0-FACT-CONTRACT-V1.md část D, D-4) verbatim: same recordId, same signature. Fail-closed: a record that
   * does not verify() under this ledger's key is refused, a different record under an existing recordId is refused,
   * an identical one is a no-op. Still append-only — nothing here can change or remove a stored record.
   */
  importSealed(record: Evidence): "IMPORTED" | "ALREADY_PRESENT" {
    const check = this.verify(record);
    if (!check.ok) throw new Error(`refusing to import unverifiable evidence ${record.recordId}: ${check.reason}`);
    const existing = this.store.get(record.recordId);
    if (existing) {
      if (existing.recordHash === record.recordHash) return "ALREADY_PRESENT";
      throw new Error(`refusing to import evidence ${record.recordId}: a different sealed record already holds this id`);
    }
    this.store.put(Object.freeze(structuredClone(record)));
    return "IMPORTED";
  }

  get(recordId: string): Evidence | undefined {
    const r = this.store.get(recordId);
    return r ? structuredClone(r) : undefined;
  }

  /** Tenant-scoped read (Žlab is tenant-scoped by design, SEVERKA `### Tři role, ne dvě`) — never returns another tenant's records. */
  forTenant(tenantId: string): Evidence[] {
    return this.store.forTenant(tenantId).map((r) => structuredClone(r));
  }

  /**
   * Recompute recordHash from content and verify platformSignature over it — proves the record is
   * exactly what the platform sealed, not edited since (Milan's "change one dot -> integrity
   * breaks" analogy) and not a hash-only forgery by someone who could edit storage but never held
   * `signing.privateKey`.
   */
  verify(record: Evidence): EvidenceVerification {
    return verifyEvidence(record, this.signing);
  }

  /**
   * Walks parentRefs recursively: each parent must still exist, verify() clean, and its *current*
   * recordHash must equal the parentHashes entry the child recorded at write time. Implements the
   * "hashový graf" (SEVERKA `### Kontrola musí být svázaná s konkrétní hodnotou`): a downstream edit
   * to any ancestor breaks trust in everything built on top of it, not just the ancestor itself.
   */
  verifyLineage(recordId: string): LineageVerification {
    const record = this.store.get(recordId);
    if (!record) return { ok: false, brokenAt: recordId, reason: "record not found" };
    const self = this.verify(record);
    if (!self.ok) return { ok: false, brokenAt: recordId, reason: self.reason };
    const parents: Array<[string, string]> = record.parentRefs.map((parentId, i) => [parentId, record.parentHashes[i] ?? ""]);
    for (const [parentId, expectedParentHash] of parents) {
      const parent = this.store.get(parentId);
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
