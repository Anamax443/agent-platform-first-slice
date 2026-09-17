// MIME family: stripMimeAttachments() (found live 2026-09-16 — a forwarded receipt with two PDF attachments
// came to 58,684 estimated tokens, over llama-3.1-8b's 32,000 context window, because document.classify fed the
// whole raw MIME message, base64 attachments and all, into the LLM prompt). Narrow on purpose: only acts on
// genuine `Content-Type: multipart/...; boundary=...` content; everything else passes through unchanged.
import { describe, expect, it } from "vitest";
import { parseMimeMessage, sanitizeMimeFilename, stripMimeAttachments } from "../src/platform/mime.js";

const CRLF = "\r\n";

function multipart(boundary: string, parts: string[], topHeaders: string[] = []): string {
  const headers = [`Content-Type: multipart/mixed; boundary="${boundary}"`, ...topHeaders].join(CRLF);
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
  return `${headers}${CRLF}${CRLF}${body}`;
}

describe("MIME-001 a plain, non-multipart document passes through completely unchanged", () => {
  it("no Content-Type header at all", () => {
    const text = "Jaký je dnešní kurz eur\n\nS pozdravem, Milan";
    expect(stripMimeAttachments(text)).toBe(text);
  });
  it("a document whose first lines happen to look header-shaped, but isn't multipart, is untouched (no false-positive on non-email documents)", () => {
    const text = "Subject: Invoice reminder\nDate: 2024-01-01\n\nPlease pay the attached invoice.";
    expect(stripMimeAttachments(text)).toBe(text);
  });
  it("a multipart Content-Type header with no blank-line separator (no real header/body split) never throws and keeps the original text", () => {
    const text = 'Content-Type: multipart/mixed; boundary="x"\nno blank line here at all';
    expect(() => stripMimeAttachments(text)).not.toThrow();
    expect(stripMimeAttachments(text)).toContain("no blank line here at all");
  });
});

describe("MIME-002 a text/plain + text/html alternative with no attachments keeps both bodies", () => {
  it("multipart/alternative: nothing to strip, just header trimming", () => {
    const raw = multipart(
      "B1",
      [`Content-Type: text/plain${CRLF}${CRLF}Hello plain`, `Content-Type: text/html${CRLF}${CRLF}<p>Hello html</p>`],
      [`Subject: hi`, `Received: from somewhere (untrusted)`],
    );
    const out = stripMimeAttachments(raw);
    expect(out).toContain("Hello plain");
    expect(out).toContain("Hello html");
    expect(out).toContain("Subject: hi");
    expect(out).not.toContain("Received:");
  });
});

describe("MIME-003 a PDF attachment part is replaced with a short placeholder, never its base64 body", () => {
  it("the placeholder names the filename and content type, the base64 payload is gone", () => {
    const base64Pdf = "JVBERi0xLjQKJeLjz9MK".repeat(500); // stand-in for a real base64-encoded PDF, large on purpose
    const raw = multipart("B2", [
      `Content-Type: text/plain${CRLF}${CRLF}See attached invoice.`,
      `Content-Type: application/pdf; name="invoice.pdf"${CRLF}Content-Disposition: attachment; filename="invoice.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Pdf}`,
    ]);
    const out = stripMimeAttachments(raw);
    expect(out).toContain("See attached invoice.");
    expect(out).toContain('filename="invoice.pdf"');
    expect(out).toContain("application/pdf");
    expect(out).not.toContain(base64Pdf);
    expect(out.length).toBeLessThan(raw.length / 4);
  });
});

describe("MIME-004 a nested multipart/alternative inside a multipart/mixed is walked recursively", () => {
  it("text bodies from the nested alternative survive, sibling attachments are stripped", () => {
    const innerBoundary = "INNER";
    const nested = [`Content-Type: text/plain${CRLF}${CRLF}Plain body`, `Content-Type: text/html${CRLF}${CRLF}<p>Html body</p>`];
    const nestedPart = `Content-Type: multipart/alternative; boundary="${innerBoundary}"${CRLF}${CRLF}${nested.map((p) => `--${innerBoundary}${CRLF}${p}`).join(CRLF)}${CRLF}--${innerBoundary}--${CRLF}`;
    const attachment = `Content-Type: application/pdf; name="receipt.pdf"${CRLF}Content-Disposition: attachment; filename="receipt.pdf"${CRLF}${CRLF}${"QkFTRTY0".repeat(300)}`;
    const raw = multipart("OUTER", [nestedPart, attachment]);
    const out = stripMimeAttachments(raw);
    expect(out).toContain("Plain body");
    expect(out).toContain("Html body");
    expect(out).toContain('filename="receipt.pdf"');
    expect(out).not.toContain("QkFTRTY0");
  });
});

