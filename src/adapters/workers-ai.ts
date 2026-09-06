// LlmAdapter over the Cloudflare Workers AI binding (free tier on the farm). The binding is injected as a structural
// interface so this file stays free of Worker types; the model id comes from the installation profile, never from code.
import type { LlmAdapter } from "./llm.js";

export interface WorkersAiBinding {
  run(model: string, inputs: { messages: Array<{ role: "system" | "user"; content: string }>; max_tokens?: number; temperature?: number }): Promise<unknown>;
}

/** Text-generation responses differ by model family: `{ response }` (native) or `{ choices: [{ message: { content } }] }` (OpenAI-shaped). */
export function textOf(result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    if (typeof r.response === "string") return r.response;
    const c = r.choices?.[0]?.message?.content;
    if (typeof c === "string") return c;
  }
  throw new Error("workers-ai: unexpected response shape");
}

export class WorkersAiAdapter implements LlmAdapter {
  readonly promptVersion = "classify-1";

  constructor(
    readonly modelId: string,
    private readonly ai: WorkersAiBinding,
    private readonly maxTokens = 16,
  ) {}

  async complete(prompt: string): Promise<string> {
    const result = await this.ai.run(this.modelId, { messages: [{ role: "user", content: prompt }], max_tokens: this.maxTokens, temperature: 0 });
    return textOf(result).trim();
  }
}
