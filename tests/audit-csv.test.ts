// CSV family: auditRowsToCsv() (src/platform/audit-csv.ts), the pure rows -> CSV text function behind GET
// /audit.csv (deploy/cloudflare/apf-gateway/src/index.ts) and the Deník export button. index.ts itself imports
// "cloudflare:workers" at module scope and so has NO unit test coverage in this repo (confirmed by grep before
// writing this file, same as tests/mail.test.ts's own note) — this pure function is the only piece of the CSV
// export path these tests can reach directly.
import { describe, expect, it } from "vitest";
import { auditRowsToCsv, type AuditCsvRow } from "../src/platform/audit-csv.js";

/** A small, correct RFC 4180 parser (quoted fields, doubled-quote escaping, embedded commas/CRLF all handled) —
 * used only here, to prove auditRowsToCsv()'s output is well-formed CSV a real spreadsheet would parse correctly,
 * not just "looks right" by eyeballing the string. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const row = (overrides: Partial<AuditCsvRow> = {}): AuditCsvRow => ({
  at: "2026-09-17T10:00:00.000Z",
  kind: "state",
  workflowId: "wf-abc123",
  tenantId: "tenant-a",
  capability: "document.classify",
  details: { status: "SUCCEEDED" },
  ...overrides,
});

describe("CSV-001 header row is exact", () => {
  it("has the required six columns, in order, unquoted", () => {
    const out = auditRowsToCsv([]);
    expect(out).toBe("at,kind,workflowId,tenantId,capability,details\r\n");
  });
});

describe("CSV-002 standard field quoting/escaping: commas, quotes, and newlines inside a field", () => {
  it("a comma inside a field does not split it into two columns", () => {
    const out = auditRowsToCsv([row({ capability: "a,b" })]);
    const parsed = parseCsv(out);
    expect(parsed[1]).toHaveLength(6);
    expect(parsed[1]![4]).toBe("a,b");
  });

  it("an embedded double quote is doubled and round-trips back to a single quote", () => {
    const out = auditRowsToCsv([row({ tenantId: 'Tenant "Q" Ltd' })]);
    expect(out).toContain('"Tenant ""Q"" Ltd"');
    const parsed = parseCsv(out);
    expect(parsed[1]![3]).toBe('Tenant "Q" Ltd');
  });

  it("an embedded newline stays inside one field, doesn't create a phantom extra row", () => {
    const out = auditRowsToCsv([row({ details: "line1\nline2" })]);
    const parsed = parseCsv(out);
    expect(parsed).toHaveLength(2); // header + exactly one data row
    expect(parsed[1]![5]).toBe("line1\nline2");
  });

  it("commas, quotes, and newlines all together in one field still parse back to the original text", () => {
    const nasty = 'a,b "c" d\ne,f';
    const out = auditRowsToCsv([row({ details: nasty })]);
    const parsed = parseCsv(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]![5]).toBe(nasty);
  });

  it("every field is wrapped in double quotes even when it needs no escaping", () => {
    const out = auditRowsToCsv([row({ kind: "state" })]);
    const dataLine = out.split("\r\n")[1] as string;
    expect(dataLine.startsWith('"')).toBe(true);
    expect(dataLine).toContain('"state"');
  });
});

describe("CSV-003 formula-injection (CSV injection) defense", () => {
  it.each([
    ["=", "=cmd|'/c calc'!A1"],
    ["+", "+1+1"],
    ["-", "-2+3"],
    ["@", "@SUM(A1:A9)"],
  ])("a field starting with %s is prefixed with a leading apostrophe, defanging the formula", (_label, malicious) => {
    const out = auditRowsToCsv([row({ details: malicious })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![5]).toBe(`'${malicious}`);
    // and the defused text no longer starts with a trigger character
    expect(parsed[1]![5]!.startsWith("'")).toBe(true);
  });

  it("ordinary text starting with none of =/+/-/@ is left completely untouched", () => {
    const out = auditRowsToCsv([row({ details: "SUCCEEDED, no problem here" })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![5]).toBe("SUCCEEDED, no problem here");
  });

  it("a trigger character NOT at the start of the field is not touched (only a LEADING = / + / - / @ is dangerous)", () => {
    const out = auditRowsToCsv([row({ details: "total=42" })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![5]).toBe("total=42");
  });

  it("the defense applies uniformly to every column, not just details", () => {
    const out = auditRowsToCsv([row({ workflowId: "=HYPERLINK(\"http://evil/\")", tenantId: "@exfiltrate", capability: "-1", kind: "+state" })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![1]).toBe("'+state");
    expect(parsed[1]![2]).toBe('\'=HYPERLINK("http://evil/")');
    expect(parsed[1]![3]).toBe("'@exfiltrate");
    expect(parsed[1]![4]).toBe("'-1");
  });
});

describe("CSV-004 empty/null fields render sensibly", () => {
  it("null workflowId/tenantId/capability render as an empty field, not the string 'null'", () => {
    const out = auditRowsToCsv([row({ workflowId: null, tenantId: null, capability: null })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![2]).toBe("");
    expect(parsed[1]![3]).toBe("");
    expect(parsed[1]![4]).toBe("");
  });

  it("undefined details renders as an empty field, not the string 'undefined'", () => {
    const out = auditRowsToCsv([row({ details: undefined })]);
    const parsed = parseCsv(out);
    expect(parsed[1]![5]).toBe("");
  });

  it("an empty-string field is distinct from null only in intent, both render as an empty quoted field", () => {
    const out = auditRowsToCsv([row({ capability: "" })]);
    expect(out).toContain(',"",');
  });
});

describe("CSV-005 details is serialized as its JSON string", () => {
  it("an object details round-trips through CSV back to the identical JSON value", () => {
    const details = { status: "FAILED", code: "TIMEOUT", attempt: 3 };
    const out = auditRowsToCsv([row({ details })]);
    const parsed = parseCsv(out);
    expect(JSON.parse(parsed[1]![5]!)).toEqual(details);
  });
});

describe("CSV-006 a realistic multi-row export produces a well-formed CSV", () => {
  it("every row has exactly 6 fields, header first, values in the documented column order", () => {
    const rows: AuditCsvRow[] = [
      row({ at: "2026-09-17T08:00:00.000Z", kind: "state", workflowId: "wf-1", details: { status: "RUNNING" } }),
      row({ at: "2026-09-17T08:05:00.000Z", kind: "state", workflowId: "wf-1", details: { status: "SUCCEEDED" } }),
      row({
        at: "2026-09-17T08:10:00.000Z",
        kind: "security",
        workflowId: null,
        tenantId: null,
        capability: null,
        details: { code: "AUDIT_TENANT_MISMATCH", claimedTenantId: "=EVIL()", note: "from an untrusted forwarded e-mail, comma, and a \"quote\"" },
      }),
    ];
    const out = auditRowsToCsv(rows);
    const parsed = parseCsv(out);
    expect(parsed).toHaveLength(4); // header + 3 rows
    expect(parsed[0]).toEqual(["at", "kind", "workflowId", "tenantId", "capability", "details"]);
    for (const line of parsed) expect(line).toHaveLength(6);

    expect(parsed[1]![0]).toBe("2026-09-17T08:00:00.000Z");
    expect(JSON.parse(parsed[1]![5]!)).toEqual({ status: "RUNNING" });
    expect(JSON.parse(parsed[2]![5]!)).toEqual({ status: "SUCCEEDED" });

    const thirdDetails = JSON.parse(parsed[3]![5]!) as { code: string; claimedTenantId: string; note: string };
    expect(thirdDetails.code).toBe("AUDIT_TENANT_MISMATCH");
    // The whole `details` field is JSON text; the injected "=EVIL()" lives INSIDE that JSON string, not as the
    // field's own leading character (the field starts with "{"), so it never triggered defusal — and once a human
    // reads the recovered JSON value here, it is inert text, not something a spreadsheet ever evaluated as a cell.
    expect(thirdDetails.claimedTenantId).toBe("=EVIL()");
    expect(thirdDetails.note).toContain('comma, and a "quote"');
    expect(parsed[3]![2]).toBe(""); // null workflowId
  });
});
