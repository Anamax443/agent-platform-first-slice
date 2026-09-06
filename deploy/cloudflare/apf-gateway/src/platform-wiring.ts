// Composition of the platform inside one Durable Object: gateway (identities from the profile, Ed25519 signer), router
// with the read-only capabilities this deployable hosts (document.classify with the installation's models,
// document.validate), and the transport the orchestrator talks to. Nothing installation-bound is written here.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { AnthropicAdapter } from "../../../../src/adapters/anthropic.js";
import { classifyByRules, FakeLlmAdapter, KeywordClassifierAdapter, type LlmAdapter } from "../../../../src/adapters/llm.js";
import { FakeRegistryAdapter } from "../../../../src/adapters/registry.js";
import { WorkersAiAdapter, type WorkersAiBinding } from "../../../../src/adapters/workers-ai.js";
import * as classifier from "../../../../src/components/document-classifier/handler.js";
import * as validator from "../../../../src/components/document-validator/handler.js";
import { modelTable, type Installation, type SecretsSource } from "../../../../src/installation.js";
import type { ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { AuditTrail } from "../../../../src/platform/audit.js";
import { iso, type Clock } from "../../../../src/platform/clock.js";
import { Gateway, IdentityProvider } from "../../../../src/platform/gateway.js";
import { policyFor } from "../../../../src/platform/policy.js";
import { Router } from "../../../../src/platform/router.js";
import { KeyRegistry, Signer } from "../../../../src/platform/signing.js";
import { InProcessTransport, type DispatchTransport } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";

export const CLASSIFY = "document.classify";
/** Capabilities the gateway itself provides; everything else is a host and stays "not wired" until its unit lands. */
export const GATEWAY_CAPABILITIES: readonly string[] = [CLASSIFY, "document.validate"];

export interface ModelChoice {
  key: string;
  label: string;
  provider: string;
  model: string;
  isDefault: boolean;
  /** Present when the option cannot be used here (its credential has no value); shown to the operator, never silently skipped. */
  unavailable?: string;
}

export interface ModelsView {
  default: string;
  choices: ModelChoice[];
}

/** What the operator can pick from, with every unavailable option and its reason. Throws when the default itself is unavailable (fail-closed). */
export function describeModels(installation: Installation, secrets: SecretsSource): ModelsView {
  const t = modelTable(installation, secrets, CLASSIFY);
  const options = installation.profile.models?.[CLASSIFY]?.options ?? {};
  return {
    default: t.default,
    choices: Object.entries(options).map(([key, o]) => ({
      key,
      label: o.label ?? `${o.provider} · ${o.model}`,
      provider: o.provider,
      model: o.model,
      isDefault: key === t.default,
      ...(t.unavailable[key] ? { unavailable: t.unavailable[key] } : {}),
    })),
  };
}

function buildAdapters(installation: Installation, secrets: SecretsSource, ai: WorkersAiBinding): Record<string, LlmAdapter> {
  const t = modelTable(installation, secrets, CLASSIFY);
  const adapters: Record<string, LlmAdapter> = {};
  for (const [key, opt] of Object.entries(t.available)) {
    adapters[key] =
      opt.provider === "workers-ai"
        ? new WorkersAiAdapter(opt.model, ai)
        : opt.provider === "anthropic"
          ? new AnthropicAdapter(opt.model, opt.secret as string, { ...(opt.inferenceGeo ? { inferenceGeo: opt.inferenceGeo } : {}) })
          : new FakeLlmAdapter();
  }
  // Strategy names of the workflow definitions: "llm" = the installation's default model, "keyword" = rules (second signal).
  adapters.llm = adapters[t.default] as LlmAdapter;
  adapters.keyword = new KeywordClassifierAdapter();
  return adapters;
}

export interface WiringOptions {
  installation: Installation;
  secrets: SecretsSource;
  ai: WorkersAiBinding;
  artifacts: ArtifactWriter;
  audit: AuditTrail;
  clock: Clock;
  keyId: string;
  /** PKCS8 PEM of the gateway's Ed25519 key (secret). Absent = ephemeral key, allowed only for an installation without an API host. */
  signingKeyPem: string | undefined;
  /** Result for a capability no deployable serves yet. */
  notWired: (message: MessageEnvelope, actorId: string) => Promise<ResultEnvelope>;
  modelTimeoutMs?: number;
}

export interface Wiring {
  transport: DispatchTransport;
  signing: "secret" | "ephemeral";
  keyId: string;
}

export function wirePlatform(o: WiringOptions): Wiring {
  const profile = o.installation.profile;
  let privateKey: KeyObject;
  let signing: Wiring["signing"];
  if (o.signingKeyPem) {
    privateKey = createPrivateKey(o.signingKeyPem);
    signing = "secret";
  } else if (profile.channels.apiHost === null) {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    signing = "ephemeral";
  } else {
    throw new Error("GATEWAY_SIGNING_KEY is missing and this installation has an API host (fail-closed)");
  }
  const registry = new KeyRegistry();
  registry.add({ keyId: o.keyId, publicKey: createPublicKey(privateKey), validFrom: iso(new Date(0)) });
  const gateway = new Gateway({ identities: new IdentityProvider(profile.identities), signer: new Signer(o.keyId, privateKey), clock: o.clock });
  const router = new Router({ registry, clock: o.clock, audit: o.audit });
  const policy = (capability: string) => policyFor(o.installation.policies, capability, "1");

  router.register({
    descriptor: classifier.descriptor as never,
    policies: { [CLASSIFY]: policy(CLASSIFY) },
    capabilities: [
      {
        name: CLASSIFY,
        version: "1",
        inputSchema: classifier.inputSchema,
        handler: classifier.createDocumentClassifier({ artifacts: o.artifacts, models: buildAdapters(o.installation, o.secrets, o.ai), clock: o.clock, modelTimeoutMs: o.modelTimeoutMs ?? 60_000 }),
      },
    ],
  });
  // Unit C replaces the in-process fake registry with the client of apf-fakes (a real network hop with chaos modes).
  router.register({
    descriptor: validator.descriptor as never,
    policies: { "document.validate": policy("document.validate") },
    capabilities: [
      {
        name: "document.validate",
        version: "1",
        inputSchema: validator.inputSchema,
        handler: validator.createDocumentValidator({ artifacts: o.artifacts, registry: new FakeRegistryAdapter("ok"), clock: o.clock, crossCheck: classifyByRules, registryTimeoutMs: 5_000 }),
      },
    ],
  });

  const inProcess = new InProcessTransport(gateway, router);
  const transport: DispatchTransport = {
    dispatch: (message, actorId) => (GATEWAY_CAPABILITIES.includes(message.capability) ? inProcess.dispatch(message, actorId) : o.notWired(message, actorId)),
  };
  return { transport, signing, keyId: o.keyId };
}
