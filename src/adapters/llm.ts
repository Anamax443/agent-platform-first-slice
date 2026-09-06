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
  if (/(faktura|invoice|iban|dič|dph|variabilní symbol)/.test(t)) return "INVOICE";
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
