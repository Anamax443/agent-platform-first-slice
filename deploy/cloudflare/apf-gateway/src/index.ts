// apf-gateway: intake + one Durable Object per workflow instance, with the platform wired inside the object
// (units A, A2, B of step 2 in docs/NAVRHOVY-LIST-farma.md): a document handed in through the page (behind Cloudflare
// Access) becomes an immutable original (text in the object, binary in R2 keyed by sha256), a binary original is turned
// into a text derivation with provenance by Workers AI (toMarkdown), a workflow instance starts in its own Durable
// Object (SQLite = journal, audit, artifacts; R2 and D1 get async copies) and the orchestrator dispatches through the
// signed gateway -> router path: document.classify with the installation's models (chosen per document) and
// document.validate (registry = the apf-fakes double over a service binding, unit C) run here; hosts (stamp, archive,
// mail, e-mail) stay "not wired" until their units land.
// The installation (profile + policies) comes from the build-time alias apf:installation and is assembled fail-closed at
// import. Nothing installation-bound is written here; secrets are named, never valued.
import { DurableObject } from "cloudflare:workers";
import { MATICE_ODPOVEDNOSTI_HTML, VYVOJOVY_DIAGRAM_EN_HTML, VYVOJOVY_DIAGRAM_HTML } from "apf:docs";
import { INSTALLATION, installation } from "apf:installation";
import { FAKES_ORIGIN, HttpRegistryAdapter } from "../../../../src/adapters/registry.js";
import type { WorkersAiBinding } from "../../../../src/adapters/workers-ai.js";
import type { SecretsSource } from "../../../../src/installation.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import { sha256Bytes, type Artifact } from "../../../../src/platform/artifacts.js";
import { iso, SystemClock, type Clock } from "../../../../src/platform/clock.js";
import { platformError } from "../../../../src/platform/errors.js";
import { newId } from "../../../../src/platform/ids.js";
import { Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import type { Instance } from "../../../../src/platform/journal.js";
import { ReviewService, type Decision } from "../../../../src/platform/review.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_NAMES, workflowDef } from "../../../../src/platform/workflow.js";
import { renderError, renderFarm, renderHome, renderInstance, renderSelfTest, type AuditLogRow, type FarmInstanceRow, type FarmStats, type InboxItem, type InstanceView, type ModelsInfo, type SelfTestRow, type Wired } from "./page.js";
import { describeModels, wirePlatform, type Wiring } from "./platform-wiring.js";
import { runSelfTest, SELF_TEST_WORKFLOW_ID } from "./self-test.js";
import { D1_AUDIT_DDL, DDL, SqliteArtifacts, SqliteAudit, SqliteJournal, SqliteReviewTaskStore } from "./store.js";
import { visuallyStamp } from "./visual-stamp.js";

export interface Env {
  WORKFLOW: DurableObjectNamespace<WorkflowInstance>;
  AUDIT: D1Database;
  ARTIFACTS: R2Bucket;
  AI: Ai;
  IMAGES: ImagesBinding;
  /** Set by config/<installation>/farm.json (apf-gateway.vars): public Google Fonts URL used to render the visual stamp text. */
  STAMP_FONT_URL: string;
  DOCUMENT_HOST: Fetcher;
  EMAIL_EXECUTOR: Fetcher;
  MAIL_INGEST: Fetcher;
  FAKES: Fetcher;
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
  /** Set by scripts/farm-config.mjs: short commit hash of the checkout the bundle was generated from. */
  GIT_SHA: string;
  KILL_SWITCH: string;
  SIGNING_KEY_ID: string;
  CONTRACTS_VERSION: string;
  WORKFLOW_DEADLINE_MS: string;
  /** Secrets (wrangler secret put): values never appear in any file of this repo. */
  GATEWAY_SIGNING_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DMS_SECRET?: string;
  ARCHIVE_SECRET?: string;
}

/** Credential references of the profile -> names of the Worker secrets that carry their values. Names only. */
const SECRET_ENV_BY_REF: Record<string, keyof Env> = {
  "cred:anthropic": "ANTHROPIC_API_KEY",
  "cred:dms-stamp": "DMS_SECRET",
  "cred:archive-store": "ARCHIVE_SECRET",
};

const secretsOf =
  (env: Env): SecretsSource =>
  (ref) => {
    const name = SECRET_ENV_BY_REF[ref];
    const value = name ? env[name] : undefined;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

const signingMode = (env: Env): string => (env.GATEWAY_SIGNING_KEY ? "secret (Ed25519 PKCS8)" : installation.profile.channels.apiHost === null ? "ephemeral (in-process installation)" : "MISSING: set GATEWAY_SIGNING_KEY");

/** What this deployment can do. Read by /version, /health and the page; every unit of step 2 flips one entry. */
const wiredOf = (env: Env): Wired => ({
  intake: true,
  extract: "workers-ai toMarkdown (pdf, obrázky, docx) → derivace s provenancí",
  journal: "durable-object-sqlite",
  audit: "durable-object-sqlite + d1",
  artifacts: "durable-object-sqlite + r2",
  dispatch: true,
  gateway: "gateway + router v objektu instance: document.classify (modely z profilu, výběr per dokument), document.validate (registr přes service binding apf-fakes)",
  signing: signingMode(env),
  fakes: "apf-fakes přes service binding: registr zapojen do validate; DMS a archiv čekají na document-host (celek D); chaos přepínače v KV apf-chaos, náhled /chaos",
  hosts: false,
  accessJwtVerified: false,
});

const modelsOf = (env: Env): ModelsInfo => {
  try {
    return describeModels(installation, secretsOf(env));
  } catch (e) {
    return { error: String(e) };
  }
};

/** What the fakes deployable answers through its service binding (/version, /chaos). An error is data here, never a crash of the caller. */
const fakesInfo = async (env: Env, path = "/version"): Promise<{ status: number; body: unknown }> => {
  try {
    const r = await env.FAKES.fetch(`${FAKES_ORIGIN}${path}`);
    return { status: r.status, body: await r.json().catch(() => undefined) };
  } catch (e) {
    return { status: 0, body: { error: String(e) } };
  }
};

/** Same shape as fakesInfo, generalized for /farm: any bound deployable's /version, never thrown — a down Worker is a row, not a crash. */
const deployableInfo = async (fetcher: Fetcher, origin: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
  try {
    const r = await fetcher.fetch(`${origin}/version`);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => undefined) };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e) } };
  }
};

const MAX_TEXT_CHARS = 1_000_000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const EXTRACTOR = "workers-ai:toMarkdown";
const EXTRACT_CAPABILITY = "document.extract";

/** The original as the object receives it: text inline, or a binary that already sits in R2 (immutable, keyed by its hash). */
type Original =
  | { kind: "text"; bytes: string; contentType: string }
  | { kind: "external"; sha256: string; contentType: string; byteLength: number; location: string; name: string };

interface Extraction {
  text: string;
  format: string;
  tokens: number;
}

interface IntakeInput {
  workflowId: string;
  workflow: string;
  tenantId: string;
  receivedFrom: string;
  original: Original;
  /** Present for a binary original: the text Workers AI derived from it. */
  extraction?: Extraction;
  /** Key of one of the installation's models (form choice); absent = the installation's default. */
  model?: string;
  stampText?: string;
}

