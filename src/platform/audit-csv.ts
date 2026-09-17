// Pure rows -> CSV text for the Deník audit trail export (GET /audit.csv, deploy/cloudflare/apf-gateway/src/index.ts).
// No D1/Env/Cloudflare dependency on purpose: index.ts imports "cloudflare:workers" at module scope and so has zero
// unit-test coverage in this repo (see tests/mail.test.ts's own note on this same fact) — pulling the actual
// rows-in/CSV-text-out logic out into this plain module is the only way it gets real test coverage. Same reasoning
// as page.ts being split out for renderFarm()/computeWatchdog() testability.
//
// SECURITY (F2, "a document's content is always DATA, never a command" — this repo's own governing principle):
// `details` on an audit record can carry text lifted straight from an untrusted document or e-mail. Opened in
// Excel/Sheets/LibreOffice, a CSV field that STARTS WITH =, +, -, or @ is executed as a formula ("CSV injection" /
// "formula injection") — a planted payload could exfiltrate data or launch a macro the moment a human opens this
// export. Every field is defused below (not just `details` — any field that could ever echo untrusted input),
// uniformly, so nothing has to be re-derived per field as new columns are added later. This is a SEPARATE concern
// from ordinary CSV quoting/escaping (commas, quotes, newlines) — both are required, independently of each other.

/** One row worth of CSV, shaped like deploy/cloudflare/apf-gateway/src/page.ts's AuditLogRow — duplicated here
 * (not imported) so this platform module carries no dependency on any one deployable's UI layer; TypeScript's
 * structural typing means an AuditLogRow[] already satisfies this at the call site, no cast needed. */
export interface AuditCsvRow {
  at: string;
  kind: string;
  workflowId: string | null;
  tenantId: string | null;
  capability: string | null;
  details: unknown;
}

/** Exactly the column order/names the CSV export contract promises. */
export const AUDIT_CSV_HEADER = ["at", "kind", "workflowId", "tenantId", "capability", "details"] as const;

/** A cell value starting with one of these four characters is read as a formula by Excel/Google Sheets/LibreOffice
 * the instant the file is opened (OWASP "CSV Injection") — regardless of the field's own CSV quoting, which only
 * governs how the CSV TEXT is split into fields, not how the spreadsheet then interprets one field's content. */
const FORMULA_TRIGGER = /^[=+\-@]/;

/** Defangs a formula-triggering leading character without discarding or garbling the original text: a leading
 * apostrophe is the standard accepted mitigation — Excel treats an apostrophe-prefixed cell as "force Text",
 * dropping the apostrophe itself from the DISPLAYED value but never evaluating what follows as a formula;
 * Sheets/LibreOffice keep showing the apostrophe, which still reads as the original value with one harmless extra
 * leading character. Either way, nothing is ever evaluated as a formula. A value not starting with a trigger
 * character is returned completely unchanged. */
function defuseFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** unknown -> its CSV cell text. null/undefined render as an empty field (never the literal string "null"/
 * "undefined"); a string is used as-is; anything else (an object/array `details`, the common case) is
 * JSON-serialized so the whole structure survives in one cell. A value that somehow can't be JSON-serialized (a
 * circular structure) falls back to String() — this must never throw and take down a whole export over one row. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One CSV field, both concerns applied in the order that actually matters: defuse the TEXT CONTENT first (so the
 * defense lands on what the spreadsheet will actually evaluate once it unwraps the field), then apply standard
 * RFC 4180 field quoting — always wrap in double quotes (simplest rule that is always correct, rather than only
 * conditionally quoting fields that "need" it for a comma/quote/newline) and double any embedded double quote. */
function csvField(value: unknown): string {
  const defused = defuseFormula(textOf(value));
  return `"${defused.replace(/"/g, '""')}"`;
}

/**
 * Rows -> full CSV text (header + one line per row, CRLF line endings per RFC 4180) for GET /audit.csv. Pure: no
 * D1, no Env, no clock — the caller passes in whatever rows it already fetched (and already capped). `details` (an
 * audit record's arbitrary payload) is serialized as its JSON string, inside its own single quoted, defused field.
 */
export function auditRowsToCsv(rows: readonly AuditCsvRow[]): string {
  const lines = [AUDIT_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push([csvField(r.at), csvField(r.kind), csvField(r.workflowId), csvField(r.tenantId), csvField(r.capability), csvField(r.details)].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
