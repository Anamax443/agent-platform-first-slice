// Composition of the platform inside one Durable Object: gateway (identities from the profile, Ed25519 signer), router
// with the read-only capabilities this deployable hosts (document.classify with the installation's models,
// document.validate), and the transport the orchestrator talks to. Nothing installation-bound is written here.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { AnthropicAdapter } from "../../../../src/adapters/anthropic.js";
import { FakeAresAdapter, NotConfiguredAresAdapter, type AresAdapter } from "../../../../src/adapters/ares.js";
import { classifyByRules, FakeInvoiceExtractorAdapter, FakeLlmAdapter, KeywordClassifierAdapter, RulesInvoiceExtractorAdapter, type LlmAdapter } from "../../../../src/adapters/llm.js";
import { FakeMojeDaneAdapter, NotConfiguredMojeDaneAdapter, type MojeDaneAdapter } from "../../../../src/adapters/moje-dane.js";
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
import { ExecutorHost, type Reconciler } from "../../../../src/platform/executor-host.js";
import { Gateway, IdentityProvider } from "../../../../src/platform/gateway.js";
import type { IdempotencyStore } from "../../../../src/platform/idempotency.js";
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
  /** Any AresAdapter: HttpAresAdapter once a real ares.gov.cz baseUrl is an installation value (SEVERKA.md
   * "## Pořadí" bod 5, HANDOFF 132), or a caller-supplied fake for tests. Absent (the live default) no
   * longer falls back to FakeAresAdapter unconditionally: Reliability Gate R4 (18.9.2026 audit) changed
   * that fallback to require the installation's explicit opt-in (aresFor(), below) — see
   * TrustedProviderNotConfigured's doc comment (src/platform/errors.ts) for the full rationale. This
   * comment used to say "FakeAresAdapter (default — same ... fallback shape as buildAdapters()'s
   * FakeLlmAdapter below)"; that is no longer true and is corrected here rather than left stale. */
  ares?: AresAdapter;
  aresTimeoutMs?: number;
  /** Any MojeDaneAdapter: HttpMojeDaneAdapter once a real adisrws.mfcr.cz baseUrl is an installation value
   * (SEVERKA.md "## Pořadí" bod 6, HANDOFF 136), or a caller-supplied fake for tests. Absent no longer
   * falls back to FakeMojeDaneAdapter unconditionally — same Reliability Gate R4 change and same
   * correction as `ares` above; see mojeDaneFor() below and TrustedProviderNotConfigured's doc comment. */
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
  /** R1 (Reliability Gate, 2026-09-18): backs mail.ingest's ExecutorHost dedup durably across this object's own
   * restart. Absent = wirePlatform() itself calls `ExecutorHost.forTests()` for the ingest host instead of
   * `.production()` (RG2-C, see that call site's own doc comment for the full rationale) — but ONLY when
   * `installation.profile.allowEphemeralIdempotency` says so explicitly (RG2-C follow-up, adversarial review
   * of RG2-C's own branch, 18.9.2026: this option alone used to be enough, silently, which was the same
   * "optional store, silent in-memory fallback" bug RG2-C closed one layer down, just moved up here — see
   * InstallationProfile.allowEphemeralIdempotency's own doc comment). An installation that has NOT opted in
   * and omits this option gets a construction-time throw from wirePlatform() instead: fail-closed, matching
   * this branch's own acceptance criterion ("missing durable idempotency -> constructor/wiring FAIL, not a
   * warning"). Does NOT dedup two independent deliveries of the same e-mail (each mints its own workflowId
   * before any dedup key exists, index.ts's `startMailIntake()`) — that is a separate, deliberately
   * out-of-scope gap (see store.ts's `idempotency` DDL comment). */
  idempotency?: IdempotencyStore;
}

