// Composition root of the first slice. The only place that knows every concrete class; tests build the world from here.
// Two flows share one gateway, router, journal, review service and audit: document-intake.v1 and mail-intake.v1.
// Nothing bound to a customer or environment lives here: identities, tenants, policies and credential references
// come from the installation profile, secret values from a SecretsSource (config/<installation>/, docs/NAVRHOVY-LIST-farma.md).
import { FakeArchiveAdapter } from "./adapters/archive.js";
import { FakeDmsAdapter } from "./adapters/dms.js";
import { classifyByRules, FakeLlmAdapter, KeywordClassifierAdapter, type LlmAdapter } from "./adapters/llm.js";
import { FakeRegistryAdapter, type RegistryAdapter } from "./adapters/registry.js";
import { FakeSmtpAdapter } from "./adapters/smtp.js";
import * as classifier from "./components/document-classifier/handler.js";
import * as validator from "./components/document-validator/handler.js";
import * as host from "./components/document-executor-host/stamp-handler.js";
import { createArchiveHandler, ARCHIVE_CREDENTIAL, ARCHIVE_HANDLER_ID, type ArchiveDeps } from "./components/document-executor-host/archive-handler.js";
import * as ingest from "./components/mail-ingest/handler.js";
import * as email from "./components/email-executor/handler.js";
import { credentialTable, type Installation, type SecretsSource } from "./installation.js";
import { ArtifactStore } from "./platform/artifacts.js";
import { Audit } from "./platform/audit.js";
import { FakeClock, iso, plus } from "./platform/clock.js";
import { CredentialResolver } from "./platform/credentials.js";
import { ExecutorHost, type HostHandlerSpec, type HostMutants } from "./platform/executor-host.js";
import { Gateway, IdentityProvider } from "./platform/gateway.js";
import { newId } from "./platform/ids.js";
import { Journal } from "./platform/journal.js";
import { Orchestrator, type WorkflowDef } from "./platform/orchestrator.js";
import { policyFor } from "./platform/policy.js";
import { ReviewService, type ReviewTaskStore } from "./platform/review.js";
import { Router } from "./platform/router.js";
import { generateKeyPair, KeyRegistry, Signer } from "./platform/signing.js";
import { InProcessTransport } from "./platform/transport.js";
import type { MessageEnvelope } from "./platform/types.js";
import { WORKFLOW_DEFINITIONS, workflowDef } from "./platform/workflow.js";

export { WORKFLOW_DEFINITIONS, WORKFLOW_NAMES, workflowDef } from "./platform/workflow.js";

/** Test default for the fake clock. Not an installation value: real runtimes use SystemClock. */
export const DEFAULT_CLOCK_START = "2026-09-06T08:00:00Z";

export interface SliceOptions {
  clockStart?: string;
  journalFile?: string;
  auditFile?: string;
  /** Durable stores can be shared between two slices to simulate a restart (RES-CRASH-001, IDM-RET-002). */
  artifacts?: ArtifactStore;
  artifactCapacityBytes?: number;
  /** Shared between two slices to simulate two requests hitting the same Durable Object (RES-REVIEW-001). */
  reviewStore?: ReviewTaskStore;
  dms?: FakeDmsAdapter;
  /** Any RegistryAdapter: the fake in process (default), or HttpRegistryAdapter over the fakes protocol (INT-HTTP-*). */
  registry?: RegistryAdapter;
  archive?: FakeArchiveAdapter;
  smtp?: FakeSmtpAdapter;
  models?: Record<string, LlmAdapter>;
  contextTtlMs?: number;
  modelTimeoutMs?: number;
  registryTimeoutMs?: number;
  /** Test harness: mutants per host (VC §6). */
  hostMutants?: HostMutants;
  emailHostMutants?: HostMutants;
  /** Replace the archive handler (test harness: rogue handler for SEC-HOST-001). */
  archiveHandler?: (deps: ArchiveDeps) => HostHandlerSpec;
  /** Primary workflow of `slice.orchestrator` (default document-intake). */
  workflow?: WorkflowDef;
}

