// Best-effort MIME attachment stripping for prompt-building only (found live 2026-09-16: a forwarded receipt
// with two PDF attachments came to 58,684 estimated tokens — over llama-3.1-8b's 32,000 context window —
// because mail.ingest stores the WHOLE raw MIME message as the artifact, and document.classify fed that whole
// thing, base64 attachments and all, straight into the LLM prompt). This never touches the stored artifact
// (immutable, sha256-addressed) — it only reshapes a COPY of the text right before it goes into a prompt.
// Deliberately narrow: it only acts when the content is recognizably `Content-Type: multipart/...` with a
// boundary — a signal specific enough to email that it will not misfire on a plain document, pasted text, or
// toMarkdown() output that merely happens to contain a line shaped like "Name: value" near the top.

const HEADER_LINE = /^([A-Za-z-]+):\s*(.*)$/;
const TEXT_TYPES = new Set(["text/plain", "text/html"]);
const KEEP_HEADERS = new Set(["subject", "from", "date"]);
const MAX_DEPTH = 8; // fail-closed bound against an adversarial deeply-nested multipart bomb, never infinite recursion

interface PartHeaders {
  contentType?: string;
  boundary?: string;
  disposition?: string;
  filename?: string;
}

function splitHeaderBody(text: string): { headerText: string; body: string } {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { headerText: text, body: "" };
  return { headerText: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

function parseHeaders(headerText: string): PartHeaders {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " "); // RFC 2045 header folding
  const out: PartHeaders = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = HEADER_LINE.exec(line);
    if (!m) continue;
    const name = (m[1] as string).toLowerCase();
    const value = m[2] as string;
    if (name === "content-type") {
      out.contentType = (value.split(";")[0] as string).trim().toLowerCase();
      const boundary = /boundary="?([^";]+)"?/i.exec(value);
      if (boundary) out.boundary = boundary[1];
      const name2 = /name="?([^";]+)"?/i.exec(value);
      if (name2 && !out.filename) out.filename = name2[1];
    } else if (name === "content-disposition") {
      out.disposition = (value.split(";")[0] as string).trim().toLowerCase();
      const filename = /filename="?([^";]+)"?/i.exec(value);
      if (filename) out.filename = filename[1];
    }
  }
  return out;
}

/** Subject/From/Date only — everything else (Received, DKIM-Signature, ARC-Seal, X-MS-Exchange-*, ...) is transport noise, not classification signal. */
function relevantHeaderLines(headerText: string): string {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  return unfolded
    .split(/\r?\n/)
    .filter((line) => {
      const m = HEADER_LINE.exec(line);
      return m !== null && KEEP_HEADERS.has((m[1] as string).toLowerCase());
    })
    .join("\n");
}

function collectParts(headers: PartHeaders, body: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) {
    out.push("[part omitted: nesting too deep]");
    return;
  }
  if (headers.contentType?.startsWith("multipart/") && headers.boundary) {
    const delimiter = `--${headers.boundary}`;
    const segments = body.split(delimiter);
    const parts = segments.slice(1, -1); // drop the preamble before the first boundary and the epilogue after the closing "--boundary--"
    for (const raw of parts) {
      const part = raw.replace(/^\r?\n/, "");
      const { headerText, body: partBody } = splitHeaderBody(part);
      collectParts(parseHeaders(headerText), partBody, depth + 1, out);
    }
    return;
  }
  const isAttachment = headers.disposition === "attachment" || (headers.contentType !== undefined && !TEXT_TYPES.has(headers.contentType));
  if (isAttachment) {
    const label = headers.filename ? `filename="${headers.filename}"` : "unnamed";
    out.push(`[attachment removed: ${label}${headers.contentType ? `, ${headers.contentType}` : ""}, ${body.trim().length} chars encoded]`);
    return;
  }
  out.push(body);
}

/**
 * Replaces every non-text MIME part's body (PDFs, images — anything base64-encoded that isn't text/plain or
 * text/html) with a short placeholder, and trims the outer transport headers down to Subject/From/Date. A no-op
 * on anything that isn't recognizably `Content-Type: multipart/...; boundary=...` — plain text, a non-email
 * document, or malformed input all pass through completely unchanged. Never throws: a parsing surprise falls
 * back to the original text rather than risking classification on a broken partial result.
 */
