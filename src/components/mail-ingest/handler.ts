// mail.ingest/1: durable ingest. Stores the raw mail as an immutable original (F7) and derives untrusted metadata by rules (F2).
// Channel-specific splitting only (owner, 17.9.2026: "je jedno jestli je příloha podaná Podatelnou, Slackem,
// Telegramem nebo e-mailem, přílohu by měl zpracovávat stejná kráva" — the channel recognizes shape, it never
// gets its own copy of processing logic): this handler recognizes "an e-mail arrived, here is its body, here are
// its N attachments" (parseMimeMessage) and derives a text artifact per part, same as Podatelna's direct-upload
// path already does via the SAME DocumentExtractor (adapters/extract.ts) for anything binary. document.classify
// downstream never learns any of this happened — it keeps reading whatever artifact `$steps.ingest.payload
// .artifactId` points to, exactly as it always has, for every channel.
import { capabilityError, parseMimeMessage, StorageFull } from "../../platform/api.js";
import type { ArtifactWriter, Clock, FieldValue, HandlerOutcome, HostHandlerSpec } from "../../platform/api.js";
import type { DocumentExtractor, ExtractResult } from "../../adapters/extract.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export const INGEST_HANDLER_ID = "mail-ingest-handler";
const SUBJECT_MAX = outputSchema.properties.subject.maxLength;
const ADDRESS = /<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/;
/** Text-ish attachment (e.g. a .csv/.txt sent as an attachment) needs no AI extraction — it's already readable. */
const isTextish = (contentType: string): boolean => contentType.startsWith("text/");

export interface IngestDeps {
  artifacts: ArtifactWriter;
  clock: Clock;
  extractor: DocumentExtractor;
}

/** Non-silent per-attachment outcome (owner, 18.9.2026, after live external review: a failed attachment must be
 * a visible, structured Case-level fact, not a silent gap someone has to notice by counting). Reuses
 * ExtractResult's own error vocabulary (adapters/extract.ts) for the ok:false branch rather than inventing a
 * parallel one; STORAGE_FULL/UNEXPECTED_ERROR cover the two catch{} cases the loop below already distinguished
 * only in a comment. attachmentArtifactIds[] stays a DERIVED/compatibility view over this array (see handler
 * below) — nothing that already reads it changes. */
