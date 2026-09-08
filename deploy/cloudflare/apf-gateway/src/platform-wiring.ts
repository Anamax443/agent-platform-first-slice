// Composition of the platform inside one Durable Object: gateway (identities from the profile, Ed25519 signer), router
// with the read-only capabilities this deployable hosts (document.classify with the installation's models,
// document.validate), and the transport the orchestrator talks to. Nothing installation-bound is written here.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { AnthropicAdapter } from "../../../../src/adapters/anthropic.js";
import { classifyByRules, FakeLlmAdapter, KeywordClassifierAdapter, type LlmAdapter } from "../../../../src/adapters/llm.js";
import type { RegistryAdapter } from "../../../../src/adapters/registry.js";
import { WorkersAiAdapter, type WorkersAiBinding } from "../../../../src/adapters/workers-ai.js";
import * as classifier from "../../../../src/components/document-classifier/handler.js";
import * as validator from "../../../../src/components/document-validator/handler.js";
import * as ingest from "../../../../src/components/mail-ingest/handler.js";
import { credentialTable, modelTable, type Installation, type SecretsSource } from "../../../../src/installation.js";
import type { ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { AuditTrail } from "../../../../src/platform/audit.js";
import { iso, type Clock } from "../../../../src/platform/clock.js";
import { CredentialResolver } from "../../../../src/platform/credentials.js";
import { ExecutorHost } from "../../../../src/platform/executor-host.js";
import { Gateway, IdentityProvider } from "../../../../src/platform/gateway.js";
import { policyFor } from "../../../../src/platform/policy.js";
import { Router } from "../../../../src/platform/router.js";
import { KeyRegistry, Signer } from "../../../../src/platform/signing.js";
import { InProcessTransport, RemoteHostTransport, type DispatchTransport, type ServiceBindingLike } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";

export const CLASSIFY = "document.classify";
/**
 * Capabilities the gateway itself provides; everything else is a host and stays "not wired" until its unit lands.
 * `mail.ingest` runs here too (not as a remote dispatch): it holds no credential to isolate and writes no external
 * system, only its own tenant's artifact store — the same reasoning that keeps document.classify/validate in-process.
 */
export const GATEWAY_CAPABILITIES: readonly string[] = [CLASSIFY, "document.validate", "mail.ingest"];
/** Capabilities apf-document-host serves over a signed dispatch across a service binding (celek D). */
export const DOCUMENT_HOST_CAPABILITIES: readonly string[] = ["document.stamp", "document.archive"];
export const DOCUMENT_HOST_ORIGIN = "https://apf-document-host.internal";
/** email.send is PRINCIPAL (its own credential domain, the Email Sending binding) — stays a genuine remote dispatch. */
export const EMAIL_EXECUTOR_CAPABILITIES: readonly string[] = ["email.send"];
export const EMAIL_EXECUTOR_ORIGIN = "https://apf-email-executor.internal";

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
  /** The document-type registry behind document.validate: on the farm the apf-fakes double over a service binding (unit C). */
  registry: RegistryAdapter;
  /** apf-document-host's service binding (celek D2). Absent = document.stamp/archive fall through to notWired, same as today. */
  documentHost?: ServiceBindingLike;
  /** apf-email-executor's service binding. Absent = email.send falls through to notWired, same as today. */
  emailExecutor?: ServiceBindingLike;
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
  // The registry is injected (unit C: apf-fakes over a service binding, chaos modes in KV); the validator treats every answer as untrusted.
  router.register({
    descriptor: validator.descriptor as never,
    policies: { "document.validate": policy("document.validate") },
    capabilities: [
      {
        name: "document.validate",
        version: "1",
        inputSchema: validator.inputSchema,
        handler: validator.createDocumentValidator({ artifacts: o.artifacts, registry: o.registry, clock: o.clock, crossCheck: classifyByRules, registryTimeoutMs: 5_000 }),
      },
    ],
  });
  // No credential domain: mail.ingest never resolves a secret, only writes into its own tenant's artifact store.
  // Still runs through ExecutorHost (not a bare Handler) for the same allowlist/context/idempotency chain every
  // write capability gets — matches src/slice.ts's ingestHost exactly, just in-process here instead of a fresh test slice.
  const ingestCredentials = new CredentialResolver(credentialTable(o.installation, o.secrets, { [ingest.INGEST_HANDLER_ID]: [] }), o.audit);
  const ingestHost = new ExecutorHost({ hostId: ingest.descriptor.module, clock: o.clock, audit: o.audit, credentials: ingestCredentials });
  ingestHost.register(ingest.createIngestHandler({ artifacts: o.artifacts, clock: o.clock }));
  router.register({
    descriptor: ingest.descriptor as never,
    policies: { "mail.ingest": policy("mail.ingest") },
    capabilities: [{ name: "mail.ingest", version: "1", inputSchema: ingest.inputSchema, handler: ingestHost.handlerFor("mail.ingest") }],
  });

  const inProcess = new InProcessTransport(gateway, router);
  const documentHost = o.documentHost ? new RemoteHostTransport(gateway, o.documentHost, DOCUMENT_HOST_ORIGIN) : undefined;
  const emailExecutor = o.emailExecutor ? new RemoteHostTransport(gateway, o.emailExecutor, EMAIL_EXECUTOR_ORIGIN) : undefined;
  const transport: DispatchTransport = {
    dispatch: (message, actorId) => {
      if (GATEWAY_CAPABILITIES.includes(message.capability)) {
        console.log(`[apf-gateway] route ${message.capability} -> in-process correlationId=${message.correlationId}`);
        return inProcess.dispatch(message, actorId);
      }
      if (documentHost && DOCUMENT_HOST_CAPABILITIES.includes(message.capability)) {
        console.log(`[apf-gateway] route ${message.capability} -> apf-document-host correlationId=${message.correlationId}`);
        return documentHost.dispatch(message, actorId);
      }
      if (emailExecutor && EMAIL_EXECUTOR_CAPABILITIES.includes(message.capability)) {
        console.log(`[apf-gateway] route ${message.capability} -> apf-email-executor correlationId=${message.correlationId}`);
        return emailExecutor.dispatch(message, actorId);
      }
      console.log(`[apf-gateway] route ${message.capability} -> notWired correlationId=${message.correlationId}`);
      return o.notWired(message, actorId);
    },
  };
  return { transport, signing, keyId: o.keyId };
}