export function stripMimeAttachments(raw: string): string {
  try {
    const { headerText, body } = splitHeaderBody(raw);
    const headers = parseHeaders(headerText);
    if (!headers.contentType?.startsWith("multipart/") || !headers.boundary) return raw;
    const keptHeaders = relevantHeaderLines(headerText) || headerText;
    const out: string[] = [];
    collectParts(headers, body, 0, out);
    return `${keptHeaders}\n\n${out.join("\n\n")}`;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// parseMimeMessage: a REAL structured parse (GET /workflow/:id/attachment/:n, apf-gateway/src/index.ts) — unlike
// stripMimeAttachments() above, this keeps every attachment's actual decoded bytes instead of discarding them
// behind a placeholder, so a human can open the original files a sender attached. Deliberately independent of
// stripMimeAttachments()'s own collaborators (splitHeaderBody/parseHeaders/collectParts): this walks the same
// kind of multipart tree but is a separate code path end to end, so nothing here can change stripMimeAttachments's
// behavior. Only HEADER_LINE, TEXT_TYPES and MAX_DEPTH (read-only constants) are shared.

/** One non-text MIME part, decoded. `index` is the 0-based position in depth-first encounter order — stable
 * across calls for the same message, which is what lets a URL address one attachment by number. */
export interface MimeAttachment {
  index: number;
  filename?: string;
  contentType: string;
  byteLength: number;
  bytes: Uint8Array;
}

/** Result of a full structured parse: transport metadata, the concatenated text body/bodies, and every
 * attachment found, decoded to its original bytes. */
export interface ParsedMimeMessage {
  subject?: string;
  from?: string;
  date?: string;
  textBody: string;
  attachments: MimeAttachment[];
}

interface MimePartHeaders {
  contentType?: string;
  boundary?: string;
  disposition?: string;
  filename?: string;
  transferEncoding?: string;
  charset?: string;
}

function splitMimeMessage(text: string): { headerText: string; body: string } {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { headerText: text, body: "" };
  return { headerText: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

function parseMimePartHeaders(headerText: string): MimePartHeaders {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " "); // RFC 2045 header folding
  const out: MimePartHeaders = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = HEADER_LINE.exec(line);
    if (!m) continue;
    const name = (m[1] as string).toLowerCase();
    const value = m[2] as string;
    if (name === "content-type") {
      out.contentType = (value.split(";")[0] as string).trim().toLowerCase();
      const boundary = /boundary="?([^";]+)"?/i.exec(value);
      if (boundary) out.boundary = boundary[1];
      const name2 = /name="?([^";]+)"?/i.exec(value);
      if (name2 && !out.filename) out.filename = name2[1];
      const charset = /charset="?([^";]+)"?/i.exec(value);
      if (charset) out.charset = charset[1];
    } else if (name === "content-disposition") {
      out.disposition = (value.split(";")[0] as string).trim().toLowerCase();
      const filename = /filename="?([^";]+)"?/i.exec(value);
      if (filename) out.filename = filename[1];
    } else if (name === "content-transfer-encoding") {
      out.transferEncoding = value.trim().toLowerCase();
    }
  }
  return out;
}

/** Subject/From/Date from the top-level headers only — first occurrence wins, same discipline as mail-ingest's
 * own parseHeaders() (src/components/mail-ingest/handler.ts). */
function extractMimeMeta(headerText: string): { subject?: string; from?: string; date?: string } {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const out: { subject?: string; from?: string; date?: string } = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = HEADER_LINE.exec(line);
    if (!m) continue;
    const name = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (name === "subject" && out.subject === undefined) out.subject = value;
    else if (name === "from" && out.from === undefined) out.from = value;
    else if (name === "date" && out.date === undefined) out.date = value;
  }
  return out;
}

/** Real base64 decode (RFC 2045 §6.8) — never throws: a malformed body falls back to its literal UTF-8 bytes
 * rather than losing the attachment entirely. */