type ExtractErrorCode = Extract<ExtractResult, { ok: false }>["code"];
export type AttachmentErrorCode = ExtractErrorCode | "STORAGE_FULL" | "UNEXPECTED_ERROR";
export type AttachmentOutcome =
  | { index: number; filename: string; contentType: string; status: "SUCCEEDED"; artifactId: string }
  | { index: number; filename: string; contentType: string; status: "FAILED"; errorCode: AttachmentErrorCode };

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
    resourceTenant: () => ({ kind: "GLOBAL_RESOURCE" as const }), // a new resource: its tenant is the trusted context, never the payload
    allowsGlobalResource: true, // explicit opt-in (Posudek 5/6): a handler cannot claim this by returning the kind alone
    run: async ({ message, context }) => {
      const p = message.payload as { rawMail: string; receivedFrom: string };
      const headers = parseHeaders(p.rawMail);
      const address = headers.from ? ADDRESS.exec(headers.from)?.[1] : undefined;
      if (!address) return failed(capabilityError("MAIL_MALFORMED", "VALIDATION", false, "mail has no parseable From header"));

      // One parse serves both the body derivation below and the attachment loop after it.
      const parsed = parseMimeMessage(p.rawMail);

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
      // The original is the whole raw MIME message, immutable, kept for evidence/audit and for opening the
      // e-mail/its attachments later (GET /workflow/:id/attachment/:n) — never what a capability classifies.

      // Best-effort per attachment: one unreadable/oversized attachment must not fail the whole message — the raw
      // bytes stay reachable on the immutable original regardless (GET /workflow/:id/attachment/:n re-parses it).
      // Owner's principle 17.9.2026: "co nejvíce převést do MDfile a dle toho hledat" — the invoice content usually
      // lives in the attachment, not the one-line cover note in the body, so classification (and later extraction)
      // needs the fullest available text, not just the body.
      // Owner, 18.9.2026 (after live external review): best-effort-per-attachment stays exactly as is — one bad
      // attachment must never fail the whole mail — but a failure must become a visible, structured Case-level
      // fact instead of a silent gap someone has to notice by counting. Every parsed attachment therefore gets
      // exactly one entry in `attachments` below, SUCCEEDED or FAILED; attachmentArtifactIds/attachmentTexts are
      // still populated only for the SUCCEEDED ones (same values, same order as before this change).
      const attachments: AttachmentOutcome[] = [];
      const attachmentTexts: { name: string; text: string }[] = [];
      for (const a of parsed.attachments) {
        const name = a.filename ?? `attachment-${a.index}`;
        try {
          if (isTextish(a.contentType)) {
            const text = new TextDecoder().decode(a.bytes);
            const artifactId = deps.artifacts.derive(stored.artifactId, text, "mail-ingest:parseMimeMessage").artifactId;
            attachmentTexts.push({ name, text });
            attachments.push({ index: a.index, filename: name, contentType: a.contentType, status: "SUCCEEDED", artifactId });
            continue;
          }
          const extracted = await deps.extractor.extract({ name, bytes: a.bytes, contentType: a.contentType });
          if (extracted.ok) {
            const artifactId = deps.artifacts.derive(stored.artifactId, extracted.text, "mail-ingest:workers-ai-toMarkdown").artifactId;
            attachmentTexts.push({ name, text: extracted.text });
            attachments.push({ index: a.index, filename: name, contentType: a.contentType, status: "SUCCEEDED", artifactId });
          } else {
            attachments.push({ index: a.index, filename: name, contentType: a.contentType, status: "FAILED", errorCode: extracted.code });
          }
        } catch (e) {
          // StorageFull or an extractor throw on ONE attachment: skip it, the message itself must still get
          // through — but record WHY, not just that it's absent.
          const errorCode: AttachmentErrorCode = e instanceof StorageFull ? "STORAGE_FULL" : "UNEXPECTED_ERROR";
          attachments.push({ index: a.index, filename: name, contentType: a.contentType, status: "FAILED", errorCode });
        }
      }
      // Compatibility/derived view: same values, same order as when this array was independently pushed to.
      const attachmentArtifactIds = attachments.filter((x): x is Extract<AttachmentOutcome, { status: "SUCCEEDED" }> => x.status === "SUCCEEDED").map((x) => x.artifactId);

      // The channel-agnostic contract downstream (document.classify, eventually invoice.extract) always just reads
      // "$steps.ingest.payload.artifactId" — same as every other channel — so it must already BE the fullest text,
      // not a second field a capability would need mail-specific knowledge to know about. Body first (it carries
      // the human's own instructions/context), then each attachment, clearly labelled so a reader (human or model)
      // can tell them apart.
      const combinedText = [
        `=== TĚLO E-MAILU ===\n${parsed.textBody}`,
        ...attachmentTexts.map((a) => `=== PŘÍLOHA: ${a.name} ===\n${a.text}`),
      ].join("\n\n");
      const combined = deps.artifacts.derive(stored.artifactId, combinedText, "mail-ingest:combined-body-and-attachments");

      const sender: FieldValue<string> = { value: address.toLowerCase(), source: "rules", trustLevel: "untrusted-derived" };
      return {
        status: "SUCCEEDED",
        payload: {
          artifactId: combined.artifactId,
          sha256: combined.sha256,
          originalArtifactId: stored.artifactId,
          attachmentArtifactIds,
          attachments,
          receivedFrom: p.receivedFrom,
          sender,
          subject: (headers.subject ?? "").slice(0, SUBJECT_MAX),
        },
        provenance: { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [stored.artifactId] },
      };
    },
  };
}
