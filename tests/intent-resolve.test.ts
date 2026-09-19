// IR family: intent.resolve (docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 6, src/components/intent-resolver/).
// Bar this file holds it to: a normal COW, artifact-ref in, one closed-vocabulary value out (F2); the
// resolved value lands in a derived Artifact, never inline in the payload and never as an Evidence value
// (AR-1/AR-6); impulse.intent.resolved is sealed on EVERY call, UNKNOWN included — contrast
// document-classifier's own value-gated seal().
import { describe, expect, it } from "vitest";
import type { LlmAdapter, TokenUsage } from "../src/adapters/llm.js";
import { createIntentResolver, INTENTS, INTENT_RESOLVE_INPUT_FIELD } from "../src/components/intent-resolver/handler.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { sha256 } from "../src/platform/api.js";
import { FakeClock, iso, plus, MINUTE } from "../src/platform/clock.js";
import { EvidenceLedger } from "../src/platform/evidence.js";
import { EvidenceWriter } from "../src/platform/evidence-writer.js";
import { newId } from "../src/platform/ids.js";
import { generateKeyPair } from "../src/platform/signing.js";
import type { HandlerInput } from "../src/platform/types.js";

const START = "2026-09-19T08:00:00Z";
const TENANT = "t-intent-resolve";

/** Deterministic LlmAdapter for handler-level tests — mirrors model-usage.test.ts's FakeUsageModel. */
class FakeIntentModel implements LlmAdapter {
  readonly modelId = "fake-intent-model-1";
  readonly promptVersion = "test-1";
  calls = 0;

  constructor(private readonly answer: string) {}

  async complete(_prompt: string, onUsage?: (u: TokenUsage) => void): Promise<string> {
    this.calls += 1;
    onUsage?.({ inputTokens: 10, outputTokens: 1 });
    return this.answer;
  }
}

class FakeFailingModel implements LlmAdapter {
  readonly modelId = "fake-failing-intent-model-1";
  readonly promptVersion = "test-1";

  async complete(): Promise<string> {
    throw new Error("simulated network failure");
  }
}

function fixture(now = START) {
  const clock = new FakeClock(now);
  const artifacts = new ArtifactStore(clock);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  const evidence = new EvidenceWriter(ledger, { producerId: "intent.resolve", capabilityVersion: "1", buildHash: "test" }, clock);
  return { clock, artifacts, ledger, evidence };
}

function handlerInput(payload: Record<string, unknown>, clock: FakeClock): HandlerInput {
  const now = iso(clock.now());
  return {
    message: {
      messageId: newId("msg"),
      correlationId: newId("cor"),
      type: "command",
      capability: "intent.resolve",
      capabilityVersion: "1",
      schemaVersion: "1",
      idempotencyKey: newId("key"),
      createdAt: now,
      notValidAfter: iso(plus(clock.now(), MINUTE)),
      payload,
    },
    context: {
      dispatchId: newId("dsp"),
      tenantId: TENANT,
      actorId: "svc-test",
      actorType: "service",
      scopes: ["intent.resolve"],
      sourceComponent: "test-harness",
      authenticatedAt: now,
      expiresAt: iso(plus(clock.now(), MINUTE)),
    },
  };
}

describe("createIntentResolver: closed-vocabulary resolution (F2)", () => {
  it("IR-000: a successful llm resolution returns the value, the derived artifact refs, and provenance", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "jake bude zitra pocasi?", receivedFrom: "test" });
    const model = new FakeIntentModel("GENERAL_QUESTION");
    const handler = createIntentResolver({ artifacts, models: { llm: model }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") return;
    expect(outcome.payload).toMatchObject({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      intent: { value: "GENERAL_QUESTION", source: "llm", trustLevel: "untrusted-derived" },
    });
    expect(outcome.payload.extractedArtifactId).toBeDefined();
    expect(outcome.payload.extractedArtifactId).not.toBe(artifact.artifactId);
    expect(outcome.provenance?.modelId).toBe("fake-intent-model-1");
    expect(outcome.modelUsage).toEqual({ inputTokens: 10, outputTokens: 1 });
  });

  it("IR-001: UNKNOWN is a valid, expected SUCCEEDED answer — not a QUALITY failure", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "asdkjhasdkjh nonsense", receivedFrom: "test" });
    const model = new FakeIntentModel("UNKNOWN");
    const handler = createIntentResolver({ artifacts, models: { llm: model }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") return;
    expect((outcome.payload.intent as { value: string }).value).toBe("UNKNOWN");
  });

  it("IR-002: every INTENTS member round-trips as SUCCEEDED (the allowlist really is the output schema's enum)", async () => {
    const { clock, artifacts } = fixture();
    expect(INTENTS).toEqual(["INVOICE_RECEIVED", "CALENDAR_QUERY", "DOCUMENT_BUNDLE", "GENERAL_QUESTION", "UNKNOWN"]);
    for (const value of INTENTS) {
      const artifact = artifacts.put({ tenantId: TENANT, bytes: `content for ${value}`, receivedFrom: "test" });
      const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel(value) }, clock });
      const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));
      expect(outcome.status).toBe("SUCCEEDED");
    }
  });

  it("IR-003: a model answer outside the allowlist is a retriable QUALITY failure, never a silently-accepted value", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "hello", receivedFrom: "test" });
    const model = new FakeIntentModel("MAYBE_SOMETHING");
    const handler = createIntentResolver({ artifacts, models: { llm: model }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("FAILED");
    if (outcome.status !== "FAILED") return;
    expect(outcome.error).toMatchObject({ code: "MODEL_OUTPUT_NOT_ALLOWED", class: "QUALITY", retryable: true });
  });

  it("IR-004: artifact not found is a non-retriable BUSINESS failure", async () => {
    const { clock, artifacts } = fixture();
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("UNKNOWN") }, clock });

    const outcome = await handler(handlerInput({ artifactId: "art-missing" }, clock));

    expect(outcome.status).toBe("FAILED");
    if (outcome.status !== "FAILED") return;
    expect(outcome.error).toMatchObject({ code: "ARTIFACT_NOT_FOUND", class: "BUSINESS", retryable: false });
  });

  it("IR-005: an artifact belonging to another tenant is refused, never read across the tenant boundary", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: "other-tenant", bytes: "hello", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("UNKNOWN") }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("FAILED");
    if (outcome.status !== "FAILED") return;
    expect(outcome.error).toMatchObject({ code: "TENANT_SCOPE_MISMATCH", class: "SECURITY", retryable: false });
  });

  it("IR-006: an unconfigured strategy fails validation instead of silently defaulting", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "hello", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: {}, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId, strategy: "llm" }, clock));

    expect(outcome.status).toBe("FAILED");
    if (outcome.status !== "FAILED") return;
    expect(outcome.error).toMatchObject({ code: "STRATEGY_UNKNOWN", class: "VALIDATION", retryable: false });
  });

  it("IR-007: MODEL_UNAVAILABLE (the model call itself throws) still reports which model was attempted", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "hello", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeFailingModel() }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("FAILED");
    if (outcome.status !== "FAILED") return;
    expect(outcome.error.code).toBe("MODEL_UNAVAILABLE");
    expect(outcome.provenance?.modelId).toBe("fake-failing-intent-model-1");
  });
});

