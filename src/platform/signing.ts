import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import { canonicalize } from "./canonical.js";
import type { Binding, DispatchEnvelope, MessageEnvelope, TrustedContext } from "./types.js";

export interface KeyRecord {
  keyId: string;
  publicKey: KeyObject;
  validFrom: string;
  validUntil?: string;
}

/** Longest deadlinePolicy of any capability behind this receiver (PT30M): a message signed by a retired key is still accepted that long after validUntil. */
export const DEFAULT_GRACE_MS = 30 * 60_000;

/** Receiver-side key registry with validity windows (FOUNDATION-core §4.3, SEC-CRED-002/003). */
export class KeyRegistry {
  private readonly keys = new Map<string, KeyRecord>();

  constructor(readonly graceMs: number = DEFAULT_GRACE_MS) {}

  add(record: KeyRecord): void {
    this.keys.set(record.keyId, { ...record });
  }

  /** Rotation step: close the validity window of a key. Messages signed inside the window stay valid for graceMs after it. */
  retire(keyId: string, validUntil: string): void {
    const r = this.keys.get(keyId);
    if (!r) throw new Error(`unknown key ${keyId}`);
    r.validUntil = validUntil;
  }

  remove(keyId: string): void {
    this.keys.delete(keyId);
  }

  get(keyId: string): KeyRecord | undefined {
    const r = this.keys.get(keyId);
    return r ? { ...r } : undefined;
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

/** Gateway-side signer. The private key never leaves the gateway (T19, SEC-HOST-002). */
export class Signer {
  constructor(
    readonly keyId: string,
    private readonly privateKey: KeyObject,
  ) {}

  sign(message: MessageEnvelope, context: TrustedContext, signedAt: string): Binding {
    const data = utf8Bytes(canonicalize({ message, context }));
    const signature = toBase64Url(sign(null, data, this.privateKey));
    return { mechanism: "signed-envelope", algorithm: "Ed25519", keyId: this.keyId, signature, signedAt, canonicalization: "JCS" };
  }
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify the binding of message and context. `now` is the receiver's clock: a key retired at validUntil is accepted for
 * messages signed inside its window only until validUntil + graceMs (SEC-CRED-003), so a stolen old key cannot be used forever.
 */
export function verifyBinding(env: DispatchEnvelope, registry: KeyRegistry, now: string): BindingCheck {
  const b = env.binding;
  if (b.mechanism === "in-process") return { ok: true };
  if (b.mechanism !== "signed-envelope") return { ok: false, reason: `mechanism ${b.mechanism} not supported by this receiver` };
  if (b.algorithm !== "Ed25519") return { ok: false, reason: `algorithm ${b.algorithm ?? "missing"} not accepted (default is Ed25519)` };
  if (!b.keyId || !b.signature || !b.signedAt || b.canonicalization !== "JCS") return { ok: false, reason: "incomplete binding" };
  const key = registry.keyValidAt(b.keyId, b.signedAt);
  if (!key) return { ok: false, reason: `no key ${b.keyId} valid at ${b.signedAt}` };
  const record = registry.get(b.keyId);
  if (record?.validUntil) {
    const graceEnd = new Date(Date.parse(record.validUntil) + registry.graceMs).toISOString();
    if (now > graceEnd) return { ok: false, reason: `key ${b.keyId} retired at ${record.validUntil}, grace period ended ${graceEnd}` };
  }
  const data = utf8Bytes(canonicalize({ message: env.message, context: env.context }));
  const ok = verify(null, data, key, fromBase64Url(b.signature));
  return ok ? { ok: true } : { ok: false, reason: "signature does not match message+context" };
}
