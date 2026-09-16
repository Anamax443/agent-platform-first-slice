import type { AuthorityGrant } from "./authorities.js";
import { iso, plus, type Clock } from "./clock.js";
import type { Evidence, EvidenceCandidate, EvidenceLedger } from "./evidence.js";
import type { HandlerInput } from "./types.js";

/** What a cow's own handler may claim — deliberately excludes tenantId/producerId/capabilityVersion/buildHash/workflowId/operationId AND authorityDomain, which EvidenceWriter sources itself (a cow can never declare its own authority — M0-FACT-CONTRACT-V1 část C). */
export interface EvidenceClaim {
  inputField: string;
  inputValueHash: string;
  result: string;
  parentRefs?: string[];
  parentHashes?: string[];
  expiresAt?: string;
}

/** The part of an installation authority grant a writer is bound to (authorities.ts AuthorityGrant, minus the producer list). */
export type WriterAuthority = Pick<AuthorityGrant, "domain" | "facts" | "maxEvidenceTtlMs">;

export interface WriterIdentity {
  producerId: string;
  capabilityVersion: string;
  buildHash: string;
  /** Resolved by the platform wiring from config/<installation>/authorities.json for this producer. Absent = no grant: "inferred". */
  authority?: WriterAuthority;
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

  write(input: HandlerInput, claim: EvidenceClaim): Evidence {
    const authority = this.identity.authority;
    if (authority && authority.facts !== "*" && !authority.facts.includes(claim.inputField)) {
      throw new Error(
        `AUTHORITY_SCOPE: ${this.identity.producerId} holds authority ${authority.domain} for ${authority.facts.join(", ")}, not for ${claim.inputField} — nothing written`,
      );
    }
    let expiresAt = claim.expiresAt;
    if (authority && authority.maxEvidenceTtlMs !== null && this.clock) {
      const cap = iso(plus(this.clock.now(), authority.maxEvidenceTtlMs));
      expiresAt = expiresAt === undefined || expiresAt > cap ? cap : expiresAt;
    }
    const candidate: EvidenceCandidate = {
      tenantId: input.context.tenantId,
      workflowId: input.message.workflowId,
      operationId: input.message.messageId,
      producerId: this.identity.producerId,
      capabilityVersion: this.identity.capabilityVersion,
      buildHash: this.identity.buildHash,
      ...(authority ? { authorityDomain: authority.domain } : {}),
      inputField: claim.inputField,
      inputValueHash: claim.inputValueHash,
      result: claim.result,
      parentRefs: claim.parentRefs ?? [],
      parentHashes: claim.parentHashes ?? [],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    return this.ledger.append(candidate);
  }
}
