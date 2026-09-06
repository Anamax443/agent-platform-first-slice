// apf-gateway: intake + one Durable Object per workflow instance. Step 2 of docs/NAVRHOVY-LIST-farma.md, unit A:
// a document handed in through the page (behind Cloudflare Access) becomes an immutable original, a workflow instance
// starts in its own Durable Object (SQLite = journal, audit, artifacts; R2 and D1 get async copies) and the orchestrator
// runs as far as the farm is wired. Until the router is wired, every step ends as an explicit DEPENDENCY_UNAVAILABLE.
// The installation (profile + policies) comes from the build-time alias apf:installation and is assembled fail-closed at
// import: a broken profile means this Worker does not start at all. Nothing installation-bound is written in this file.
import { DurableObject } from "cloudflare:workers";
import { INSTALLATION, installation } from "apf:installation";
import { iso, SystemClock } from "../../../../src/platform/clock.js";
import { platformError } from "../../../../src/platform/errors.js";
import { newId } from "../../../../src/platform/ids.js";
import { Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import { ReviewService } from "../../../../src/platform/review.js";
import type { DispatchTransport } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_DEFINITIONS, workflowDef } from "../../../../src/platform/workflow.js";
import { renderHome, renderInstance, type InstanceView, type Wired } from "./page.js";
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

/** What this deployment can do. Read by /version, /health and the page; every unit of step 2 flips one flag. */
const WIRED: Wired = {
  intake: true,
  journal: "durable-object-sqlite",
  audit: "durable-object-sqlite + d1",
  artifacts: "durable-object-sqlite + r2",
  dispatch: false,
  hosts: false,
  accessJwtVerified: false,
};

const MAX_DOCUMENT_CHARS = 1_000_000;

interface IntakeInput {
  workflowId: string;
  workflow: string;
  tenantId: string;
  bytes: string;
  receivedFrom: string;
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
    const artifact = this.artifacts.put({ tenantId: input.tenantId, bytes: input.bytes, receivedFrom: input.receivedFrom });
    const orchestrator = this.orchestratorFor(workflowDef(input.workflow));
    const inst = orchestrator.start(
      { tenantId: input.tenantId, artifactId: artifact.artifactId, ...(input.stampText ? { stampText: input.stampText } : {}) },
      undefined,
      input.workflowId,
    );
    this.audit.append({
      kind: "state",
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      tenantId: inst.tenantId,
      details: { status: "RUNNING", receivedFrom: input.receivedFrom, artifactId: artifact.artifactId, sha256: artifact.sha256 },
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

  /** Originals to R2 (immutable, keyed by tenant + sha256) and audit records to the shared D1 trail. Idempotent. */
  private async copyOut(): Promise<void> {
    for (const a of this.artifacts.uncopied()) {
      const key = `originals/${a.tenantId}/${a.sha256}`;
      if (!(await this.env.ARTIFACTS.head(key))) {
        await this.env.ARTIFACTS.put(key, a.bytes, { customMetadata: { artifactId: a.artifactId, receivedFrom: a.receivedFrom, receivedAt: a.receivedAt } });
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

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderHome({ installation: INSTALLATION, user: receivedFrom(request), workflows: Object.keys(WORKFLOW_DEFINITIONS), wired: WIRED }));
    }

    if (url.pathname === "/intake" && request.method === "POST") {
      if (env.KILL_SWITCH === "true") return Response.json({ error: "KILL_SWITCH" }, { status: 503 });
      const form = await request.formData();
      const file = form.get("file");
      let bytes = String(form.get("text") ?? "");
      if (file instanceof File && file.size > 0) bytes = await file.text();
      if (!bytes.trim()) return html(renderHome({ installation: INSTALLATION, user: receivedFrom(request), workflows: Object.keys(WORKFLOW_DEFINITIONS), wired: WIRED }), 400);
      if (bytes.length > MAX_DOCUMENT_CHARS) return Response.json({ error: "DOCUMENT_TOO_LARGE", max: MAX_DOCUMENT_CHARS }, { status: 413 });
      const workflow = String(form.get("workflow") ?? "document-intake");
      if (!(workflow in WORKFLOW_DEFINITIONS)) return Response.json({ error: "UNKNOWN_WORKFLOW", workflow }, { status: 400 });
      const stampText = String(form.get("stampText") ?? "").trim();
      const workflowId = newId("wf");
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
      await stub.intake({ workflowId, workflow, tenantId: intakeTenant(), bytes, receivedFrom: receivedFrom(request), ...(stampText ? { stampText } : {}) });
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
