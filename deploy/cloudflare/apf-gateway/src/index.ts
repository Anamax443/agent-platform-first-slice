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
import { INSTALLATION, installation } from "apf:installation";
import { FAKES_ORIGIN, HttpRegistryAdapter } from "../../../../src/adapters/registry.js";
import type { WorkersAiBinding } from "../../../../src/adapters/workers-ai.js";
import type { SecretsSource } from "../../../../src/installation.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import { sha256Bytes } from "../../../../src/platform/artifacts.js";
import { iso, SystemClock } from "../../../../src/platform/clock.js";
import { platformError } from "../../../../src/platform/errors.js";
import { newId } from "../../../../src/platform/ids.js";
import { Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import { ReviewService } from "../../../../src/platform/review.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_NAMES, workflowDef } from "../../../../src/platform/workflow.js";
import { renderError, renderFarm, renderHome, renderInstance, type FarmInstanceRow, type InstanceView, type ModelsInfo, type Wired } from "./page.js";
import { describeModels, wirePlatform, type Wiring } from "./platform-wiring.js";
import { D1_AUDIT_DDL, DDL, SqliteArtifacts, SqliteAudit, SqliteJournal } from "./store.js";

export interface Env {
  WORKFLOW: DurableObjectNamespace<WorkflowInstance>;
  AUDIT: D1Database;
  ARTIFACTS: R2Bucket;
  AI: Ai;
  DOCUMENT_HOST: Fetcher;
  EMAIL_EXECUTOR: Fetcher;
  MAIL_INGEST: Fetcher;
  FAKES: Fetcher;
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
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
  private wiringCache: Wiring | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const stmt of DDL) ctx.storage.sql.exec(stmt);
    this.journal = new SqliteJournal(ctx.storage.sql);
    this.audit = new SqliteAudit(ctx.storage.sql, this.clock);
    this.artifacts = new SqliteArtifacts(ctx.storage.sql, this.clock);
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
        : this.artifacts.putExternal({ tenantId: input.tenantId, receivedFrom: input.receivedFrom, sha256: o.sha256, contentType: o.contentType, byteLength: o.byteLength, location: o.location });

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
    this.ctx.waitUntil(this.copyOut());
    return this.view() as InstanceView;
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
      review: new ReviewService(this.clock, this.audit),
      audit: this.audit,
      clock: this.clock,
      actorId: installation.profile.roles.orchestrator,
    });
  }

  /** Text artifacts to R2 (immutable, keyed by tenant + sha256) and audit records to the shared D1 trail. Idempotent. */
  private async copyOut(): Promise<void> {
    for (const a of this.artifacts.uncopied()) {
      const key = `${a.derivedFrom ? "derived" : "originals"}/${a.tenantId}/${a.sha256}`;
      if (!(await this.env.ARTIFACTS.head(key))) {
        await this.env.ARTIFACTS.put(key, a.bytes, {
          httpMetadata: { contentType: a.contentType ?? "text/plain" },
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
  return { workflowId, workflow: i.workflow, workflowVersion: i.workflowVersion, tenantId: i.tenantId, actorId: i.actorId, status: i.status, createdAt: i.createdAt, updatedAt: i.updatedAt, steps: i.steps };
};

/** The most recently active workflow ids (D1, cheap) — then each instance's real steps[] straight from its own Durable Object (the DO journal is the source of truth, not the audit relay). */
const recentInstances = async (env: Env, limit = 15): Promise<FarmInstanceRow[]> => {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare(`SELECT workflow_id, MAX(at) AS last_at FROM audit WHERE workflow_id IS NOT NULL GROUP BY workflow_id ORDER BY last_at DESC LIMIT ?`)
    .bind(limit)
    .all<{ workflow_id: string; last_at: string }>();
  return Promise.all(rows.results.map((r) => farmRowOf(env, r.workflow_id, r.last_at)));
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

const contentTypeOf = (file: File): string => {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return file.type && file.type !== "application/octet-stream" ? file.type : (BY_EXTENSION[ext] ?? "application/octet-stream");
};

const isText = (contentType: string): boolean =>
  contentType.startsWith("text/") || contentType === "message/rfc822" || contentType === "application/json" || contentType === "application/xml";

const homeModel = (request: Request, env: Env) => ({ installation: INSTALLATION, user: receivedFrom(request), workflows: [...WORKFLOW_NAMES], wired: wiredOf(env), models: modelsOf(env) });

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

    // "Farmář" (owner's own word for it): one page, health of all five deployables + the most recent workflow instances.
    if (url.pathname === "/farm" && request.method === "GET") {
      const [documentHost, emailExecutor, mailIngest, fakes, instances] = await Promise.all([
        deployableInfo(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
        deployableInfo(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
        deployableInfo(env.MAIL_INGEST, "https://apf-mail-ingest.internal"),
        deployableInfo(env.FAKES, FAKES_ORIGIN),
        recentInstances(env, 15),
      ]);
      return html(
        renderFarm({
          installation: INSTALLATION,
          gatewaySigning: signingMode(env),
          deployables: [
            { name: "apf-gateway", ok: true, status: 200, body: { isolation: "self", wired: wiredOf(env) } },
            { name: "apf-document-host", ...documentHost },
            { name: "apf-email-executor", ...emailExecutor },
            { name: "apf-mail-ingest", ...mailIngest },
            { name: "apf-fakes", ...fakes },
          ],
          instances,
        }),
      );
    }

    if (url.pathname === "/" && request.method === "GET") return html(renderHome(homeModel(request, env)));

    if (url.pathname === "/intake" && request.method === "POST") {
      if (env.KILL_SWITCH === "true") return Response.json({ error: "KILL_SWITCH" }, { status: 503 });
      const form = await request.formData();
      const workflow = String(form.get("workflow") ?? "document-intake");
      if (!WORKFLOW_NAMES.includes(workflow)) return Response.json({ error: "UNKNOWN_WORKFLOW", workflow }, { status: 400 });
      const stampText = String(form.get("stampText") ?? "").trim();
      const tenantId = intakeTenant();
      const from = receivedFrom(request);
      const file = form.get("file");

      // The model is a choice among the installation's options; an unavailable or unknown key is refused here, not silently replaced.
      const modelKey = String(form.get("model") ?? "").trim();
      const models = modelsOf(env);
      if ("error" in models) return html(renderError("Modely nejsou k dispozici", "Instalace nemá použitelný výchozí model; tok se nespustí (nikdy bez modelu).", { error: models.error }), 503);
      if (modelKey) {
        const choice = models.choices.find((c) => c.key === modelKey);
        if (!choice) return html(renderError("Neznámý model", "Klíč modelu není v seznamu instalace.", { model: modelKey }), 400);
        if (choice.unavailable) return html(renderError("Model není dostupný", choice.unavailable, { model: modelKey }), 400);
      }

      let original: Original;
      let extraction: Extraction | undefined;
      if (file instanceof File && file.size > 0) {
        if (file.size > MAX_UPLOAD_BYTES) return html(renderError("Soubor je příliš velký", `Limit je ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, { size: file.size }), 413);
        const contentType = contentTypeOf(file);
        if (isText(contentType)) {
          original = { kind: "text", bytes: await file.text(), contentType };
        } else {
          // Binary original: into R2 first (immutable, keyed by hash), then Workers AI derives the text the workflow will see.
          const buf = await file.arrayBuffer();
          const digest = sha256Bytes(new Uint8Array(buf));
          const location = `originals/${tenantId}/${digest}`;
          if (!(await env.ARTIFACTS.head(location))) {
            await env.ARTIFACTS.put(location, buf, { httpMetadata: { contentType }, customMetadata: { name: file.name, receivedFrom: from, receivedAt: new Date().toISOString() } });
          }
          original = { kind: "external", sha256: digest, contentType, byteLength: file.size, location, name: file.name };
          let converted: ConversionResponse;
          try {
            converted = await env.AI.toMarkdown({ name: file.name, blob: new Blob([buf], { type: contentType }) });
          } catch (e) {
            return html(renderError("Extrakce textu selhala", "Workers AI konverzi neprovedla; originál je uložený, tok nebyl spuštěn.", { sha256: digest, contentType, error: String(e) }), 422);
          }
          if (converted.format === "error") {
            return html(renderError("Extrakce textu selhala", "Workers AI soubor odmítla; originál je uložený, tok nebyl spuštěn.", { sha256: digest, contentType, error: converted.error }), 422);
          }
          if (!converted.data.trim()) {
            return html(renderError("Prázdný výsledek extrakce", "Workers AI ze souboru nezískala žádný text (např. sken bez OCR vrstvy nebo prázdná stránka); originál je uložený, tok nebyl spuštěn.", { sha256: digest, contentType }), 422);
          }
          extraction = { text: converted.data, format: converted.format, tokens: converted.tokens };
        }
      } else {
        const text = String(form.get("text") ?? "");
        if (!text.trim()) return html(renderHome(homeModel(request, env)), 400);
        original = { kind: "text", bytes: text, contentType: "text/plain" };
      }
      if (original.kind === "text" && original.bytes.length > MAX_TEXT_CHARS) return Response.json({ error: "DOCUMENT_TOO_LARGE", max: MAX_TEXT_CHARS }, { status: 413 });
      if (extraction && extraction.text.length > MAX_TEXT_CHARS) extraction = { ...extraction, text: extraction.text.slice(0, MAX_TEXT_CHARS) };

      const workflowId = newId("wf");
      console.log(`[apf-gateway] intake start workflowId=${workflowId} workflow=${workflow} tenantId=${tenantId} from=${from} model=${modelKey || "(default)"}`);
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
      const t0 = Date.now();
      try {
        await stub.intake({
          workflowId,
          workflow,
          tenantId,
          receivedFrom: from,
          original,
          ...(extraction ? { extraction } : {}),
          ...(modelKey ? { model: modelKey } : {}),
          ...(stampText ? { stampText } : {}),
        });
      } catch (e) {
        console.error(`[apf-gateway] intake wiring threw workflowId=${workflowId} (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return html(renderError("Tok se nespustil", "Zapojení platformy v objektu instance selhalo (fail-closed); originál zůstal uložený.", { workflowId, error: String(e) }), 500);
      }
      console.log(`[apf-gateway] intake done workflowId=${workflowId} (${Date.now() - t0}ms)`);
      return Response.redirect(new URL(`/workflow/${workflowId}`, url).toString(), 303);
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

    // Read-only artifact access for apf-document-host (celek D2), reached only through the DOCUMENT_HOST service binding.
    const artifactRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/artifact\/(art-[A-Za-z0-9]+)$/.exec(url.pathname);
    if (artifactRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(artifactRoute[1] as string));
      const artifact = await stub.artifact(artifactRoute[2] as string);
      if (!artifact) return Response.json({ error: "NOT_FOUND", artifactId: artifactRoute[2] }, { status: 404 });
      return Response.json(artifact);
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
} satisfies ExportedHandler<Env>;
