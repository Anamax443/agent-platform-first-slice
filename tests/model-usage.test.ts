// Token-usage capture end-to-end: adapters report real usage via an optional onUsage callback, handlers carry
// it as HandlerOutcome.modelUsage, and the router writes it as a new, additive "model-usage" audit record —
// without touching any frozen contract (ResultEnvelope never carries modelUsage).
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import type { LlmAdapter, TokenUsage } from "../src/adapters/llm.js";
import { WorkersAiAdapter, type WorkersAiBinding } from "../src/adapters/workers-ai.js";
import { createDocumentClassifier } from "../src/components/document-classifier/handler.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { Audit } from "../src/platform/audit.js";
import { FakeClock, iso, plus, MINUTE } from "../src/platform/clock.js";
import { newId } from "../src/platform/ids.js";
import { LifecycleRegistry } from "../src/platform/lifecycle.js";
import { Router, type RegisteredComponent } from "../src/platform/router.js";
import { KeyRegistry } from "../src/platform/signing.js";
import type { DispatchEnvelope, Handler, HandlerOutcome, MessageEnvelope, TrustedContext } from "../src/platform/types.js";

const START = "2026-09-17T08:00:00Z";

describe("AnthropicAdapter.complete() onUsage (contracts/ untouched: this is adapter-level, no schema involved)", () => {
  /** Only the two fields anthropic.ts actually reads matter here; the create() replacement below is typed loosely
   * (Promise<unknown>), so this fake does not need to satisfy the full Anthropic SDK Message shape. */
  function fakeResponse(opts: { text: string; stopReason: string; inputTokens: number; outputTokens: number }) {
    return {
      id: "msg_test",
      content: [{ type: "text", text: opts.text }],
      model: "claude-haiku-4-5",
      role: "assistant",
      stop_reason: opts.stopReason,
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    };
  }

  /** Haiku 4.5 matches neither EFFORT_FAMILY nor FALLBACK_FAMILY, so complete() takes the plain client.messages.create() path. */
  function adapterWithFakeClient() {
    const adapter = new AnthropicAdapter("claude-haiku-4-5", "test-api-key");
    const client = (adapter as unknown as { client: { messages: { create: (...args: unknown[]) => Promise<unknown> } } }).client;
    return { adapter, client };
  }

  it("calls onUsage with the real input/output token counts from the SDK response, and returns the completion text", async () => {
    const { adapter, client } = adapterWithFakeClient();
    client.messages.create = async () => fakeResponse({ text: "INVOICE", stopReason: "end_turn", inputTokens: 123, outputTokens: 7 });

    let usage: TokenUsage | undefined;
    const text = await adapter.complete("classify this document", (u) => {
      usage = u;
    });

    expect(text).toBe("INVOICE");
    expect(usage).toEqual({ inputTokens: 123, outputTokens: 7 });
  });

  it("still reports real usage on a refusal, before the refusal throw (a refused-but-billed request must not lose its tokens)", async () => {
    const { adapter, client } = adapterWithFakeClient();
    client.messages.create = async () => fakeResponse({ text: "", stopReason: "refusal", inputTokens: 40, outputTokens: 2 });

    let usage: TokenUsage | undefined;
    await expect(
      adapter.complete("classify this document", (u) => {
        usage = u;
      }),
    ).rejects.toThrow(/refused/);

    expect(usage).toEqual({ inputTokens: 40, outputTokens: 2 });
  });

  it("calling complete() with no onUsage argument at all still works (optional, backward compatible)", async () => {
    const { adapter, client } = adapterWithFakeClient();
    client.messages.create = async () => fakeResponse({ text: "CONTRACT", stopReason: "end_turn", inputTokens: 10, outputTokens: 1 });
    await expect(adapter.complete("classify this document")).resolves.toBe("CONTRACT");
  });
});

describe("WorkersAiAdapter.complete() onUsage (Cloudflare declares every usage field fully optional)", () => {
  it("calls onUsage with prompt/completion token counts when the raw AI result carries a full usage object", async () => {
    const ai: WorkersAiBinding = { run: async () => ({ response: "INVOICE", usage: { prompt_tokens: 42, completion_tokens: 5, total_tokens: 47 } }) };
    const adapter = new WorkersAiAdapter("@cf/test-model", ai);

    let usage: TokenUsage | undefined;
    const text = await adapter.complete("classify this document", (u) => {
      usage = u;
    });

    expect(text).toBe("INVOICE");
    expect(usage).toEqual({ inputTokens: 42, outputTokens: 5 });
  });

  it("does not call onUsage, and does not throw, when the raw AI result has no usage field at all", async () => {
    const ai: WorkersAiBinding = { run: async () => ({ response: "INVOICE" }) };
    const adapter = new WorkersAiAdapter("@cf/test-model", ai);

    let called = false;
    const text = await adapter.complete("classify this document", () => {
      called = true;
    });

    expect(text).toBe("INVOICE");
    expect(called).toBe(false);
  });

  it("does not call onUsage when usage is present but only partially populated (defensive, never assume both fields)", async () => {
    const ai: WorkersAiBinding = { run: async () => ({ response: "INVOICE", usage: { prompt_tokens: 42 } }) };
    const adapter = new WorkersAiAdapter("@cf/test-model", ai);

    let called = false;
    await adapter.complete("classify this document", () => {
      called = true;
    });

    expect(called).toBe(false);
  });
});

