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

/**
 * Trusted-context-bound writer for the Žlab (docs/POSUDKY.md Posudek 15, P1-2). `EvidenceLedger`
 * itself says in its own doc comment that it is a storage primitive, not a trust boundary — a
 * caller with a direct reference to `append()` could claim any `tenantId`/`producerId`/`buildHash`
 * it likes. `EvidenceWriter` is that missing trust boundary:
 *
 *   - **Identity is bound once, at construction** (`producerId`/`capabilityVersion`/`buildHash`/
 *     `authorityDomain` from the installation grant) — the same instance the platform wiring would hand to exactly one
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
 */
export class EvidenceWriter {
  constructor(
    private readonly ledger: EvidenceLedger,
    private readonly identity: { producerId: string; capabilityVersion: string; buildHash: string; authorityDomain?: string },
  ) {}

  write(input: HandlerInput, claim: EvidenceClaim): Evidence {
    const candidate: EvidenceCandidate = {
      tenantId: input.context.tenantId,
      workflowId: input.message.workflowId,
      operationId: input.message.messageId,
      producerId: this.identity.producerId,
      capabilityVersion: this.identity.capabilityVersion,
      buildHash: this.identity.buildHash,
      ...(this.identity.authorityDomain !== undefined ? { authorityDomain: this.identity.authorityDomain } : {}),
      inputField: claim.inputField,
      inputValueHash: claim.inputValueHash,
      result: claim.result,
      parentRefs: claim.parentRefs ?? [],
      parentHashes: claim.parentHashes ?? [],
      expiresAt: claim.expiresAt,
    };
    return this.ledger.append(candidate);
  }
}
