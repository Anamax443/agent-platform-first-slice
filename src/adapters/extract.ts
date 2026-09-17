// Binary document -> readable text, over Workers AI's toMarkdown. One shared implementation for every channel
// that hands the farm a binary attachment (Podatelna direct upload, mail.ingest's e-mail attachments, any future
// channel) — the extraction mechanism must not depend on how the document arrived (owner, 17.9.2026: "je jedno
// jestli je příloha podaná Podatelnou, Slackem, Telegramem nebo e-mailem, přílohu by měl zpracovávat stejná
// kráva"). Previously this exact call lived inline in deploy/cloudflare/apf-gateway/src/index.ts's startIntake()
// only; mail-ingest/handler.ts is the second real caller, relocated here so both go through one implementation.
import type { WorkersAiBinding } from "./workers-ai.js";

export type ExtractResult = { ok: true; text: string; format: string; tokens: number } | { ok: false; code: "EXTRACTION_UNAVAILABLE" | "EXTRACTION_FAILED" | "EXTRACTION_EMPTY"; message: string; detail?: Record<string, unknown> };

export interface DocumentExtractor {
  extract(input: { name: string; bytes: Uint8Array; contentType: string }): Promise<ExtractResult>;
}

/** Real adapter over the Workers AI binding's toMarkdown — same error mapping the direct-upload path already had. */
export class WorkersAiExtractor implements DocumentExtractor {
  constructor(private readonly ai: WorkersAiBinding) {}

  async extract(input: { name: string; bytes: Uint8Array; contentType: string }): Promise<ExtractResult> {
    if (!this.ai.toMarkdown) return { ok: false, code: "EXTRACTION_UNAVAILABLE", message: "this Workers AI binding does not support document conversion" };
    let converted: { format: string; data?: string; tokens?: number; error?: string };
    try {
      converted = await this.ai.toMarkdown({ name: input.name, blob: new Blob([input.bytes as BlobPart], { type: input.contentType }) });
    } catch (e) {
      return { ok: false, code: "EXTRACTION_FAILED", message: "Workers AI konverzi neprovedla.", detail: { contentType: input.contentType, error: String(e) } };
    }
    if (converted.format === "error") return { ok: false, code: "EXTRACTION_FAILED", message: "Workers AI soubor odmítla.", detail: { contentType: input.contentType, error: converted.error } };
    if (!converted.data?.trim()) return { ok: false, code: "EXTRACTION_EMPTY", message: "Workers AI ze souboru nezískala žádný text.", detail: { contentType: input.contentType } };
    return { ok: true, text: converted.data, format: converted.format, tokens: converted.tokens ?? 0 };
  }
}

/** Deterministic test double (mirrors FakeSmtpAdapter/FakeLlmAdapter's shape: configurable mode, no network). */
export class FakeExtractor implements DocumentExtractor {
  calls: Array<{ name: string; contentType: string }> = [];
  constructor(
    private readonly mode: "ok" | "failed" | "empty" | "unavailable" = "ok",
    private readonly text = "extracted markdown text",
  ) {}

  async extract(input: { name: string; bytes: Uint8Array; contentType: string }): Promise<ExtractResult> {
    this.calls.push({ name: input.name, contentType: input.contentType });
    if (this.mode === "unavailable") return { ok: false, code: "EXTRACTION_UNAVAILABLE", message: "fake: unavailable" };
    if (this.mode === "failed") return { ok: false, code: "EXTRACTION_FAILED", message: "fake: failed" };
    if (this.mode === "empty") return { ok: false, code: "EXTRACTION_EMPTY", message: "fake: empty" };
    return { ok: true, text: this.text, format: "markdown", tokens: Math.round(this.text.length / 4) };
  }
}