/** Deterministic LlmAdapter that reports a fixed TokenUsage through onUsage, for handler-level tests. */
class FakeUsageModel implements LlmAdapter {
  readonly modelId = "fake-usage-model-1";
  readonly promptVersion = "test-1";

  constructor(
    private readonly usage: TokenUsage,
    private readonly answer: string,
  ) {}

  async complete(_prompt: string, onUsage?: (u: TokenUsage) => void): Promise<string> {
    onUsage?.(this.usage);
    return this.answer;
  }
}

describe("document-classifier handler: HandlerOutcome.modelUsage (F2 unaffected — this only adds a sibling field)", () => {
  const TENANT = "t-model-usage";

  it("a successful llm-strategy classification attaches the real token usage the model reported", async () => {
    const clock = new FakeClock(START);
    const artifacts = new ArtifactStore(clock);
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "Faktura c. 123, DIC CZ00000000, castka 1000 Kc", receivedFrom: "test" });
    const model = new FakeUsageModel({ inputTokens: 55, outputTokens: 3 }, "INVOICE");
    const handler = createDocumentClassifier({ artifacts, models: { llm: model }, clock });

    const now = iso(clock.now());
    const outcome = await handler({
      message: {
        messageId: newId("msg"),
        correlationId: newId("cor"),
        type: "command",
        capability: "document.classify",
        capabilityVersion: "1",
        schemaVersion: "1",
        idempotencyKey: newId("key"),
        createdAt: now,
        notValidAfter: iso(plus(clock.now(), MINUTE)),
        payload: { artifactId: artifact.artifactId },
      },
      context: {
        dispatchId: newId("dsp"),
        tenantId: TENANT,
        actorId: "svc-test",
        actorType: "service",
        scopes: ["document.classify"],
        sourceComponent: "test-harness",
        authenticatedAt: now,
        expiresAt: iso(plus(clock.now(), MINUTE)),
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.modelUsage).toEqual({ inputTokens: 55, outputTokens: 3 });
  });

  it("the human-corrected strategy never calls a model and so never carries modelUsage (additive-only, unaffected path)", async () => {
    const clock = new FakeClock(START);
    const artifacts = new ArtifactStore(clock);
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "irrelevant", receivedFrom: "test" });
    // No model in the strategy map at all: if this path ever tried to call one, it would fail with STRATEGY_UNKNOWN.
    const handler = createDocumentClassifier({ artifacts, models: {}, clock });

    const now = iso(clock.now());
    const outcome = await handler({
      message: {
        messageId: newId("msg"),
        correlationId: newId("cor"),
        type: "command",
        capability: "document.classify",
        capabilityVersion: "1",
        schemaVersion: "1",
        idempotencyKey: newId("key"),
        createdAt: now,
        notValidAfter: iso(plus(clock.now(), MINUTE)),
        payload: { artifactId: artifact.artifactId, strategy: "human-corrected", documentType: "INVOICE" },
      },
      context: {
        dispatchId: newId("dsp"),
        tenantId: TENANT,
        actorId: "svc-test",
        actorType: "service",
        scopes: ["document.classify"],
        sourceComponent: "test-harness",
        authenticatedAt: now,
        expiresAt: iso(plus(clock.now(), MINUTE)),
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.modelUsage).toBeUndefined();
  });
});

