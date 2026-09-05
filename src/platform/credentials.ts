import { AsyncLocalStorage } from "node:async_hooks";
import type { Audit } from "./audit.js";

export class CredentialDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDenied";
  }
}

export type ResolverMode = "strict" | "mutant";

/** Read-only facade handed to handlers. */
export interface CredentialAccess {
  resolve(ref: string): string;
}

/**
 * CredentialResolverFixture (VERIFICATION-CONTRACT §6). The calling handler's identity is taken from the
 * execution context set by the host (AsyncLocalStorage), never from an argument. In a LOGICAL host this is
 * policy, not a memory boundary (FOUNDATION-core §3.2); MUT-HOST-001 flips `mode` to "mutant".
 */
export class CredentialResolver implements CredentialAccess {
  private readonly als = new AsyncLocalStorage<string>();
  private mode: ResolverMode = "strict";

  constructor(
    private readonly table: Record<string, Record<string, string>>,
    private readonly audit?: Audit,
  ) {}

  setMode(mode: ResolverMode): void {
    this.mode = mode;
  }

  runAs<T>(handlerId: string, fn: () => Promise<T>): Promise<T> {
    return this.als.run(handlerId, fn);
  }

  currentHandler(): string | undefined {
    return this.als.getStore();
  }

  resolve(ref: string): string {
    const handler = this.als.getStore();
    if (this.mode === "mutant") {
      for (const t of Object.values(this.table)) if (ref in t) return t[ref] as string;
    }
    if (!handler) throw new CredentialDenied(`no handler identity in execution context for ${ref}`);
    const own = this.table[handler];
    if (own && ref in own) return own[ref] as string;
    this.audit?.append({ kind: "security", details: { event: "CREDENTIAL_DENIED", handlerId: handler, ref } });
    throw new CredentialDenied(`handler ${handler} may not resolve ${ref}`);
  }
}
