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
  constructor() {
    super("registry unavailable (503)");
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
