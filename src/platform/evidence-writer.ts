import type { AuthorityGrant } from "./authorities.js";
import { iso, plus, type Clock } from "./clock.js";
import type { Evidence, EvidenceCandidate, EvidenceLedger } from "./evidence.js";
import { formatFactAddress, type FactAddress } from "./fact-address.js";
import type { HandlerInput } from "./types.js";

/** What a cow's own handler may claim — deliberately excludes tenantId/producerId/capabilityVersion/buildHash/workflowId/operationId/originCaseId AND authorityDomain/reusePolicy, which EvidenceWriter sources itself (a cow can never declare its own authority — M0-FACT-CONTRACT-V1 část C — and, by the same principle, never its own cross-Case reuse policy either; docs/AUTONOMOUS-RUNTIME-V1.md část 2). */
export interface EvidenceClaim {
  subject: FactAddress;
  inputValueHash: string;
  result: string;
  parentRefs?: string[];
  parentHashes?: string[];
  expiresAt?: string;
}

/** Per-call options a caller with more context than the claim itself may supply — currently just originCaseId
 * (docs/AUTONOMOUS-RUNTIME-V1.md část 2): HandlerInput/MessageEnvelope/TrustedContext do not carry a caseId today
 * (adding one there is a bigger, separate dispatch-type change, explicitly out of scope for that ADR's step 2), so
 * a caller that already knows the Case at write time (the DO layer, once a caseId has been threaded down to it
 * through a capability's own payload — see attachment-fanout.ts/document-classifier's handler.ts) passes it here
 * instead. Never claim-settable (EvidenceClaim has no such field) — same reasoning as authorityDomain/reusePolicy. */
export interface EvidenceWriteOptions {
  originCaseId?: string;
}

/** The part of an installation authority grant a writer is bound to (authorities.ts AuthorityGrant, minus the producer list). */
export type WriterAuthority = Pick<AuthorityGrant, "domain" | "facts" | "maxEvidenceTtlMs">;

export interface WriterIdentity {
  producerId: string;
  capabilityVersion: string;
  buildHash: string;
  /** Resolved by the platform wiring from config/<installation>/authorities.json for this producer. Absent = no grant: "inferred". */
  authority?: WriterAuthority;
  /**
   * Cross-Case reuse policy this producer's evidence seals under (docs/AUTONOMOUS-RUNTIME-V1.md část 2). Bound at
   * construction by the platform wiring, exactly like `authority`/`authorityDomain` — NOT settable per call on
   * `EvidenceClaim` (same "a cow can never assert its own identity/authority" principle EvidenceWriter's own class
   * doc comment already applies to authorityDomain: a compromised or careless cow could otherwise mark its own
   * Case-specific evidence TENANT_WIDE and make it look reusable across every Case of the tenant). Absent =
   * EvidenceLedger.append()'s own default, CASE_ONLY. Set to TENANT_WIDE for producers whose fact is genuinely
   * Case-independent (cz.company.verify/cz.vat.verify — a company's registration status doesn't depend on which
   * Case asked, the ADR's own example) — document.classify stays unset/CASE_ONLY (this exact document is a fact of
   * its own Case, never generically reusable).
   */
  reusePolicy?: Evidence["reusePolicy"];
}

/**
 * Trusted-context-bound writer for the Žlab (docs/POSUDKY.md Posudek 15, P1-2). `EvidenceLedger`
 * itself says in its own doc comment that it is a storage primitive, not a trust boundary — a
 * caller with a direct reference to `append()` could claim any `tenantId`/`producerId`/`buildHash`
 * it likes. `EvidenceWriter` is that missing trust boundary:
 *
 *   - **Identity is bound once, at construction** (`producerId`/`capabilityVersion`/`buildHash`/
 *     the installation's `authority` grant) — the same instance the platform wiring would hand to exactly one
 *     capability's handler. A handler holding this writer can never claim to be a *different*
 *     capability or build than the one it was actually constructed for; there is no per-call way
 *     to override it, unlike `EvidenceCandidate`'s fields, which are all mutable per call.
 *   - **`tenantId`/`workflowId`/`operationId` come from `HandlerInput`** — the `message`+`context`
 *     pair `Router`/`ExecutorHost` produce only after schema, binding, signature, scope and policy
 *     checks already passed (`HandlerInput` is what a `Handler` actually receives, FOUNDATION-core
 *     §3.3) — never from a field the handler itself could set.
 *   - **The handler supplies only the domain-specific claim**: which field it verified, that
 *     field's value hash, and the result — `EvidenceClaim` structurally has no `tenantId`/
 *     `producerId`/etc. field to smuggle a false identity through, even under a type-unsafe cast,
 *     because `write()` never spreads `claim` into the candidate — it reads exactly the six named
 *     properties.
 *   - **Authority is enforced, not declared** (M0 část C, C-1): the grant bound at construction stamps
 *     `authorityDomain`, refuses a fact outside its scope (AUTHORITY_SCOPE — nothing is written, the same
 *     shape as Router refusing a scope outside a policy grant) and caps `expiresAt` at the grant's TTL —
 *     a cow may only ever shorten how long its evidence is trusted (Posudek 16 P1-10).
 */
export class EvidenceWriter {
  constructor(
    private readonly ledger: EvidenceLedger,
    private readonly identity: WriterIdentity,
    private readonly clock?: Clock,
  ) {
    if (identity.authority && identity.authority.maxEvidenceTtlMs !== null && !clock) {
      throw new Error(`EvidenceWriter for ${identity.producerId}: authority ${identity.authority.domain} caps evidence TTL, which needs a clock (fail-closed)`);
    }
  }

  write(input: HandlerInput, claim: EvidenceClaim, opts?: EvidenceWriteOptions): Evidence {
    const authority = this.identity.authority;
    const factKey = formatFactAddress(claim.subject);
    if (authority && authority.facts !== "*" && !authority.facts.includes(factKey)) {
      throw new Error(`AUTHORITY_SCOPE: ${this.identity.producerId} holds authority ${authority.domain} for ${authority.facts.join(", ")}, not for ${factKey} — nothing written`);
    }
    let expiresAt = claim.expiresAt;
    if (authority && authority.maxEvidenceTtlMs !== null && this.clock) {
      const cap = iso(plus(this.clock.now(), authority.maxEvidenceTtlMs));
      expiresAt = expiresAt === undefined || expiresAt > cap ? cap : expiresAt;
    }
    const candidate: EvidenceCandidate = {
      tenantId: input.context.tenantId,
      ...(opts?.originCaseId !== undefined ? { originCaseId: opts.originCaseId } : {}),
      workflowId: input.message.workflowId,
      operationId: input.message.messageId,
      producerId: this.identity.producerId,
      capabilityVersion: this.identity.capabilityVersion,
      buildHash: this.identity.buildHash,
      ...(authority ? { authorityDomain: authority.domain } : {}),
      subject: claim.subject,
      inputValueHash: claim.inputValueHash,
      result: claim.result,
      ...(this.identity.reusePolicy ? { reusePolicy: this.identity.reusePolicy } : {}),
      parentRefs: claim.parentRefs ?? [],
      parentHashes: claim.parentHashes ?? [],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    return this.ledger.append(candidate);
  }
}
