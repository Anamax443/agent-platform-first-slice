import { ProcessCrash, UnknownOutcomeError } from "../platform/errors.js";

/** DMS adapter: the external system document.stamp writes into. */
export interface DmsAdapter {
  stamp(bytes: string, stampText: string, credential: string): Promise<{ bytes: string; ref: string }>;
  status(ref: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN">;
  read(ref: string): Promise<string | undefined>;
}

export type DmsMode = "ok" | "unknown-once" | "unknown-always" | "crash-after-write" | "auth-fail";
export type DmsStatusMode = "ok" | "unknown";

export class FakeDmsAdapter implements DmsAdapter {
  stampCalls = 0;
  readonly written = new Map<string, string>();
  private thrownOnce = false;
  constructor(
    public mode: DmsMode = "ok",
    public statusMode: DmsStatusMode = "ok",
    private readonly expectedCredential = "dms-secret",
  ) {}

  async stamp(bytes: string, stampText: string, credential: string): Promise<{ bytes: string; ref: string }> {
    if (credential !== this.expectedCredential || this.mode === "auth-fail") throw new Error("DMS authentication failed");
    this.stampCalls += 1;
    const out = `${bytes}\n--- ${stampText} ---`;
    const ref = `dms-${this.stampCalls}`;
    this.written.set(ref, out); // the side effect happened
    if (this.mode === "unknown-once" && !this.thrownOnce) {
      this.thrownOnce = true;
      throw new UnknownOutcomeError(ref);
    }
    if (this.mode === "unknown-always") throw new UnknownOutcomeError(ref);
    if (this.mode === "crash-after-write") throw new ProcessCrash(ref);
    return { bytes: out, ref };
  }

  async status(ref: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN"> {
    if (this.statusMode === "unknown") return "UNKNOWN";
    return this.written.has(ref) ? "DONE" : "NOT_FOUND";
  }

  async read(ref: string): Promise<string | undefined> {
    return this.written.get(ref);
  }
}
