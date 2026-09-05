// Composition root of the first slice. The only place that knows every concrete class; tests build the world from here.
import { join } from "node:path";
import { FakeArchiveAdapter } from "./adapters/archive.js";
import { FakeDmsAdapter } from "./adapters/dms.js";
import { FakeLlmAdapter, KeywordClassifierAdapter, type LlmAdapter } from "./adapters/llm.js";
import { FakeRegistryAdapter } from "./adapters/registry.js";
import * as classifier from "./components/document-classifier/handler.js";
import * as validator from "./components/document-validator/handler.js";
import * as host from "./components/document-executor-host/stamp-handler.js";
import { createArchiveHandler, ARCHIVE_CREDENTIAL, ARCHIVE_HANDLER_ID, type ArchiveDeps } from "./components/document-executor-host/archive-handler.js";
import { ArtifactStore } from "./platform/artifacts.js";
import { Audit } from "./platform/audit.js";
import { FakeClock, iso, plus } from "./platform/clock.js";
import { CredentialResolver } from "./platform/credentials.js";
import { ExecutorHost, type HostHandlerSpec, type HostMutants } from "./platform/executor-host.js";
import { Gateway, IdentityProvider, type Identity } from "./platform/gateway.js";
import { newId } from "./platform/ids.js";
import { Journal } from "./platform/journal.js";
import { Orchestrator, type WorkflowDef } from "./platform/orchestrator.js";
import { loadPolicy } from "./platform/policy.js";
import { ReviewService } from "./platform/review.js";
import { Router } from "./platform/router.js";
import { loadJson, projectRoot } from "./platform/schemas.js";
import { generateKeyPair, KeyRegistry, Signer } from "./platform/signing.js";
import type { MessageEnvelope } from "./platform/types.js";

export const TENANT_A = "tenant-42";
export const TENANT_B = "tenant-7";
export const ORCHESTRATOR = "svc-orchestrator";
export const ORCHESTRATOR_B = "svc-orchestrator-t7";
export const AI_AGENT = "ai-doc-classifier";
export const DEFAULT_CLOCK_START = "2026-09-06T08:00:00Z";
export const ALL_SCOPES = ["document.classify", "document.validate", "document.stamp", "document.archive"];

export const IDENTITIES: Identity[] = [
  { actorId: ORCHESTRATOR, actorType: "service", tenantId: TENANT_A, scopes: ALL_SCOPES, authStrength: "client-credentials" },
  { actorId: ORCHESTRATOR_B, actorType: "service", tenantId: TENANT_B, scopes: ALL_SCOPES, authStrength: "client-credentials" },
  // The AI identity holds exactly one scope. No policy grants it a write capability (F1).
  { actorId: AI_AGENT, actorType: "ai-agent", tenantId: TENANT_A, scopes: ["document.classify"], authStrength: "client-credentials" },
];

export interface SliceOptions {
  clockStart?: string;
  journalFile?: string;
  auditFile?: string;
  /** Durable stores can be shared between two slices to simulate a restart (RES-CRASH-001). */
  artifacts?: ArtifactStore;
  dms?: FakeDmsAdapter;
  registry?: FakeRegistryAdapter;
  archive?: FakeArchiveAdapter;
  models?: Record<string, LlmAdapter>;
  contextTtlMs?: number;
  modelTimeoutMs?: number;
  registryTimeoutMs?: number;
  hostMutants?: HostMutants;
  /** Replace the archive handler (test harness: rogue handler for SEC-HOST-001). */
  archiveHandler?: (deps: ArchiveDeps) => HostHandlerSpec;
  workflow?: WorkflowDef;
}

export function loadWorkflow(name = "document-intake.v1"): WorkflowDef {
  return loadJson<WorkflowDef>(join(projectRoot, "workflows", `${name}.json`));
}