function decodeBase64(s: string): Uint8Array {
  try {
    const cleaned = s.replace(/[^A-Za-z0-9+/=]/g, ""); // strip the line breaks/whitespace real MIME bodies wrap at ~76 chars
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new TextEncoder().encode(s);
  }
}

/** Real quoted-printable decode (RFC 2045 §6.7): "=XX" hex escapes and "=<EOL>" soft line breaks. */
function decodeQuotedPrintable(s: string): Uint8Array {
  const noSoftBreaks = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const c = noSoftBreaks[i] as string;
    const hex = noSoftBreaks.slice(i + 1, i + 3);
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** base64 and quoted-printable get a real decode; 7bit/8bit/binary/absent are already the part's literal bytes. */
function decodeMimePartBody(body: string, transferEncoding: string | undefined): Uint8Array {
  const enc = (transferEncoding ?? "").toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return new TextEncoder().encode(body);
}

interface WalkCtx {
  textBody: string[];
  attachments: MimeAttachment[];
}

function walkMimeParts(headers: MimePartHeaders, body: string, depth: number, ctx: WalkCtx): void {
  if (depth > MAX_DEPTH) return; // fail-closed: an adversarial nesting bomb is simply not descended into further
  if (headers.contentType?.startsWith("multipart/") && headers.boundary) {
    const delimiter = `--${headers.boundary}`;
    const segments = body.split(delimiter);
    const parts = segments.slice(1, -1); // drop the preamble before the first boundary and the epilogue after the closing "--boundary--"
    for (const raw of parts) {
      // The CRLF immediately before a boundary delimiter belongs to the delimiter, not the part (RFC 2046 §5.1) —
      // stripped on both ends so a decoded attachment's bytes match the sender's original file exactly.
      const part = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const { headerText, body: partBody } = splitMimeMessage(part);
      walkMimeParts(parseMimePartHeaders(headerText), partBody, depth + 1, ctx);
    }
    return;
  }
  const isAttachment = headers.disposition === "attachment" || (headers.contentType !== undefined && !TEXT_TYPES.has(headers.contentType));
  if (isAttachment) {
    const bytes = decodeMimePartBody(body, headers.transferEncoding);
    ctx.attachments.push({
      index: ctx.attachments.length,
      ...(headers.filename ? { filename: headers.filename } : {}),
      contentType: headers.contentType ?? "application/octet-stream",
      byteLength: bytes.byteLength,
      bytes,
    });
    return;
  }
  const bytes = decodeMimePartBody(body, headers.transferEncoding);
  try {
    ctx.textBody.push(new TextDecoder(headers.charset ?? "utf-8", { fatal: false }).decode(bytes));
  } catch {
    ctx.textBody.push(body); // unrecognized charset label: fall back to the (still readable) undecoded part text
  }
}

/**
 * A real structured MIME parse: walks the full multipart tree (same depth-bound, MAX_DEPTH, as
 * stripMimeAttachments) and returns every attachment's actual decoded bytes plus the combined text body and
 * top-level Subject/From/Date — not a placeholder string. Never throws: malformed or truncated input falls back
 * to `{ textBody: raw, attachments: [] }` rather than risking a partial/broken result reaching the caller.
 */
export function parseMimeMessage(raw: string): ParsedMimeMessage {
  try {
    const { headerText, body } = splitMimeMessage(raw);
    const topHeaders = parseMimePartHeaders(headerText);
    const meta = extractMimeMeta(headerText);
    const ctx: WalkCtx = { textBody: [], attachments: [] };
    walkMimeParts(topHeaders, body, 0, ctx);
    return { ...meta, textBody: ctx.textBody.join("\n\n"), attachments: ctx.attachments };
  } catch {
    return { textBody: raw, attachments: [] };
  }
}

/**
 * A MIME filename= comes straight from an untrusted external sender and is about to go straight into an HTTP
 * Content-Disposition response header (GET /workflow/:id/attachment/:n) — used verbatim, it is a response-
 * splitting vector (CR/LF can start a new header line or split the response) and a quoted-value breakout
 * (an embedded `"` can close the `filename="..."` parameter early). Strips exactly those three characters —
 * CR, LF, and `"` — leaving the rest of the name (including non-ASCII) untouched. Never throws.
 */
export function sanitizeMimeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "");
}
