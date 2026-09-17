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