describe("Router.finish(): the \"model-usage\" audit record (additive, never touches ResultEnvelope)", () => {
  const CAP = "test.model.usage";
  const MODULE = "test-model-usage-module";
  const TENANT = "t-router-usage";
  const ACTOR = "svc-router-usage-test";

  const descriptor: Record<string, unknown> & { module: string } = {
    module: MODULE,
    componentVersion: "0.1.0",
    runtime: "in-process",
    tenantMode: "SINGLE",
    owner: "test",
    verificationProfiles: ["PROVIDER"],
    capabilities: [
      {
        name: CAP,
        versions: ["1"],
        preferredVersion: "1",
        sideEffects: "none",
        executionMode: "sync",
        trustClass: "untrusted-processing",
        riskClass: "LOW",
        requiredScopes: [CAP],
        // Explicit "not-applicable" (mirroring document-classifier/descriptor.json), not omitted: the schema's
        // reversibility/unknownOutcomeRecovery "if" checks are vacuously true when the property is absent, which
        // would otherwise demand compensationCapability/statusQuery on a sideEffects:"none" capability that needs neither.
        reversibility: "not-applicable",
        unknownOutcomeRecovery: "not-applicable",
        humanApproval: "none",
      },
    ],
    endpoints: { health: "/health", version: "/version", capabilities: "/capabilities" },
  };

  const inputSchema = { type: "object", additionalProperties: true };

  /** Real Router.route() end to end (schema -> binding -> scope -> policy -> handler -> finish()), binding
   * mechanism "in-process" so no signing is needed — the same shortcut dh.test.ts documents for a direct
   * Router boundary test. `handler`'s HandlerOutcome is the only thing under test's control. */
  function fixture(handler: Handler) {
    const clock = new FakeClock(START);
    const audit = new Audit(clock);
    const router = new Router({ registry: new KeyRegistry(), clock, audit, acceptedMechanisms: ["in-process"], lifecycle: new LifecycleRegistry({ [MODULE]: "ACTIVE" }) });
    const component: RegisteredComponent = {
      descriptor,
      policies: { [CAP]: { policyRef: `test.${CAP}`, capability: CAP, capabilityVersion: "1", owner: "test", grants: [{ actorId: ACTOR, scopes: [CAP], tenants: [TENANT] }], failClosed: true } },
      capabilities: [{ name: CAP, version: "1", inputSchema, handler }],
    };
    router.register(component);

    const now = iso(clock.now());
    const message: MessageEnvelope = {
      messageId: newId("msg"),
      correlationId: newId("cor"),
      workflowId: "wf-model-usage-1",
      stepId: "classify-step",
      type: "command",
      capability: CAP,
      capabilityVersion: "1",
      schemaVersion: "1",
      idempotencyKey: newId("key"),
      createdAt: now,
      notValidAfter: iso(plus(clock.now(), MINUTE)),
      payload: {},
    };
    const context: TrustedContext = {
      dispatchId: newId("dsp"),
      tenantId: TENANT,
      actorId: ACTOR,
      actorType: "service",
      scopes: [CAP],
      sourceComponent: "test-harness",
      authenticatedAt: now,
      expiresAt: iso(plus(clock.now(), MINUTE)),
    };
    const env: DispatchEnvelope = { message, context, binding: { mechanism: "in-process" } };
    return { audit, route: () => router.route(env) };
  }

  it("writes one model-usage audit record, matching the dispatch record's correlation/workflow/tenant/actor/capability, when outcome.modelUsage is present", async () => {
    const usage: TokenUsage = { inputTokens: 88, outputTokens: 12 };
    const f = fixture(async (): Promise<HandlerOutcome> => ({ status: "SUCCEEDED", payload: { ok: true }, modelUsage: usage }));

    const result = await f.route();
    expect(result.status).toBe("SUCCEEDED");
    // Never touches the frozen ResultEnvelope shape: modelUsage is audit-only.
    expect(result).not.toHaveProperty("modelUsage");

    const records = f.audit.byKind("model-usage");
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.correlationId).toBe(result.correlationId);
    expect(rec.workflowId).toBe("wf-model-usage-1");
    expect(rec.tenantId).toBe(TENANT);
    expect(rec.actorId).toBe(ACTOR);
    expect(rec.capability).toBe(CAP);
    expect(rec.details).toEqual({ stepId: "classify-step", executionId: result.executionId, inputTokens: 88, outputTokens: 12 });
  });

  it("writes no model-usage audit record when outcome.modelUsage is absent (every non-LLM capability today)", async () => {
    const f = fixture(async (): Promise<HandlerOutcome> => ({ status: "SUCCEEDED", payload: { ok: true } }));

    const result = await f.route();
    expect(result.status).toBe("SUCCEEDED");
    expect(f.audit.byKind("model-usage")).toHaveLength(0);
  });

  it("writes no model-usage audit record on a FAILED outcome that never reports usage either", async () => {
    const f = fixture(async (): Promise<HandlerOutcome> => ({ status: "FAILED", error: { code: "TEST_FAILURE", class: "TECHNICAL", retryable: false, message: "synthetic" } }));

    const result = await f.route();
    expect(result.status).toBe("FAILED");
    expect(f.audit.byKind("model-usage")).toHaveLength(0);
  });
});