/** A capability no deployable serves yet ends as DEPENDENCY_UNAVAILABLE: an explicit, audited FAILED, never a pretended success. */
class NotWiredTransport {
  constructor(
    private readonly audit: SqliteAudit,
    private readonly clock: SystemClock,
  ) {}

  async dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope> {
    this.audit.append({
      kind: "dispatch",
      correlationId: message.correlationId,
      ...(message.workflowId ? { workflowId: message.workflowId } : {}),
      actorId,
      capability: message.capability,
      details: { wired: false, messageId: message.messageId },
    });
    return {
      messageId: newId("res"),
      inReplyTo: message.messageId,
      correlationId: message.correlationId,
      ...(message.workflowId ? { workflowId: message.workflowId } : {}),
      ...(message.stepId ? { stepId: message.stepId } : {}),
      status: "FAILED",
      capability: message.capability,
      capabilityVersion: message.capabilityVersion,
      schemaVersion: message.schemaVersion,
      completedAt: iso(this.clock.now()),
      error: platformError("DEPENDENCY_UNAVAILABLE", `capability ${message.capability} is not wired on this farm yet (design sheet, step 2)`),
    };
  }
}

let d1AuditReady: Promise<unknown> | undefined;
const ensureD1Audit = (db: D1Database): Promise<unknown> => (d1AuditReady ??= db.prepare(D1_AUDIT_DDL).run());

