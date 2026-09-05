import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { Binding, DispatchEnvelope, MessageEnvelope, TrustedContext } from "./types.js";

export interface KeyRecord {
  keyId: string;
  publicKey: KeyObject;
  validFrom: string;
  validUntil?: string;
}

/** Receiver-side key registry with validity windows (FOUNDATION-core §4.3, SEC-CRED-002/003). */
export class KeyRegistry {
  private readonly keys = new Map<string, KeyRecord>();

  add(record: KeyRecord): void {
    this.keys.set(record.keyId, { ...record });
  }

  /** Close the validity window of a key (rotation step 3 happens later via remove()). */
  retire(keyId: string, validUntil: string): void {
    const r = this.keys.get(keyId);
    if (!r) throw new Error(`unknown key ${keyId}`);
    r.validUntil = validUntil;
  }

  remove(keyId: string): void {
    this.keys.delete(keyId);
  }

  /** The key that was valid at the given instant (compare ISO strings, all UTC with Z). */
  keyValidAt(keyId: string, at: string): KeyObject | undefined {
    const r = this.keys.get(keyId);
    if (!r) return undefined;
    if (at < r.validFrom) return undefined;
    if (r.validUntil && at > r.validUntil) return undefined;
    return r.publicKey;
  }

  list(): KeyRecord[] {
    return [...this.keys.values()].map((k) => ({ ...k }));
  }
}

export function generateKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

/** Gateway-side signer. The private key never leaves the gateway (T19). */
export class Signer {
  constructor(
    readonly keyId: string,
    private readonly privateKey: KeyObject,
  ) {}

  sign(message: MessageEnvelope, context: TrustedContext, signedAt: string): Binding {
    const data = Buffer.from(canonicalize({ message, context }), "utf8");
    const signature = sign(null, data, this.privateKey).toString("base64url");
    return { mechanism: "signed-envelope", algorithm: "Ed25519", keyId: this.keyId, signature, signedAt, canonicalization: "JCS" };
  }
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };

export function verifyBinding(env: DispatchEnvelope, registry: KeyRegistry): BindingCheck {
  const b = env.binding;
  if (b.mechanism === "in-process") return { ok: true };
  if (b.mechanism !== "signed-envelope") return { ok: false, reason: `mechanism ${b.mechanism} not supported by this receiver` };
  if (b.algorithm !== "Ed25519") return { ok: false, reason: `algorithm ${b.algorithm ?? "missing"} not accepted (default is Ed25519)` };
  if (!b.keyId || !b.signature || !b.signedAt || b.canonicalization !== "JCS") return { ok: false, reason: "incomplete binding" };
  const key = registry.keyValidAt(b.keyId, b.signedAt);
  if (!key) return { ok: false, reason: `no key ${b.keyId} valid at ${b.signedAt}` };
  const data = Buffer.from(canonicalize({ message: env.message, context: env.context }), "utf8");
  const ok = verify(null, data, key, Buffer.from(b.signature, "base64url"));
  return ok ? { ok: true } : { ok: false, reason: "signature does not match message+context" };
}
