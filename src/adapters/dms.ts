import { ProcessCrash, UnknownOutcomeError } from "../platform/errors.js";

/**
 * DMS adapter: the external system document.stamp writes into. `clientRef` is the caller's idempotency key;
 * the DMS keeps it as the business identity of the write so that status can be queried after an unknown outcome.
 */
export interface DmsAdapter {
  stamp(input: { bytes: string; stampText: string; clientRef: string }, credential: string): Promise<{ bytes: string; ref: string }>;
  status(clientRef: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN">;
  read(clientRef: string): Promise<{ bytes: string; ref: string } | undefined>;
}

export type DmsMode = "ok" | "unknown-once" | "unknown-always" | "crash-after-write" | "auth-fail";
export type DmsStatusMode = "ok" | "unknown";

export class FakeDmsAdapter implements DmsAdapter {
  stampCalls = 0;
  readonly written = new Map<string, { bytes: string; ref: string }>();
  private thrownOnce = false;
  constructor(
    public mode: DmsMode = "ok",
    public statusMode: DmsStatusMode = "ok",
    private readonly expectedCredential = "dms-secret",
  ) {}

  async stamp(input: { bytes: string; stampText: string; clientRef: string }, credential: string): Promise<{ bytes: string; ref: string }> {
    if (credential !== this.expectedCredential || this.mode === "auth-fail") throw new Error("DMS authentication failed");
    this.stampCalls += 1;
    const out = `${input.bytes}\n--- ${input.stampText} ---`;
    const ref = `dms-${this.stampCalls}`;
    this.written.set(input.clientRef, { bytes: out, ref }); // the side effect happened
    if (this.mode === "unknown-once" && !this.thrownOnce) {
      this.thrownOnce = true;
      throw new UnknownOutcomeError(input.clientRef);
    }
    if (this.mode === "unknown-always") throw new UnknownOutcomeError(input.clientRef);
    if (this.mode === "crash-after-write") throw new ProcessCrash(input.clientRef);
    return { bytes: out, ref };
  }

  async status(clientRef: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN"> {
    if (this.statusMode === "unknown") return "UNKNOWN";
    return this.written.has(clientRef) ? "DONE" : "NOT_FOUND";
  }

  async read(clientRef: string): Promise<{ bytes: string; ref: string } | undefined> {
    return this.written.get(clientRef);
  }
}
