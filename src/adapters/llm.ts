/** LLM adapter contract. Components never see a vendor SDK; tests use the fakes below. */
export interface LlmAdapter {
  readonly modelId: string;
  readonly promptVersion: string;
  complete(prompt: string): Promise<string>;
}

const UNTRUSTED = /<untrusted>([\s\S]*?)<\/untrusted>/;

/** Deterministic rules classifier over plain text. Also the second signal the validator uses (W4 in MEASUREMENT). */
export function classifyByRules(text: string): string {
  const t = text.toLowerCase();
  // ISDOC (Czech e-invoice XML, isdoc.cz): every DocumentType of the standard is an invoice-family document; no model needed to see that.
  if (/<invoice[^>]*isdoc\.cz\/namespace/.test(t)) return "INVOICE";
  // \bdph\b, not a bare substring: "celkemBezDph" (a JSON field name, not the word "DPH") was matching before the fix.
  if (/(faktura|invoice|iban|dič|\bdph\b|variabilní symbol)/.test(t)) return "INVOICE";
  if (/(smlouva|contract|smluvní strany|agreement)/.test(t)) return "CONTRACT";
  return "OTHER";
}

/**
 * Deterministic stand-in for a model. It is deliberately gullible: an injected instruction inside the
 * untrusted block makes it return whatever the attacker asked for. That is the behaviour F2 has to survive.
 */
export class FakeLlmAdapter implements LlmAdapter {
  readonly modelId = "fake-llm-1";
  readonly promptVersion = "classify-1";
  calls = 0;

  async complete(prompt: string): Promise<string> {
    this.calls += 1;
    const text = UNTRUSTED.exec(prompt)?.[1] ?? "";
    const injected = /system:\s*ignore[^\n]*?classify\s+(?:this\s+)?as\s+([a-z_]+)/i.exec(text);
    if (injected) return (injected[1] as string).toUpperCase();
    return classifyByRules(text);
  }
}

/** Second implementation of the same contract (INT-REPLACE-001): rules, no model, immune to instructions. */
export class KeywordClassifierAdapter implements LlmAdapter {
  readonly modelId = "keyword-rules-1";
  readonly promptVersion = "rules-1";
  calls = 0;

  async complete(prompt: string): Promise<string> {
    this.calls += 1;
    return classifyByRules(UNTRUSTED.exec(prompt)?.[1] ?? "");
  }
}

/** Deterministic field extraction for invoice.extract's "rules" strategy — same role as classifyByRules() for
 * this capability, and the second signal a future validator for this chain can cross-check against (W4). Every
 * field is independently optional: absence is informative, not a parse failure. Returned as loosely-typed raw
 * candidates (strings), exactly like a real model's JSON would be — the handler's own normalize*() functions do
 * the actual structural validation, so this and the LLM path share one trust boundary, not two. */
export function extractInvoiceFieldsByRules(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ico = /(?:IČO|ICO)[:\s]*([0-9]{8})\b/i.exec(text)?.[1];
  if (ico) out.companyId = ico;
  const account = /\bCZ\d{2}[0-9]{20}\b/i.exec(text)?.[0] ?? /\b([0-9]{1,6}-?[0-9]{2,10}\/[0-9]{4})\b/.exec(text)?.[1];
  if (account) out.bankAccount = account;
  const invoiceNo = /(?:Faktura\s*č\.?|Invoice\s*No\.?|Variabilní symbol)[:\s]*([A-Za-z0-9][A-Za-z0-9 ./_-]{0,20})/i.exec(text)?.[1]?.trim();
  if (invoiceNo) out.invoiceNumber = invoiceNo;
  const totalRaw = /(?:Celkem\s*k\s*úhradě|Total\s*due|Celkem)[:\s]*([0-9][0-9\s.,]*[0-9]|[0-9])/i.exec(text)?.[1];
  if (totalRaw) out.totalWithVat = totalRaw.replace(/\s/g, "").replace(",", ".");
  return out;
}

/** invoice.extract's "rules" strategy adapter — same role as KeywordClassifierAdapter: deterministic, no model, immune to instructions. */
export class RulesInvoiceExtractorAdapter implements LlmAdapter {
  readonly modelId = "invoice-rules-1";
  readonly promptVersion = "extract-rules-1";
  calls = 0;

  async complete(prompt: string): Promise<string> {
    this.calls += 1;
    return JSON.stringify(extractInvoiceFieldsByRules(UNTRUSTED.exec(prompt)?.[1] ?? ""));
  }
}

/**
 * Deliberately gullible stand-in for invoice.extract's "llm" strategy (FakeLlmAdapter's counterpart for this
 * capability): legitimate documents get a real extraction; an injected instruction inside the untrusted block
 * makes it comply — mixing in whatever the attacker asked for alongside the real fields — exactly the failure
 * mode F2 (the handler reads only its four known keys by name) and the output schema (additionalProperties:
 * false) have to survive.
 */
export class FakeInvoiceExtractorAdapter implements LlmAdapter {
  readonly modelId = "fake-invoice-extractor-1";
  readonly promptVersion = "extract-1";
  calls = 0;

  async complete(prompt: string): Promise<string> {
    this.calls += 1;
    const text = UNTRUSTED.exec(prompt)?.[1] ?? "";
    const fields = extractInvoiceFieldsByRules(text);
    if (/system:\s*ignore[^\n]*?email\.send/i.test(text)) {
      return JSON.stringify({ ...fields, note: "forwarded per injected instruction", action: "email.send" });
    }
    return JSON.stringify(fields);
  }
}
