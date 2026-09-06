// LlmAdapter over the Anthropic SDK (paid models on the farm). The API key is resolved by name through the installation's
// secrets, the model id comes from the profile. Classification needs one short answer, so effort is low and output tiny.
import Anthropic from "@anthropic-ai/sdk";
import type { LlmAdapter } from "./llm.js";

/** Families that take `output_config.effort` (5-series and the 4.6+ line); older ids such as Haiku 4.5 reject it. */
const EFFORT_FAMILY = /^claude-(fable|opus|sonnet)-(5|4-[678])/;
/** Families with safety classifiers where a server-side fallback keeps a declined request from ending the step. */
const FALLBACK_FAMILY = /^claude-(fable|opus)-5/;

export class AnthropicAdapter implements LlmAdapter {
  readonly promptVersion = "classify-1";
  private readonly client: Anthropic;

  constructor(
    readonly modelId: string,
    apiKey: string,
    private readonly opts: { maxTokens?: number; inferenceGeo?: string } = {},
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  async complete(prompt: string): Promise<string> {
    const base = {
      model: this.modelId,
      max_tokens: this.opts.maxTokens ?? 64,
      messages: [{ role: "user" as const, content: prompt }],
      ...(EFFORT_FAMILY.test(this.modelId) ? { output_config: { effort: "low" as const } } : {}),
      // Compliance, not tuning: the installation says where inference may run (e.g. "eu"); supported on Opus/Sonnet 4.6 and later.
      ...(this.opts.inferenceGeo ? { inference_geo: this.opts.inferenceGeo } : {}),
    };
    const response = FALLBACK_FAMILY.test(this.modelId)
      ? await this.client.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await this.client.messages.create(base);
    if (response.stop_reason === "refusal") throw new Error(`model ${this.modelId} refused the request`);
    return response.content
      .filter((b): b is Extract<(typeof response.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