describe("MIME-005 an adversarially deep multipart nesting is bounded, never an infinite loop", () => {
  it("depth beyond the cap is truncated with a placeholder, still returns", () => {
    let body = `Content-Type: text/plain${CRLF}${CRLF}bottom`;
    for (let i = 0; i < 12; i++) {
      const boundary = `B${i}`;
      body = `Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}--${boundary}${CRLF}${body}${CRLF}--${boundary}--${CRLF}`;
    }
    const start = Date.now();
    const out = stripMimeAttachments(body);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toContain("[part omitted: nesting too deep]");
  });
});

describe("MIME-006 the transport-header block is trimmed to Subject/From/Date once multipart structure is confirmed", () => {
  it("DKIM-Signature/ARC-Seal/Received/X-MS-Exchange-* noise is dropped, Subject/From/Date survive", () => {
    const raw = multipart(
      "B3",
      [`Content-Type: text/plain${CRLF}${CRLF}Body text`],
      [
        `Subject: FW: receipt`,
        `From: someone@example.com`,
        `Date: Wed, 16 Sep 2026 13:29:38 +0000`,
        `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=selector; b=abc123`,
        `ARC-Seal: i=1; a=rsa-sha256; d=example.com; cv=none; b=xyz789`,
        `X-MS-Exchange-CrossTenant-Network-Message-Id: 12345`,
      ],
    );
    const out = stripMimeAttachments(raw);
    expect(out).toContain("Subject: FW: receipt");
    expect(out).toContain("From: someone@example.com");
    expect(out).toContain("Date: Wed, 16 Sep 2026 13:29:38 +0000");
    expect(out).not.toContain("DKIM-Signature");
    expect(out).not.toContain("ARC-Seal");
    expect(out).not.toContain("X-MS-Exchange");
  });
});

describe("MIME-007 the real live failure case shrinks well under a small token budget", () => {
  it("two ~34KB base64 PDF attachments plus verbose Outlook headers collapse to a small fraction of the original size", () => {
    const outlookNoise = Array.from({ length: 40 }, (_, i) => `X-MS-Exchange-Header-${i}: ${"a".repeat(200)}`);
    const pdf1 = "JVBERi0xLjQK".repeat(2500); // ~34KB-ish base64 stand-in
    const pdf2 = "JVBERi0xLjQK".repeat(2500);
    const raw = multipart(
      "REAL",
      [
        `Content-Type: text/plain${CRLF}${CRLF}Receipt from Anthropic, PBC. Paid $108.90.`,
        `Content-Type: application/pdf; name="Invoice.pdf"${CRLF}Content-Disposition: attachment; filename="Invoice.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${pdf1}`,
        `Content-Type: application/pdf; name="Receipt.pdf"${CRLF}Content-Disposition: attachment; filename="Receipt.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${pdf2}`,
      ],
      ["Subject: Your receipt from Anthropic, PBC", "From: invoice+statements@mail.anthropic.com", ...outlookNoise],
    );
    const out = stripMimeAttachments(raw);
    expect(out).toContain("Receipt from Anthropic");
    expect(out).toContain('filename="Invoice.pdf"');
    expect(out).toContain('filename="Receipt.pdf"');
    expect(out).not.toContain(pdf1);
    expect(out).not.toContain(pdf2);
    // The real failure was ~58,684 estimated tokens against a 32,000 window; a rough 4-chars-per-token estimate
    // on the stripped output must land comfortably under that, not just "smaller than before".
    expect(out.length / 4).toBeLessThan(4000);
  });
});

// parseMimeMessage: a REAL structured parse (GET /workflow/:id/attachment/:n, deploy/cloudflare/apf-gateway/src/index.ts)
// — unlike stripMimeAttachments() above, this keeps every attachment's actual decoded bytes so a human can open
// what a sender attached. NOTE on route-level coverage: index.ts imports `cloudflare:workers` at module scope, so
// it cannot be imported into this (plain node) vitest run at all — that's also why no existing route in this file
// (/original, /artifact/:id, ...) has ANY test in this suite today (confirmed by grep before writing these). These
// tests exercise the real security- and correctness-critical unit (parseMimeMessage + sanitizeMimeFilename) directly,
// including reconstructing the exact header-value string the route builds, rather than the unreachable fetch() route.

