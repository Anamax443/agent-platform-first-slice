/** Document-type registry: the external dependency of document.validate (INT-FAIL-*). */
export interface RegistryRecord {
  documentType: string;
  stampAllowed: boolean;
  retentionDays: number;
}

export interface RegistryAdapter {
  lookup(documentType: string): Promise<RegistryRecord>;
}

export class RegistryUnavailable extends Error {
  readonly httpStatus = 503;
  constructor(detail?: string) {
    super(detail ? `registry unavailable: ${detail}` : "registry unavailable (503)");
    this.name = "RegistryUnavailable";
  }
}

export class RegistryBusinessError extends Error {
  constructor(public readonly code: string) {
    super(`registry business error ${code}`);
    this.name = "RegistryBusinessError";
  }
}

export type RegistryMode = "ok" | "timeout" | "unavailable" | "business" | "nonsense-range" | "nonsense-semantic";

const TABLE: Record<string, RegistryRecord> = {
  INVOICE: { documentType: "INVOICE", stampAllowed: true, retentionDays: 3650 },
  CONTRACT: { documentType: "CONTRACT", stampAllowed: true, retentionDays: 3650 },
  OTHER: { documentType: "OTHER", stampAllowed: false, retentionDays: 365 },
};

/** Fake with failure modes. It knows no business logic: nonsense modes just return prepared values. */
export class FakeRegistryAdapter implements RegistryAdapter {
  calls = 0;
  constructor(public mode: RegistryMode = "ok") {}

  async lookup(documentType: string): Promise<RegistryRecord> {
    this.calls += 1;
    switch (this.mode) {
      case "timeout":
        return new Promise<RegistryRecord>(() => {});
      case "unavailable":
        throw new RegistryUnavailable();
      case "business":
        throw new RegistryBusinessError("DOCUMENT_TYPE_UNKNOWN");
      case "nonsense-range":
        return { documentType, stampAllowed: true, retentionDays: -1 };
      case "nonsense-semantic":
        return { documentType: documentType === "INVOICE" ? "CONTRACT" : "INVOICE", stampAllowed: true, retentionDays: 3650 };
      default: {
        const r = TABLE[documentType];
        if (!r) throw new RegistryBusinessError("DOCUMENT_TYPE_UNKNOWN");
        return { ...r };
      }
    }
  }
}

/** The minimum of fetch a client adapter needs: a Worker service binding (`Fetcher`), global fetch, or an in-process handler in tests. */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Origin used to address the apf-fakes service binding; a binding ignores the host, but a URL must be absolute. */
export const FAKES_ORIGIN = "https://apf-fakes.internal";

/**
 * Registry over HTTP (the apf-fakes double, or a real registry with the same protocol): POST /registry/lookup
 * {documentType} -> 200 record | 5xx | 4xx {code}. A 200 body is untrusted data: the validator checks range and
 * semantics (INT-FAIL-004); this adapter only maps transport and status codes to the adapter's error classes.
 */
export class HttpRegistryAdapter implements RegistryAdapter {
  calls = 0;
  constructor(
    private readonly client: HttpClient,
    private readonly baseUrl: string = FAKES_ORIGIN,
  ) {}

  async lookup(documentType: string): Promise<RegistryRecord> {
    this.calls += 1;
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/registry/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentType }) });
    } catch (e) {
      throw new RegistryUnavailable(`unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500) throw new RegistryUnavailable(`HTTP ${res.status}`);
    if (res.status >= 400) {
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      throw new RegistryBusinessError(typeof body.code === "string" ? body.code : `HTTP_${res.status}`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    // Not an object = a protocol violation; handed on as an empty record so that the validator ends it as REGISTRY_RESPONSE_INVALID.
    return (body && typeof body === "object" ? body : {}) as RegistryRecord;
  }
}
