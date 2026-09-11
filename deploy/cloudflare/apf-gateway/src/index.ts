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
import type { CapabilityRecord } from "../../../../src/platform/registry.js";
import { Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import { IdentityProvider } from "../../../../src/platform/gateway.js";
import type { Instance } from "../../../../src/platform/journal.js";
import { ReviewService, type Decision } from "../../../../src/platform/review.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_NAMES, workflowDef } from "../../../../src/platform/workflow.js";
import {
  composeIncidentAlert,
  computeWatchdog,
  reconcileIncidents,
  renderError,
  renderFarm,
  renderHome,
  renderInstance,
  renderSelfTest,
  type AuditLogRow,
  type CapabilityRow,
  type FarmInstanceRow,
  type FarmModel,
  type FarmStats,
  type IncidentRecord,
  type InboxItem,
  type InstanceView,
  type ModelsInfo,
  type SelfTestFixtureState,
  type SelfTestRow,
  type Wired,
} from "./page.js";
import { describeModels, gatewayCatalog, wirePlatform, type Wiring } from "./platform-wiring.js";
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
  /** Argos watchdog alert e-mail (HANDOFF 85): the send_email binding itself is the authorization, same
   * reasoning as apf-email-executor's EMAIL binding — no separate secret. */
  ARGOS_MAIL: SendEmail;
  /** "sandbox" (log only, sends nothing) until deliberately flipped to "live" for an installation — same
   * explicit-opt-in discipline as apf-email-executor's SEND_MODE. */
  ARGOS_ALERT_MODE: "sandbox" | "live";
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

/** A remote deployable's own /capabilities (its declared endpoint, docs/SEVERKA.md "Agent Registry") — never thrown,
 * an unreachable Worker just contributes zero rows to the Kravičky lifecycle table. */
const capabilitiesOf = async (fetcher: Fetcher, origin: string): Promise<CapabilityRecord[]> => {
  try {
    const r = await fetcher.fetch(`${origin}/capabilities`);
    if (!r.ok) return [];
    const body = (await r.json().catch(() => undefined)) as { capabilities?: CapabilityRecord[] } | undefined;
    return body?.capabilities ?? [];
  } catch {
    return [];
  }
};

/** Merged across runs — owner's request 2026-09-09 ("nevím, jestli jsou zdravé, jen je zelené OK" / "kde
 * jsou slibované testy kraviček?" / "ale já chci vidět kontroly a i si je být schopen individuálně
 * vyvolat"): a bare "OK" badge proves nothing; this is what makes the last real self-test's per-check
 * result visible on the Kravičky/Argos cards instead of only on the throwaway /farm/self-test report page,
 * and survives a partial (single-capability) re-run without losing every other capability's last-known
 * state. SelfTestFixtureState itself lives in page.ts, next to SelfTestRow it extends. */
export interface SelfTestSummary {
  updatedAt: string;
  fixtures: SelfTestFixtureState[];
}

const SELF_TEST_STATE_AUDIT_ID = "self-test-state";

/** Merge this run's rows into the stored state (read-modify-write, keyed by capability+id) and write it back
 * to ONE fixed-id audit row (INSERT OR REPLACE) — a single-capability run only ever touches its own fixtures,
 * every other capability's last-known card state is untouched. Also appends one history row per non-skipped
 * fixture (kind: "self-test-check", normal append, never replaced) — owner's request 2026-09-09: "logování do
 * DB jednotlivých kontrol, protože pokud se budou opakovat chyby v kontrole tak je někde problém". That history
 * is queryable the same way as any other audit record (kind = 'self-test-check'); nothing new to build for it
 * to exist, only to later have a dedicated trend view read it. */
async function recordSelfTestSummary(env: Env, rows: SelfTestRow[]): Promise<void> {
  await ensureD1Audit(env.AUDIT);
  const at = iso(new Date());
  const existing = await latestSelfTestSummary(env);
  const merged = new Map<string, SelfTestFixtureState>((existing?.fixtures ?? []).map((f) => [`${f.capability}::${f.id}`, f]));
  for (const r of rows) merged.set(`${r.capability}::${r.id}`, { ...r, at });
  const summary: SelfTestSummary = { updatedAt: at, fixtures: [...merged.values()] };
  const insertHistory = env.AUDIT.prepare(
    "INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const historyWrites = rows
    .filter((r) => !r.skipped)
    .map((r) => insertHistory.bind(newId("aud"), at, "self-test-check", null, null, null, "self-test", r.capability, JSON.stringify({ ...r, at })));
  await env.AUDIT.batch([
    env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      SELF_TEST_STATE_AUDIT_ID,
      at,
      "self-test-state",
      null,
      null,
      null,
      "self-test",
      null,
      JSON.stringify(summary),
    ),
    ...historyWrites,
  ]);
}

/** The current merged state (every capability's last-known per-fixture result), or undefined if self-test was
 * never run on this farm yet. */
async function latestSelfTestSummary(env: Env): Promise<SelfTestSummary | undefined> {
  await ensureD1Audit(env.AUDIT);
  const row = await env.AUDIT.prepare("SELECT json FROM audit WHERE audit_id = ?").bind(SELF_TEST_STATE_AUDIT_ID).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as SelfTestSummary) : undefined;
}