export function createSlice(installation: Installation, secrets: SecretsSource, o: SliceOptions = {}) {
  const profile = installation.profile;
  const clock = new FakeClock(o.clockStart ?? DEFAULT_CLOCK_START);
  const audit = new Audit(clock, o.auditFile);
  const artifacts = o.artifacts ?? new ArtifactStore(clock, o.artifactCapacityBytes !== undefined ? { capacityBytes: o.artifactCapacityBytes } : {});

  // Gateway with Ed25519 key k1; receivers hold only the public key. Identities come from the profile, never from code.
  const keyPair = generateKeyPair();
  const keyRegistry = new KeyRegistry();
  keyRegistry.add({ keyId: "k1", publicKey: keyPair.publicKey, validFrom: iso(clock.now()) });
  const signer = new Signer("k1", keyPair.privateKey);
  const identities = new IdentityProvider(profile.identities);
  const gateway = new Gateway({ identities, signer, clock, ...(o.contextTtlMs !== undefined ? { contextTtlMs: o.contextTtlMs } : {}) });

  // Adapters (fakes)
  const dms = o.dms ?? new FakeDmsAdapter();
  const registry: RegistryAdapter = o.registry ?? new FakeRegistryAdapter();
  const archive = o.archive ?? new FakeArchiveAdapter();
  const smtp = o.smtp ?? new FakeSmtpAdapter();
  const models = o.models ?? { llm: new FakeLlmAdapter(), keyword: new KeywordClassifierAdapter() };

  // Credential domains (CredentialResolverFixture, VC §6): one table per deployable, rows only for its handlers,
  // references from the profile, values from the secrets source; a missing or ungranted reference stops the wiring.
  const documentCredentials = new CredentialResolver(
    credentialTable(installation, secrets, { [host.STAMP_HANDLER_ID]: [host.STAMP_CREDENTIAL], [ARCHIVE_HANDLER_ID]: [ARCHIVE_CREDENTIAL] }),
    audit,
  );
  const emailCredentials = new CredentialResolver(credentialTable(installation, secrets, { [email.SEND_HANDLER_ID]: [email.SMTP_CREDENTIAL] }), audit);
  const ingestCredentials = new CredentialResolver(credentialTable(installation, secrets, { [ingest.INGEST_HANDLER_ID]: [] }), audit);

  // Hosts: document-executor-host (LOGICAL, two handlers), email-executor (PRINCIPAL: own context, own credential domain), mail-ingest.
  const documentHost = new ExecutorHost({ hostId: host.descriptor.module, clock, audit, credentials: documentCredentials });
  Object.assign(documentHost.mutants, o.hostMutants ?? {});
  documentHost.register(host.createStampHandler({ artifacts, dms, credentials: documentCredentials, clock }));
  documentHost.register((o.archiveHandler ?? createArchiveHandler)({ artifacts, archive, credentials: documentCredentials, clock }));

  // Policies are authority artefacts of the installation (ADR-016); a capability without one cannot be registered.
  const policy = (capability: string) => policyFor(installation.policies, capability, "1");
  const emailPolicy = policy("email.send");
  const recipients: email.RecipientDirectory = (tenantId, ref) => emailPolicy.recipientAllowlist?.[tenantId]?.[ref];
  const emailHost = new ExecutorHost({ hostId: email.descriptor.module, clock, audit, credentials: emailCredentials });
  Object.assign(emailHost.mutants, o.emailHostMutants ?? {});
  emailHost.register(email.createEmailSendHandler({ artifacts, smtp, credentials: emailCredentials, recipients, clock }));

  const ingestHost = new ExecutorHost({ hostId: ingest.descriptor.module, clock, audit, credentials: ingestCredentials });
  ingestHost.register(ingest.createIngestHandler({ artifacts, clock }));

  // Router: descriptors validated against the frozen schema, policies looked up fail-closed.
  const router = new Router({ registry: keyRegistry, clock, audit });
  router.register({
    descriptor: classifier.descriptor as never,
    policies: { "document.classify": policy("document.classify") },
    capabilities: [
      {
        name: "document.classify",
        version: "1",
        inputSchema: classifier.inputSchema,
        handler: classifier.createDocumentClassifier({ artifacts, models, clock, ...(o.modelTimeoutMs !== undefined ? { modelTimeoutMs: o.modelTimeoutMs } : {}) }),
      },
    ],
  });
  router.register({
    descriptor: validator.descriptor as never,
    policies: { "document.validate": policy("document.validate") },
    capabilities: [
      {
        name: "document.validate",
        version: "1",
        inputSchema: validator.inputSchema,
        handler: validator.createDocumentValidator({
          artifacts,
          registry,
          clock,
          crossCheck: classifyByRules,
          ...(o.registryTimeoutMs !== undefined ? { registryTimeoutMs: o.registryTimeoutMs } : {}),
        }),
      },
    ],
  });
  router.register({
    descriptor: host.descriptor as never,
    policies: { "document.stamp": policy("document.stamp"), "document.archive": policy("document.archive") },
    capabilities: [
      { name: "document.stamp", version: "1", inputSchema: host.stampInputSchema, handler: documentHost.handlerFor("document.stamp") },
      { name: "document.archive", version: "1", inputSchema: host.archiveInputSchema, handler: documentHost.handlerFor("document.archive") },
    ],
  });
  router.register({
    descriptor: ingest.descriptor as never,
    policies: { "mail.ingest": policy("mail.ingest") },
    capabilities: [{ name: "mail.ingest", version: "1", inputSchema: ingest.inputSchema, handler: ingestHost.handlerFor("mail.ingest") }],
  });
  router.register({
    descriptor: email.descriptor as never,
    policies: { "email.send": emailPolicy },
    capabilities: [{ name: "email.send", version: "1", inputSchema: email.inputSchema, handler: emailHost.handlerFor("email.send") }],
  });

  // Transport: in this runtime gateway and router share the process. Orchestrators only ever see the interface.
  const transport = new InProcessTransport(gateway, router);
  const journal = new Journal(o.journalFile);
  const review = o.reviewStore ? new ReviewService(clock, audit, o.reviewStore) : new ReviewService(clock, audit);
  const workflow = o.workflow ?? workflowDef("document-intake");
  const mailWorkflow = workflowDef("mail-intake");
  const reconcilers = { "document.stamp": documentHost.reconcilerFor("document.stamp"), "email.send": emailHost.reconcilerFor("email.send") };
  const shared = { transport, journal, review, audit, clock, actorId: profile.roles.orchestrator, reconcilers };
  const orchestrator = new Orchestrator({ workflow, ...shared });
  const mailOrchestrator = new Orchestrator({ workflow: mailWorkflow, ...shared });
  // One orchestrator per definition and version (`name@version`), the latest also under `name`; running instances stay pinned (WF-VER-001).
  const orchestrators: Record<string, Orchestrator> = {};
  const byDef = new Map<WorkflowDef, Orchestrator>([[workflow, orchestrator], [mailWorkflow, mailOrchestrator]]);
  for (const [key, def] of Object.entries(WORKFLOW_DEFINITIONS)) {
    let orch = byDef.get(def);
    if (!orch) {
      orch = new Orchestrator({ workflow: def, ...shared });
      byDef.set(def, orch);
    }
    orchestrators[key] = orch;
  }

  return {
    installation,
    clock,
    audit,
    artifacts,
    keyPair,
    keyRegistry,
    signer,
    identities,
    gateway,
    transport,
    credentials: documentCredentials,
    emailCredentials,
    host: documentHost,
    emailHost,
    ingestHost,
    dms,
    registry,
    archive,
    smtp,
    models,
    recipients,
    router,
    journal,
    review,
    workflow,
    mailWorkflow,
    orchestrator,
    mailOrchestrator,
    orchestrators,
  };
}

export type Slice = ReturnType<typeof createSlice>;

/** Build a well-formed command the way the orchestrator would, for direct router tests. */
export function command(
  slice: Slice,
  input: { capability: string; payload: Record<string, unknown>; version?: string; idempotencyKey?: string; correlationId?: string; deadlineMs?: number; type?: "command" | "query" | "event" },
): MessageEnvelope {
  const now = slice.clock.now();
  const m: MessageEnvelope = {
    messageId: newId("msg"),
    correlationId: input.correlationId ?? newId("cor"),
    type: input.type ?? "command",
    capability: input.capability,
    capabilityVersion: input.version ?? "1",
    schemaVersion: "1",
    createdAt: iso(now),
    payload: input.payload,
  };
  if (m.type === "command") {
    m.idempotencyKey = input.idempotencyKey ?? newId("key");
    m.notValidAfter = iso(plus(now, input.deadlineMs ?? slice.workflow.deadlineMs));
  }
  return m;
}