export function createSlice(o: SliceOptions = {}) {
  const clock = new FakeClock(o.clockStart ?? DEFAULT_CLOCK_START);
  const audit = new Audit(clock, o.auditFile);
  const artifacts = o.artifacts ?? new ArtifactStore(clock);

  // Gateway with Ed25519 key k1; receivers hold only the public key.
  const keyPair = generateKeyPair();
  const keyRegistry = new KeyRegistry();
  keyRegistry.add({ keyId: "k1", publicKey: keyPair.publicKey, validFrom: iso(clock.now()) });
  const signer = new Signer("k1", keyPair.privateKey);
  const identities = new IdentityProvider(IDENTITIES);
  const gateway = new Gateway({ identities, signer, clock, ...(o.contextTtlMs !== undefined ? { contextTtlMs: o.contextTtlMs } : {}) });

  // Adapters (fakes) and credentials: one table row per handler identity (CredentialResolverFixture, VC §6).
  const dms = o.dms ?? new FakeDmsAdapter();
  const registry = o.registry ?? new FakeRegistryAdapter();
  const archive = o.archive ?? new FakeArchiveAdapter();
  const models = o.models ?? { llm: new FakeLlmAdapter(), keyword: new KeywordClassifierAdapter() };
  const credentials = new CredentialResolver(
    {
      [host.STAMP_HANDLER_ID]: { [host.STAMP_CREDENTIAL]: "dms-secret" },
      [ARCHIVE_HANDLER_ID]: { [ARCHIVE_CREDENTIAL]: "archive-secret" },
    },
    audit,
  );

  // Executor host: two LOGICAL handlers in one process.
  const executorHost = new ExecutorHost({ hostId: host.descriptor.module, clock, audit, credentials });
  Object.assign(executorHost.mutants, o.hostMutants ?? {});
  executorHost.register(host.createStampHandler({ artifacts, dms, credentials, clock }));
  executorHost.register((o.archiveHandler ?? createArchiveHandler)({ artifacts, archive, credentials, clock }));

  // Router: descriptors validated against the frozen schema, policies loaded fail-closed.
  const router = new Router({ registry: keyRegistry, clock, audit });
  router.register({
    descriptor: classifier.descriptor as never,
    policies: { "document.classify": loadPolicy("document.classify", "1") },
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
    policies: { "document.validate": loadPolicy("document.validate", "1") },
    capabilities: [
      {
        name: "document.validate",
        version: "1",
        inputSchema: validator.inputSchema,
        handler: validator.createDocumentValidator({ artifacts, registry, clock, ...(o.registryTimeoutMs !== undefined ? { registryTimeoutMs: o.registryTimeoutMs } : {}) }),
      },
    ],
  });
  router.register({
    descriptor: host.descriptor as never,
    policies: { "document.stamp": loadPolicy("document.stamp", "1"), "document.archive": loadPolicy("document.archive", "1") },
    capabilities: [
      { name: "document.stamp", version: "1", inputSchema: host.stampInputSchema, handler: executorHost.handlerFor("document.stamp") },
      { name: "document.archive", version: "1", inputSchema: host.archiveInputSchema, handler: executorHost.handlerFor("document.archive") },
    ],
  });

  const journal = new Journal(o.journalFile);
  const review = new ReviewService(clock, audit);
  const workflow = o.workflow ?? loadWorkflow();
  const orchestrator = new Orchestrator({
    workflow,
    gateway,
    router,
    journal,
    review,
    audit,
    clock,
    actorId: ORCHESTRATOR,
    reconcilers: { "document.stamp": executorHost.reconcilerFor("document.stamp") },
  });

  return { clock, audit, artifacts, keyPair, keyRegistry, signer, identities, gateway, credentials, host: executorHost, dms, registry, archive, models, router, journal, review, workflow, orchestrator };
}

export type Slice = ReturnType<typeof createSlice>;

/** Build a well-formed command the way the orchestrator would, for direct router tests. */
export function command(slice: Slice, input: { capability: string; payload: Record<string, unknown>; version?: string; idempotencyKey?: string; correlationId?: string; deadlineMs?: number; type?: "command" | "query" | "event" }): MessageEnvelope {
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
