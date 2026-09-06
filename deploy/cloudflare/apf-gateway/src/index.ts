// apf-gateway: intake + one Durable Object per workflow instance. Step 2 of docs/NAVRHOVY-LIST-farma.md, units A and A2:
// a document handed in through the page (behind Cloudflare Access) becomes an immutable original (text in the object,
// binary in R2 keyed by sha256), a binary original is turned into a text derivation with provenance by Workers AI
// (toMarkdown: PDF, images, docx), a workflow instance starts in its own Durable Object (SQLite = journal, audit,
// artifacts; R2 and D1 get async copies) and the orchestrator runs as far as the farm is wired. Until the router is
// wired, every step ends as an explicit DEPENDENCY_UNAVAILABLE. The installation (profile + policies) comes from the
// build-time alias apf:installation and is assembled fail-closed at import. Nothing installation-bound is written here.
import { DurableObject } from "cloudflare:workers";
import { INSTALLATION, installation } from "apf:installation";
import { sha256Bytes } from "../../../../src/platform/artifacts.js";
import { iso, SystemClock } from "../../../../src/platform/clock.js";
import { platformError } from "../../../../src/platform/errors.js";
import { newId } from "../../../../src/platform/ids.js";
import { Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import { ReviewService } from "../../../../src/platform/review.js";
import type { DispatchTransport } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_DEFINITIONS, workflowDef } from "../../../../src/platform/workflow.js";
import { renderError, renderHome, renderInstance, type InstanceView, type Wired } from "./page.js";
import { D1_AUDIT_DDL, DDL, SqliteArtifacts, SqliteAudit, SqliteJournal } from "./store.js";

export interface Env {
  WORKFLOW: DurableObjectNamespace<WorkflowInstance>;
  AUDIT: D1Database;
  ARTIFACTS: R2Bucket;
  AI: Ai;
  DOCUMENT_HOST: Fetcher;
  EMAIL_EXECUTOR: Fetcher;
  FAKES: Fetcher;
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
  KILL_SWITCH: string;
  SIGNING_KEY_ID: string;
  CONTRACTS_VERSION: string;
  WORKFLOW_DEADLINE_MS: string;
  GATEWAY_SIGNING_KEY?: string;
}

/** What this deployment can do. Read by /version, /health and the page; every unit of step 2 flips one entry. */
const WIRED: Wired = {
  intake: true,
  extract: "workers-ai toMarkdown (pdf, obrázky, docx) → derivace s provenancí",
  journal: "durable-object-sqlite",
  audit: "durable-object-sqlite + d1",
  artifacts: "durable-object-sqlite + r2",
  dispatch: false,
  hosts: false,
  accessJwtVerified: false,
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
  stampText?: string;
}

/** Until the router is wired every command ends as DEPENDENCY_UNAVAILABLE: an explicit, audited FAILED, never a pretended success. */
class NotWiredTransport implements DispatchTransport {
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const stmt of DDL) ctx.storage.sql.exec(stmt);
    this.journal = new SqliteJournal(ctx.storage.sql);
    this.audit = new SqliteAudit(ctx.storage.sql, this.clock);
    this.artifacts = new SqliteArtifacts(ctx.storage.sql, this.clock);
  }

  async intake(input: IntakeInput): Promise<InstanceView> {
    if (this.journal.list().length > 0) throw new Error(`instance ${input.workflowId} already exists`);
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

    const orchestrator = this.orchestratorFor(workflowDef(input.workflow));
    const inst = orchestrator.start(
      { tenantId: input.tenantId, artifactId: subject.artifactId, ...(input.stampText ? { stampText: input.stampText } : {}) },
      undefined,
      input.workflowId,
    );
    this.audit.append({
      kind: "state",
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      tenantId: inst.tenantId,
      details: { status: "RUNNING", receivedFrom: input.receivedFrom, originalId: original.artifactId, artifactId: subject.artifactId, sha256: original.sha256, contentType: original.contentType },
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

  private orchestratorFor(def: WorkflowDef): Orchestrator {
    return new Orchestrator({
      workflow: def,
      transport: new NotWiredTransport(this.audit, this.clock),
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
};

const contentTypeOf = (file: File): string => {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return file.type && file.type !== "application/octet-stream" ? file.type : (BY_EXTENSION[ext] ?? "application/octet-stream");
};

const isText = (contentType: string): boolean => contentType.startsWith("text/") || contentType === "message/rfc822" || contentType === "application/json";

const homeModel = (request: Request) => ({ installation: INSTALLATION, user: receivedFrom(request), workflows: Object.keys(WORKFLOW_DEFINITIONS), wired: WIRED });

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
        workflows: Object.keys(WORKFLOW_DEFINITIONS),
        contracts: env.CONTRACTS_VERSION,
        killSwitch: env.KILL_SWITCH === "true",
        wired: WIRED,
      });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: WIRED });

    if (url.pathname === "/" && request.method === "GET") return html(renderHome(homeModel(request)));

    if (url.pathname === "/intake" && request.method === "POST") {
      if (env.KILL_SWITCH === "true") return Response.json({ error: "KILL_SWITCH" }, { status: 503 });
      const form = await request.formData();
      const workflow = String(form.get("workflow") ?? "document-intake");
      if (!(workflow in WORKFLOW_DEFINITIONS)) return Response.json({ error: "UNKNOWN_WORKFLOW", workflow }, { status: 400 });
      const stampText = String(form.get("stampText") ?? "").trim();
      const tenantId = intakeTenant();
      const from = receivedFrom(request);
      const file = form.get("file");

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
        if (!text.trim()) return html(renderHome(homeModel(request)), 400);
        original = { kind: "text", bytes: text, contentType: "text/plain" };
      }
      if (original.kind === "text" && original.bytes.length > MAX_TEXT_CHARS) return Response.json({ error: "DOCUMENT_TOO_LARGE", max: MAX_TEXT_CHARS }, { status: 413 });
      if (extraction && extraction.text.length > MAX_TEXT_CHARS) extraction = { ...extraction, text: extraction.text.slice(0, MAX_TEXT_CHARS) };

      const workflowId = newId("wf");
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
      await stub.intake({ workflowId, workflow, tenantId, receivedFrom: from, original, ...(extraction ? { extraction } : {}), ...(stampText ? { stampText } : {}) });
      return Response.redirect(new URL(`/workflow/${workflowId}`, url).toString(), 303);
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

    if (url.pathname === "/dispatch") {
      return Response.json({ error: "NOT_WIRED", message: "apf-gateway: router and signed dispatch are the next unit of step 2 (NAVRHOVY-LIST-farma.md)" }, { status: 501 });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
