// Composition of the platform inside one Durable Object: gateway (identities from the profile, Ed25519 signer), router
// with the read-only capabilities this deployable hosts (document.classify with the installation's models,
// document.validate), and the transport the orchestrator talks to. Nothing installation-bound is written here.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { AnthropicAdapter } from "../../../../src/adapters/anthropic.js";
import { FakeAresAdapter, type AresAdapter } from "../../../../src/adapters/ares.js";
import { classifyByRules, FakeInvoiceExtractorAdapter, FakeLlmAdapter, KeywordClassifierAdapter, RulesInvoiceExtractorAdapter, type LlmAdapter } from "../../../../src/adapters/llm.js";
import { FakeMojeDaneAdapter, type MojeDaneAdapter } from "../../../../src/adapters/moje-dane.js";
import type { RegistryAdapter } from "../../../../src/adapters/registry.js";
import { WorkersAiAdapter, type WorkersAiBinding } from "../../../../src/adapters/workers-ai.js";
import { WorkersAiExtractor } from "../../../../src/adapters/extract.js";
import * as classifier from "../../../../src/components/document-classifier/handler.js";
import * as companyVerify from "../../../../src/components/cz-company-verify/handler.js";
import * as vatVerify from "../../../../src/components/cz-vat-verify/handler.js";
import hostDescriptor from "../../../../src/components/document-executor-host/descriptor.json" with { type: "json" };
import * as extractor from "../../../../src/components/invoice-extractor/handler.js";
import * as validator from "../../../../src/components/document-validator/handler.js";
import emailDescriptor from "../../../../src/components/email-executor/descriptor.json" with { type: "json" };
import * as ingest from "../../../../src/components/mail-ingest/handler.js";
import { credentialTable, modelTable, type Installation, type SecretsSource } from "../../../../src/installation.js";
import type { ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { AuditTrail } from "../../../../src/platform/audit.js";
import { iso, type Clock } from "../../../../src/platform/clock.js";
import { CredentialResolver } from "../../../../src/platform/credentials.js";
import { EvidenceLedger, type EvidenceStore } from "../../../../src/platform/evidence.js";
import { EvidenceWriter } from "../../../../src/platform/evidence-writer.js";
import { ExecutorHost } from "../../../../src/platform/executor-host.js";
import { Gateway, IdentityProvider } from "../../../../src/platform/gateway.js";
import { policyFor } from "../../../../src/platform/policy.js";
import { capabilityNamesOf, catalogOf, type CapabilityRecord } from "../../../../src/platform/registry.js";
import { Router } from "../../../../src/platform/router.js";
import { KeyRegistry, Signer } from "../../../../src/platform/signing.js";
import { InProcessTransport, RemoteHostTransport, type DispatchTransport, type ServiceBindingLike } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";

export const CLASSIFY = "document.classify";
export const EXTRACT = "invoice.extract";
export const COMPANY_VERIFY = "cz.company.verify";
export const VAT_VERIFY = "cz.vat.verify";
/** Not a dispatched Router capability (no descriptor, no policy, nothing goes through checkGrant) — reuses
 * installation.ts's `profile.models` keying purely to get its existing "never without a model, fail-closed,
 * unavailable options shown with a reason" guarantee for Kravská dílna's own model choice, the same guarantee
 * CLASSIFY/EXTRACT already have. */
export const COW_WORKSHOP = "cow.workshop";
/**
 * Capabilities the gateway itself provides; everything else is a host and stays "not wired" until its unit lands.
 * `mail.ingest` runs here too (not as a remote dispatch): it holds no credential to isolate and writes no external
 * system, only its own tenant's artifact store — the same reasoning that keeps document.classify/validate in-process.
 * Derived from each component's own descriptor (Agent Registry, SEVERKA.md item 4), not hand-duplicated — a
 * capability added to a descriptor without also touching this file used to risk silently misrouting to notWired.
 * cz.company.verify/cz.vat.verify (SEVERKA.md "## Pořadí" bod 5-6, HANDOFF 152) join in-process here for the same
 * reason: sideEffects:none, no credential to isolate — same shape as document.classify/validate.
 */
export const GATEWAY_CAPABILITIES: readonly string[] = [
  ...capabilityNamesOf(classifier.descriptor),
  ...capabilityNamesOf(validator.descriptor),
  ...capabilityNamesOf(ingest.descriptor),
  ...capabilityNamesOf(extractor.descriptor),
  ...capabilityNamesOf(companyVerify.descriptor),
  ...capabilityNamesOf(vatVerify.descriptor),
];
/** Capabilities apf-document-host serves over a signed dispatch across a service binding (celek D). */
export const DOCUMENT_HOST_CAPABILITIES: readonly string[] = capabilityNamesOf(hostDescriptor);
export const DOCUMENT_HOST_ORIGIN = "https://apf-document-host.internal";
/** email.send is PRINCIPAL (its own credential domain, the Email Sending binding) — stays a genuine remote dispatch. */
export const EMAIL_EXECUTOR_CAPABILITIES: readonly string[] = capabilityNamesOf(emailDescriptor);
export const EMAIL_EXECUTOR_ORIGIN = "https://apf-email-executor.internal";

/** Agent Registry (SEVERKA.md item 4): the gateway's own in-process catalog, for its `/capabilities` endpoint — no live Router round-trip needed, same reasoning as GATEWAY_CAPABILITIES above. */
export function gatewayCatalog(): CapabilityRecord[] {
  return [
    ...catalogOf(classifier.descriptor),
    ...catalogOf(validator.descriptor),
    ...catalogOf(ingest.descriptor),
    ...catalogOf(extractor.descriptor),
    ...catalogOf(companyVerify.descriptor),
    ...catalogOf(vatVerify.descriptor),
  ];
}

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

/** What the operator can pick from, with every unavailable option and its reason. Throws when the capability's own
 * configured default is unavailable (fail-closed) — that default is a build-time guarantee (installation.ts's
 * "never without a model"), independent of `selectedKey`. `capability` defaults to CLASSIFY (document.classify's
 * per-document model dropdown, the only caller before Kravská dílna needed a second one — installation.ts's
 * `profile.models` was already keyed generically by capability, this just stopped hardcoding CLASSIFY here too).
 * `selectedKey` marks a DIFFERENT option as `isDefault` in the returned view (e.g. Nastavení's own runtime pick,
 * settings.ts, stored in D1) without touching what the fail-closed check above validates — an unset or
 * no-longer-available `selectedKey` silently falls back to the capability's own configured default, never throws. */
export function describeModels(installation: Installation, secrets: SecretsSource, capability: string = CLASSIFY, selectedKey?: string): ModelsView {
  const t = modelTable(installation, secrets, capability);
  const options = installation.profile.models?.[capability]?.options ?? {};
  const effective = selectedKey && t.available[selectedKey] ? selectedKey : t.default;
  return {
    default: effective,
    choices: Object.entries(options).map(([key, o]) => ({
      key,
      label: o.label ?? `${o.provider} · ${o.model}`,
      provider: o.provider,
      model: o.model,
      isDefault: key === effective,
      ...(t.unavailable[key] ? { unavailable: t.unavailable[key] } : {}),
    })),
  };
}

/** Resolves ONE model choice into a working LlmAdapter — unlike buildAdapters()/its invoice.extract twin below
 * (every option of a capability, keyed for workflow strategy names), Kravská dílna's chat only ever needs a
 * single adapter for whatever model Nastavení currently points at. `key` falls back to the capability's own
 * configured default when absent, unavailable, or unknown (the same fail-closed guarantee modelTable() already
 * makes for CLASSIFY/EXTRACT — a capability is never left without a usable model). */
export function modelAdapterFor(installation: Installation, secrets: SecretsSource, ai: WorkersAiBinding, capability: string, key?: string, maxTokens?: number): { adapter: LlmAdapter; key: string } {
  const t = modelTable(installation, secrets, capability);
  const resolvedKey = key && t.available[key] ? key : t.default;
  const opt = t.available[resolvedKey] as (typeof t.available)[string];
  const adapter =
    opt.provider === "workers-ai"
      ? new WorkersAiAdapter(opt.model, ai, maxTokens)
      : opt.provider === "anthropic"
        ? new AnthropicAdapter(opt.model, opt.secret as string, { ...(opt.inferenceGeo ? { inferenceGeo: opt.inferenceGeo } : {}), ...(maxTokens ? { maxTokens } : {}) })
        : new FakeLlmAdapter();
  return { adapter, key: resolvedKey };
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

/** invoice.extract's own adapter set (EXTRACT, not CLASSIFY) — same structure as buildAdapters(), a separate
 * function rather than a parameterized one, matching this codebase's own stated preference for duplication
 * over premature abstraction (Posudek 1 #3, agent-platform-foundation) until a third capability needs it too. */
function buildExtractAdapters(installation: Installation, secrets: SecretsSource, ai: WorkersAiBinding): Record<string, LlmAdapter> {
  const t = modelTable(installation, secrets, EXTRACT);
  const adapters: Record<string, LlmAdapter> = {};
  for (const [key, opt] of Object.entries(t.available)) {
    adapters[key] =
      opt.provider === "workers-ai"
        ? new WorkersAiAdapter(opt.model, ai)
        : opt.provider === "anthropic"
          ? new AnthropicAdapter(opt.model, opt.secret as string, { ...(opt.inferenceGeo ? { inferenceGeo: opt.inferenceGeo } : {}) })
          : new FakeInvoiceExtractorAdapter();
  }
  adapters.llm = adapters[t.default] as LlmAdapter;
  adapters.rules = new RulesInvoiceExtractorAdapter();
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
  /** Any AresAdapter: FakeAresAdapter (default — same "no real baseUrl configured yet" fallback shape as
   * buildAdapters()'s FakeLlmAdapter below) or HttpAresAdapter once a real ares.gov.cz baseUrl is an
   * installation value (SEVERKA.md "## Pořadí" bod 5, HANDOFF 132). */
  ares?: AresAdapter;
  aresTimeoutMs?: number;
  /** Any MojeDaneAdapter: FakeMojeDaneAdapter (default) or HttpMojeDaneAdapter once a real adisrws.mfcr.cz
   * baseUrl is an installation value (SEVERKA.md "## Pořadí" bod 6, HANDOFF 136). */
  mojeDane?: MojeDaneAdapter;
  mojeDaneTimeoutMs?: number;
  /**
   * Durable Žlab (docs/M0-FACT-CONTRACT-V1.md část D, D-5). HANDOFF 152 deliberately left `evidence` out while the
   * Žlab was in-memory-only; D-2..D-4 made it durable, so cz.company.verify/cz.vat.verify now seal into the object's
   * SqliteEvidenceStore. Absent = no evidence is written (tests that don't care). The ledger signs with the same
   * Ed25519 key as dispatch, domain-separated ("EVIDENCE:v3:", evidence.ts), so neither signature can stand in for
   * the other. `buildHash` = the running deploy (GIT_SHA), stamped on every record (R5).
   */
  evidence?: { store: EvidenceStore; buildHash: string };
}

export interface Wiring {
  transport: DispatchTransport;
  signing: "secret" | "ephemeral";
  keyId: string;
  /** The object's Žlab, present when WiringOptions.evidence was given. Read-only use outside the handlers (stats, import). */
  evidence?: EvidenceLedger;
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
  // Durable Žlab (M0 D-5): one ledger per object over its SQLite store, sealed with the platform key. Each evidence-
  // writing capability gets its own EvidenceWriter bound at construction to its producerId AND to the installation's
  // authority grant for it (M0 C-1: config/<installation>/authorities.json → domain stamped, fact scope enforced,
  // TTL capped). A producer without a grant writes "inferred" evidence — never a self-declared authority.
  const evidence = o.evidence ? new EvidenceLedger(o.clock, { keyId: o.keyId, privateKey, publicKey: createPublicKey(privateKey) }, o.evidence.store) : undefined;
  // reusePolicy (docs/AUTONOMOUS-RUNTIME-V1.md część 2): TENANT_WIDE for cz.company.verify/cz.vat.verify (identity/
  // registry facts — a company's registration status doesn't depend on which Case asked, the ADR's own example),
  // left unset (CASE_ONLY, EvidenceLedger.append()'s own default) for CLASSIFY — a decided document type is a fact
  // of its own Case, never generically reusable. Bound here, at the writer's identity, never on a per-call claim.
  const writerFor = (producerId: string, reusePolicy?: "CASE_ONLY" | "TENANT_WIDE"): { evidence?: EvidenceWriter } => {
    if (!evidence || !o.evidence) return {};
    const grant = o.installation.authorities.forProducer(producerId);
    const authority = grant ? { domain: grant.domain, facts: grant.facts, maxEvidenceTtlMs: grant.maxEvidenceTtlMs } : undefined;
    return { evidence: new EvidenceWriter(evidence, { producerId, capabilityVersion: "1", buildHash: o.evidence.buildHash, ...(authority ? { authority } : {}), ...(reusePolicy ? { reusePolicy } : {}) }, o.clock) };
  };
  const router = new Router({ registry, clock: o.clock, audit: o.audit, lifecycle: o.installation.lifecycle });
  const policy = (capability: string) => policyFor(o.installation.policies, capability, "1");

  router.register({
    descriptor: classifier.descriptor as never,
    policies: { [CLASSIFY]: policy(CLASSIFY) },
    capabilities: [
      {
        name: CLASSIFY,
        version: "1",
        inputSchema: classifier.inputSchema,
        handler: classifier.createDocumentClassifier({
          artifacts: o.artifacts,
          models: buildAdapters(o.installation, o.secrets, o.ai),
          clock: o.clock,
          modelTimeoutMs: o.modelTimeoutMs ?? 60_000,
          ...writerFor(CLASSIFY),
        }),
      },
    ],
  });
  router.register({
    descriptor: extractor.descriptor as never,
    policies: { [EXTRACT]: policy(EXTRACT) },
    capabilities: [
      {
        name: EXTRACT,
        version: "1",
        inputSchema: extractor.inputSchema,
        handler: extractor.createInvoiceExtractor({ artifacts: o.artifacts, models: buildExtractAdapters(o.installation, o.secrets, o.ai), clock: o.clock, modelTimeoutMs: o.modelTimeoutMs ?? 60_000 }),
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
  router.register({
    descriptor: companyVerify.descriptor as never,
    policies: { [COMPANY_VERIFY]: policy(COMPANY_VERIFY) },
    capabilities: [
      {
        name: COMPANY_VERIFY,
        version: "1",
        inputSchema: companyVerify.inputSchema,
        handler: companyVerify.createCompanyVerifier({
          ares: o.ares ?? new FakeAresAdapter(),
          clock: o.clock,
          ...(o.aresTimeoutMs !== undefined ? { aresTimeoutMs: o.aresTimeoutMs } : {}),
          ...writerFor(COMPANY_VERIFY, "TENANT_WIDE"),
        }),
      },
    ],
  });
  router.register({
    descriptor: vatVerify.descriptor as never,
    policies: { [VAT_VERIFY]: policy(VAT_VERIFY) },
    capabilities: [
      {
        name: VAT_VERIFY,
        version: "1",
        inputSchema: vatVerify.inputSchema,
        handler: vatVerify.createVatVerifier({
          mojeDane: o.mojeDane ?? new FakeMojeDaneAdapter(),
          clock: o.clock,
          ...(o.mojeDaneTimeoutMs !== undefined ? { mojeDaneTimeoutMs: o.mojeDaneTimeoutMs } : {}),
          ...writerFor(VAT_VERIFY, "TENANT_WIDE"),
        }),
      },
    ],
  });
  // No credential domain: mail.ingest never resolves a secret, only writes into its own tenant's artifact store.
  // Still runs through ExecutorHost (not a bare Handler) for the same allowlist/context/idempotency chain every
  // write capability gets — matches src/slice.ts's ingestHost exactly, just in-process here instead of a fresh test slice.
  const ingestCredentials = new CredentialResolver(credentialTable(o.installation, o.secrets, { [ingest.INGEST_HANDLER_ID]: [] }), o.audit);
  // No review-task store wired here (mail.ingest has approval.required:false today) — checkApproval()
  // still fails closed (APPROVAL_REQUIRED) if a future policy ever sets approval.required:true.
  const ingestHost = new ExecutorHost({ hostId: ingest.descriptor.module, clock: o.clock, audit: o.audit, credentials: ingestCredentials, policyFor: policy });
  // Same extractor as document.extract (below, Podatelna's binary uploads) — one implementation of "binary ->
  // readable text" regardless of which channel handed the farm the attachment.
  ingestHost.register(ingest.createIngestHandler({ artifacts: o.artifacts, clock: o.clock, extractor: new WorkersAiExtractor(o.ai) }));
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
  return { transport, signing, keyId: o.keyId, ...(evidence ? { evidence } : {}) };
}