export interface Wiring {
  transport: DispatchTransport;
  signing: "secret" | "ephemeral";
  keyId: string;
  /** The object's Žlab, present when WiringOptions.evidence was given. Read-only use outside the handlers (stats, import). */
  evidence?: EvidenceLedger;
  /**
   * RG2-D (2026-09-18, "stale RESERVED reconciliation"): src/platform/orchestrator.ts's reconcile() looks up
   * `this.opts.reconcilers?.[def.capability]` to attempt automatic recovery of an UNKNOWN_OUTCOME step before ever
   * falling back to human review — but index.ts's orchestratorFor() builds one `Orchestrator` per HTTP call/alarm
   * tick and, before this field existed, never passed OrchestratorOpts.reconcilers at all, so that lookup always
   * came back undefined (safe — reconcile() with no reconciler still creates a review task — but it never even
   * tried the one reconciler that could resolve mail.ingest's stuck-RESERVED case automatically). Exposing this
   * narrower `capability -> Reconciler` map (rather than `ingestHost` itself, the ExecutorHost it is built from)
   * keeps orchestratorFor() from needing to know which capabilities of which host are reconcile-capable — it just
   * spreads this map into OrchestratorOpts.reconcilers. Built once inside wirePlatform() below, currently just
   * `{ "mail.ingest": ingestHost.reconcilerFor("mail.ingest") }` — the only host wired IN-PROCESS inside this
   * object with a reconcile-capable handler today (mail-ingest/handler.ts's own `reconcile` field). document.stamp
   * and email.send are dispatched to SEPARATE Cloudflare Workers (apf-document-host, apf-email-executor) over a
   * signed remote dispatch, not local calls within this object's own wirePlatform() output — reconciling those
   * needs a new remote reconcile RPC, a bigger, separate item, deliberately out of scope here.
   */
  reconcilers?: Record<string, Reconciler>;
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
  // Reliability Gate R4 (owner's second, "months/years unattended" audit, 18.9.2026): before this change,
  // `o.ares ?? new FakeAresAdapter()` / `o.mojeDane ?? new FakeMojeDaneAdapter()` at the two capability
  // registrations below fell back to the fakes UNCONDITIONALLY whenever no real adapter was wired — a
  // missing installation config silently became fabricated ARES/MOJE daně data indistinguishable from a
  // real answer downstream. These two closures gate that fallback on the installation's explicit opt-in
  // (InstallationProfile.allowUnconfiguredTrustedProviders, installation.ts) instead: opted in ->
  // FakeAresAdapter/FakeMojeDaneAdapter, same as before (config/local-fakes/profile.json sets this, on
  // purpose — it exists to BE the fakes); not opted in -> NotConfiguredAresAdapter/NotConfiguredMojeDaneAdapter,
  // whose lookup() throws TrustedProviderNotConfigured (src/platform/errors.ts), caught by
  // cz-company-verify/cz-vat-verify's own handler.ts and turned into a FAILED/TRUSTED_PROVIDER_NOT_CONFIGURED
  // result — loud and named, never a silent HANDLER_CRASHED and never a fabricated SUCCEEDED. Deliberately
  // just two closures, not a throw here in wirePlatform() itself (Approach B, rejected — see the R4 patch
  // plan): wirePlatform() builds every capability of one Durable Object in a single call that index.ts's
  // WorkflowInstance.wiring() and self-test.ts both share unconditionally, so throwing here over a config
  // gap in only these two capabilities would take document.classify/invoice.extract/document.validate/
  // mail.ingest down with them for every tenant, including ones that never call cz.company.verify or
  // cz.vat.verify at all.
  const aresFor = (): AresAdapter => o.ares ?? (profile.allowUnconfiguredTrustedProviders ? new FakeAresAdapter() : new NotConfiguredAresAdapter());
  const mojeDaneFor = (): MojeDaneAdapter => o.mojeDane ?? (profile.allowUnconfiguredTrustedProviders ? new FakeMojeDaneAdapter() : new NotConfiguredMojeDaneAdapter());

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
          ares: aresFor(),
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
          mojeDane: mojeDaneFor(),
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
  // `idempotency: o.idempotency` (R1, 2026-09-18): previously never passed, so this host's dedup ran on
  // ExecutorHost's own in-memory fallback and lost every RESERVED reservation across a restart of this object —
  // see the WiringOptions.idempotency doc comment above and store.ts's `idempotency` DDL comment for the trail.
  //
  // RG2-C (2026-09-18): ExecutorHost's constructor no longer defaults idempotency at all — `production()`
  // requires a real store, `forTests()` is the only place an in-memory one still appears, and it must be called
  // by name. This is the ONE call site in the whole codebase that deliberately still allows the ephemeral,
  // ExecutorHost.forTests()-style non-durable path in something that is not a plain unit test: wirePlatform()
  // itself supports installations that opt into ephemeral dedup for the ingest host — a NAMED, visible
  // exception, made explicit right here, not a silent default buried in ExecutorHost's constructor.
  //
  // RG2-C follow-up (adversarial review of RG2-C's own branch, 18.9.2026): the opt-in below used to be
  // WiringOptions.idempotency alone being omitted — no installation-level gate — which was exactly the
  // "optional, silently substitutes a fake" bug this branch closed one layer down (ExecutorHost's own
  // constructor), just recreated here under deploy/cloudflare/*, the one place this branch's own doc comments
  // say forTests() must never be reached from. It now additionally requires
  // `installation.profile.allowEphemeralIdempotency === true` (see that field's own doc comment,
  // src/installation.ts) — an installation that omits `idempotency` WITHOUT that opt-in gets a
  // construction-time throw instead of a silent fallback, matching this branch's own acceptance criterion
  // ("missing durable idempotency -> constructor/wiring FAIL, not a warning"). Safe to throw for the whole
  // wiring, not just this capability: mail.ingest is a GATEWAY_CAPABILITY every installation registers
  // unconditionally, unlike cz.company.verify/cz.vat.verify's narrower, per-capability
  // allowUnconfiguredTrustedProviders gate above (Approach B was rejected there specifically because a
  // construction-time throw would have taken unrelated capabilities down with it for tenants that never call
  // those two — that concern does not apply here).
  //
  // tests/gw-platform-wiring-fanout.test.ts's "without a passed-in idempotency store (every pre-existing call
  // site's shape), two independently-built wirings do NOT dedup — the pre-existing behavior is unchanged" test
  // (LOCAL_FAKES, which sets allowEphemeralIdempotency:true) is what proves this branch is real, tested,
  // intentional behavior, not an oversight — it must keep passing. Its sibling
  // "installation that has NOT opted in AND omits idempotency -> wirePlatform() throws, fail-closed" test
  // proves the new gate actually gates. In practice neither real installation takes the ephemeral branch today:
  // both farm-bass443 and local-fakes' own live deploy always pass a real store via
  // deploy/cloudflare/apf-gateway/src/index.ts's own wirePlatform() call (`idempotency: this.idempotency`, a
  // real SqliteIdempotencyStore) — verified by grepping every wirePlatform() call site in this repo, there is
  // exactly one, and it always supplies `idempotency`. So this `else` branch exists for wirePlatform()'s own
  // generality (a future caller, or this test file) rather than any live installation actually needing it —
  // but unlike before, a future caller that forgets `idempotency` now fails loudly instead of degrading silently.
  let ingestHost: ExecutorHost;
  if (o.idempotency) {
    ingestHost = ExecutorHost.production({ hostId: ingest.descriptor.module, clock: o.clock, audit: o.audit, credentials: ingestCredentials, policyFor: policy, idempotency: o.idempotency });
  } else if (profile.allowEphemeralIdempotency) {
    ingestHost = ExecutorHost.forTests({ hostId: ingest.descriptor.module, clock: o.clock, audit: o.audit, credentials: ingestCredentials, policyFor: policy });
  } else {
    throw new Error(
      "mail.ingest's ExecutorHost needs a durable idempotency store (WiringOptions.idempotency) and this installation has not set profile.allowEphemeralIdempotency (fail-closed) — see InstallationProfile.allowEphemeralIdempotency's doc comment",
    );
  }
  // Same extractor as document.extract (below, Podatelna's binary uploads) — one implementation of "binary ->
  // readable text" regardless of which channel handed the farm the attachment.
  ingestHost.register(ingest.createIngestHandler({ artifacts: o.artifacts, clock: o.clock, extractor: new WorkersAiExtractor(o.ai) }));
  router.register({
    descriptor: ingest.descriptor as never,
    policies: { "mail.ingest": policy("mail.ingest") },
    capabilities: [{ name: "mail.ingest", version: "1", inputSchema: ingest.inputSchema, handler: ingestHost.handlerFor("mail.ingest") }],
  });

  // RG2-D (2026-09-18): the one reconciler map this object can build from what it wires in-process — see
  // Wiring.reconcilers's own doc comment above for why it is a map and not `ingestHost` itself, and
  // mail-ingest/handler.ts's `reconcile` field for why the reconciler it wraps is honestly always UNKNOWN.
  // Built AFTER ingestHost.register() above: reconcilerFor() looks the handler spec up lazily at call time
  // (executor-host.ts), so ordering is not load-bearing for correctness, but building it here keeps "every
  // reconcile-capable in-process host" in one place next to the hosts themselves. Same shape as src/slice.ts's
  // own `reconcilers` object (the test/reference composition), minus document.stamp/email.send, which are remote here.
  const reconcilers: Record<string, Reconciler> = { "mail.ingest": ingestHost.reconcilerFor("mail.ingest") };

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
  return { transport, signing, keyId: o.keyId, ...(evidence ? { evidence } : {}), reconcilers };
}