const WATCHDOG_INCIDENT_KIND = "watchdog-incident";
const watchdogIncidentAuditId = (key: string): string => `${WATCHDOG_INCIDENT_KIND}:${key}`;

/** Every incident ever recorded (open and resolved) — same "one row per key, INSERT OR REPLACE" idiom as
 * self-test-state, just one row per incident key instead of one row for the whole farm. */
async function allIncidents(env: Env): Promise<IncidentRecord[]> {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare("SELECT json FROM audit WHERE kind = ?").bind(WATCHDOG_INCIDENT_KIND).all<{ json: string }>();
  return (rows.results ?? []).map((r) => JSON.parse(r.json) as IncidentRecord);
}

/**
 * Argos's own e-mail port (HANDOFF 85, oponentura bod 11 "hlídací pes potřebuje štěkat") — direct Cloudflare
 * Email Sending, deliberately not the email.send capability (Argos is platform self-monitoring, not a
 * tenant-scoped business workflow; going through Router/Policy would be the wrong boundary for it). Same
 * "sandbox by default" split as apf-email-executor's CloudflareSmtpAdapter/FakeSmtpAdapter.
 */
interface ArgosAlertPort {
  send(to: string, from: { email: string; name: string }, subject: string, body: string): Promise<void>;
}
class LiveArgosAlertPort implements ArgosAlertPort {
  constructor(private readonly email: SendEmail) {}
  async send(to: string, from: { email: string; name: string }, subject: string, body: string): Promise<void> {
    await this.email.send({ to, from, subject, text: body });
  }
}
class SandboxArgosAlertPort implements ArgosAlertPort {
  async send(to: string, _from: { email: string; name: string }, subject: string): Promise<void> {
    console.log(`[apf-gateway] ARGOS_ALERT_MODE=sandbox, not sending "${subject}" to ${to}`);
  }
}

/** Sends the alert e-mail for whatever reconcileAndPersistIncidents() found new this run, if `channels.
 * operatorAlertTo` is configured. Best-effort — a send failure must never break the page rendering it triggered
 * from, same reasoning as the D1 write itself. */
