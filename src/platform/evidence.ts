import { sign, verify, type KeyObject } from "node:crypto";
import { sha256 } from "./artifacts.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import { canonicalize } from "./canonical.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { formatFactAddress, type FactAddress } from "./fact-address.js";
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
  /**
   * The Case this evidence was sealed within (docs/AUTONOMOUS-RUNTIME-V1.md část 2, ADR-1 18.9.2026) — VOLITELNÉ,
   * not required: `createCaseForMailIntake()` builds the Case only AFTER `orchestrator.run()` returns, but the
   * top-level mail-intake instance's own `document.classify` step calls `EvidenceWriter.write()` INSIDE that same
   * `orchestrator.run()` call — so no Case exists yet at that exact moment for that one instance. It DOES exist by
   * the time a fan-out sub-instance (attachment-classify/attachment-extract) runs, since those start after
   * `createCaseForMailIntake()`. Populated wherever a Case is genuinely knowable at seal time (the DO layer passes
   * it through as an optional per-call `write()` option — see evidence-writer.ts); left `undefined` otherwise. A
   * Case-scoped reader (`EvidenceLedger.forCase()` below) must treat `undefined` as "not attributable to any Case,
   * never returned by a Case-scoped lookup unless reusePolicy is TENANT_WIDE" — a safe default, not a bug.
   */
  originCaseId?: string;
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
  /**
   * The structured FactAddress this record attests (docs/AUTONOMOUS-RUNTIME-V1.md část 2) — fact-address.ts's
   * `{key, scope, entityId?}`, set by the caller (EvidenceCandidate/EvidenceClaim) and never touched by the ledger.
   */
  subject: FactAddress;
  /**
   * Which field of which business object this record verifies, e.g. "bankAccount" — DERIVED, set by the ledger
   * itself as `formatFactAddress(subject)` at write time (never a second source of truth, never caller-settable:
   * EvidenceCandidate has no `inputField` of its own). Kept as a real, stored, queryable field on purpose — every
   * existing reader (evidence-sqlite.ts's SQL index, evidence-mirror.ts's lookup, the aggregator's byField grouping)
   * keeps working against the plain textual form unchanged; `subject` is for a reader that wants the structured form.
   */
  inputField: string;
  /** Hash of the value being verified at the moment of verification (SEVERKA's `valueHash`). */
  inputValueHash: string;
  /** Capability-specific vocabulary (PASS/FAIL/NENALEZEN/...), kept as a string on purpose — the ledger doesn't judge outcomes. */
  result: string;
  /**
   * Cross-Case reuse (docs/AUTONOMOUS-RUNTIME-V1.md část 2, AR-5): CASE_ONLY (default) means only the Case named by
   * `originCaseId` may treat this record as available evidence; TENANT_WIDE is an explicit opt-in ("does this
   * company exist" — true independent of which Case is asking) that `EvidenceLedger.forCase()` also returns to
   * every Case of the same tenant. Set once, on the EvidenceWriter's bound identity (never per-call on a claim a
   * cow could set to TENANT_WIDE for itself — see evidence-writer.ts's WriterIdentity for why).
   */
  reusePolicy: "CASE_ONLY" | "TENANT_WIDE";
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

/**
 * `inputField` is derived (append() computes it from `subject`, never accepted from a caller — see Evidence's own
 * doc comment on `inputField`). `reusePolicy` is optional here and defaults to CASE_ONLY in append() when omitted —
 * additive, so every existing candidate literal that never mentions reuse still gets the safe default without
 * having to be touched.
 */
export type EvidenceCandidate = Omit<Evidence, "recordId" | "observedAt" | "schemaVersion" | "recordHash" | "keyId" | "platformSignature" | "inputField" | "reusePolicy"> & {
  reusePolicy?: Evidence["reusePolicy"];
};

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
 * Evidence record schema this ledger writes and accepts (docs/M0-FACT-CONTRACT-V1.md část D, R4;
 * docs/AUTONOMOUS-RUNTIME-V1.md část 2). v1 records (bare-hash signature, no authorityDomain) are refused by
 * verify() — never silently accepted. v2 records (no originCaseId/subject/reusePolicy — `subject` did not exist,
 * `inputField` was the only field) are refused the same way, same fail-closed discipline as the v1->v2 bump: a
 * schema version bump means older records genuinely stop verifying, not "verify() gets looser to cope". Real,
 * accepted operational cost of this particular bump (18.9.2026): farm-bass443 has real v2 Evidence records sealed
 * live (133+ D1-mirrored records confirmed via /farm/zlab.json as of 18.9.2026) — those become unverifiable via
 * verify() going forward, the same situation the v1->v2 bump already created once for v1 records.
 */
export const EVIDENCE_SCHEMA_VERSION = "3";
/**
 * Domain separation (docs/POSUDKY.md Posudek 16 P1-12): the platform signs "EVIDENCE:v3:<recordHash>", never the
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
    const inputField = formatFactAddress(candidate.subject);
    const reusePolicy = candidate.reusePolicy ?? "CASE_ONLY";
    const unsigned = { ...candidate, inputField, reusePolicy, recordId, observedAt, schemaVersion: EVIDENCE_SCHEMA_VERSION };
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
   * Case-scoped read (docs/AUTONOMOUS-RUNTIME-V1.md část 2, AR-5) — the ONE place the CASE_ONLY-unless-TENANT_WIDE
   * filter is applied. A reader that wants "evidence available to this Case" should call this instead of
   * re-implementing the filter over forTenant() itself — attachment-fanout.ts's classifiedAsInvoice() used to do
   * exactly that unfiltered scan before this method existed (fixed 18.9.2026, same commit that added this method).
   * Evidence with no originCaseId (sealed before its Case existed — see Evidence.originCaseId's own doc comment for
   * exactly when that happens) is returned here only if it is also reusePolicy TENANT_WIDE — the safe default from
   * part 2 of the ADR, not a gap: an un-attributable CASE_ONLY record is simply never reusable by any Case.
   */
  forCase(tenantId: string, caseId: string): Evidence[] {
    return this.forTenant(tenantId).filter((r) => r.originCaseId === caseId || r.reusePolicy === "TENANT_WIDE");
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
