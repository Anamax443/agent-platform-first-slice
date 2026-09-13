import { sign, verify } from "node:crypto";
import { sha256 } from "./artifacts.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import { canonicalize } from "./canonical.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import type { EvidenceSigningKey } from "./evidence.js";
import type { EvidenceLedger } from "./evidence.js";
import type { AggregateResult } from "./aggregator.js";
import { newId } from "./ids.js";

/**
 * Konev (SEVERKA.md `### Tři role, ne dvě`): the Dojička's sealed output. Once sealed a
 * CertifiedBusinessObject is immutable — a change to the business data never edits the object, it
 * produces a new one with its own certifiedObjectId and rootHash (no update path exists on
 * BusinessObjectSealer, same discipline as EvidenceLedger/Audit). `businessPayload` is the only
 * place a business value may legally travel from here on: the Router/ExecutorHost chain that
 * eventually consumes this (a future Mlékárna) must verify the object as a whole, not trust a
 * `validation.status` claim buried in some other payload (docs/POSUDKY.md Posudek 14 point 5).
 */
export interface CertifiedBusinessObject {
  certifiedObjectId: string;
  tenantId: string;
  workflowId?: string;
  /** What kind of business object this is (e.g. "invoice") — generalized like Evidence.producerId, never a hardcoded single type. */
  objectType: string;
  businessPayload: Record<string, unknown>;
  /** Žlab records this object was certified from — re-checked live by verify(), not trusted from sealing time. */
  evidenceRefs: string[];
  certifiedAt: string;
  /** sha256(canonicalize(every field above)) — proves the object's own content hasn't changed since sealing. */
  rootHash: string;
  keyId: string;
  /** Ed25519 signature over rootHash, same platform key as EvidenceLedger — a Mlékárna never gets this key either. */
  platformSignature: string;
}

export type SealResult = { ok: true; object: CertifiedBusinessObject } | { ok: false; reason: string };

export type SealVerification = { ok: true } | { ok: false; reason: string };

/**
 * Seals a Dojička's READY decision into an immutable Konev. Only accepts a `AggregateResult` whose
 * `decision` is already "READY" (a REVIEW/REJECT cannot be sealed, structurally, not just by
 * caller discipline) and independently re-verifies every referenced evidence record against the
 * ledger at seal time (defense in depth against evidence changing between aggregate() and seal(),
 * the same "recheck immediately before the consequential step" pattern ExecutorHost's deadline
 * check already uses) — it never simply trusts the AggregateResult's own evidenceRefs list.
 */
export class BusinessObjectSealer {
  private readonly byId = new Map<string, CertifiedBusinessObject>();

  constructor(
    private readonly ledger: EvidenceLedger,
    private readonly clock: Clock,
    private readonly signing: EvidenceSigningKey,
  ) {}

  seal(input: { result: AggregateResult; tenantId: string; workflowId?: string; objectType: string; businessPayload: Record<string, unknown> }): SealResult {
    if (input.result.decision !== "READY") {
      return { ok: false, reason: `cannot seal a ${input.result.decision} decision — only READY may become a Konev` };
    }
    for (const recordId of input.result.evidenceRefs) {
      const record = this.ledger.get(recordId);
      if (!record) return { ok: false, reason: `evidence ${recordId} no longer exists in the ledger` };
      if (record.tenantId !== input.tenantId) return { ok: false, reason: `evidence ${recordId} belongs to tenant ${record.tenantId}, expected ${input.tenantId}` };
      const integrity = this.ledger.verify(record);
      if (!integrity.ok) return { ok: false, reason: `evidence ${recordId} failed integrity check at seal time: ${integrity.reason}` };
      const lineage = this.ledger.verifyLineage(recordId);
      if (!lineage.ok) return { ok: false, reason: `evidence ${recordId} lineage broken at seal time (${lineage.brokenAt}): ${lineage.reason}` };
    }

    const certifiedObjectId = newId("obj");
    const certifiedAt = iso(this.clock.now());
    const unsigned = {
      certifiedObjectId,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      objectType: input.objectType,
      businessPayload: input.businessPayload,
      evidenceRefs: input.result.evidenceRefs,
      certifiedAt,
    };
    const rootHash = sha256(canonicalize(unsigned));
    const platformSignature = toBase64Url(sign(null, utf8Bytes(rootHash), this.signing.privateKey));
    const object: CertifiedBusinessObject = Object.freeze({ ...unsigned, rootHash, keyId: this.signing.keyId, platformSignature });
    this.byId.set(certifiedObjectId, object);
    return { ok: true, object: structuredClone(object) };
  }

  get(certifiedObjectId: string): CertifiedBusinessObject | undefined {
    const o = this.byId.get(certifiedObjectId);
    return o ? structuredClone(o) : undefined;
  }

  /**
   * Two independent checks, on purpose: (1) the object's own rootHash/signature still match its
   * own content — catches a direct edit of the sealed object; (2) every evidenceRef still verifies
   * and lineage-checks clean *right now* — catches the underlying Žlab evidence being altered
   * *after* this Konev was sealed, which the object's own rootHash cannot see because it never
   * embedded the evidence's hashes, only their ids. A future Mlékárna must call this, not just
   * trust that the object once passed seal().
   */
  verify(object: CertifiedBusinessObject): SealVerification {
    const { rootHash, keyId, platformSignature, ...rest } = object;
    const expectedHash = sha256(canonicalize(rest));
    if (expectedHash !== rootHash) return { ok: false, reason: "rootHash does not match object content — object was altered after sealing" };
    if (keyId !== this.signing.keyId) return { ok: false, reason: `signed by unknown key ${keyId}, this sealer trusts ${this.signing.keyId}` };
    const sigOk = verify(null, utf8Bytes(rootHash), this.signing.publicKey, fromBase64Url(platformSignature));
    if (!sigOk) return { ok: false, reason: "platformSignature does not match rootHash — forged or corrupted" };

    for (const recordId of object.evidenceRefs) {
      const record = this.ledger.get(recordId);
      if (!record) return { ok: false, reason: `evidence ${recordId} backing this object no longer exists` };
      const integrity = this.ledger.verify(record);
      if (!integrity.ok) return { ok: false, reason: `evidence ${recordId} backing this object failed integrity check: ${integrity.reason}` };
      const lineage = this.ledger.verifyLineage(recordId);
      if (!lineage.ok) return { ok: false, reason: `evidence ${recordId} backing this object has broken lineage at ${lineage.brokenAt}: ${lineage.reason}` };
    }
    return { ok: true };
  }
}