async function sendArgosAlerts(env: Env, newlyOpened: IncidentRecord[], newlyResolved: IncidentRecord[]): Promise<void> {
  const to = installation.profile.channels.operatorAlertTo;
  const fromEmail = installation.profile.channels.notifyFrom;
  // No installation-bound fallback here (ARCH-DEP-001): an installation without both a destination and a real
  // sender address has nothing correct to send from, not a default to send from instead.
  if (!to || !fromEmail) return;
  const alert = composeIncidentAlert(newlyOpened, newlyResolved);
  if (!alert) return;
  const from = { email: fromEmail, name: "Argos — " + installation.profile.channels.notifyFromName };
  const port: ArgosAlertPort = env.ARGOS_ALERT_MODE === "live" ? new LiveArgosAlertPort(env.ARGOS_MAIL) : new SandboxArgosAlertPort();
  try {
    await port.send(to, from, alert.subject, alert.body);
  } catch (e) {
    console.error(`[apf-gateway] sendArgosAlerts failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Incident Store, first slice (oponentura item 2, HANDOFF 84 continued): turns this render's watchdog findings
 * into persisted incident state — page.ts's reconcileIncidents() decides what changed, this just reads/writes
 * it. Runs on every GET /farm (reuses the FarmModel already assembled for the page, no extra fetches); there is
 * no cron reconciliation yet, so an incident's freshness is bounded by how often a human opens the page or runs
 * self-test — same honesty as self-test itself being manual today (docs/SEVERKA.md, scheduled probes are a
 * later step). Best-effort: a D1 hiccup here must never break the page it's reporting on.
 */
async function reconcileAndPersistIncidents(env: Env, model: FarmModel, now: string): Promise<IncidentRecord[]> {
  try {
    await ensureD1Audit(env.AUDIT);
    const existing = await allIncidents(env);
    const changed = reconcileIncidents(existing, computeWatchdog(model).findings, now);
    if (changed.length > 0) {
      const stmt = env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      await env.AUDIT.batch(changed.map((i) => stmt.bind(watchdogIncidentAuditId(i.key), now, WATCHDOG_INCIDENT_KIND, null, null, null, "argos", null, JSON.stringify(i))));
      // "New to us" = first occurrence (whether truly first-ever, or a fresh incident after a prior one with the
      // same key already resolved — reconcileIncidents() always starts a reopened key at occurrences 1).
      const newlyOpened = changed.filter((i) => !i.resolvedAt && i.occurrences === 1);
      const newlyResolved = changed.filter((i) => i.resolvedAt);
      await sendArgosAlerts(env, newlyOpened, newlyResolved);
    }
    const byKey = new Map(existing.map((i) => [i.key, i]));
    for (const i of changed) byKey.set(i.key, i);
    return [...byKey.values()].filter((i) => !i.resolvedAt);
  } catch (e) {
    console.error(`[apf-gateway] reconcileAndPersistIncidents failed (non-fatal, /farm still renders): ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** byWorker/byCapability pass/total, derived from the merged fixture state — skipped fixtures never count
 * toward either (matches self-test's own report header, "58/72 fixtures prošlo — 10 přeskočeno"). */
function selfTestAggregates(summary: SelfTestSummary | undefined): { byWorker: Record<string, { passed: number; total: number }>; byCapability: Record<string, { passed: number; total: number }> } {
  const byWorker: Record<string, { passed: number; total: number }> = {};
  const byCapability: Record<string, { passed: number; total: number }> = {};
  for (const f of summary?.fixtures ?? []) {
    if (f.skipped) continue;
    const w = (byWorker[f.worker] ??= { passed: 0, total: 0 });
    w.total += 1;
    if (f.ok) w.passed += 1;
    const c = (byCapability[f.capability] ??= { passed: 0, total: 0 });
    c.total += 1;
    if (f.ok) c.passed += 1;
  }
  return { byWorker, byCapability };
}

const MAX_TEXT_CHARS = 1_000_000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_MAIL_CHARS = 1_000_000;
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

interface MailIntakeInput {
  workflowId: string;
  tenantId: string;
  rawMail: string;
  receivedFrom: string;
  notifyRef: string;
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
      emailExecutor: this.env.EMAIL_EXECUTOR,
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
    await this.rearmReviewAlarm();
    return this.view() as InstanceView;
  }

  /**
   * mail-intake's step 1 (mail.ingest) creates the artifact itself — unlike intake(), there is no original to
   * put() upfront here (SEVERKA.md item 3: second real write-type, first event-driven case).
   */
  async mailIntake(input: MailIntakeInput): Promise<InstanceView> {
    if (this.journal.list().length > 0) throw new Error(`instance ${input.workflowId} already exists`);
    const wiring = this.wiring();
    const orchestrator = this.orchestratorFor(workflowDef("mail-intake"), wiring);
    const inst = orchestrator.start(
      { tenantId: input.tenantId, rawMail: input.rawMail, receivedFrom: input.receivedFrom, notifyRef: input.notifyRef, ...(input.stampText ? { stampText: input.stampText } : {}) },
      undefined,
      input.workflowId,
    );
    this.audit.append({
      kind: "state",
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      tenantId: inst.tenantId,
      details: { status: "RUNNING", receivedFrom: input.receivedFrom, signing: wiring.signing, keyId: wiring.keyId },
    });
    await orchestrator.run(inst.workflowId);
    this.ctx.waitUntil(this.copyOut());
    await this.rearmReviewAlarm();
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
  async selfTest(only?: { capability?: string; worker?: string }): Promise<SelfTestRow[]> {
    return runSelfTest({
      transport: this.wiring().transport,
      artifacts: this.artifacts,
      clock: this.clock,
      defaultActor: installation.profile.roles.orchestrator,
      deadlineMs: 60_000,
      only,
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
   * WF-REV-003 time-based expiry (found 2026-09-09, docs/SEVERKA.md Human Review row): `orchestrator
   * .applyReviewExpiries()` and `review.expire()` existed and were tested since (50), but nothing on the farm ever
   * called them — decide() worked, but a review nobody decided on just sat there past its deadline. A single global
   * `scheduled()` cron can't do it: there is no directory of "every WorkflowInstance currently WAITING(REVIEW)",
   * each one is its own Durable Object. So each instance arms its own alarm for its own open review's deadline
   * instead — no new registry, no change to the frozen contracts.
   */
  private async rearmReviewAlarm(): Promise<void> {
    const openDeadlines = this.reviewStore.all().filter((t) => t.status === "OPEN").map((t) => Date.parse(t.expiresAt));
    if (openDeadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...openDeadlines));
  }

  /** Fires at the earliest open review's deadline (armed by rearmReviewAlarm()). ESCALATE keeps the instance waiting
   * on a new task with a later deadline, so the alarm re-arms itself for that one too. */
  async alarm(): Promise<void> {
    const inst = this.journal.list()[0];
    if (!inst) return;
    const wiring = this.wiring();
    const orchestrator = this.orchestratorFor(workflowDef(inst.workflow), wiring);
    orchestrator.applyReviewExpiries();
    this.ctx.waitUntil(this.copyOut());
    await this.rearmReviewAlarm();
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
    // Authorization must come from the actor's own identity (tenant + granted scopes), never from
    // task.requiredRole itself (found by external review 2026-09-09: the old code passed
    // `role: task.requiredRole` straight into ReviewService.decide(), so its own
    // `task.requiredRole !== by.role` check compared a value against itself — always true, never a
    // real check). `installation.profile.identities` today only lists svc-*/ai-* actors; a human
    // reviewer must be added there with the scopes they actually hold before they can decide anything.
    if (!new IdentityProvider(installation.profile.identities).authorizeRole(actorId, task.tenantId, task.requiredRole)) {
      this.audit.append({
        kind: "security",
        tenantId: task.tenantId,
        actorId,
        correlationId: task.correlationId,
        details: { code: "REVIEW_ROLE_NOT_AUTHORIZED", reviewTaskId, requiredRole: task.requiredRole },
      });
      throw new Error(`actor ${actorId} is not authorized for role ${task.requiredRole} in tenant ${task.tenantId}`);
    }
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
    await this.rearmReviewAlarm();
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

interface MailIntakeRequest {
  rawMail: string;
  receivedFrom: string;
  /** Who to notify once processing finishes (recipientAllowlist ref) — an installation value, supplied by the
   * caller (apf-mail-ingest's own DEFAULT_NOTIFY_REF var), never a literal here (ARCH-DEP-001). */
  notifyRef: string;
}
type MailIntakeOutcome = { ok: true; workflowId: string } | { ok: false; code: string; message: string; detail?: Record<string, unknown> };

/**
 * The mail-intake equivalent of startIntake(): tenant resolved server-side (never trusted from the caller),
 * only apf-mail-ingest ever calls this (POST /mail-intake, not a public form) — SEVERKA.md item 3.
 */
async function startMailIntake(env: Env, req: MailIntakeRequest): Promise<MailIntakeOutcome> {
  if (env.KILL_SWITCH === "true") return { ok: false, code: "KILL_SWITCH", message: "Farma je vypnutá (KILL_SWITCH)." };
  const models = modelsOf(env);
  if ("error" in models) return { ok: false, code: "NO_MODEL", message: "Instalace nemá použitelný výchozí model; tok se nespustí (nikdy bez modelu).", detail: { error: models.error } };
  if (!req.rawMail.trim()) return { ok: false, code: "EMPTY_MAIL", message: "Prázdná zpráva." };
  if (req.rawMail.length > MAX_MAIL_CHARS) return { ok: false, code: "MAIL_TOO_LARGE", message: "Zpráva je moc velká.", detail: { max: MAX_MAIL_CHARS } };

  const workflowId = newId("wf");
  console.log(`[apf-gateway] mail-intake start workflowId=${workflowId} from=${req.receivedFrom}`);
  const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
  const t0 = Date.now();
  try {
    await stub.mailIntake({ workflowId, tenantId: intakeTenant(), rawMail: req.rawMail, receivedFrom: req.receivedFrom, notifyRef: req.notifyRef });
  } catch (e) {
    console.error(`[apf-gateway] mail-intake wiring threw workflowId=${workflowId} (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { ok: false, code: "WIRING_FAILED", message: "Zapojení platformy v objektu instance selhalo (fail-closed).", detail: { workflowId, error: String(e) } };
  }
  console.log(`[apf-gateway] mail-intake done workflowId=${workflowId} (${Date.now() - t0}ms)`);
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
  EMPTY_MAIL: 400,
  MAIL_TOO_LARGE: 413,
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
    // Agent Registry (SEVERKA.md item 4): the descriptor's own declared endpoint (endpoints.capabilities), read-only,
    // no live Router round-trip needed — document.classify/document.validate/mail.ingest run in-process here.
    if (url.pathname === "/capabilities") return Response.json({ deployable: "apf-gateway", capabilities: gatewayCatalog() });

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
      return Response.redirect(new URL("/farm#zadani", url).toString(), 303);
    }

    // "Farmář" (owner's own word for it): one page, health of all five deployables + the most recent workflow instances.
    if (url.pathname === "/farm" && request.method === "GET") {
      const rawLimit = Number(url.searchParams.get("limit"));
      const instanceLimit = [15, 30, 50, 100, 200].includes(rawLimit) ? rawLimit : 15;
      const instanceWindow = url.searchParams.get("window") ?? "";
      const [documentHost, emailExecutor, mailIngest, fakes, instances, log, inbox, stats, documentHostCaps, emailExecutorCaps, selfTestSummary] = await Promise.all([
        deployableInfo(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
        deployableInfo(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
        deployableInfo(env.MAIL_INGEST, "https://apf-mail-ingest.internal"),
        deployableInfo(env.FAKES, FAKES_ORIGIN),
        recentInstances(env, instanceLimit, windowSince(instanceWindow, new SystemClock())),
        auditLog(env, 50),
        inboxDetail(env),
        farmStats(env),
        capabilitiesOf(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
        capabilitiesOf(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
        latestSelfTestSummary(env),
      ]);
      // Admission Gate visibility (HANDOFF 70/71): the same LifecycleRegistry the Router enforces, read here only —
      // this page never writes it. Quarantining a module still means editing config/<installation>/lifecycle.json
      // and redeploying (a human decision with its own commit), not a button on this page.
      const selfTestAgg = selfTestAggregates(selfTestSummary);
      const fixturesOf = (predicate: (f: SelfTestFixtureState) => boolean): SelfTestFixtureState[] => (selfTestSummary?.fixtures ?? []).filter(predicate);
      const capabilities: CapabilityRow[] = [...gatewayCatalog(), ...documentHostCaps, ...emailExecutorCaps].map((c) => ({
        ...c,
        lifecycleStatus: installation.lifecycle.statusOf(c.module),
        selfTest: selfTestAgg.byCapability[c.capability],
        selfTestFixtures: fixturesOf((f) => f.capability === c.capability),
      }));
      const deployableName = (name: string): { name: string; selfTest: { passed: number; total: number } | undefined; selfTestFixtures: SelfTestFixtureState[] } => ({
        name,
        selfTest: selfTestAgg.byWorker[name],
        selfTestFixtures: fixturesOf((f) => f.worker === name),
      });
      const model: FarmModel = {
        installation: INSTALLATION,
        gitSha: env.GIT_SHA,
        gatewaySigning: signingMode(env),
        deployables: [
          { ...deployableName("apf-gateway"), ok: true, status: 200, body: { isolation: "self", wired: wiredOf(env) } },
          { ...deployableName("apf-document-host"), ...documentHost },
          { ...deployableName("apf-email-executor"), ...emailExecutor },
          { ...deployableName("apf-mail-ingest"), ...mailIngest },
          { ...deployableName("apf-fakes"), ...fakes },
        ],
        capabilities,
        instances,
        instanceLimit,
        instanceWindow,
        auditLog: log,
        inbox,
        workflows: [...WORKFLOW_NAMES],
        models: modelsOf(env),
        stats,
        selfTestAt: selfTestSummary?.updatedAt,
      };
      // Incident Store (HANDOFF 84 continued): reconcile this render's watchdog findings against persisted
      // incident state before rendering, so the Argos banner can show "poprvé viděno / kolikrát" instead of
      // findings looking freshly discovered on every page load.
      model.incidents = await reconcileAndPersistIncidents(env, model, iso(new SystemClock().now()));
      return html(renderFarm(model));
    }

    // Live self-test (owner's request 2026-09-08): a dedicated, fixed-name instance (SELF_TEST_WORKFLOW_ID, shape
    // wf-... so apf-document-host's artifact fetch-back resolves to it too) so it never pollutes "Poslední instance"
    // (recentInstances() excludes it explicitly) or clashes with a real document's workflowId; purgeable like any
    // instance at /workflow/wf-selftest/purge if its artifact store grows.
    if (url.pathname === "/farm/self-test" && request.method === "POST") {
      // Owner's request 2026-09-09: "chci vidět kontroly a i si je být schopen individuálně vyvolat" — an
      // Argos capability card or a Kravičky worker card can each post their own narrower run instead of
      // always the full 72-fixture suite.
      const only = { capability: url.searchParams.get("capability") ?? undefined, worker: url.searchParams.get("worker") ?? undefined };
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
      const rows = (await stub.selfTest(only.capability || only.worker ? only : undefined)) as SelfTestRow[];
      await recordSelfTestSummary(env, rows);
      return html(renderSelfTest(rows));
    }

    // Manual verification for the Argos alert wiring (HANDOFF 85) — "never deploy untested" for a real external
    // side effect means actually confirming an e-mail arrives, which nothing automated here can do. Goes through
    // the exact same sendArgosAlerts()/ArgosAlertPort path a real incident would (respects ARGOS_ALERT_MODE),
    // just with a synthetic IncidentRecord instead of a real one.
    if (url.pathname === "/farm/test-alert" && request.method === "POST") {
      if (!installation.profile.channels.operatorAlertTo) return Response.json({ error: "NO_ALERT_TO", message: "channels.operatorAlertTo not configured for this installation" }, { status: 400 });
      const now = iso(new SystemClock().now());
      const testIncident: IncidentRecord = { key: "test-alert", level: "WARN", text: "Testovací zpráva z /farm/test-alert — pokud tohle vidíš, doručení funguje.", firstSeenAt: now, lastSeenAt: now, occurrences: 1 };
      await sendArgosAlerts(env, [testIncident], []);
      return Response.json({ ok: true, mode: env.ARGOS_ALERT_MODE, to: installation.profile.channels.operatorAlertTo });
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
      return Response.redirect(new URL("/farm#zadani", url).toString(), 303);
    }

    // The two diagram pages from the repo root, bundled fresh at config-generation time (scripts/farm-config.mjs) —
    // requested by the owner so "jak to funguje" links to the real, already-maintained explanation instead of a new one.
    if (url.pathname === "/VYVOJOVY-DIAGRAM.html" && request.method === "GET") return html(VYVOJOVY_DIAGRAM_HTML);
    if (url.pathname === "/VYVOJOVY-DIAGRAM.en.html" && request.method === "GET") return html(VYVOJOVY_DIAGRAM_EN_HTML);
    // Same treatment (owner: "a proč to není v GUI?" — docs/MATICE-ODPOVEDNOSTI.md alone wasn't reachable from the console).
    if (url.pathname === "/MATICE-ODPOVEDNOSTI.html" && request.method === "GET") return html(MATICE_ODPOVEDNOSTI_HTML);

    // The "AI FARMA" illustration (owner's own concept art, embedded on /farm's Přehled) — a fixed asset in R2
    // (uploaded once via `wrangler r2 object put`, not through any app code path), cached hard since the object
    // never changes without a new key.
    if (url.pathname === "/farm/ilustrace.png" && request.method === "GET") {
      const obj = await env.ARTIFACTS.get("assets/farma-ilustrace.png");
      if (!obj) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
    }

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

    // Internal: only apf-mail-ingest's email() handler ever calls this, over the GATEWAY/MAIL_INGEST service
    // bindings — not a public form like /intake. Tenant is resolved server-side, never trusted from the caller.
    if (url.pathname === "/mail-intake" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as Partial<MailIntakeRequest> | undefined;
      if (!body?.rawMail || !body.receivedFrom || !body.notifyRef) return Response.json({ ok: false, code: "BAD_REQUEST", message: "expected { rawMail, receivedFrom, notifyRef }" }, { status: 400 });
      const result = await startMailIntake(env, { rawMail: body.rawMail, receivedFrom: body.receivedFrom, notifyRef: body.notifyRef });
      return Response.json(result, { status: result.ok ? 200 : (INTAKE_ERROR_STATUS[result.code] ?? 500) });
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
      // ?after=<at ISO>: ascending, strictly newer than the given record — the Deník live terminal's tail-f poll.
      // Without it: unchanged descending "latest N" (existing callers, existing behavior).
      const after = url.searchParams.get("after");
      const rows = after
        ? await env.AUDIT.prepare("SELECT json FROM audit WHERE at > ? ORDER BY at ASC LIMIT ?").bind(after, limit).all<{ json: string }>()
        : await env.AUDIT.prepare("SELECT json FROM audit ORDER BY at DESC LIMIT ?").bind(limit).all<{ json: string }>();
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
