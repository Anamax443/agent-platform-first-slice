// mail.ingest/1: durable ingest. Stores the raw mail as an immutable original (F7) and derives untrusted metadata by rules (F2).
import { capabilityError, StorageFull } from "../../platform/api.js";
import type { ArtifactWriter, Clock, FieldValue, HandlerOutcome, HostHandlerSpec } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export const INGEST_HANDLER_ID = "mail-ingest-handler";
const SUBJECT_MAX = outputSchema.properties.subject.maxLength;
const ADDRESS = /<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/;

export interface IngestDeps {
  artifacts: ArtifactWriter;
  clock: Clock;
}

/** Deterministic header parse: first blank line ends the headers; only From and Subject are read, everything stays data. */
export function parseHeaders(rawMail: string): { from?: string; subject?: string } {
  const out: { from?: string; subject?: string } = {};
  for (const line of rawMail.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = (m[1] as string).toLowerCase();
    if (name === "from" && out.from === undefined) out.from = m[2] as string;
    if (name === "subject" && out.subject === undefined) out.subject = m[2] as string;
  }
  return out;
}

export function createIngestHandler(deps: IngestDeps): HostHandlerSpec {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  return {
    capability: "mail.ingest",
    handlerId: INGEST_HANDLER_ID,
    resourceTenant: () => undefined, // a new resource: its tenant is the trusted context, never the payload
    run: async ({ message, context }) => {
      const p = message.payload as { rawMail: string; receivedFrom: string };
      const headers = parseHeaders(p.rawMail);
      const address = headers.from ? ADDRESS.exec(headers.from)?.[1] : undefined;
      if (!address) return failed(capabilityError("MAIL_MALFORMED", "VALIDATION", false, "mail has no parseable From header"));

      let stored;
      try {
        stored = deps.artifacts.put({ tenantId: context.tenantId, bytes: p.rawMail, receivedFrom: p.receivedFrom });
      } catch (e) {
        if (e instanceof StorageFull) {
          // RES-STOR-001: no false success; retryable so the caller applies backpressure instead of dropping the mail
          return failed(capabilityError("STORAGE_FULL", "DEPENDENCY", true, "artifact store cannot accept the original", { capacityBytes: e.capacityBytes }));
        }
        throw e;
      }
      const sender: FieldValue<string> = { value: address.toLowerCase(), source: "rules", trustLevel: "untrusted-derived" };
      return {
        status: "SUCCEEDED",
        payload: { artifactId: stored.artifactId, sha256: stored.sha256, receivedFrom: p.receivedFrom, sender, subject: (headers.subject ?? "").slice(0, SUBJECT_MAX) },
        provenance: { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [stored.artifactId] },
      };
    },
  };
}