describe("createIntentResolver: AR-1/AR-6 — value goes to an Artifact, never inline/into Evidence", () => {
  it("IR-008: the derived Artifact's bytes actually carry the resolved intent as JSON", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "faktura prijata", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("INVOICE_RECEIVED") }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));
    expect(outcome.status).toBe("SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") return;

    const derived = artifacts.get(outcome.payload.extractedArtifactId as string);
    expect(derived).toBeDefined();
    expect(derived?.tenantId).toBe(TENANT);
    expect(derived?.derivedFrom).toBe(artifact.artifactId);
    expect(JSON.parse(derived?.bytes ?? "{}")).toEqual({ intent: { value: "INVOICE_RECEIVED", source: "llm", confidence: 0.9, trustLevel: "untrusted-derived" } });
  });

  it("IR-009: the SUCCEEDED payload never carries the value inline anywhere except the intent field itself (no top-level duplication)", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "faktura prijata", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("INVOICE_RECEIVED") }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));
    expect(outcome.status).toBe("SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") return;

    expect(Object.keys(outcome.payload).sort()).toEqual(["artifactId", "extractedArtifactId", "extractedSha256", "intent", "sha256"].sort());
  });

  it("IR-010: impulse.intent.resolved is sealed on EVERY call, UNKNOWN included — contrast document-classifier's value-gated seal()", async () => {
    const { clock, artifacts, ledger, evidence } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "asdkjh nonsense", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("UNKNOWN") }, clock, evidence });

    await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    const sealed = ledger.forTenant(TENANT);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ subject: { key: INTENT_RESOLVE_INPUT_FIELD, scope: "case" }, result: "UNKNOWN" });
  });

  it("IR-011: the sealed Evidence carries a hash of the value, never the value's own richer JSON — AR-6", async () => {
    const { clock, artifacts, ledger, evidence } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "faktura prijata", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("INVOICE_RECEIVED") }, clock, evidence });

    await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    const [record] = ledger.forTenant(TENANT);
    expect(record?.result).toBe("INVOICE_RECEIVED");
    expect(record?.inputValueHash).toBe(sha256("INVOICE_RECEIVED"));
    // No field on Evidence carries the derived Artifact's richer { intent: {...} } JSON — only the closed token.
    expect(JSON.stringify(record)).not.toContain("confidence");
  });

  it("IR-012: without an evidence writer, resolution still succeeds — evidence is present=used, absent=skipped, never a hard dependency", async () => {
    const { clock, artifacts } = fixture();
    const artifact = artifacts.put({ tenantId: TENANT, bytes: "hello", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("UNKNOWN") }, clock });

    const outcome = await handler(handlerInput({ artifactId: artifact.artifactId }, clock));

    expect(outcome.status).toBe("SUCCEEDED");
  });

  it("IR-013: caseId threads through to the sealed evidence's originCaseId, absent when not given", async () => {
    const { clock, artifacts, ledger, evidence } = fixture();
    const withCase = artifacts.put({ tenantId: TENANT, bytes: "a", receivedFrom: "test" });
    const withoutCase = artifacts.put({ tenantId: TENANT, bytes: "b", receivedFrom: "test" });
    const handler = createIntentResolver({ artifacts, models: { llm: new FakeIntentModel("UNKNOWN") }, clock, evidence });

    await handler(handlerInput({ artifactId: withCase.artifactId, caseId: "case-77" }, clock));
    await handler(handlerInput({ artifactId: withoutCase.artifactId }, clock));

    const [first, second] = ledger.forTenant(TENANT);
    expect(first?.originCaseId).toBe("case-77");
    expect(second?.originCaseId).toBeUndefined();
  });
});
