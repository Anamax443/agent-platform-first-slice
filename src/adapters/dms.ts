import { ProcessCrash, UnknownOutcomeError } from "../platform/errors.js";
import type { HttpClient } from "./registry.js";
import { FAKES_ORIGIN } from "./registry.js";

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

/**
 * DMS over HTTP (the apf-fakes double, or a real DMS with the same protocol): POST /dms/stamp with a bearer credential,
 * GET /dms/status and /dms/read without one (the fakes protocol never required it for reads; matched here on purpose —
 * see MEASUREMENT W22). `stamp()` is the only method allowed to throw `UnknownOutcomeError`: a network failure there
 * means the write's fate is genuinely unknown (celek D). `status()`/`read()` must never throw — `stamp-handler.ts`'s
 * `reconcile()` calls them with no try/catch, so a network failure there must degrade to "UNKNOWN" / "not found",
 * exactly like the fakes' own chaos mode would report, not crash the reconciliation loop.
 */
export class HttpDmsAdapter implements DmsAdapter {
  constructor(
    private readonly client: HttpClient,
    private readonly baseUrl: string = FAKES_ORIGIN,
  ) {}

  async stamp(input: { bytes: string; stampText: string; clientRef: string }, credential: string): Promise<{ bytes: string; ref: string }> {
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/dms/stamp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify(input),
      });
    } catch {
      // Unreachable double: whether the write happened is genuinely unknown, exactly like a crash mid-call.
      throw new UnknownOutcomeError(input.clientRef);
    }
    if (res.status >= 500) {
      const body = (await res.json().catch(() => ({}))) as { reconciliationRef?: string };
      throw new UnknownOutcomeError(body.reconciliationRef ?? input.clientRef);
    }
    if (!res.ok) throw new Error(`DMS rejected the stamp request: HTTP ${res.status}`);
    return (await res.json()) as { bytes: string; ref: string };
  }

  async status(clientRef: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN"> {
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/dms/status?clientRef=${encodeURIComponent(clientRef)}`);
    } catch {
      return "UNKNOWN"; // can't reach the double; the caller's reconciliation budget will retry later
    }
    if (!res.ok) return "UNKNOWN";
    const body = (await res.json().catch(() => ({}))) as { status?: unknown };
    return body.status === "DONE" ? "DONE" : body.status === "UNKNOWN" ? "UNKNOWN" : "NOT_FOUND";
  }

  async read(clientRef: string): Promise<{ bytes: string; ref: string } | undefined> {
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/dms/read?clientRef=${encodeURIComponent(clientRef)}`);
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    return (await res.json().catch(() => undefined)) as { bytes: string; ref: string } | undefined;
  }
}
