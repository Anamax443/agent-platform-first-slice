import type { Clock } from "./clock.js";
import { iso, plus, HOUR } from "./clock.js";
import { newId } from "./ids.js";
import type { Signer } from "./signing.js";
import type { ActorType, AuthStrength, DispatchEnvelope, MessageEnvelope, TrustedContext } from "./types.js";

/** An authenticated principal as the platform knows it. Never derived from a payload. */
export interface Identity {
  actorId: string;
  actorType: ActorType;
  tenantId: string;
  scopes: string[];
  authStrength: AuthStrength;
}

export class IdentityProvider {
  private readonly byId = new Map<string, Identity>();
  constructor(identities: Identity[]) {
    for (const i of identities) this.byId.set(i.actorId, { ...i, scopes: [...i.scopes] });
  }
  authenticate(actorId: string): Identity | undefined {
    const i = this.byId.get(actorId);
    return i ? { ...i, scopes: [...i.scopes] } : undefined;
  }
}

/** Creates the TrustedExecutionContext from identity and signs the dispatch envelope (FOUNDATION-core §4.2, §4.3). */
export class Gateway {
  private signer: Signer;
  constructor(
    private readonly opts: { identities: IdentityProvider; signer: Signer; clock: Clock; contextTtlMs?: number },
  ) {
    this.signer = opts.signer;
  }

  /** Key rotation step 2: gateway switches to the new key; receivers already hold both (registry). */
  rotate(signer: Signer): void {
    this.signer = signer;
  }

  dispatch(message: MessageEnvelope, actorId: string): DispatchEnvelope {
    const id = this.opts.identities.authenticate(actorId);
    if (!id) throw new Error(`unknown actor ${actorId}`);
    const now = this.opts.clock.now();
    const context: TrustedContext = {
      dispatchId: newId("dsp"),
      tenantId: id.tenantId,
      actorId: id.actorId,
      actorType: id.actorType,
      originatingActorId: id.actorId,
      authStrength: id.authStrength,
      scopes: id.scopes,
      sourceComponent: id.actorId,
      authenticatedAt: iso(now),
      expiresAt: iso(plus(now, this.opts.contextTtlMs ?? HOUR)),
    };
    const binding = this.signer.sign(message, context, iso(now));
    return { message, context, binding };
  }
}