/** One Durable Object per workflow instance: its SQLite is the journal, the audit and the artifact store of that instance. */
export class WorkflowInstance extends DurableObject<Env> {
  private readonly clock = new SystemClock();
  private readonly journal: SqliteJournal;
  private readonly audit: SqliteAudit;
  private readonly artifacts: SqliteArtifacts;
  private readonly reviewStore: SqliteReviewTaskStore;
  private wiringCache: Wiring | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const stmt of DDL) ctx.storage.sql.exec(stmt);
    this.journal = new SqliteJournal(ctx.storage.sql);
    this.audit = new SqliteAudit(ctx.storage.sql, this.clock);
    this.artifacts = new SqliteArtifacts(ctx.storage.sql, this.clock);
    this.reviewStore = new SqliteReviewTaskStore(ctx.storage.sql);
  }

  /** Built on first use so that a broken wiring (missing secret) fails the intake with a message, not the object. */
  private wiring(): Wiring {
    const notWired = new NotWiredTransport(this.audit, this.clock);
    this.wiringCache ??= wirePlatform({
      installation,
      secrets: secretsOf(this.env),
      ai: this.env.AI as unknown as WorkersAiBinding,
      registry: new HttpRegistryAdapter(this.env.FAKES),
      documentHost: this.env.DOCUMENT_HOST,
      artifacts: this.artifacts,
      audit: this.audit,
      clock: this.clock,
      keyId: this.env.SIGNING_KEY_ID,
      signingKeyPem: this.env.GATEWAY_SIGNING_KEY,
      notWired: (m, a) => notWired.dispatch(m, a),
    });
    return this.wiringCache;
  }

  async intake(input: IntakeInput): Promise<InstanceView> {
    if (this.journal.list().length > 0) throw new Error(`instance ${input.workflowId} already exists`);
    const wiring = this.wiring();
    const o = input.original;
    const original =
      o.kind === "text"
        ? this.artifacts.put({ tenantId: input.tenantId, bytes: o.bytes, receivedFrom: input.receivedFrom, contentType: o.contentType })
        : this.artifacts.putExternal({ tenantId: input.tenantId, receivedFrom: input.receivedFrom, sha256: o.sha256, contentType: o.contentType, byteLength: o.byteLength, location: o.location, name: o.name });

    // A binary original never reaches a capability: the workflow runs over the text derived from it (provenance = derivedFrom + producer).
    let subject = original;
    if (input.extraction) {
      this.audit.append({ kind: "write-intent", workflowId: input.workflowId, tenantId: input.tenantId, capability: EXTRACT_CAPABILITY, details: { originalId: original.artifactId, producer: EXTRACTOR } });
      subject = this.artifacts.derive(original.artifactId, input.extraction.text, EXTRACTOR, input.extraction.format === "markdown" ? "text/markdown" : "text/plain");
      this.audit.append({
        kind: "write-done",
        workflowId: input.workflowId,
        tenantId: input.tenantId,
        capability: EXTRACT_CAPABILITY,
        details: { status: "SUCCEEDED", artifactId: subject.artifactId, sha256: subject.sha256, tokens: input.extraction.tokens, format: input.extraction.format, chars: input.extraction.text.length },
      });
    }

    const orchestrator = this.orchestratorFor(workflowDef(input.workflow), wiring);
    const inst = orchestrator.start(
      { tenantId: input.tenantId, artifactId: subject.artifactId, ...(input.model ? { model: input.model } : {}), ...(input.stampText ? { stampText: input.stampText } : {}) },
      undefined,
      input.workflowId,
    );
    this.audit.append({
      kind: "state",
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      tenantId: inst.tenantId,
      details: {
        status: "RUNNING",
        receivedFrom: input.receivedFrom,
        originalId: original.artifactId,
        artifactId: subject.artifactId,
        sha256: original.sha256,
        contentType: original.contentType,
        ...(input.model ? { model: input.model } : {}),
        signing: wiring.signing,
        keyId: wiring.keyId,
      },
    });
    await orchestrator.run(inst.workflowId);
    this.recordClassifyResult(input.workflowId, input.tenantId, inst.correlationId);
    this.ctx.waitUntil(this.copyOut());
    this.ctx.waitUntil(this.visualStampIfApplicable(original, input.workflowId));
    return this.view() as InstanceView;
  }

  /**
   * document.classify has sideEffects: none, so it never gets a write-intent/write-done pair (that pattern is only
   * for proving idempotent writes happened) — its result lived only inside this one Durable Object, unreadable in
   * bulk across instances. Owner's request 2026-09-07 ("kolik zpracováno, jaké agendy" dashboard on /farm): mirror
   * the result into the shared audit trail too, under the existing "state" kind (there is no dedicated kind for a
   * read-only capability's result, and adding one is a bigger norm change than this needs), tagged with
   * capability so it's distinguishable from the instance-level RUNNING/SUCCEEDED "state" records.
   */
  private recordClassifyResult(workflowId: string, tenantId: string, correlationId: string): void {
    const inst = this.journal.get(workflowId);
    const step = inst?.steps.find((s) => s.capability === "document.classify" && s.status === "SUCCEEDED");
    const payload = step?.result?.payload as { documentType?: { value?: unknown; confidence?: unknown; source?: unknown } } | undefined;
    if (!payload?.documentType?.value) return;
    this.audit.append({
      kind: "state",
      workflowId,
      tenantId,
      correlationId,
      capability: "document.classify",
      details: { status: "SUCCEEDED", documentType: payload.documentType.value, confidence: payload.documentType.confidence, source: payload.documentType.source },
    });
  }

  /**
   * Additive visual stamp on the original binary (owner's decision 2026-09-07: "vedle sebe", not instead of the
   * existing text-based DMS write). Only runs when document.stamp actually succeeded and the original is a format
   * visual-stamp.ts knows how to handle (PDF, JPG, PNG) — never blocks or changes the outcome of the workflow itself.
   */
  private async visualStampIfApplicable(original: Artifact, workflowId: string): Promise<void> {
    if (!original.location) return; // text intake: nothing to stamp visually
    const inst = this.journal.get(workflowId);
    const stampStep = inst?.steps.find((s) => s.capability === "document.stamp" && s.status === "SUCCEEDED");
    if (!stampStep) return;
    const payload = stampStep.result?.payload as { dmsRef?: unknown } | undefined;
    const dmsRef = typeof payload?.dmsRef === "string" ? payload.dmsRef : "unknown";
    try {
      const obj = await this.env.ARTIFACTS.get(original.location);
      if (!obj) return;
      const bytes = await obj.arrayBuffer();
      const stamped = await visuallyStamp(bytes, original.contentType ?? "application/octet-stream", { label: "ZPRACOVANO", at: iso(this.clock.now()), ref: dmsRef }, this.env.IMAGES, this.env.STAMP_FONT_URL);
      if (!stamped) return; // content type has no visual-stamp recipe yet
      // Keyed by workflowId, not by content hash: two documents that happen to share bytes (a re-upload of the
      // same PDF, a duplicate inbox pick-up) are still two separate instances and must not overwrite each other's
      // stamp — found live 2026-09-08, /original-stamped of one instance was serving the other's stamped image.
      const key = `stamped-visual/${original.tenantId}/${workflowId}`;
      await this.env.ARTIFACTS.put(key, stamped.bytes, { httpMetadata: { contentType: stamped.contentType } });
      console.log(`[apf-gateway] visual stamp written workflowId=${workflowId} key=${key}`);
    } catch (e) {
      console.error(`[apf-gateway] visual stamp failed workflowId=${workflowId}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  /**
   * Live self-test (owner's request 2026-09-08): runs document.classify + document.validate's conformance fixtures
   * against this Worker's real wiring. Deliberately bypasses intake()/orchestratorFor() — a single capability call
   * via wiring.transport.dispatch(), the same primitive the orchestrator itself uses per step, no journal entry, no
   * workflow instance created (this DO's own "self-test" identity never shows up in "Poslední instance").
   */
  async selfTest(): Promise<SelfTestRow[]> {
    return runSelfTest({
      transport: this.wiring().transport,
      artifacts: this.artifacts,
      clock: this.clock,
      defaultActor: installation.profile.roles.orchestrator,
      deadlineMs: 60_000,
    });
  }

  view(): InstanceView | null {
    const inst = this.journal.list()[0];
    if (!inst) return null;
    return { workflowId: inst.workflowId, installation: INSTALLATION, instance: inst, artifacts: this.artifacts.list(), audit: [...this.audit.all()] };
  }

  /**
   * Read-only artifact access for a remote executor host (celek D2): the instance object is the only place that has the
   * bytes, so a host pre-fetches this over the GATEWAY service binding before it runs its own synchronous Router.
   * No tenant check beyond "found in this instance": the instance object itself is already scoped to one tenant.
   */
  artifact(artifactId: string): { artifactId: string; tenantId: string; sha256: string; bytes: string; contentType?: string } | null {
    const a = this.artifacts.get(artifactId);
    return a ? { artifactId: a.artifactId, tenantId: a.tenantId, sha256: a.sha256, bytes: a.bytes, ...(a.contentType ? { contentType: a.contentType } : {}) } : null;
  }

  /**
   * Remove the instance and every artifact it holds (retention, or test data on the owner's request): R2 objects,
   * then the object's whole storage. The shared D1 trail keeps its append-only records and gets one more: PURGED.
   */
  async purge(by: string, reason: string): Promise<{ workflowId: string; artifacts: number; r2Deleted: number }> {
    const inst = this.journal.list()[0];
    if (!inst) throw new Error("no instance in this object");
    const artifacts = this.artifacts.list();
    let r2Deleted = 0;
    for (const a of artifacts) {
      const key = a.location ?? `${a.derivedFrom ? "derived" : "originals"}/${a.tenantId}/${a.sha256}`;
      if (await this.env.ARTIFACTS.head(key)) {
        await this.env.ARTIFACTS.delete(key);
        r2Deleted += 1;
      }
    }
    await ensureD1Audit(this.env.AUDIT);
    const record = {
      auditId: newId("aud"),
      at: iso(this.clock.now()),
      kind: "state",
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      tenantId: inst.tenantId,
      actorId: by,
      details: { status: "PURGED", reason, artifacts: artifacts.length, r2Deleted, previousStatus: inst.status },
    };
    await this.env.AUDIT.prepare("INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(record.auditId, record.at, record.kind, record.correlationId, record.workflowId, record.tenantId, record.actorId, null, JSON.stringify(record))
      .run();
    await this.ctx.storage.deleteAll();
    // deleteAll drops the tables too; the object may stay alive, so bring the (empty) schema back for the next call.
    for (const stmt of DDL) this.ctx.storage.sql.exec(stmt);
    return { workflowId: inst.workflowId, artifacts: artifacts.length, r2Deleted };
  }

  private orchestratorFor(def: WorkflowDef, wiring: Wiring): Orchestrator {
    return new Orchestrator({
      workflow: def,
      transport: wiring.transport,
      journal: this.journal,
      review: new ReviewService(this.clock, this.audit, this.reviewStore),
      audit: this.audit,
      clock: this.clock,
      actorId: installation.profile.roles.orchestrator,
    });
  }

  /**
   * The missing decision path (found 2026-09-08, docs/OPONENTURA-BEZPECNOST-STABILITA.md #1): a human can now
   * actually resolve a WAITING(REVIEW) instance instead of it staying stuck forever. Reuses the orchestrator's own
   * resumeAfterReview() as-is (already tested, WF-REV-003/004) — the only thing missing was a durable place for the
   * review task to live between the request that created it and the request that decides it (now `this.reviewStore`).
   */
  async decideReview(reviewTaskId: string, decision: Decision, actorId: string, correctedType?: string): Promise<Instance> {
    const inst = this.journal.list()[0];
    if (!inst) throw new Error("no instance in this object");
    const task = this.reviewStore.get(reviewTaskId);
    if (!task) throw new Error(`review task ${reviewTaskId} not found`);
    // Always the same top-level correction field regardless of which step is waiting: the workflow definition
    // (document-intake.v2.json) maps $input.documentType to each step's own expected payload key itself — classify
    // reads it as `documentType`, validate's own `inputs` mapping renames it to `correctedDocumentType` for its
    // handler. decideReview() does not need to know which step it is.
    const correction = correctedType ? { documentType: correctedType } : undefined;
    const review = new ReviewService(this.clock, this.audit, this.reviewStore);
    const result = review.decide(reviewTaskId, { actorId, role: task.requiredRole, tenantId: task.tenantId, decision, ...(correction ? { correction } : {}) });
    if (!result.ok) throw new Error(`review decision rejected: ${result.code}`);
    const wiring = this.wiring();
    const orchestrator = this.orchestratorFor(workflowDef(inst.workflow), wiring);
    const updated = await orchestrator.resumeAfterReview(inst.workflowId, reviewTaskId);
    this.ctx.waitUntil(this.copyOut());
    const original = this.artifacts.list().find((a) => !a.derivedFrom);
    if (original) this.ctx.waitUntil(this.visualStampIfApplicable(original, inst.workflowId));
    return updated;
  }

  /** Text artifacts to R2 (immutable, keyed by tenant + sha256) and audit records to the shared D1 trail. Idempotent. */
  private async copyOut(): Promise<void> {
    for (const a of this.artifacts.uncopied()) {
      const key = `${a.derivedFrom ? "derived" : "originals"}/${a.tenantId}/${a.sha256}`;
      if (!(await this.env.ARTIFACTS.head(key))) {
        await this.env.ARTIFACTS.put(key, a.bytes, {
          httpMetadata: { contentType: a.contentType ?? "text/plain; charset=utf-8" },
          customMetadata: { artifactId: a.artifactId, receivedFrom: a.receivedFrom, receivedAt: a.receivedAt, ...(a.derivedFrom ? { derivedFrom: a.derivedFrom } : {}) },
        });
      }
      this.artifacts.markCopied(a.artifactId);
    }
    const pending = this.audit.unmirrored();
    if (pending.length === 0) return;
    await ensureD1Audit(this.env.AUDIT);
    const insert = this.env.AUDIT.prepare(
      "INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await this.env.AUDIT.batch(
      pending.map((r) => insert.bind(r.auditId, r.at, r.kind, r.correlationId ?? null, r.workflowId ?? null, r.tenantId ?? null, r.actorId ?? null, r.capability ?? null, JSON.stringify(r))),
    );
    this.audit.markMirrored(pending.map((r) => r.auditId));
  }
}

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** One row of /farm's instance list: the real instance from its own Durable Object, or a PURGED placeholder if the journal is gone. */
const farmRowOf = async (env: Env, workflowId: string, lastAt: string): Promise<FarmInstanceRow> => {
  const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
  // stub.view()'s RPC-inferred return type collapses the InstanceView|null union to just null (workers-types quirk,
  // same category as HANDOFF (16)'s "RPC návrat je & Disposable"); cast to what the class method actually declares.
  const view = (await stub.view()) as InstanceView | null;
  if (!view) return { workflowId, purged: true, at: lastAt };
  const i = view.instance;
  const original = view.artifacts.find((a) => !a.derivedFrom);
  return {
    workflowId,
    workflow: i.workflow,
    workflowVersion: i.workflowVersion,
    tenantId: i.tenantId,
    actorId: i.actorId,
    status: i.status,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    steps: i.steps,
    ...(original?.name ? { originalName: original.name } : {}),
    ...(original?.byteLength !== undefined ? { originalByteLength: original.byteLength } : {}),
  };
};

/** "24h"/"7d"/"30d" -> ISO cutoff from the given clock; anything else (missing, "all") -> no cutoff, full history. */
const WINDOW_MS: Record<string, number> = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000 };
export const windowSince = (window: string | null, clock: Clock): string | undefined => {
  const ms = window ? WINDOW_MS[window] : undefined;
  return ms === undefined ? undefined : iso(new Date(clock.now().getTime() - ms));
};

/** The most recently active workflow ids (D1, cheap) — then each instance's real steps[] straight from its own Durable Object (the DO journal is the source of truth, not the audit relay). Owner's request 2026-09-08: "kolik dokumentů a nebo časové okno" — both are just narrower reads over the same query, nothing else changes. */
const recentInstances = async (env: Env, limit = 15, sinceIso?: string): Promise<FarmInstanceRow[]> => {
  await ensureD1Audit(env.AUDIT);
  // SELF_TEST_WORKFLOW_ID excluded: apf-document-host relays document.stamp/document.archive self-test dispatches
  // to this same shared audit trail (RelayAudit -> POST /audit, writes unconditionally) — without this filter a
  // self-test run shows up here as a fake, journal-less "PURGED" document (found live 2026-09-08).
  const sql = `SELECT workflow_id, MAX(at) AS last_at FROM audit WHERE workflow_id IS NOT NULL AND workflow_id != ?${sinceIso ? " AND at >= ?" : ""} GROUP BY workflow_id ORDER BY last_at DESC LIMIT ?`;
  const stmt = sinceIso ? env.AUDIT.prepare(sql).bind(SELF_TEST_WORKFLOW_ID, sinceIso, limit) : env.AUDIT.prepare(sql).bind(SELF_TEST_WORKFLOW_ID, limit);
  const rows = await stmt.all<{ workflow_id: string; last_at: string }>();
  return Promise.all(rows.results.map((r) => farmRowOf(env, r.workflow_id, r.last_at)));
};

/** The "deník": the shared audit trail as-is, same source as /audit.json, newest first. */
const auditLog = async (env: Env, limit = 50): Promise<AuditLogRow[]> => {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare("SELECT json FROM audit ORDER BY at DESC LIMIT ?").bind(limit).all<{ json: string }>();
  return rows.results.map((r) => {
    const full = JSON.parse(r.json) as AuditRecord;
    return { at: full.at, kind: full.kind, workflowId: full.workflowId ?? null, tenantId: full.tenantId ?? null, capability: full.capability ?? null, details: full.details };
  });
};

/**
 * Přehled dashboard (owner's request, 2026-09-07: "kolik zpracováno celkem, kolik dnes, kolik to zabírá, jaké
 * agendy"). Reads the shared D1 audit trail directly with SQL, not per-instance Durable Object calls — the same
 * "state" (capability IS NULL) records already written for every instance's RUNNING/SUCCEEDED transitions, plus the
 * document.classify result mirrored there by recordClassifyResult() (added the same day, for exactly this).
 */
const farmStats = async (env: Env): Promise<FarmStats> => {
  await ensureD1Audit(env.AUDIT);
  const succeededFilter = `kind = 'state' AND capability IS NULL AND json_extract(json, '$.details.status') = 'SUCCEEDED'`;
  const [totalRow, todayRow, typeRows, durationRows] = await Promise.all([
    env.AUDIT.prepare(`SELECT COUNT(*) as n FROM audit WHERE ${succeededFilter}`).first<{ n: number }>(),
    env.AUDIT.prepare(`SELECT COUNT(*) as n FROM audit WHERE ${succeededFilter} AND substr(at, 1, 10) = date('now')`).first<{ n: number }>(),
    env.AUDIT.prepare(
      `SELECT json_extract(json, '$.details.documentType') as type, COUNT(*) as n FROM audit WHERE kind = 'state' AND capability = 'document.classify' GROUP BY type ORDER BY n DESC`,
    ).all<{ type: string | null; n: number }>(),
    env.AUDIT.prepare(
      `SELECT workflow_id,
         MIN(CASE WHEN json_extract(json, '$.details.status') = 'RUNNING' THEN at END) as started,
         MAX(CASE WHEN json_extract(json, '$.details.status') = 'SUCCEEDED' THEN at END) as ended
       FROM audit WHERE kind = 'state' AND capability IS NULL GROUP BY workflow_id HAVING started IS NOT NULL AND ended IS NOT NULL`,
    ).all<{ workflow_id: string; started: string; ended: string }>(),
  ]);
  const durations = durationRows.results.map((r) => Date.parse(r.ended) - Date.parse(r.started)).filter((n) => Number.isFinite(n) && n >= 0);
  return {
    totalProcessed: totalRow?.n ?? 0,
    processedToday: todayRow?.n ?? 0,
    avgProcessingMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    byType: typeRows.results.map((r) => ({ type: r.type ?? "?", count: r.n })),
  };
};

/** Who handed the document in, as data: the Access-authenticated e-mail, or the service token path. JWT verification is a later unit. */
const receivedFrom = (request: Request): string => {
  const email = request.headers.get("cf-access-authenticated-user-email");
  return email ? `access:${email}` : "access:service-token";
};

/** Documents handed in through the page belong to the tenant of the orchestrator identity (profile, not code). */
const intakeTenant = (): string => {
  const id = installation.profile.identities.find((i) => i.actorId === installation.profile.roles.orchestrator);
  if (!id) throw new Error("orchestrator identity missing");
  return id.tenantId;
};

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  eml: "message/rfc822",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  // ISDOC (Czech e-invoice standard, isdoc.cz): structured XML, read by code, never by a model.
  isdoc: "application/xml",
};

const contentTypeOf = (name: string, type: string): string => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return type && type !== "application/octet-stream" ? type : (BY_EXTENSION[ext] ?? "application/octet-stream");
};

const isText = (contentType: string): boolean =>
  contentType.startsWith("text/") || contentType === "message/rfc822" || contentType === "application/json" || contentType === "application/xml";

const homeModel = (request: Request, env: Env) => ({ installation: INSTALLATION, user: receivedFrom(request), workflows: [...WORKFLOW_NAMES], wired: wiredOf(env), models: modelsOf(env) });

interface IntakeRequest {
  workflow: string;
  tenantId: string;
  receivedFrom: string;
  modelKey?: string;
  stampText?: string;
  content: { kind: "text"; bytes: string; contentType: string } | { kind: "binary"; buf: ArrayBuffer; name: string; contentType: string };
}
type IntakeOutcome = { ok: true; workflowId: string } | { ok: false; code: string; message: string; detail?: Record<string, unknown> };

/**
 * Everything /intake (the web form) does, minus the HTTP request/response shape — so the same fail-closed checks and
 * the same immutable-original/extraction/dispatch sequence run for a batch pulled from the R2 inbox (scheduled()) as
 * for someone clicking "Odeslat do toku". No second, drifting copy of this logic.
 */
async function startIntake(env: Env, req: IntakeRequest): Promise<IntakeOutcome> {
  if (env.KILL_SWITCH === "true") return { ok: false, code: "KILL_SWITCH", message: "Farma je vypnutá (KILL_SWITCH)." };
  if (!WORKFLOW_NAMES.includes(req.workflow)) return { ok: false, code: "UNKNOWN_WORKFLOW", message: `Neznámý tok ${req.workflow}.` };

  const models = modelsOf(env);
  if ("error" in models) return { ok: false, code: "NO_MODEL", message: "Instalace nemá použitelný výchozí model; tok se nespustí (nikdy bez modelu).", detail: { error: models.error } };
  if (req.modelKey) {
    const choice = models.choices.find((c) => c.key === req.modelKey);
    if (!choice) return { ok: false, code: "UNKNOWN_MODEL", message: "Klíč modelu není v seznamu instalace.", detail: { model: req.modelKey } };
    if (choice.unavailable) return { ok: false, code: "MODEL_UNAVAILABLE", message: choice.unavailable, detail: { model: req.modelKey } };
  }

  let original: Original;
  let extraction: Extraction | undefined;
  if (req.content.kind === "binary") {
    const { buf, name, contentType } = req.content;
    const digest = sha256Bytes(new Uint8Array(buf));
    const location = `originals/${req.tenantId}/${digest}`;
    if (!(await env.ARTIFACTS.head(location))) {
      await env.ARTIFACTS.put(location, buf, { httpMetadata: { contentType }, customMetadata: { name, receivedFrom: req.receivedFrom, receivedAt: new Date().toISOString() } });
    }
    original = { kind: "external", sha256: digest, contentType, byteLength: buf.byteLength, location, name };
    let converted: ConversionResponse;
    try {
      converted = await env.AI.toMarkdown({ name, blob: new Blob([buf], { type: contentType }) });
    } catch (e) {
      return { ok: false, code: "EXTRACTION_FAILED", message: "Workers AI konverzi neprovedla; originál je uložený, tok nebyl spuštěn.", detail: { sha256: digest, contentType, error: String(e) } };
    }
    if (converted.format === "error") {
      return { ok: false, code: "EXTRACTION_FAILED", message: "Workers AI soubor odmítla; originál je uložený, tok nebyl spuštěn.", detail: { sha256: digest, contentType, error: converted.error } };
    }
    if (!converted.data.trim()) {
      return { ok: false, code: "EXTRACTION_EMPTY", message: "Workers AI ze souboru nezískala žádný text; originál je uložený, tok nebyl spuštěn.", detail: { sha256: digest, contentType } };
    }
    extraction = { text: converted.data, format: converted.format, tokens: converted.tokens };
  } else {
    if (!req.content.bytes.trim()) return { ok: false, code: "EMPTY_TEXT", message: "Prázdný text." };
    original = { kind: "text", bytes: req.content.bytes, contentType: req.content.contentType };
  }
  if (original.kind === "text" && original.bytes.length > MAX_TEXT_CHARS) return { ok: false, code: "DOCUMENT_TOO_LARGE", message: "Dokument je moc dlouhý.", detail: { max: MAX_TEXT_CHARS } };
  if (extraction && extraction.text.length > MAX_TEXT_CHARS) extraction = { ...extraction, text: extraction.text.slice(0, MAX_TEXT_CHARS) };

  const workflowId = newId("wf");
  console.log(`[apf-gateway] intake start workflowId=${workflowId} workflow=${req.workflow} tenantId=${req.tenantId} from=${req.receivedFrom} model=${req.modelKey || "(default)"}`);
  const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
  const t0 = Date.now();
  try {
    await stub.intake({
      workflowId,
      workflow: req.workflow,
      tenantId: req.tenantId,
      receivedFrom: req.receivedFrom,
      original,
      ...(extraction ? { extraction } : {}),
      ...(req.modelKey ? { model: req.modelKey } : {}),
      ...(req.stampText ? { stampText: req.stampText } : {}),
    });
  } catch (e) {
    console.error(`[apf-gateway] intake wiring threw workflowId=${workflowId} (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { ok: false, code: "WIRING_FAILED", message: "Zapojení platformy v objektu instance selhalo (fail-closed); originál zůstal uložený.", detail: { workflowId, error: String(e) } };
  }
  console.log(`[apf-gateway] intake done workflowId=${workflowId} (${Date.now() - t0}ms)`);
  return { ok: true, workflowId };
}

const INTAKE_ERROR_STATUS: Record<string, number> = {
  KILL_SWITCH: 503,
  UNKNOWN_WORKFLOW: 400,
  NO_MODEL: 503,
  UNKNOWN_MODEL: 400,
  MODEL_UNAVAILABLE: 400,
  DOCUMENT_TOO_LARGE: 413,
  EXTRACTION_FAILED: 422,
  EXTRACTION_EMPTY: 422,
  EMPTY_TEXT: 400,
  WIRING_FAILED: 500,
};
const INTAKE_ERROR_TITLE: Record<string, string> = {
  KILL_SWITCH: "Farma je vypnutá",
  UNKNOWN_WORKFLOW: "Neznámý tok",
  NO_MODEL: "Modely nejsou k dispozici",
  UNKNOWN_MODEL: "Neznámý model",
  MODEL_UNAVAILABLE: "Model není dostupný",
  DOCUMENT_TOO_LARGE: "Dokument je příliš velký",
  EXTRACTION_FAILED: "Extrakce textu selhala",
  EXTRACTION_EMPTY: "Prázdný výsledek extrakce",
  EMPTY_TEXT: "Prázdný text",
  WIRING_FAILED: "Tok se nespustil",
};

/**
 * The "adresář odkud se dávkově čerpají dokumenty" (owner's request, 2026-09-07): Workers have no filesystem, so the
 * inbox is an R2 prefix instead — browsable and drag-and-drop uploadable straight from the Cloudflare dashboard
 * (R2 → apf-artifacts → inbox/), no extra tooling needed. A Cron Trigger picks files up every 5 minutes, runs them
 * through the exact same startIntake() as the web form, and either deletes the inbox copy (the real immutable
 * original now lives under originals/, this was just the drop-off) or moves it to inbox/failed/ so a broken file
 * doesn't retry forever and silently burn Workers AI calls — the operator sees it sitting there instead.
 */
const INBOX_PREFIX = "inbox/";
const INBOX_FAILED_PREFIX = "inbox/failed/";
const INBOX_BATCH_LIMIT = 10;

/** File names become part of the R2 key (prefixed with a fresh id) — strip path separators so a crafted name can't escape inbox/. */
const sanitizeInboxName = (name: string): string => name.replace(/[\\/]/g, "_") || "upload";

async function processInbox(env: Env): Promise<{ picked: number; ok: number; failed: number }> {
  const listed = await env.ARTIFACTS.list({ prefix: INBOX_PREFIX, limit: 1000 });
  const pending = listed.objects.filter((o) => !o.key.startsWith(INBOX_FAILED_PREFIX)).slice(0, INBOX_BATCH_LIMIT);
  let ok = 0;
  let failed = 0;
  for (const obj of pending) {
    // One file's exception must never abort the batch (owner's requirement, 2026-09-07: a check first, and a failure
    // in file N can't block N+1..10) — everything about this file, including an unexpected throw, stays inside this
    // try so the loop always reaches the next object.
    const name = obj.key.slice(INBOX_PREFIX.length);
    try {
      const got = await env.ARTIFACTS.get(obj.key);
      if (!got) continue; // listed a moment ago, gone now (raced with something else) - nothing to do
      const buf = await got.arrayBuffer();
      const contentType = contentTypeOf(name, got.httpMetadata?.contentType ?? "");
      const content: IntakeRequest["content"] = isText(contentType) ? { kind: "text", bytes: new TextDecoder().decode(buf), contentType } : { kind: "binary", buf, name, contentType };
      const result = await startIntake(env, { workflow: "document-intake", tenantId: intakeTenant(), receivedFrom: "inbox:r2", content });
      if (result.ok) {
        ok += 1;
        console.log(`[apf-gateway] inbox picked up ${obj.key} -> workflowId=${result.workflowId}`);
        await env.ARTIFACTS.delete(obj.key);
      } else {
        failed += 1;
        console.error(`[apf-gateway] inbox failed for ${obj.key}: ${result.code} ${result.message}`);
        await env.ARTIFACTS.put(`${INBOX_FAILED_PREFIX}${name}`, buf, { httpMetadata: { contentType }, customMetadata: { reason: result.code, message: result.message, name } });
        await env.ARTIFACTS.delete(obj.key);
      }
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[apf-gateway] inbox threw for ${obj.key}: ${message}`);
      try {
        const buf = await (await env.ARTIFACTS.get(obj.key))?.arrayBuffer();
        if (buf) await env.ARTIFACTS.put(`${INBOX_FAILED_PREFIX}${name}`, buf, { customMetadata: { reason: "UNEXPECTED_ERROR", message, name } });
        await env.ARTIFACTS.delete(obj.key);
      } catch (e2) {
        // Moving the file itself failed too (e.g. R2 unavailable) — leave it in inbox/, next tick will try again
        // rather than lose it; the object never blocks the objects after it in this loop either way.
        console.error(`[apf-gateway] inbox could not quarantine ${obj.key} after throw: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  }
  return { picked: pending.length, ok, failed };
}

/** What /farm shows under "Dávkový příjem" — actual files, not just counts (owner's request, 2026-09-07: "inbox mi chybí na zobrazení a /failed také"). Read-only, never triggers processing. */
async function inboxDetail(env: Env): Promise<{ pending: InboxItem[]; failed: InboxItem[]; batchLimit: number }> {
  const listed = await env.ARTIFACTS.list({ prefix: INBOX_PREFIX, limit: 500, include: ["customMetadata"] });
  const toItem = (o: (typeof listed.objects)[number], prefix: string): InboxItem => ({
    key: o.key,
    name: o.customMetadata?.name ?? o.key.slice(prefix.length),
    size: o.size,
    uploaded: typeof o.uploaded === "string" ? o.uploaded : new Date(o.uploaded).toISOString(),
    ...(o.customMetadata?.reason ? { reason: o.customMetadata.reason } : {}),
    ...(o.customMetadata?.message ? { message: o.customMetadata.message } : {}),
  });
  const pending: InboxItem[] = [];
  const failed: InboxItem[] = [];
  for (const o of listed.objects) (o.key.startsWith(INBOX_FAILED_PREFIX) ? failed : pending).push(toItem(o, o.key.startsWith(INBOX_FAILED_PREFIX) ? INBOX_FAILED_PREFIX : INBOX_PREFIX));
  return { pending, failed, batchLimit: INBOX_BATCH_LIMIT };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Bundle and vars must name the same installation; anything else is a deployment mistake and stops here (fail-closed).
    if (env.INSTALLATION !== INSTALLATION) {
      return Response.json({ error: "INSTALLATION_MISMATCH", bundle: INSTALLATION, vars: env.INSTALLATION }, { status: 500 });
    }
    if (url.pathname === "/version") {
      return Response.json({
        deployable: "apf-gateway",
        installation: INSTALLATION,
        gitSha: env.GIT_SHA,
        tenants: installation.profile.tenants.length,
        identities: installation.profile.identities.length,
        policies: Object.keys(installation.policies).length,
        workflows: WORKFLOW_NAMES,
        models: modelsOf(env),
        fakes: await fakesInfo(env),
        contracts: env.CONTRACTS_VERSION,
        killSwitch: env.KILL_SWITCH === "true",
        wired: wiredOf(env),
      });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: wiredOf(env) });

    // Read-only view of the chaos switches (KV of apf-fakes) for the operator; they are set with wrangler kv, never through the page.
    if (url.pathname === "/chaos" && request.method === "GET") {
      const f = await fakesInfo(env, "/chaos");
      return Response.json(f.body ?? { error: "NO_ANSWER" }, { status: f.status || 503 });
    }

    // Move one failed file back to inbox/ under a fresh key, for the "podívej se, co je špatně, a nahraj znovu" link.
    if (url.pathname === "/farm/inbox/retry" && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const key = String(form.get("key") ?? "");
      if (!key.startsWith(INBOX_FAILED_PREFIX)) return Response.json({ error: "INVALID_KEY" }, { status: 400 });
      const obj = await env.ARTIFACTS.get(key);
      if (!obj) return Response.json({ error: "NOT_FOUND", key }, { status: 404 });
      const buf = await obj.arrayBuffer();
      const name = obj.customMetadata?.name ?? key.slice(INBOX_FAILED_PREFIX.length);
      await env.ARTIFACTS.put(`${INBOX_PREFIX}${newId("up")}-${sanitizeInboxName(name)}`, buf, { httpMetadata: obj.httpMetadata, customMetadata: { name, receivedFrom: "farm-retry", receivedAt: new Date().toISOString() } });
      await env.ARTIFACTS.delete(key);
      return Response.redirect(new URL("/farm#view-prehled", url).toString(), 303);
    }

    // "Farmář" (owner's own word for it): one page, health of all five deployables + the most recent workflow instances.
    if (url.pathname === "/farm" && request.method === "GET") {
      const rawLimit = Number(url.searchParams.get("limit"));
      const instanceLimit = [15, 30, 50, 100, 200].includes(rawLimit) ? rawLimit : 15;
      const instanceWindow = url.searchParams.get("window") ?? "";
      const [documentHost, emailExecutor, mailIngest, fakes, instances, log, inbox, stats] = await Promise.all([
        deployableInfo(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
        deployableInfo(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
        deployableInfo(env.MAIL_INGEST, "https://apf-mail-ingest.internal"),
        deployableInfo(env.FAKES, FAKES_ORIGIN),
        recentInstances(env, instanceLimit, windowSince(instanceWindow, new SystemClock())),
        auditLog(env, 50),
        inboxDetail(env),
        farmStats(env),
      ]);
      return html(
        renderFarm({
          installation: INSTALLATION,
          gitSha: env.GIT_SHA,
          gatewaySigning: signingMode(env),
          deployables: [
            { name: "apf-gateway", ok: true, status: 200, body: { isolation: "self", wired: wiredOf(env) } },
            { name: "apf-document-host", ...documentHost },
            { name: "apf-email-executor", ...emailExecutor },
            { name: "apf-mail-ingest", ...mailIngest },
            { name: "apf-fakes", ...fakes },
          ],
          instances,
          instanceLimit,
          instanceWindow,
          auditLog: log,
          inbox,
          workflows: [...WORKFLOW_NAMES],
          models: modelsOf(env),
          stats,
        }),
      );
    }

    // Live self-test (owner's request 2026-09-08): a dedicated, fixed-name instance (SELF_TEST_WORKFLOW_ID, shape
    // wf-... so apf-document-host's artifact fetch-back resolves to it too) so it never pollutes "Poslední instance"
    // (recentInstances() excludes it explicitly) or clashes with a real document's workflowId; purgeable like any
    // instance at /workflow/wf-selftest/purge if its artifact store grows.
    if (url.pathname === "/farm/self-test" && request.method === "POST") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
      const rows = (await stub.selfTest()) as SelfTestRow[];
      return html(renderSelfTest(rows));
    }

    // Upload straight into the R2 inbox from the Farmář page (owner's request, 2026-09-07: "potřebuji to u
    // farmáře, ne na Cloudflare") — same drop-off as dragging files into the R2 console, same processInbox()/cron
    // pickup, no second pipeline. Key gets a fresh id prefix so two files with the same name never collide.
    if (url.pathname === "/farm/inbox" && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) continue; // same limit as /intake; oversized files are skipped, not queued broken
        const buf = await file.arrayBuffer();
        const contentType = contentTypeOf(file.name, file.type);
        const key = `${INBOX_PREFIX}${newId("up")}-${sanitizeInboxName(file.name)}`;
        await env.ARTIFACTS.put(key, buf, { httpMetadata: { contentType }, customMetadata: { name: file.name, receivedFrom: "farm-upload", receivedAt: new Date().toISOString() } });
      }
      return Response.redirect(new URL("/farm#view-prehled", url).toString(), 303);
    }

    // The two diagram pages from the repo root, bundled fresh at config-generation time (scripts/farm-config.mjs) —
    // requested by the owner so "jak to funguje" links to the real, already-maintained explanation instead of a new one.
    if (url.pathname === "/VYVOJOVY-DIAGRAM.html" && request.method === "GET") return html(VYVOJOVY_DIAGRAM_HTML);
    if (url.pathname === "/VYVOJOVY-DIAGRAM.en.html" && request.method === "GET") return html(VYVOJOVY_DIAGRAM_EN_HTML);
    // Same treatment (owner: "a proč to není v GUI?" — docs/MATICE-ODPOVEDNOSTI.md alone wasn't reachable from the console).
    if (url.pathname === "/MATICE-ODPOVEDNOSTI.html" && request.method === "GET") return html(MATICE_ODPOVEDNOSTI_HTML);

    if (url.pathname === "/" && request.method === "GET") return html(renderHome(homeModel(request, env)));

    if (url.pathname === "/intake" && request.method === "POST") {
      const form = await request.formData();
      const workflow = String(form.get("workflow") ?? "document-intake");
      const stampText = String(form.get("stampText") ?? "").trim();
      const tenantId = intakeTenant();
      const from = receivedFrom(request);
      const file = form.get("file");
      const modelKey = String(form.get("model") ?? "").trim();

      let content: IntakeRequest["content"];
      if (file instanceof File && file.size > 0) {
        if (file.size > MAX_UPLOAD_BYTES) return html(renderError("Soubor je příliš velký", `Limit je ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, { size: file.size }), 413);
        const contentType = contentTypeOf(file.name, file.type);
        content = isText(contentType) ? { kind: "text", bytes: await file.text(), contentType } : { kind: "binary", buf: await file.arrayBuffer(), name: file.name, contentType };
      } else {
        const text = String(form.get("text") ?? "");
        if (!text.trim()) return html(renderHome(homeModel(request, env)), 400);
        content = { kind: "text", bytes: text, contentType: "text/plain" };
      }

      const result = await startIntake(env, { workflow, tenantId, receivedFrom: from, modelKey: modelKey || undefined, stampText: stampText || undefined, content });
      if (!result.ok) return html(renderError(INTAKE_ERROR_TITLE[result.code] ?? result.code, result.message, { ...(result.detail ?? {}) }), INTAKE_ERROR_STATUS[result.code] ?? 500);
      return Response.redirect(new URL(`/workflow/${result.workflowId}`, url).toString(), 303);
    }

    const purge = /^\/workflow\/(wf-[A-Za-z0-9]+)\/purge$/.exec(url.pathname);
    if (purge && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const reason = String(form.get("reason") ?? "owner request").slice(0, 200);
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(purge[1] as string));
      if (!(await stub.view())) return Response.json({ error: "NOT_FOUND", workflowId: purge[1] }, { status: 404 });
      const result = await stub.purge(receivedFrom(request), reason);
      return html(renderError("Instance smazána", "Originál, derivace i obsah objektu instance jsou pryč; ve společném auditu (D1) zůstal záznam PURGED.", { ...result }), 200);
    }

    // The decision path that was missing entirely on the deployed farm until now (2026-09-08,
    // docs/OPONENTURA-BEZPECNOST-STABILITA.md #1): a human can resolve a WAITING(REVIEW) instance.
    const reviewDecide = /^\/workflow\/(wf-[A-Za-z0-9]+)\/review\/decide$/.exec(url.pathname);
    if (reviewDecide && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const reviewTaskId = String(form.get("reviewTaskId") ?? "");
      const decisionRaw = String(form.get("decision") ?? "");
      const allowedDecisions: Decision[] = ["APPROVE", "REJECT", "CORRECT", "RECLASSIFY"];
      if (!allowedDecisions.includes(decisionRaw as Decision)) return Response.json({ error: "INVALID_DECISION", decision: decisionRaw }, { status: 400 });
      const correctedType = String(form.get("correctedType") ?? "").trim();
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(reviewDecide[1] as string));
      try {
        await stub.decideReview(reviewTaskId, decisionRaw as Decision, receivedFrom(request), correctedType || undefined);
      } catch (e) {
        return html(renderError("Rozhodnutí se nepodařilo použít", e instanceof Error ? e.message : String(e), { reviewTaskId, decision: decisionRaw }), 400);
      }
      return Response.redirect(new URL(`/workflow/${reviewDecide[1]}`, url).toString(), 303);
    }

    // Read-only artifact access for apf-document-host (celek D2), reached only through the DOCUMENT_HOST service binding.
    const artifactRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/artifact\/(art-[A-Za-z0-9]+)$/.exec(url.pathname);
    if (artifactRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(artifactRoute[1] as string));
      const artifact = await stub.artifact(artifactRoute[2] as string);
      if (!artifact) return Response.json({ error: "NOT_FOUND", artifactId: artifactRoute[2] }, { status: 404 });
      return Response.json(artifact);
    }

    // The stamped derivative's bytes never travel back in the dispatch result (only its id/hash do, payloadFor() in
    // stamp-handler.ts) — apf-document-host writes them to R2 itself, keyed by tenant + sha256 (SingleArtifactStore.derive()
    // in apf-document-host/src/index.ts). Same bucket, so gateway can read the object directly, no host round-trip needed.
    const stampedRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/stamped$/.exec(url.pathname);
    if (stampedRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(stampedRoute[1] as string));
      const view = (await stub.view()) as InstanceView | null;
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: stampedRoute[1] }, { status: 404 });
      const stampStep = [...view.instance.steps].reverse().find((s) => s.capability === "document.stamp" && s.status === "SUCCEEDED");
      const sha = (stampStep?.result?.payload as { stampedSha256?: unknown } | undefined)?.stampedSha256;
      if (typeof sha !== "string") return Response.json({ error: "NOT_FOUND", message: "instance has no successful document.stamp step" }, { status: 404 });
      const key = `derived/${view.instance.tenantId}/${sha}`;
      const obj = await env.ARTIFACTS.get(key);
      if (!obj) return Response.json({ error: "NOT_FOUND", message: "not in R2 yet (async write) or already purged", key }, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }

    // The original upload itself (PDF/photo/etc.), not just the text Workers AI extracted from it — owner's request,
    // 2026-09-07: "chci vidět vizuál dokladu". Text originals have nothing extra here; the text is already inline.
    const originalRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/original$/.exec(url.pathname);
    if (originalRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(originalRoute[1] as string));
      const view = (await stub.view()) as InstanceView | null;
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: originalRoute[1] }, { status: 404 });
      const original = view.artifacts.find((a) => !a.derivedFrom);
      if (!original?.location) return Response.json({ error: "NOT_FOUND", message: "instance has no binary original (text intake, or already purged)" }, { status: 404 });
      const obj = await env.ARTIFACTS.get(original.location);
      if (!obj) return Response.json({ error: "NOT_FOUND", message: "not in R2 (already purged)", key: original.location }, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "no-store" } });
    }

    // The visual stamp (owner's decision 2026-09-07: "vedle sebe" alongside the text-based DMS write) — written
    // asynchronously by visualStampIfApplicable() right after document.stamp succeeds, so this can 404 briefly.
    const originalStampedRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/original-stamped$/.exec(url.pathname);
    if (originalStampedRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(originalStampedRoute[1] as string));
      const view = (await stub.view()) as InstanceView | null;
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: originalStampedRoute[1] }, { status: 404 });
      const original = view.artifacts.find((a) => !a.derivedFrom);
      if (!original?.location) return Response.json({ error: "NOT_FOUND", message: "instance has no binary original" }, { status: 404 });
      // The three real reasons this can be missing, told apart — a generic "maybe async, maybe not applicable" left
      // the owner unable to tell a genuine bug from the (much more common) case of a document still waiting on review.
      const stampStep = [...view.instance.steps].reverse().find((s) => s.capability === "document.stamp");
      if (stampStep?.status !== "SUCCEEDED") {
        return Response.json({ error: "NOT_FOUND", message: "document.stamp never succeeded for this instance (still waiting on review, or the flow ended before reaching it) — there is nothing to visually stamp yet", stampStepStatus: stampStep?.status ?? "not reached" }, { status: 404 });
      }
      const key = `stamped-visual/${view.instance.tenantId}/${originalStampedRoute[1]}`;
      const obj = await env.ARTIFACTS.get(key);
      if (!obj) return Response.json({ error: "NOT_FOUND", message: "document.stamp succeeded but the visual stamp isn't in R2 yet — either still writing asynchronously (try again in a few seconds) or this content type has no visual-stamp recipe (visual-stamp.ts only knows PDF, JPG, PNG)", key }, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "no-store" } });
    }

    const m = /^\/workflow\/(wf-[A-Za-z0-9]+)(\.json)?$/.exec(url.pathname);
    if (m && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(m[1] as string));
      const view = await stub.view();
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: m[1] }, { status: 404 });
      return m[2] ? Response.json(view) : html(renderInstance(view));
    }

    if (url.pathname === "/audit.json" && request.method === "GET") {
      await ensureD1Audit(env.AUDIT);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 500);
      const rows = await env.AUDIT.prepare("SELECT json FROM audit ORDER BY at DESC LIMIT ?").bind(limit).all<{ json: string }>();
      return Response.json(rows.results.map((r) => JSON.parse(r.json) as unknown));
    }

    // Shared append-only trail for remote hosts (celek D2, docs/NAVRHOVY-LIST-farma.md "žádný Worker nesahá do cizí DB"):
    // reached only through a service binding, no host's own config ever routes it to the public internet.
    if (url.pathname === "/audit" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as Partial<AuditRecord> | undefined;
      if (!body?.kind) return Response.json({ error: "BAD_REQUEST", message: "kind required" }, { status: 400 });
      await ensureD1Audit(env.AUDIT);
      const record: AuditRecord = { ...body, auditId: newId("aud"), at: iso(new Date()), kind: body.kind };
      await env.AUDIT.prepare("INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(record.auditId, record.at, record.kind, record.correlationId ?? null, record.workflowId ?? null, record.tenantId ?? null, record.actorId ?? null, record.capability ?? null, JSON.stringify(record))
        .run();
      return Response.json({ ok: true, auditId: record.auditId });
    }

    if (url.pathname === "/dispatch") {
      return Response.json({ error: "NOT_WIRED", message: "apf-gateway: the HTTP /dispatch endpoint for remote callers (harness, hosts) is a later unit; the page and the orchestrator dispatch inside the instance object" }, { status: 501 });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },

  // R2 inbox batch import (owner's request, 2026-09-07): every 5 min, pick up whatever landed under inbox/ and run it
  // through the same startIntake() as the web form. See processInbox() for the full design note.
  async scheduled(controller, env, ctx): Promise<void> {
    if (env.KILL_SWITCH === "true") {
      console.log(`[apf-gateway] scheduled skipped: KILL_SWITCH cron=${controller.cron}`);
      return;
    }
    const t0 = Date.now();
    try {
      const r = await processInbox(env);
      console.log(`[apf-gateway] scheduled inbox picked=${r.picked} ok=${r.ok} failed=${r.failed} (${Date.now() - t0}ms) cron=${controller.cron}`);
    } catch (e) {
      console.error(`[apf-gateway] scheduled inbox threw (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      controller.noRetry(); // a thrown error here is a bug to look at in Workers Logs, not something an immediate retry fixes
    }
  },
} satisfies ExportedHandler<Env>;