describe("PMM-001 parseMimeMessage decodes each attachment to its real original bytes", () => {
  it("a base64-encoded attachment and a quoted-printable-encoded attachment both decode correctly, with correct filenames/contentTypes/indices", () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 stand-in binary \x00\x01\x02 content");
    const base64Body = Buffer.from(pdfBytes).toString("base64");
    const qpBody = "Line1=\r\nLine2=3D100%"; // soft line break ("=\r\n") + a real "=XX" hex escape
    const raw = multipart(
      "PMIME1",
      [
        `Content-Type: text/plain${CRLF}${CRLF}See the two attached files.`,
        `Content-Type: application/pdf; name="invoice.pdf"${CRLF}Content-Disposition: attachment; filename="invoice.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Body}`,
        `Content-Type: text/csv; name="note.csv"${CRLF}Content-Disposition: attachment; filename="note.csv"${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${qpBody}`,
      ],
      [`Subject: two files`, `From: sender@example.com`, `Date: Wed, 16 Sep 2026 13:29:38 +0000`],
    );

    const parsed = parseMimeMessage(raw);
    expect(parsed.subject).toBe("two files");
    expect(parsed.from).toBe("sender@example.com");
    expect(parsed.date).toBe("Wed, 16 Sep 2026 13:29:38 +0000");
    expect(parsed.textBody).toContain("See the two attached files.");
    expect(parsed.attachments).toHaveLength(2);

    const [pdf, csv] = parsed.attachments;
    expect(pdf!.index).toBe(0);
    expect(pdf!.filename).toBe("invoice.pdf");
    expect(pdf!.contentType).toBe("application/pdf");
    expect(Buffer.from(pdf!.bytes)).toEqual(Buffer.from(pdfBytes));
    expect(pdf!.byteLength).toBe(pdfBytes.byteLength);

    expect(csv!.index).toBe(1);
    expect(csv!.filename).toBe("note.csv");
    expect(csv!.contentType).toBe("text/csv");
    expect(new TextDecoder().decode(csv!.bytes)).toBe("Line1Line2=100%");
  });
});

describe("PMM-002 a plain non-multipart email has no attachments and its full body as textBody", () => {
  it("subject/from/date parsed from top-level headers, textBody is exactly the body", () => {
    const raw = [
      `Subject: Plain hello`,
      `From: Milan <milan@example.com>`,
      `Date: Tue, 15 Sep 2026 09:00:00 +0000`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Ahoj, toto je obycejny text bez priloh.`,
    ].join(CRLF);
    const parsed = parseMimeMessage(raw);
    expect(parsed.subject).toBe("Plain hello");
    expect(parsed.from).toBe("Milan <milan@example.com>");
    expect(parsed.date).toBe("Tue, 15 Sep 2026 09:00:00 +0000");
    expect(parsed.textBody).toBe("Ahoj, toto je obycejny text bez priloh.");
    expect(parsed.attachments).toEqual([]);
  });
});

describe("PMM-003 malformed or truncated multipart input never throws", () => {
  it("a multipart Content-Type with no header/body blank-line separator at all", () => {
    const text = 'Content-Type: multipart/mixed; boundary="x"\nno blank line here at all';
    expect(() => parseMimeMessage(text)).not.toThrow();
    expect(parseMimeMessage(text).attachments).toEqual([]);
  });

  it("a multipart body truncated mid-attachment, missing its closing boundary entirely", () => {
    const raw = multipart("TRUNC", [
      `Content-Type: text/plain${CRLF}${CRLF}kept`,
      `Content-Type: application/pdf; name="cut.pdf"${CRLF}Content-Disposition: attachment; filename="cut.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${"QUJD".repeat(50)}`,
    ]);
    const truncated = raw.slice(0, raw.length - 40); // cut off before the closing "--TRUNC--"
    expect(() => parseMimeMessage(truncated)).not.toThrow();
  });
});

describe("PMM-004 an adversarially deep multipart nesting is bounded, never a hang or a throw", () => {
  it("depth beyond MAX_DEPTH stops descending instead of recursing forever", () => {
    let body = `Content-Type: text/plain${CRLF}${CRLF}bottom`;
    for (let i = 0; i < 12; i++) {
      const boundary = `D${i}`;
      body = `Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}--${boundary}${CRLF}${body}${CRLF}--${boundary}--${CRLF}`;
    }
    const start = Date.now();
    expect(() => parseMimeMessage(body)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("PMM-005 sanitizeMimeFilename strips the characters that make a Content-Disposition header unsafe", () => {
  it("CR and LF (response-splitting) and a double quote (breaking out of the quoted value) are all removed", () => {
    const malicious = 'evil"; x-injected: yes\r\nSet-Cookie: pwned=1\r\ninvoice.pdf';
    const sanitized = sanitizeMimeFilename(malicious);
    expect(sanitized).not.toContain("\r");
    expect(sanitized).not.toContain("\n");
    expect(sanitized).not.toContain('"');
  });

  it("built into the exact header value the /attachment/:n route constructs, no CR/LF/quote from the attacker survives", () => {
    // Same construction as GET /workflow/:id/attachment/:n in deploy/cloudflare/apf-gateway/src/index.ts:
    // `attachment; filename="${sanitizeMimeFilename(attachment.filename ?? "") || fallback}"`.
    const malicious = 'x"\r\nContent-Disposition: form-data\r\nfilename="y';
    const filename = sanitizeMimeFilename(malicious) || "attachment-0";
    const headerValue = `attachment; filename="${filename}"`;
    expect(headerValue).not.toMatch(/[\r\n]/);
    // exactly the two quotes we ourselves wrapped the value in — none of the attacker-controlled name reached the header
    expect((headerValue.match(/"/g) ?? []).length).toBe(2);
  });

  it("an ordinary filename with no dangerous characters passes through unchanged", () => {
    expect(sanitizeMimeFilename("invoice (final) v2.pdf")).toBe("invoice (final) v2.pdf");
  });
});
