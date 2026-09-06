import type { HttpClient } from "./registry.js";
import { FAKES_ORIGIN } from "./registry.js";

/** Archive store adapter: the second write target in the shared document executor host (document.archive). */
export interface ArchiveAdapter {
  put(input: { bytes: string; sha256: string; clientRef: string }, credential: string): Promise<{ ref: string }>;
}

export class FakeArchiveAdapter implements ArchiveAdapter {
  putCalls = 0;
  readonly stored = new Map<string, { bytes: string; sha256: string }>();
  constructor(private readonly expectedCredential = "archive-secret") {}

  async put(input: { bytes: string; sha256: string; clientRef: string }, credential: string): Promise<{ ref: string }> {
    if (credential !== this.expectedCredential) throw new Error("archive authentication failed");
    this.putCalls += 1;
    this.stored.set(input.clientRef, { bytes: input.bytes, sha256: input.sha256 });
    return { ref: `arch-${this.putCalls}` };
  }
}

/**
 * Archive over HTTP (the apf-fakes double, or a real archive with the same protocol): POST /archive/put with a bearer
 * credential. `archive-handler.ts` catches every rejection uniformly as ARCHIVE_REJECTED (DEPENDENCY, retryable), so this
 * adapter only needs to throw on failure; it never needs to distinguish an unknown outcome the way DMS does.
 */
export class HttpArchiveAdapter implements ArchiveAdapter {
  constructor(
    private readonly client: HttpClient,
    private readonly baseUrl: string = FAKES_ORIGIN,
  ) {}

  async put(input: { bytes: string; sha256: string; clientRef: string }, credential: string): Promise<{ ref: string }> {
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/archive/put`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify(input),
      });
    } catch (e) {
      throw new Error(`archive unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`archive rejected the request: HTTP ${res.status}`);
    return (await res.json()) as { ref: string };
  }
}
