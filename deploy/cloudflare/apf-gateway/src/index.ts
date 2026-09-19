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
import { WorkersAiExtractor } from "../../../../src/adapters/extract.js";
import type { SecretsSource } from "../../../../src/installation.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import { auditRowsToCsv, type AuditCsvRow } from "../../../../src/platform/audit-csv.js";
import { sha256Bytes, type Artifact } from "../../../../src/platform/artifacts.js";
import { fanOutAttachments, summarizeFanoutOutcomes, type AttachmentFanoutOutcome, type MailIngestAttachmentOutcome } from "../../../../src/platform/attachment-fanout.js";
import { addInstance, aggregateCaseStatus, newCase, type Case, type NormalizedImpulse } from "../../../../src/platform/case.js";
import { ImpulseError, normalizeImpulse } from "../../../../src/platform/impulse.js";
import { iso, SystemClock, type Clock } from "../../../../src/platform/clock.js";
import { platformError } from "../../../../src/platform/errors.js";
import { newId } from "../../../../src/platform/ids.js";
import { parseMimeMessage, sanitizeMimeFilename } from "../../../../src/platform/mime.js";
import type { CapabilityRecord } from "../../../../src/platform/registry.js";
import { isRunningStepStale, maxStepDeadlineMs, type Orchestrator, type WorkflowDef } from "../../../../src/platform/orchestrator.js";
import { CertificationRegistry, deriveLifecycleStatus, type CertificationRecord, type LifecycleStatus } from "../../../../src/platform/certification.js";
import { IdentityProvider } from "../../../../src/platform/gateway.js";
import type { Instance, InstanceStatus } from "../../../../src/platform/journal.js";
import { ReviewService, type Decision } from "../../../../src/platform/review.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { WORKFLOW_NAMES, workflowDef } from "../../../../src/platform/workflow.js";
import {
  acknowledgeIncident,
  auditClaimContradicts,
  composeIncidentAlert,
  computeWatchdog,
  reconcileIncidents,
  renderError,
  renderFarm,
  renderInstance,
  renderSelfTest,
  renderWorkshopSession,
  type ArgosAlertHealth,
  type AuditLogRow,
  type CapabilityRow,
  type FarmInstanceRow,
  type FarmModel,
  type FarmStats,
  type IncidentRecord,
  type InboxItem,
  type InstanceView,
  type ModelsInfo,
  type OpenWorkflowProblem,
  type SelfTestFixtureState,
  type SelfTestRow,
  type Wired,
} from "./page.js";
import { FACT_CATALOG } from "./fact-catalog-bundle.js";
import { DISCOVERY_INPUT_BUILDERS } from "./discovery-wiring.js";
import { runDiscovery } from "../../../../src/platform/discovery-runner.js";
import { projectCurrentCase } from "../../../../src/platform/case-projection.js";
import { resolveCaseGoal } from "../../../../src/platform/goal-mapping.js";
import { buildOrchestrator, checkWiringPreconditions, COW_WORKSHOP, describeModels, gatewayCatalog, modelAdapterFor, wirePlatform, type Wiring } from "./platform-wiring.js";
// RG2-E (2026-09-18): /live, /ready, /health/details — every decision is a pure function in readiness.ts (same
// "index.ts cannot load under vitest" reason as alarm-scheduler.ts/fanout-retry.ts); this file only supplies the
// I/O thunks (readinessProbes()/remoteHostProbes() below) and the three thin routes in fetch().
import { assessReadiness, boundedRead, buildHealthDetails, missingBindings, runProbes, summarizeSelfTest, summarizeWatchdog, trustedProvidersCheck, type ProbeSpec } from "./readiness.js";
import { runSelfTest, requiredTestsFor, selfTestCapabilityForTick, SELF_TEST_CAPABILITIES, SELF_TEST_WORKFLOW_ID } from "./self-test.js";
import { newSession, sendMessage, type WorkshopSession } from "./workshop.js";
import { D1_AUDIT_DDL, D1_EVIDENCE_DDL, D1_R2_REF_DDL, d1Sql, DDL, evidenceMirrorOf, evidenceStoreOf, r2RefCounterOf, SqliteArtifacts, SqliteAudit, SqliteCaseStore, SqliteDurableJobStore, SqliteFanoutJobStore, SqliteIdempotencyStore, SqliteJournal, SqliteReviewTaskStore } from "./store.js";
// R2R3 integration (18.9.2026 owner spec — see fanout-retry.ts's/alarm-scheduler.ts's own file-level doc comments
// for the full "why"): pure decision logic over the durable fanout_job row and the unified alarm scheduler, split
// out so both stay loadable under plain-Node vitest (this file imports "cloudflare:workers" two lines up and
// cannot be). fanoutNextWakeAt() itself is not called directly here any more — nextAlarmWakeMs() (alarm-
// scheduler.ts) is the one place that folds it into the three-source Math.min(...), so index.ts only ever needs
// its OWN two inputs (missingAttachments()/fanoutRetryDecision()) plus the combined result.
import { fanoutRetryDecision, missingAttachments, type CaseMemberSummary, type FanoutJobRecord } from "./fanout-retry.js";
import { nextAlarmWakeMs, runAlarmCycle } from "./alarm-scheduler.js";
import { registerDerived, type DerivedArtifactRegistration, type RegisterDerivedResult } from "./artifact-registration.js";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { verifyEvidence, type Evidence } from "../../../../src/platform/evidence.js";
import { mirrorEvidence } from "../../../../src/platform/evidence-mirror.js";
import { releaseR2Ref } from "../../../../src/platform/r2-refcount.js";
// RG2-A (2026-09-18): the ordering-safe artifact loop copyOut() (below) delegates to, plus the generic durable
// job primitive both it and (indirectly, via fanout-retry.ts) fan-out's own retry decision now share — see
// copyout-artifacts.ts's and durable-job.ts's own file-level doc comments for the P0 this closes and why each is
// its own file rather than a private WorkflowInstance method (same "cannot load cloudflare:workers under vitest"
// reason fanout-retry.ts/alarm-scheduler.ts already are).
import { copyOutArtifacts } from "../../../../src/platform/copyout-artifacts.js";
import { nextCopyoutJobRecord } from "../../../../src/platform/durable-job.js";
import type { SqliteEvidenceStore } from "../../../../src/platform/evidence-sqlite.js";
import type { ZlabStats } from "./page.js";
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

const cowWorkshopModelsOf = (env: Env, selectedKey: string | undefined): ModelsInfo => {
  try {
    return describeModels(installation, secretsOf(env), COW_WORKSHOP, selectedKey);
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

/** A remote deployable's own /capabilities (its declared endpoint, docs/SEVERKA.md "Agent Registry") — never
 * thrown. `ok: false` (HANDOFF 93, MAJOR 5 of the second external review) is distinct from "fetched fine, zero
 * capabilities": a fetch failure here used to silently return [], the same shape as a real empty answer, which
 * let a capability vanish from the model without anything actually saying so — buildFarmModel() uses `ok` to
 * keep that from reading as "no longer a problem" to reconcileIncidents(). */
const capabilitiesOf = async (fetcher: Fetcher, origin: string): Promise<{ ok: boolean; capabilities: CapabilityRecord[] }> => {
  try {
    const r = await fetcher.fetch(`${origin}/capabilities`);
    if (!r.ok) return { ok: false, capabilities: [] };
    const body = (await r.json().catch(() => undefined)) as { capabilities?: CapabilityRecord[] } | undefined;
    return body ? { ok: true, capabilities: body.capabilities ?? [] } : { ok: false, capabilities: [] };
  } catch {
    return { ok: false, capabilities: [] };
  }
};

/** R2 key /ready head()s — never written by anything; head() of an absent key answers null (reachable) and only
 * an unreachable bucket throws, so the probe is side-effect free. */
const READINESS_PROBE_R2_KEY = "readiness-probe";
/** Per-probe budgets (RG2-E): every probe runs concurrently (readiness.ts runProbes), so /ready's wall-clock is
 * bounded by the single slowest budget — 2 s — never their sum. Chosen, not measured: D1/R2 answer in tens of ms
 * when healthy, and a load balancer polling /ready needs an answer well under its own typical 5–10 s timeout. */
const READINESS_PROBE_TIMEOUT_MS = 2_000;
const REMOTE_HOST_PROBE_TIMEOUT_MS = 1_500;
/** Bindings a new Case cannot be accepted without — presence only, no call on any of them (readiness.ts
 * missingBindings). IMAGES/ARGOS_MAIL are deliberately absent: neither is on the intake path. */
const READINESS_REQUIRED_BINDINGS = ["AUDIT", "ARTIFACTS", "WORKFLOW", "AI", "DOCUMENT_HOST", "EMAIL_EXECUTOR", "MAIL_INGEST", "FAKES"] as const;

/**
 * /ready's REQUIRED probes (RG2-E) — "can I SAFELY accept a NEW Case right now?": the four things intake()/
 * mailIntake() touch synchronously before a Case exists (bindings, the object's D1 audit mirror, the R2 artifact
 * store, and the wiring that must construct inside the object). The kill switch is folded in by
 * assessReadiness() itself. Each thunk is one cheap call; readiness.ts bounds and catches every one of them.
 *
 * Remote hosts (DOCUMENT_HOST/EMAIL_EXECUTOR/MAIL_INGEST/FAKES) are NOT here on purpose — see remoteHostProbes().
 */
function readinessProbes(env: Env): ProbeSpec[] {
  return [
    {
      name: "bindings",
      required: true,
      timeoutMs: READINESS_PROBE_TIMEOUT_MS,
      run: () => {
        const missing = missingBindings(env as unknown as Record<string, unknown>, READINESS_REQUIRED_BINDINGS);
        if (missing.length > 0) throw new Error(`missing bindings: ${missing.join(", ")}`);
      },
    },
    {
      // READ-ONLY, deliberately: ensureD1Audit() (the DDL, cached after the first call) + `SELECT 1` prove the
      // database binding answers within budget. The first cut of this probe also did a fixed-row INSERT OR REPLACE
      // to prove D1 accepts writes; the RG2-E adversarial review (18.9.2026) showed why that cannot sit on a
      // load-balancer-polled path: the row's fresh `at` on EVERY poll pinned it to the top of the Deník (auditLog()
      // ORDER BY at DESC), re-emitted it on every /audit.json?after= live-tail poll and into every /audit.csv
      // export, and cost one D1 write per poll (~17k writes/day per poller at 5 s against D1's 100k/day free
      // quota) — the probe would have been the farm's single biggest writer. What a read-only probe CANNOT see
      // (a quota-exhausted / read-only D1) is named as such in readiness.ts's NOT_OBSERVABLE_GLOBALLY rather
      // than silently reported as fine; the first real write that fails surfaces per instance through that
      // object's own copyOut() durable-job retries (RG2-A).
      name: "d1-audit",
      required: true,
      timeoutMs: READINESS_PROBE_TIMEOUT_MS,
      run: async () => {
        await ensureD1Audit(env.AUDIT);
        await env.AUDIT.prepare("SELECT 1").first();
      },
    },
    {
      name: "r2-artifacts",
      required: true,
      timeoutMs: READINESS_PROBE_TIMEOUT_MS,
      run: () => env.ARTIFACTS.head(READINESS_PROBE_R2_KEY),
    },
    {
      // The DO-independent construction-time preconditions of wirePlatform() (platform-wiring.ts
      // checkWiringPreconditions — its doc comment says exactly which throw points it covers and why the real
      // wirePlatform() is not called from here: it needs this object's own ctx.storage.sql stores). Same inputs
      // WorkflowInstance.wiring() passes: the bundled installation, secretsOf(env), env.GATEWAY_SIGNING_KEY.
      name: "wiring-config",
      required: true,
      timeoutMs: READINESS_PROBE_TIMEOUT_MS,
      run: () => checkWiringPreconditions({ installation, secrets: secretsOf(env), signingKeyPem: env.GATEWAY_SIGNING_KEY }),
    },
  ];
}

/**
 * Best-effort, bounded GET of each bound Worker's own /health — reported by /health/details only, NEVER a /ready
 * blocker. A new Case can be safely accepted while a remote host is down: every dispatch to it goes through the
 * orchestrator's durable journal and, since RG2-A..D, a failed/unknown dispatch is retried from the object's own
 * alarm() (R2 recover(), R3/RG2-A durable jobs) or escalated to a human review task (RG2-D) — it is never lost.
 * Refusing intake because apf-document-host is momentarily unreachable would turn a self-healing delay into a
 * client-visible outage. Non-required, so assessReadiness() lists them without letting them flip `ready`.
 */
function remoteHostProbes(env: Env): ProbeSpec[] {
  const probe = (name: string, fetcher: Fetcher | undefined, origin: string): ProbeSpec => ({
    name,
    required: false,
    timeoutMs: REMOTE_HOST_PROBE_TIMEOUT_MS,
    run: async () => {
      if (!fetcher) throw new Error("binding missing");
      const r = await fetcher.fetch(`${origin}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
  });
  return [
    probe("apf-document-host", env.DOCUMENT_HOST, "https://apf-document-host.internal"),
    probe("apf-email-executor", env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
    probe("apf-mail-ingest", env.MAIL_INGEST, "https://apf-mail-ingest.internal"),
    probe("apf-fakes", env.FAKES, FAKES_ORIGIN),
  ];
}

/** /ready's answer (RG2-E): every required probe concurrently, assessed by readiness.ts. Never throws. Runs the
 * probes even while KILL_SWITCH=true (the switch is then the first blocker): every probe is read-only and cheap
 * (one SELECT 1, one R2 head(), two synchronous checks), and an operator about to lift the switch wants
 * /health/details to already say whether the farm would be ready once it is off. */
async function readinessReport(env: Env) {
  return assessReadiness(await runProbes(readinessProbes(env)), { killSwitch: env.KILL_SWITCH === "true", gitSha: env.GIT_SHA, installation: INSTALLATION });
}

/**
 * Reliability Gate R4's config gap, made visible (RG2-E adversarial review, 18.9.2026): WorkflowInstance.wiring()
 * below passes NO `ares`/`mojeDane` adapter to wirePlatform() — the gateway has no real ARES / MOJE daně client
 * yet — so on an installation whose profile has not opted into the fakes (allowUnconfiguredTrustedProviders)
 * every cz.company.verify / cz.vat.verify dispatch FAILs TRUSTED_PROVIDER_NOT_CONFIGURED, permanently, by design
 * (platform-wiring.ts's aresFor()/mojeDaneFor(): loud and named, never a fabricated answer; and never a
 * construction-time throw, so checkWiringPreconditions() cannot and must not cover it). That is NOT a readiness
 * blocker — a new Case is accepted and two capabilities degrade — so it is reported by /health/details only, as
 * a non-required check (readiness.ts trustedProvidersCheck). The `false` here is the single source of truth for
 * "no real adapter wired"; the day wiring() passes a real adapter, flip it in the same commit
 * (tests/gw-readiness.test.ts traps wiring() against passing `ares:`/`mojeDane:` while this stays false).
 */
const GATEWAY_WIRES_REAL_TRUSTED_PROVIDERS = false;

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

const CERTIFICATION_STATE_PREFIX = "certification-state:";

/**
 * Admission Gate, made real (docs/POSUDKY.md Posudek 16 — "kde se zadává nová kráva?"). `CertificationRegistry`
 * (src/platform/certification.ts) is a pure, in-memory primitive; a stateless Worker has nowhere to keep its Map
 * across requests, so this derives one build-bound `CertificationRecord` per call (a throwaway registry instance
 * is fine — `certify()`'s decision logic is a pure function of its input) and persists JUST that record here,
 * same fixed-row `INSERT OR REPLACE` + append-only history idiom as `recordSelfTestSummary` above. `requiredTests`
 * comes ONLY from `requiredTestsFor()` (self-test.ts) — the platform's own conformance suite for this exact
 * capability — never from a query param or request body, closing Posudek 16 P1-9 for the one real caller that
 * exists today.
 */
function certifyFromSelfTest(input: { module: string; capability: string; riskProfile: string; buildHash: string; rows: SelfTestRow[]; clock: Clock }): CertificationRecord {
  const requiredTests = requiredTestsFor(input.capability);
  const actualResults: Record<string, "PASS" | "FAIL"> = {};
  for (const r of input.rows) if (!r.skipped) actualResults[r.id] = r.ok ? "PASS" : "FAIL";
  return new CertificationRegistry(input.clock).certify({
    module: input.module,
    capability: input.capability,
    buildHash: input.buildHash,
    riskProfile: input.riskProfile,
    requiredTests,
    actualResults,
  });
}

async function recordCertification(env: Env, record: CertificationRecord): Promise<void> {
  await ensureD1Audit(env.AUDIT);
  const insertHistory = env.AUDIT.prepare(
    "INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(newId("aud"), record.certifiedAt, "certification-check", null, null, null, "admission-gate", record.capability, JSON.stringify(record));
  const upsertState = env.AUDIT.prepare(
    "INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(`${CERTIFICATION_STATE_PREFIX}${record.capability}`, record.certifiedAt, "certification-state", null, null, null, "admission-gate", record.capability, JSON.stringify(record));
  await env.AUDIT.batch([upsertState, insertHistory]);
}

/** Every capability's last-known certification, keyed by capability — empty for a capability never certified. */
async function latestCertifications(env: Env): Promise<Record<string, CertificationRecord>> {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare("SELECT json FROM audit WHERE kind = ?").bind("certification-state").all<{ json: string }>();
  const out: Record<string, CertificationRecord> = {};
  for (const row of rows.results ?? []) {
    const record = JSON.parse(row.json) as CertificationRecord;
    out[record.capability] = record;
  }
  return out;
}

// Nastavení (owner's request 2026-09-14, over "kde se zadává nová kráva"): the farm's first runtime-editable
// setting. "cow.workshop" (COW_WORKSHOP) rides installation.ts's existing profile.models mechanism for its
// catalog and fail-closed default; this D1 row only overrides WHICH of those options is currently selected —
// never invents a new provider/credential, never bypasses modelTable()'s own "unavailable options are shown,
// never used" guarantee. Same fixed-row idiom as self-test-state/certification-state above.
const SETTINGS_COW_WORKSHOP_MODEL_AUDIT_ID = "settings:cow-workshop-model";

async function latestCowWorkshopModelKey(env: Env): Promise<string | undefined> {
  await ensureD1Audit(env.AUDIT);
  const row = await env.AUDIT.prepare("SELECT json FROM audit WHERE audit_id = ?").bind(SETTINGS_COW_WORKSHOP_MODEL_AUDIT_ID).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as { key: string }).key : undefined;
}

async function setCowWorkshopModelKey(env: Env, key: string, now: string): Promise<void> {
  await ensureD1Audit(env.AUDIT);
  await env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(SETTINGS_COW_WORKSHOP_MODEL_AUDIT_ID, now, "settings", null, null, null, "operator", null, JSON.stringify({ key }))
    .run();
}

// Kravská dílna sessions (owner's request 2026-09-14) — one D1 row per session, kind "cow-workshop-session",
// audit_id = sessionId (so a single session is a direct-key read, same as certification-state's per-capability
// key), never mutated in place from outside sendMessage()'s own append-only history. No separate table: this IS
// what the shared `audit` table is for (self-test-state/certification-state/settings already use it the same
// way) — a session is just a JSON blob keyed by its own id, nothing relational about it.
const WORKSHOP_SESSION_KIND = "cow-workshop-session";
const workshopSessionAuditId = (sessionId: string): string => `${WORKSHOP_SESSION_KIND}:${sessionId}`;

async function saveWorkshopSession(env: Env, session: WorkshopSession): Promise<void> {
  await ensureD1Audit(env.AUDIT);
  await env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(workshopSessionAuditId(session.sessionId), session.updatedAt, WORKSHOP_SESSION_KIND, null, null, null, "operator", null, JSON.stringify(session))
    .run();
}

async function getWorkshopSession(env: Env, sessionId: string): Promise<WorkshopSession | undefined> {
  await ensureD1Audit(env.AUDIT);
  const row = await env.AUDIT.prepare("SELECT json FROM audit WHERE audit_id = ?").bind(workshopSessionAuditId(sessionId)).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as WorkshopSession) : undefined;
}

/** Newest first — the session list Kravská dílna's own tab shows. */
async function listWorkshopSessions(env: Env): Promise<WorkshopSession[]> {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare("SELECT json FROM audit WHERE kind = ? ORDER BY at DESC").bind(WORKSHOP_SESSION_KIND).all<{ json: string }>();
  return (rows.results ?? []).map((r) => JSON.parse(r.json) as WorkshopSession);
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

const ARGOS_ALERT_HEALTH_AUDIT_ID = "argos-alert-health";

/** Current alerting channel health, or undefined if no send has ever been attempted on this installation. */
async function latestAlertHealth(env: Env): Promise<ArgosAlertHealth | undefined> {
  await ensureD1Audit(env.AUDIT);
  const row = await env.AUDIT.prepare("SELECT json FROM audit WHERE audit_id = ?").bind(ARGOS_ALERT_HEALTH_AUDIT_ID).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as ArgosAlertHealth) : undefined;
}

/** Records one send attempt's outcome (HANDOFF 92, MAJOR 3 of the second external review) — same fixed-row
 * INSERT OR REPLACE idiom as self-test-state, so this is what lets computeWatchdog() notice "Argos itself
 * can't speak" instead of that only ever reaching a Workers Logs console.error nobody is tailing. */
async function recordAlertHealth(env: Env, outcome: { ok: true } | { ok: false; reason: string }, now: string): Promise<void> {
  const existing = await latestAlertHealth(env);
  const health: ArgosAlertHealth = {
    lastAttemptAt: now,
    lastSuccessAt: outcome.ok ? now : existing?.lastSuccessAt,
    lastFailureAt: outcome.ok ? existing?.lastFailureAt : now,
    lastFailureReason: outcome.ok ? existing?.lastFailureReason : outcome.reason,
  };
  await env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(ARGOS_ALERT_HEALTH_AUDIT_ID, now, "argos-alert-health", null, null, null, "argos", null, JSON.stringify(health))
    .run();
}

/** Sends the alert e-mail for whatever reconcileAndPersistIncidents() found new this run, if `channels.
 * operatorAlertTo` is configured. Best-effort for the page rendering it triggered from (a send failure must
 * never break that), but NOT silent otherwise (HANDOFF 92): every actual attempt records its outcome via
 * recordAlertHealth(), which computeWatchdog() reads back — so a broken alert channel becomes its own
 * "alert-channel" finding (and, once the channel recovers, its own resolved-alert e-mail) instead of only ever
 * reaching a console.error, the exact class of failure HANDOFF 87 found live by accident. */
async function sendArgosAlerts(env: Env, newlyOpened: IncidentRecord[], newlyResolved: IncidentRecord[], now: string): Promise<void> {
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
    await recordAlertHealth(env, { ok: true }, now);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[apf-gateway] sendArgosAlerts failed (non-fatal): ${reason}`);
    await recordAlertHealth(env, { ok: false, reason }, now).catch((e2) => console.error(`[apf-gateway] recordAlertHealth itself failed: ${e2 instanceof Error ? e2.message : String(e2)}`));
  }
}

/**
 * Incident Store (oponentura item 2, HANDOFF 84 continued): turns this render's watchdog findings into
 * persisted incident state — page.ts's reconcileIncidents() decides what changed, this just reads/writes it.
 * Runs on every GET /farm AND on every scheduled self-test tick (HANDOFF 88), reusing the FarmModel already
 * assembled for that caller — no extra fetches. Best-effort: a D1 hiccup here must never break the page or the
 * scheduled tick it's reporting on.
 */
async function reconcileAndPersistIncidents(env: Env, model: FarmModel, now: string): Promise<IncidentRecord[]> {
  try {
    await ensureD1Audit(env.AUDIT);
    const existing = await allIncidents(env);
    const changed = reconcileIncidents(existing, computeWatchdog(model).findings, now, model.capabilities.map((c) => c.capability));
    if (changed.length > 0) {
      const stmt = env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      await env.AUDIT.batch(changed.map((i) => stmt.bind(watchdogIncidentAuditId(i.key), now, WATCHDOG_INCIDENT_KIND, null, null, null, "argos", null, JSON.stringify(i))));
      // "New to us" = first occurrence (whether truly first-ever, or a fresh incident after a prior one with the
      // same key already resolved — reconcileIncidents() always starts a reopened key at occurrences 1).
      const newlyOpened = changed.filter((i) => !i.resolvedAt && i.occurrences === 1);
      const newlyResolved = changed.filter((i) => i.resolvedAt);
      await sendArgosAlerts(env, newlyOpened, newlyResolved, now);
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

/**
 * Once-per-isolate DDL, but never a cached failure: a rejected promise kept in the module variable would poison every
 * later call in this isolate (copyOut, /farm) for the isolate's whole life. Found live 15. 9. 2026 (HANDOFF 166) with
 * the evidence DDL — the same shape protects the audit DDL too.
 */
const oncePerIsolate = (run: () => Promise<void>): (() => Promise<void>) => {
  let ready: Promise<void> | undefined;
  return () =>
    (ready ??= run().catch((e: unknown) => {
      ready = undefined;
      throw e;
    }));
};
let ensureAudit: (() => Promise<void>) | undefined;
const ensureD1Audit = (db: D1Database): Promise<void> => (ensureAudit ??= oncePerIsolate(async () => void (await db.prepare(D1_AUDIT_DDL).run())))();
/** Durable Žlab's shared copy (M0 D-5): the evidence_mirror table in the same D1 as the audit trail. Sequential on purpose — the index must see the table. */
let ensureEvidence: (() => Promise<void>) | undefined;
const ensureD1Evidence = (db: D1Database): Promise<void> =>
  (ensureEvidence ??= oncePerIsolate(async () => {
    for (const stmt of D1_EVIDENCE_DDL) await db.prepare(stmt).run();
  }))();
/**
 * Shared D1 r2_ref table (Reliability Gate R0, commit 1d465dd — see src/platform/r2-refcount.ts's header): same
 * once-per-isolate-but-never-a-cached-failure guard as ensureD1Audit/ensureD1Evidence just above, for the same
 * reason (HANDOFF 166) — a rejected DDL promise cached forever would poison every later copyOut()/purge() call in
 * this isolate's whole life.
 */
let ensureR2Ref: (() => Promise<void>) | undefined;
const ensureD1R2Ref = (db: D1Database): Promise<void> => (ensureR2Ref ??= oncePerIsolate(async () => void (await db.prepare(D1_R2_REF_DDL).run())))();

/** Žlab as seen from the shared D1 copy: counts and domains only — never a value, never a result. */
async function zlabStats(env: Env): Promise<ZlabStats> {
  await ensureD1Evidence(env.AUDIT);
  const rows = await d1Sql(env.AUDIT).all("SELECT authority_domain AS domain, COUNT(*) AS records, MAX(observed_at) AS last FROM evidence_mirror GROUP BY authority_domain ORDER BY records DESC, domain");
  const byDomain = rows.map((r) => ({ domain: (r.domain as string | null) ?? "inferred", records: Number(r.records), last: String(r.last) }));
  return { total: byDomain.reduce((n, d) => n + d.records, 0), byDomain };
}

/** One Durable Object per workflow instance: its SQLite is the journal, the audit and the artifact store of that instance. */
/**
 * R2 (2026-09-18 reliability audit, "recover() exists but the live gateway never calls it"): the pessimistic
 * pre-arm in intake()/mailIntake()/decideReview() below arms the backstop alarm BEFORE buildMessage()
 * (src/platform/orchestrator.ts) has durably written the step's own precise `notValidAfter` — both happen inside
 * the same synchronous call on the same isolate, so the real gap this margin covers is sub-millisecond. 60s is
 * generous slack over that, and negligible against the 10–30 minute real workflow deadlines (workflows/mail-
 * intake.v3.json:6/65, workflows/document-intake.v2.json:6): worst case, a crash in that impossibly narrow window
 * before the precise write delays detection by at most this margin, not by the full workflow deadline.
 */
const STUCK_ALARM_SAFETY_MARGIN_MS = 60_000;

/** runCaseDiscovery()'s own single transport.dispatch() deadline — generous for one LLM call (intent.resolve),
 * same order of magnitude as document.classify's own step deadline in workflows/document-intake.v2.json. */
const DISCOVERY_DEADLINE_MS = 2 * 60_000;

/**
 * Follow-up fix, R2R3 integration (adversarial review, 18.9.2026 — see this commit's own message): `recover()`'s
 * cascade (src/platform/orchestrator.ts's `run()` loop, one real `transport.dispatch()` per remaining step) and
 * `maybeRetryFanoutJob()`'s cascade (`fanOutAttachmentsIfAny()`, one real dispatch per attachment) each have no
 * time budget of their own. Before this fix, alarm()'s deliberate recovery-then-fanout-then-reviews reordering
 * (see alarm()'s own doc comment below) meant a slow cascade in either of the first two steps could delay — in
 * the worst case, starve entirely, if the isolate's own CPU/wall-clock budget ran out first — the third step
 * (`applyReviewExpiries()`) and even the `finally` block's `rearmAlarm()` from getting a turn in the SAME tick. A
 * silently-skipped review-expiry check (not merely a delayed one) is exactly the WF-REV-003 regression this
 * integration must not introduce; the pre-integration ordering never had this exposure because reviews ran
 * first, unconditionally, before either cascade could run at all.
 *
 * withTimeout() (src/platform/api.ts) already races each individual dependency call further down in these same
 * cascades against a budget WITHOUT cancelling the underlying operation — an accepted, already-shipped
 * characteristic of this codebase (cz-vat-verify/cz-company-verify/document-classifier/document-validator's own
 * handler.ts callers all rely on exactly this). This constant applies the identical discipline one layer up, at
 * the whole-subsystem boundary runAlarmTick() (alarm-scheduler.ts) already isolates in its own try/catch: passed
 * below as `runAlarmTick(..., { subsystemBudgetMs: ALARM_SUBSYSTEM_BUDGET_MS })`, it is runAlarmTick() itself
 * (via its own internal `bounded()` helper) that races `recover`/`retryFanout` against this budget — kept there,
 * not duplicated here per callback, so the SAME bound this doc comment describes is also the one
 * tests/gw-alarm-scheduler.test.ts exercises directly against the real function alarm() calls. A hung recovery
 * or fan-out cascade now always yields its turn within this budget, so fan-out/reviews/rearmAlarm still run in
 * the same tick regardless of how long the abandoned cascade keeps executing in the background.
 * Residual, deliberately-accepted risk (same class as maybeRetryFanoutJob()'s own "a previous pass cannot be
 * ruled out with certainty" note above it): because Workers has no cheap way to truly cancel an in-flight
 * `transport.dispatch()` short of threading an AbortSignal through every component's handler.ts contract (a much
 * larger change than this integration's scope), the abandoned cascade's later SQLite writes can still land after
 * fan-out/reviews have already run in the same tick. Those writes are scoped to state the timed-out subsystem
 * itself owns (recover()'s own journal row, maybeRetryFanoutJob()'s own fanout_job row) and every store here is
 * already designed to be read fresh and reconciled on the next tick (rearmAlarm() below never trusts a snapshot),
 * so this is a bounded, self-healing residual risk, not a data-loss one — flagged for a human reviewer with real
 * Workers AI latency numbers, same "explicit judgment call" status as FANOUT_RETRY_GRACE_MS below.
 */
const ALARM_SUBSYSTEM_BUDGET_MS = 20_000;

export class WorkflowInstance extends DurableObject<Env> {
  private readonly clock = new SystemClock();
  private readonly journal: SqliteJournal;
  private readonly audit: SqliteAudit;
  private readonly artifacts: SqliteArtifacts;
  private readonly reviewStore: SqliteReviewTaskStore;
  /** Durable Žlab of this object (M0 D-5): sealed evidence in the same SQLite, mirrored to D1 by copyOut(). */
  private readonly evidenceStore: SqliteEvidenceStore;
  /** Case wiring (Commit 3): groups this object's own mail-intake instance with its fanned-out attachment-
   * classify/attachment-extract instances — DO-local only, same as `journal`, no D1 mirror (store.ts's DDL comment). */
  private readonly caseStore: SqliteCaseStore;
  /** R1 (Reliability Gate, 2026-09-18): backs mail.ingest's ExecutorHost dedup durably across this object's own
   * restart — see store.ts's `idempotency` DDL comment for the full citation trail (executor-host.ts:90's
   * in-memory fallback, orchestrator.ts:245's key shape, what this deliberately does not fix). DO-local only,
   * same reasoning as `caseStore`/`journal` above: a reservation is scoped to the instance that made it. */
  private readonly idempotency: SqliteIdempotencyStore;
  /** Durable outbox for the attachment fan-out background task (Reliability Gate R3, 18.9.2026 owner audit) — see
   * fanout-retry.ts's file-level doc comment and store.ts's `fanout_job` DDL comment for the full "why". */
  private readonly fanoutJobStore: SqliteFanoutJobStore;
  /** Durable outbox for copyOut()'s own outstanding-work tracking (Reliability Gate RG2-A, 2026-09-18) — see
   * copyout-artifacts.ts's/durable-job.ts's file-level doc comments and store.ts's `durable_job` DDL comment for
   * the full "why". Always read/written with `kind: "copyout"` (this.COPYOUT_JOB_KIND below); the table's PK is
   * multi-kind-ready for a future job this object might also track this way. */
  private readonly copyoutJobStore: SqliteDurableJobStore;
  private static readonly COPYOUT_JOB_KIND = "copyout";
  /** How long a PENDING copyout-job row must sit untouched before an alarm tick is willing to retry it (RG2-A) —
   * same "explicit judgment call, not measured" status as FANOUT_RETRY_GRACE_MS below, but deliberately much
   * shorter: copyOut() only ever does D1/R2 calls, never a real Workers AI model call, so there is far less
   * concern about a redundant concurrent retry being expensive or racy — the risk this grace period guards
   * against is only "don't hammer D1/R2 every single tick", not "don't double-run an AI model". */
  private static readonly COPYOUT_RETRY_GRACE_MS = 60_000;
  /**
   * How long a PENDING fanout_job row must sit untouched before an alarm tick is willing to retry it (R3). Chosen,
   * not measured: this codebase has no live Workers AI latency data for a many-attachment mail's worst-case
   * classify+extract time as of writing (18.9.2026) — too short risks a redundant concurrent retry racing a
   * still-legitimately-running first attempt (see fanoutRetryDecision()'s own "wait" doc comment in
   * fanout-retry.ts); too long delays recovery from a genuine crash/eviction. Explicit and testable on purpose so
   * it can be retuned in one place once real latency data exists — flagged as an open item for a human reviewer
   * with production Workers AI numbers, same as this item's own judged patch plan flagged it.
   */
  private static readonly FANOUT_RETRY_GRACE_MS = 5 * 60_000;
  /** How many PENDING passes (the initial attempt plus alarm()-driven retries) a fan-out job gets before
   * maybeRetryFanoutJob() gives up on it (R3) — same "explicit judgment call, not measured" status as
   * FANOUT_RETRY_GRACE_MS above; a human reviewer should confirm or retune both before this reaches production. */
  private static readonly FANOUT_MAX_ATTEMPTS = 5;
  /** Same-isolate-only double-fire guard for maybeRetryFanoutJob() (R3) — NOT what protects against a genuine
   * cross-eviction overlap (two different isolates both deciding "retry" for the same stale row): that protection
   * is the durable attempts+updatedAt/grace-period check in fanoutRetryDecision() itself, which survives this
   * boolean resetting to false on every fresh isolate. This is only here so one isolate's own alarm() tick and a
   * concurrent request into fanOutAttachmentsIfAny() (there isn't one today — mailIntake() is the only other
   * caller, and it only ever runs once per instance — but a future caller might add one) cannot both decide
   * "retry" on top of each other in the same running object. */
  private fanoutRetryInFlight = false;
  private wiringCache: Wiring | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const stmt of DDL) ctx.storage.sql.exec(stmt);
    this.journal = new SqliteJournal(ctx.storage.sql);
    this.audit = new SqliteAudit(ctx.storage.sql, this.clock);
    this.artifacts = new SqliteArtifacts(ctx.storage.sql, this.clock);
    this.reviewStore = new SqliteReviewTaskStore(ctx.storage.sql);
    this.evidenceStore = evidenceStoreOf(ctx.storage.sql);
    this.caseStore = new SqliteCaseStore(ctx.storage.sql);
    this.idempotency = new SqliteIdempotencyStore(ctx.storage.sql, this.clock);
    this.fanoutJobStore = new SqliteFanoutJobStore(ctx.storage.sql);
    this.copyoutJobStore = new SqliteDurableJobStore(ctx.storage.sql);
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
      evidence: { store: this.evidenceStore, buildHash: this.env.GIT_SHA },
      idempotency: this.idempotency,
      notWired: (m, a) => notWired.dispatch(m, a),
    });
    return this.wiringCache;
  }

  async intake(input: IntakeInput): Promise<InstanceView> {
    if (this.journal.list().length > 0) throw new Error(`instance ${input.workflowId} already exists`);
    // R2 (2026-09-18 reliability audit): a pessimistic backstop, armed before dispatch can even start, so a crash
    // between here and orchestrator.run()'s own precise buildMessage() write (src/platform/orchestrator.ts) is
    // still bounded — see rearmAlarm()'s doc comment below for why this is safe to layer on top of the existing
    // review-deadline arming rather than a second, competing alarm mechanism (a DO has exactly one).
    await this.rearmAlarm(this.clock.now().getTime() + maxStepDeadlineMs(workflowDef(input.workflow)) + STUCK_ALARM_SAFETY_MARGIN_MS);
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
    await this.rearmAlarm();
    return this.view() as InstanceView;
  }

  /**
   * mail-intake's step 1 (mail.ingest) creates the artifact itself — unlike intake(), there is no original to
   * put() upfront here (SEVERKA.md item 3: second real write-type, first event-driven case).
   */
  async mailIntake(input: MailIntakeInput): Promise<InstanceView> {
    if (this.journal.list().length > 0) throw new Error(`instance ${input.workflowId} already exists`);
    // R2 (2026-09-18 reliability audit): same pessimistic backstop as intake() above, armed before this event-
    // driven flow's own dispatch can start.
    await this.rearmAlarm(this.clock.now().getTime() + maxStepDeadlineMs(workflowDef("mail-intake")) + STUCK_ALARM_SAFETY_MARGIN_MS);
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
    // Case wiring (Commit 3): synchronous, unlike fan-out below — building the NormalizedImpulse and the fresh
    // Case is pure local SQLite work (no AI call, no remote host), so there is no reason to defer it to
    // ctx.waitUntil() and risk GET /case/:id.json 404ing for a window after mailIntake() already answered.
    this.createCaseForMailIntake(inst.workflowId, inst.tenantId);
    // R3 (18.9.2026 owner audit): the durable outbox row is written HERE — synchronously, in the same critical
    // section as createCaseForMailIntake()'s own synchronous SQLite write, BEFORE ctx.waitUntil() schedules the
    // background fan-out task below — so that a crash between this line and the background task actually
    // starting still leaves a PENDING row for a later alarm() tick to find and resume (RES-CRASH-001 discipline:
    // durable before the next call, same rule store.ts's own DDL comments hold every other write in this object
    // to). Only written when there is actually something to fan out — mailIngestPayload() here duplicates the
    // same read fanOutAttachmentsIfAny() below will do a moment later (both need the same journal read; there is
    // no cheaper way to know "will there be attachments" before that method runs), and if `attachments.length` is
    // 0 there, fanOutAttachmentsIfAny() itself returns immediately with nothing to retry — no job row needed.
    const fanoutIngest = this.mailIngestPayload(inst.workflowId);
    if ((fanoutIngest?.attachments.length ?? 0) > 0) {
      const fanoutCaseId = this.caseStore.byWorkflowId(inst.workflowId)?.caseId;
      // fanoutCaseId should always resolve here — createCaseForMailIntake() just ran unconditionally above and
      // requires nothing beyond what mailIngestPayload() itself already required to be non-empty. Guarded rather
      // than asserted (matches fanOutAttachmentsIfAny()'s own "fail-closed, audited guard against an invariant
      // somehow not holding" discipline a few methods down): no caseId means no durable outbox row can be
      // written (case_id is NOT NULL), and fanOutAttachmentsIfAny() itself will hit its own no-Case SKIPPED
      // branch and audit the same condition a moment later — nothing is silently lost by skipping the write here.
      if (fanoutCaseId) {
        const now = iso(this.clock.now());
        this.fanoutJobStore.set({ workflowId: inst.workflowId, caseId: fanoutCaseId, status: "PENDING", attempts: 0, startedAt: now, updatedAt: now });
      }
    }
    this.ctx.waitUntil(this.copyOut());
    this.ctx.waitUntil(this.fanOutAttachmentsIfAny(inst.workflowId, inst.tenantId, inst.correlationId, wiring));
    await this.rearmAlarm();
    return this.view() as InstanceView;
  }

  /**
   * mail.ingest's own step result (payload shape: src/components/mail-ingest/handler.ts), read out of the journal
   * the same way recordClassifyResult() reads document.classify's — the payload lives only in this instance's own
   * journal entry, there is no other channel for it. Shared by createCaseForMailIntake() (called synchronously,
   * right after mail.ingest succeeds) and fanOutAttachmentsIfAny() (called later, in the background): one parsing
   * implementation for the same journal read, not two independently-drifting copies of the same field list.
   * Returns undefined when mail.ingest itself never reached SUCCEEDED — there is nothing to group or fan out yet.
   *
   * Also surfaces `artifactId` — mail.ingest's own combined-text artifact (handler.ts's `combinedText`: the mail
   * body plus every attachment's extracted text, joined into one document) — as of Commit 4 (18.9.2026, response
   * to a live external audit; see case.ts's `NormalizedImpulse.content` doc comment for the full "why"). Before
   * this change `payload.artifactId` was read only by document.classify/invoice.extract's own capability inputs
   * ("$steps.ingest.payload.artifactId", channel-agnostic by handler.ts's own design) — this method itself never
   * surfaced it, so createCaseForMailIntake() below had no way to put it on the Case at all.
   */
  private mailIngestPayload(workflowId: string): { sender?: string; subject?: string; artifactId?: string; attachmentArtifactIds: string[]; attachments: MailIngestAttachmentOutcome[] } | undefined {
    const inst = this.journal.get(workflowId);
    const step = inst?.steps.find((s) => s.capability === "mail.ingest" && s.status === "SUCCEEDED");
    const payload = step?.result?.payload as { artifactId?: unknown; attachmentArtifactIds?: unknown; attachments?: unknown; sender?: { value?: unknown }; subject?: unknown } | undefined;
    if (!payload) return undefined;
    return {
      ...(typeof payload.sender?.value === "string" ? { sender: payload.sender.value } : {}),
      ...(typeof payload.subject === "string" ? { subject: payload.subject } : {}),
      ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
      attachmentArtifactIds: Array.isArray(payload.attachmentArtifactIds) ? (payload.attachmentArtifactIds as string[]) : [],
      attachments: Array.isArray(payload.attachments) ? (payload.attachments as MailIngestAttachmentOutcome[]) : [],
    };
  }

  /**
   * Case creation (Commit 3, M0-FACT-CONTRACT-V1.md część 0/E follow-up): builds the NormalizedImpulse every
   * ingress channel is meant to normalize into (case.ts's own hard invariant — structurally no workflow/goal/
   * intent field) and a fresh Case wrapping it plus this mail-intake instance as its first member. Deliberately
   * unconditional on attachments existing (unlike fan-out below, which has nothing to do for a plain attachment-
   * less mail) — a Case exists for every inbound e-mail, so "show me everything for this one impulse" always has
   * an answer, even when there is nothing yet to grow it with.
   *
   * `impulse.artifacts` is one ArtifactRef per SUCCEEDED entry of mail.ingest's own `attachments[]` — the raw
   * files the sender actually attached — NOT mail.ingest's own combined-text artifact (body + every attachment's
   * extracted text concatenated into one document for document.classify to read): that combined artifact is this
   * ONE channel's own processing convenience, not something "the impulse carries" in a channel-agnostic sense — a
   * future Telegram message's NormalizedImpulse would carry its own N media files the same way, with no combined-
   * text equivalent to include, and a future folder/batch upload's would carry its own N documents the same way.
   * Keeping `artifacts` == "the discrete things the sender actually sent" (never a channel's own derived synthesis
   * of them) is what keeps this construction read as a template another channel could copy, not mail-specific
   * logic that happens to also produce a NormalizedImpulse. (Now reachable, instead, via NormalizedImpulse's own
   * `content` field — see case.ts.)
   *
   * `text` is left unset on purpose — not because the body has nowhere to go (it does now, see below), but
   * because mail has no short inline sender-typed message the way a chat channel would: the closest equivalent,
   * the subject line, stays in `metadata.subject`, never promoted to `text` (case.ts's own doc comment reads
   * `text` as "short inline content the sender typed directly", which a subject line is not). Until Commit 4
   * (18.9.2026) this comment claimed the body was merely "reachable elsewhere, not duplicated here" — true but
   * incomplete, since "elsewhere" meant only the mail-intake instance's own journal entry, not the Case itself; a
   * live external audit flagged that gap (case.ts's `NormalizedImpulse.content` doc comment has the full story).
   * As of this change, the actual body+attachments content (mail.ingest's own combined-text artifact,
   * `ingest.artifactId` below) is reachable from the Case via the new `content` field, not only through the
   * mail-intake instance's own journal entry as before.
   */
  private createCaseForMailIntake(workflowId: string, tenantId: string): void {
    const ingest = this.mailIngestPayload(workflowId);
    if (!ingest) return;
    const inst = this.journal.get(workflowId);
    if (!inst) return;
    const impulse: NormalizedImpulse = {
      impulseId: newId("imp"),
      tenantId,
      channel: "mail",
      ...(ingest.sender ? { sender: ingest.sender } : {}),
      receivedAt: iso(this.clock.now()),
      artifacts: ingest.attachments.filter((a) => a.status === "SUCCEEDED" && typeof a.artifactId === "string").map((a) => ({ artifactId: a.artifactId as string })),
      ...(ingest.artifactId ? { content: { artifactId: ingest.artifactId } } : {}),
      metadata: ingest.subject ? { subject: ingest.subject } : {},
    };
    const c = newCase({
      caseId: newId("case"),
      impulse,
      instance: { workflowId: inst.workflowId, tenantId: inst.tenantId, status: inst.status, createdAt: inst.createdAt, updatedAt: inst.updatedAt },
    });
    this.caseStore.put(c);
  }

  /**
   * Grows the mail-intake instance's own Case with every attachment-classify/attachment-extract instance
   * fanOutAttachments() actually started (Commit 3) — best-effort PER ATTACHMENT, same discipline the fan-out
   * driver itself already holds (one attachment's own failure never stops the others): a single addInstance()
   * throwing (e.g. a duplicate workflowId, which should not happen but must never silently wipe out the rest of
   * this loop's work if it somehow does) is caught and logged, never allowed to drop instances already added in
   * this same pass. Recomputes the real Case-level aggregate status (aggregateCaseStatus()) over every member
   * instance's CURRENT journal status once, after the whole batch — not the addInstance()-internal "status =
   * last-added instance" simplification (case.ts's own doc comment on Case.status explains why that alone is not
   * enough once a Case has more than one instance).
   */
  private growCaseWithFanout(workflowId: string, outcomes: readonly AttachmentFanoutOutcome[]): void {
    const existing = this.caseStore.byWorkflowId(workflowId);
    if (!existing) return; // createCaseForMailIntake() found nothing to build a Case from (mail.ingest never succeeded) — nothing to grow
    let current = existing;
    for (const outcome of outcomes) {
      for (const member of [outcome.classify, outcome.extract]) {
        if (!member) continue;
        try {
          current = addInstance(current, { workflowId: member.workflowId, tenantId: member.tenantId, status: member.status, updatedAt: member.updatedAt });
        } catch (e) {
          console.error(`[apf-gateway] case fan-out addInstance failed case=${current.caseId} workflowId=${member.workflowId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const statuses = current.instances.map((wid): InstanceStatus => this.journal.get(wid)?.status ?? "RUNNING");
    this.caseStore.put({ ...current, status: aggregateCaseStatus(statuses), updatedAt: iso(this.clock.now()) });
  }

  /**
   * Read-only Case view for GET /case/:id.json (Commit 3): `workflowId` is the mail-intake instance's own id —
   * the SAME "wf-..." id GET /workflow/:id.json accepts, already the name this Durable Object was created under
   * (env.WORKFLOW.idFromName(workflowId) in startMailIntake()) — NOT the Case's own caseId. Case storage is
   * DO-local only (no D1 mirror, store.ts's DDL comment), so there is no external caseId -> Durable Object index
   * to route a bare caseId to the right object without building one (out of scope here); routing by the
   * mail-intake workflowId the caller already has (shown throughout /farm, /workflow/:id, the audit trail) needs
   * none. Every instance this Case has grown to (fan-out sub-instances included) lives in THIS SAME object's own
   * journal, so unlike GET /workflow/:id.json asked for a SUB-instance's own workflowId (which 404s today — a
   * live test 18.9.2026 confirmed it looks up a different, nonexistent object), building each instance's brief
   * view here needs no further idFromName() round-trip at all, just this.journal.get() per id.
   */
  caseView(workflowId: string): { case: Case; instances: Array<{ workflowId: string; workflow?: string; workflowVersion?: string; status: InstanceStatus | "UNKNOWN"; createdAt?: string; updatedAt?: string }> } | null {
    const c = this.caseStore.byWorkflowId(workflowId);
    if (!c) return null;
    const instances = c.instances.map((wid) => {
      const i = this.journal.get(wid);
      return i
        ? { workflowId: i.workflowId, workflow: i.workflow, workflowVersion: i.workflowVersion, status: i.status, createdAt: i.createdAt, updatedAt: i.updatedAt }
        : { workflowId: wid, status: "UNKNOWN" as const };
    });
    return { case: c, instances };
  }

  /**
   * ADR część 5's `/impulse` step: creates a Case directly from an already-normalized impulse, with NO
   * workflow instance — `newCase()` with no `instance` argument, so the Case starts UNSTARTED (case.ts).
   * Case storage is DO-local (same discipline as every other Case here, see caseView()'s own doc comment
   * above, which flagged "no external caseId -> Durable Object index... out of scope here" as of Commit 3) —
   * this method closes exactly that gap by never needing such an index at all: index.ts's /impulse handler
   * mints `caseId` BEFORE addressing this object (`env.WORKFLOW.idFromName(caseId)`), the same pattern
   * startIntake()/startMailIntake() already use for `workflowId`, just naming the object after the Case
   * instead of after a workflow instance that does not exist yet.
   */
  createCase(input: { caseId: string; impulse: NormalizedImpulse }): Case {
    const c = newCase({ caseId: input.caseId, impulse: input.impulse });
    this.caseStore.put(c);
    // Discovery (docs/AUTONOMOUS-RUNTIME-V1.md część 6 krok 7's own precondition, część 3/6 krok 9's first,
    // single-round slice — src/platform/discovery-runner.ts's own header comment has the full "why"): runs in
    // the background (ctx.waitUntil), same discipline as fanOutAttachmentsIfAny() below — awaiting an LLM call
    // here would hold this RPC (and /impulse's own response) hostage. The Case is already durably stored above,
    // so a concurrent GET /case/:caseId.json sees a real, well-formed UNSTARTED Case either way, just without
    // impulse.intent evidence until this finishes. A background failure here is caught and audited (kind:
    // "state", capability: "case-discovery"), same "must stay legible" discipline as that method's own doc
    // comment describes for fan-out failures.
    this.ctx.waitUntil(this.runCaseDiscovery(c));
    return c;
  }

  /**
   * The live wiring discovery-runner.ts's own header comment describes as its "first, single-round, single-goal
   * slice": computes CurrentCaseProjection, asks discovery.ts's planDiscovery() what (if anything) is needed to
   * reach impulse.intent, and dispatches whatever plan() resolves — genuinely, never a hardcoded "if UNSTARTED,
   * call intent.resolve" (AR-4). No evidence ledger wired for this installation (WiringOptions.evidence absent)
   * means there is nothing for plan() to check availability against — skipped, audited, same shape as
   * fanOutAttachmentsIfAny()'s own no-ledger guard below.
   */
  private async runCaseDiscovery(c: Case): Promise<void> {
    // Adversarial verification (2026-09-19) found this.wiring() previously called OUTSIDE this try block:
    // wirePlatform() can throw for real (signingKeyFor()'s own fail-closed throw on a missing
    // GATEWAY_SIGNING_KEY, platform-wiring.ts) — from inside createCase()'s bare `this.ctx.waitUntil(...)`
    // (no `.catch()`), that would have been an unhandled rejection invisible to the audit trail, breaking
    // this method's own "a background failure must stay legible" claim. Moved inside so every throw here,
    // wiring included, reaches the catch below — mirrors mailIntake()'s own discipline of never leaving a
    // wiring()/wirePlatform() failure outside an awaited, caught path.
    try {
      const wiring = this.wiring();
      if (!wiring.evidence) {
        this.audit.append({ kind: "state", tenantId: c.tenantId, capability: "case-discovery", details: { caseId: c.caseId, status: "SKIPPED", reason: "no evidence ledger wired for this installation" } });
        return;
      }
      await runDiscovery(
        {
          catalog: FACT_CATALOG,
          ledger: wiring.evidence,
          artifacts: this.artifacts,
          authorities: installation.authorities,
          lifecycle: installation.lifecycle,
          transport: wiring.transport,
          actorId: installation.profile.roles.orchestrator,
          clock: this.clock,
          deadlineMs: DISCOVERY_DEADLINE_MS,
          audit: this.audit,
          inputBuilders: DISCOVERY_INPUT_BUILDERS,
        },
        c,
      );
      // Intent -> Goal mapping (część 6 krok 7, goal-mapping.ts's own header comment has the full "why"): only
      // meaningful once discovery has actually run. Re-projects FRESH — the discovery call above may just have
      // sealed impulse.intent.resolved, which a projection computed before that dispatch cannot see yet — then
      // reads the resolved value through goal-mapping.ts's own AR-1 "separately-authorized path" (never through
      // planner.ts/discovery.ts, which stay value-free on purpose). Computes and audits the mapped goal; does
      // NOT execute it — that is część 6 krok 8's compiler, not this method's job.
      const freshProjection = projectCurrentCase({ case: c, ledger: wiring.evidence, artifacts: this.artifacts, now: iso(this.clock.now()), authorities: installation.authorities, lifecycle: installation.lifecycle });
      resolveCaseGoal({ ledger: wiring.evidence, goalMap: installation.goalMap, audit: this.audit }, freshProjection);
    } catch (e) {
      console.error(`[apf-gateway] case discovery failed caseId=${c.caseId}: ${e instanceof Error ? e.message : String(e)}`);
      this.audit.append({ kind: "state", tenantId: c.tenantId, capability: "case-discovery", details: { caseId: c.caseId, status: "FAILED", error: e instanceof Error ? e.message : String(e) } });
    }
  }

  /**
   * Read-only counterpart to createCase() above — looks up a Case by its OWN caseId, for a Case that may
   * still have zero instances (caseView() above stays byWorkflowId()-only; a zero-instance Case has no
   * workflowId to look it up by). GET /case/:caseId.json (index.ts) addresses the same DO this Case was
   * created in, via the same caseId-as-DO-name convention createCase() documents above.
   */
  caseByCaseId(caseId: string): Case | null {
    return this.caseStore.get(caseId) ?? null;
  }

  /**
   * Attachment fan-out (owner's Commit 1, M0-FACT-CONTRACT-V1.md část C, 18.9.2026 + its follow-up fix): mail.ingest's
   * own attachmentArtifactIds[] (its output payload, unchanged) never drove anything after it — attachment-classify/
   * attachment-extract were registered (GATEWAY_CAPABILITIES, WORKFLOW_DEFINITIONS) and reachable through
   * src/platform/attachment-fanout.ts, but nothing on the live farm ever called fanOutAttachments(), so both
   * WorkflowDefs sat unreachable from real inbound mail despite /version listing them. Reads mail.ingest's own step
   * result out of the journal the same way recordClassifyResult() (above) reads document.classify's — the payload
   * lives only in this instance's own journal entry, there is no other channel for it.
   *
   * Runs in the background (ctx.waitUntil), same as copyOut() two lines above: fan-out calls an AI model per
   * attachment (classify, and for each attachment classify actually confirms as INVOICE, invoice.extract too) —
   * awaiting it here would let one slow or many-attachment mail hold mailIntake()'s own response hostage, risking a
   * timeout on a request whose own capability (mail.ingest) already succeeded. Unlike copyOut()'s waitUntil() call,
   * whose own failure becomes an invisible unhandled rejection (exactly the gap HANDOFF 166 found for the Žlab
   * mirror, only ever caught because selfTest()/copyOutNow() await copyOut() directly elsewhere), a fan-out failure
   * here is caught and written to the shared audit trail (kind: "state", capability: "attachment-fanout") — the
   * same "a background failure must stay legible" discipline visualStampIfApplicable() already applies with its own
   * try/catch + console.error, with an audit record added on top because this failure is a live orchestration
   * decision (whether invoice.extract ran at all for this mail's attachments), not a cosmetic side effect. Also
   * re-arms the alarm afterwards: attachment-classify/attachment-extract can create their own review tasks
   * (onFailed: BUSINESS/VALIDATION -> review in their WorkflowDefs) after the mail-intake instance's own
   * rearmAlarm() call already ran (renamed from rearmReviewAlarm() by R2, further folded into the R2R3-integrated
   * three-source scheduler — alarm-scheduler.ts's nextAlarmWakeMs() — same call site, wider meaning).
   *
   * R3 (Reliability Gate, owner's second audit, 18.9.2026 — see fanout-retry.ts's file-level doc comment for the
   * full "why"): this method used to call fanOutAttachments() ONCE with the whole attachment list, with no
   * durable record that it had even started and no per-attachment isolation — one thrown exception (from, say,
   * the SECOND of three attachments) meant growCaseWithFanout() never ran at all for that pass, silently
   * orphaning the FIRST attachment's already-finished classify instance from the Case even though its own AI call
   * had genuinely succeeded. Rewritten so that (a) `this.fanoutJobStore` (store.ts) durably records which
   * attachments are still outstanding before/after each pass, letting alarm()'s own maybeRetryFanoutJob() resume
   * exactly the unfinished subset after an eviction instead of re-running already-done attachments (re-running a
   * done one would re-trigger a real Workers AI call, not a cheap no-op — ids.ts's newId() confirmed live,
   * non-deterministic, gives a retry no idempotency key of its own to lean on), and (b) each attachment now runs
   * fanOutAttachments() as its own single-element call inside its own try/catch, with growCaseWithFanout() called
   * immediately after each one succeeds — so a later attachment's exception can no longer erase an earlier
   * attachment's already-real Case membership.
   */
  private async fanOutAttachmentsIfAny(workflowId: string, tenantId: string, correlationId: string, wiring: Wiring): Promise<void> {
    const ingest = this.mailIngestPayload(workflowId);
    const attachments = ingest?.attachments ?? [];
    if (attachments.length === 0) return;
    // P0 fact-scope-multi-doc pass (docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit): fanOutAttachments()
    // now takes {artifactId, entityId} pairs (AttachmentFanoutInput.attachments), not the old flat attachmentArtifactIds[]
    // string list — entityId is mail.ingest's own newEntityId() mint (handler.ts), present iff status is SUCCEEDED
    // (output.schema.json), so this filter+map mirrors the same "SUCCEEDED, has an artifactId" narrowing
    // attachmentArtifactIds itself used to apply, plus the new entityId. A distinct local name on purpose (not reusing
    // `attachmentArtifactIds`, and not shadowing `attachments` above, which summarizeFanoutOutcomes() below still needs
    // in its original, unfiltered shape): this file already has its own unrelated `attachments` local for that call.
    const fanoutAttachments = attachments
      .filter((a): a is MailIngestAttachmentOutcome & { status: "SUCCEEDED"; artifactId: string; entityId: string } => a.status === "SUCCEEDED" && typeof a.artifactId === "string" && typeof a.entityId === "string")
      .map((a) => ({ artifactId: a.artifactId, entityId: a.entityId }));
    if (!wiring.evidence) {
      // WiringOptions.evidence absent (no durable Žlab for this installation) — fan-out has no evidence to plan()
      // against and would only ever see CAPABILITY_GAP; skipping is honest, not a silent no-op (still audited).
      // R3: also closes out the durable outbox row, if one exists — no evidence ledger is a standing
      // installation-level condition a retry cannot fix, so there is nothing to gain from leaving it PENDING for
      // the alarm to keep waking up on (markFanoutJobDone() is a no-op when no row was ever written).
      this.audit.append({ kind: "state", workflowId, tenantId, correlationId, capability: "attachment-fanout", details: { status: "SKIPPED", reason: "no evidence ledger wired for this installation" } });
      this.markFanoutJobDone(workflowId, "no evidence ledger wired for this installation");
      await this.rearmAlarm();
      return;
    }
    // Case-scoped evidence (docs/AUTONOMOUS-RUNTIME-V1.md część 2): this method only ever reaches here once
    // `attachments.length > 0`, which requires mailIngestPayload() to have found a SUCCEEDED mail.ingest step —
    // exactly the same condition createCaseForMailIntake() (called synchronously in mailIntake(), strictly before
    // this background task starts) already required to build the Case. So byWorkflowId() below should always
    // resolve; the undefined branch is a fail-closed, audited guard against that invariant somehow not holding
    // (e.g. createCaseForMailIntake() itself failing after ingest succeeded), never a silent unscoped fallback.
    const caseId = this.caseStore.byWorkflowId(workflowId)?.caseId;
    if (!caseId) {
      this.audit.append({
        kind: "state",
        workflowId,
        tenantId,
        correlationId,
        capability: "attachment-fanout",
        details: { status: "SKIPPED", reason: "no Case found for this mail-intake instance — fan-out needs a caseId for the case-scoped evidence filter" },
      });
      // R3: same reasoning as the no-evidence branch above — this invariant violation is not something a retry
      // fixes, and mailIntake()'s own job-row write already required a resolvable caseId, so in practice no row
      // exists to close here; markFanoutJobDone() stays a safe no-op if one somehow does.
      this.markFanoutJobDone(workflowId, "no Case found for this mail-intake instance");
      await this.rearmAlarm();
      return;
    }
    const job = this.fanoutJobStore.get(workflowId);
    const now = iso(this.clock.now());
    try {
      // R3: only the attachments NOT already represented in the Case as a finished attachment-classify member —
      // on a fresh (non-retry) pass this is every attachment (the Case has no classify members yet), on a RETRY
      // pass (maybeRetryFanoutJob() below) this is exactly the subset an earlier, interrupted pass never got to.
      // Built from this object's own journal/caseStore (never from `attempted`'s own artifactIds blindly trusted)
      // so a mid-batch eviction that DID manage to add a member to the Case before dying is correctly skipped on
      // resume — missingAttachments() itself is pure and separately unit-tested (fanout-retry.ts,
      // tests/gw-fanout-retry.test.ts).
      const already: CaseMemberSummary[] = (this.caseStore.get(caseId)?.instances ?? [])
        .map((wid) => this.journal.get(wid))
        .filter((i): i is Instance => i !== undefined)
        .map((i) => ({ workflow: i.workflow, artifactId: typeof i.input.artifactId === "string" ? (i.input.artifactId as string) : undefined }));
      const toAttempt = missingAttachments(already, fanoutAttachments);

      // One fanOutAttachments() call PER ATTACHMENT, each in its own try/catch (R3's actual fix for the
      // batch-orphaning bug described in this method's own doc comment above): growCaseWithFanout() runs
      // immediately after each success, so a later attachment's exception can never erase an earlier attachment's
      // already-real Case membership the way one shared try/catch around the whole batch used to.
      const outcomes: AttachmentFanoutOutcome[] = [];
      let firstError: string | undefined;
      for (const attachment of toAttempt) {
        try {
          const [outcome] = await fanOutAttachments(
            {
              classifyOrchestrator: this.orchestratorFor(workflowDef("attachment-classify"), wiring),
              extractOrchestrator: this.orchestratorFor(workflowDef("attachment-extract"), wiring),
              catalog: FACT_CATALOG,
              evidence: wiring.evidence,
            },
            { tenantId, caseId, attachments: [attachment], correlationId },
          );
          if (outcome) {
            outcomes.push(outcome);
            // Case wiring (Commit 3): group this attachment's own classify/extract instance into the same Case
            // createCaseForMailIntake() built for this mail-intake instance. Its own failure must never stop the
            // rest of this loop or corrupt the fan-out audit summary below — this method's real job — so it gets
            // its own try/catch, not the outer one (same discipline the pre-R3 version already held, now applied
            // per-attachment instead of once for the whole batch).
            try {
              this.growCaseWithFanout(workflowId, [outcome]);
            } catch (e) {
              console.error(`[apf-gateway] case fan-out growth failed workflowId=${workflowId} artifactId=${attachment.artifactId}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } catch (e) {
          const message = String((e as Error)?.message ?? e).slice(0, 500);
          firstError ??= message;
          console.error(`[apf-gateway] attachment fan-out failed workflowId=${workflowId} artifactId=${attachment.artifactId}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        }
      }

      // R3: the audit summary reports honestly on just THIS pass's own work (`attemptedThisPass`, the subset of
      // the original `attachments` this pass actually tried), not the full original list — so a retry pass that
      // only had two attachments left to try does not re-claim credit for (or re-blame itself for) the one
      // attachment a previous pass already finished. `attempt` is purely additive on top of
      // summarizeFanoutOutcomes()'s own existing FanoutSummary shape (attachment-fanout.ts) — zero change to its
      // signature/contract, so tests/attachment-fanout.test.ts and tests/gw-platform-wiring-fanout.test.ts stay
      // untouched by this pass.
      const attemptedIds = new Set(toAttempt.map((a) => a.artifactId));
      const attemptedThisPass = attachments.filter((a) => a.status === "SUCCEEDED" && typeof a.artifactId === "string" && attemptedIds.has(a.artifactId));
      const attemptNumber = (job?.attempts ?? 0) + 1;
      // Aggregate status is a genuine summary, not an optimistic default: SUCCEEDED only when every attachment
      // ingested AND every classify step succeeded — a mail where 2 of 3 attachments classified fine and 1
      // genuinely failed reports PARTIAL, not an unqualified SUCCEEDED (owner, 18.9.2026, after live external
      // review). summarizeFanoutOutcomes() is the pure, separately-unit-tested function (attachment-fanout.ts) —
      // this method itself cannot be loaded under plain-Node vitest (imports "cloudflare:workers").
      this.audit.append({
        kind: "state",
        workflowId,
        tenantId,
        correlationId,
        capability: "attachment-fanout",
        details: { ...summarizeFanoutOutcomes(attemptedThisPass, outcomes), attempt: attemptNumber },
      });

      // R3's own durable bookkeeping: PENDING (with attempts incremented and lastError set) when at least one
      // attachment threw this pass — maybeRetryFanoutJob() (below) is what actually retries it on a later alarm
      // tick, after its own grace period. DONE otherwise — covers both "everything this pass attempted
      // succeeded" and "there was nothing left to attempt" (toAttempt.length === 0, e.g. a retry pass confirming
      // a prior pass had in fact already finished everything). Always writes a row even if one never existed
      // (job undefined) on the failure branch — self-healing for an instance whose PENDING row predates this
      // fix, or the rare case mailIntake()'s own guard above chose not to write one.
      if (firstError) {
        this.fanoutJobStore.set({ workflowId, caseId, status: "PENDING", attempts: attemptNumber, startedAt: job?.startedAt ?? now, updatedAt: now, lastError: firstError });
      } else if (job) {
        this.fanoutJobStore.set({ ...job, status: "DONE", updatedAt: now });
      }
    } catch (e) {
      // Fail-safe outer guard (this batch's own explicit requirement for every wake/background-path change): an
      // unexpected error OUTSIDE the per-attachment loop (e.g. caseStore/journal access itself throwing) must
      // still leave a legible audit trail and a durable PENDING row for the next alarm tick, exactly like a
      // per-attachment failure does — never let a bug here escape as an invisible unhandled rejection the way a
      // bare ctx.waitUntil() failure normally would (this method's own top doc comment explains why that
      // distinction matters).
      console.error(`[apf-gateway] attachment fan-out failed workflowId=${workflowId}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      const message = String((e as Error)?.message ?? e).slice(0, 500);
      this.audit.append({
        kind: "state",
        workflowId,
        tenantId,
        correlationId,
        capability: "attachment-fanout",
        details: { status: "FAILED", reason: message },
      });
      this.fanoutJobStore.set({ workflowId, caseId, status: "PENDING", attempts: (job?.attempts ?? 0) + 1, startedAt: job?.startedAt ?? now, updatedAt: now, lastError: message });
    }
    await this.rearmAlarm();
  }

  /**
   * Closes a fanout_job row as DONE without touching `attempts` — used by fanOutAttachmentsIfAny()'s own
   * fail-closed SKIPPED branches above (no evidence ledger wired; no Case found), where the underlying condition
   * is a standing installation/invariant issue a retry cannot fix on its own, so there is nothing to gain from
   * leaving the row PENDING for the alarm to keep waking up on. A no-op when no row exists — both callers may run
   * before mailIntake() ever had a caseId to write one with, or after a previous pass already closed it out.
   */
  private markFanoutJobDone(workflowId: string, reason?: string): void {
    const job = this.fanoutJobStore.get(workflowId);
    if (!job) return;
    this.fanoutJobStore.set({ ...job, status: "DONE", updatedAt: iso(this.clock.now()), ...(reason ? { lastError: reason } : {}) });
  }

  /**
   * R3 (Reliability Gate, owner's second audit, 18.9.2026): called from alarm() on every tick (via the R2R3
   * integration's runAlarmTick(), alarm-scheduler.ts — its own isolated "fanout" step), this is the actual
   * "safely wake up and repeat" half of the owner's own stated requirement ("musí se nejdřív sama umět bezpečně
   * probudit, zopakovat..."). Reads the durable fanout_job row for this object's own mail-intake instance and
   * decides, via the pure fanoutRetryDecision() (fanout-retry.ts), whether there is unfinished fan-out work worth
   * resuming.
   *
   * Deliberately fail-safe, not fail-loud-and-blocking on top of ITS OWN internal try/catch below: the R2R3
   * integration's alarm() wraps this call in its own isolated try/catch too (every subsystem gets its own
   * boundary, not "trust that one already has one internally") — belt and suspenders is intentional here, not
   * redundant, because this method is also reachable from fanOutAttachmentsIfAny()'s own retry path with its own
   * failure modes. The fanoutJobStore.get() read below runs in its own try/catch, and ANY error there — a
   * corrupt row, an unexpected throw — is caught, logged, and the method returns normally.
   */
  private async maybeRetryFanoutJob(inst: Instance, wiring: Wiring): Promise<void> {
    if (this.fanoutRetryInFlight) return;
    let job: FanoutJobRecord | undefined;
    try {
      job = this.fanoutJobStore.get(inst.workflowId);
    } catch (e) {
      console.error(`[apf-gateway] fanout job read failed workflowId=${inst.workflowId}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const decision = fanoutRetryDecision(job, this.clock.now().getTime(), { graceMs: WorkflowInstance.FANOUT_RETRY_GRACE_MS, maxAttempts: WorkflowInstance.FANOUT_MAX_ATTEMPTS });
    if (decision === "none" || decision === "wait") return;
    if (decision === "give-up") {
      // job is guaranteed defined here: fanoutRetryDecision() only ever returns "give-up" for a PENDING (hence
      // present) row — the `if (!job)` guard below is TypeScript narrowing, not a real runtime path.
      if (!job) return;
      try {
        // Deliberately still a 2-state schema, not a dedicated DEAD status (fanout-retry.ts's FanoutJobRecord doc
        // comment has the full reasoning) — this ONE audited FAILED record plus `lastError` on the row IS the
        // operator-visible answer to "odhalit stagnaci" (detect stagnation) for a job that has exhausted its
        // retries: a permanently-stuck fan-out is discoverable via the audit trail and this row's own lastError
        // text, not silently invisible. Transitions PENDING -> DONE exactly once, so this branch never re-fires
        // on a later, unrelated alarm tick for the same job.
        this.fanoutJobStore.set({ ...job, status: "DONE", updatedAt: iso(this.clock.now()), lastError: `gave up after ${job.attempts} attempts` });
        this.audit.append({
          kind: "state",
          workflowId: inst.workflowId,
          tenantId: inst.tenantId,
          correlationId: inst.correlationId,
          capability: "attachment-fanout",
          details: { status: "FAILED", reason: "attachment fan-out retry cap reached — some attachments may be permanently missing from this Case", attempts: job.attempts },
        });
      } catch (e) {
        console.error(`[apf-gateway] fanout give-up bookkeeping failed workflowId=${inst.workflowId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    // decision === "retry": stale enough (past FANOUT_RETRY_GRACE_MS) that whatever pass last touched this row
    // has had long enough to either finish or genuinely be gone. fanOutAttachmentsIfAny() itself recomputes
    // `missingAttachments()` from the Case's own current members, so this call is safe to make even though a
    // previous, still-technically-running pass in a different isolate cannot be ruled out with certainty — the
    // accepted, bounded (attempts-capped) residual risk this item's own patch plan flagged, not a solved one.
    this.fanoutRetryInFlight = true;
    try {
      this.audit.append({
        kind: "state",
        workflowId: inst.workflowId,
        tenantId: inst.tenantId,
        correlationId: inst.correlationId,
        capability: "attachment-fanout",
        details: { status: "RETRY", attempt: (job?.attempts ?? 0) + 1 },
      });
      await this.fanOutAttachmentsIfAny(inst.workflowId, inst.tenantId, inst.correlationId, wiring);
    } catch (e) {
      console.error(`[apf-gateway] fanout retry failed workflowId=${inst.workflowId}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    } finally {
      this.fanoutRetryInFlight = false;
    }
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
    const rows = await runSelfTest({
      transport: this.wiring().transport,
      artifacts: this.artifacts,
      clock: this.clock,
      defaultActor: installation.profile.roles.orchestrator,
      deadlineMs: 60_000,
      only,
    });
    // cz.company.verify/cz.vat.verify fixtures seal real evidence into this object's Žlab (M0 D-5) — copy it out and
    // WAIT for it: a waitUntil() after this RPC returns never finished (found live 15. 9. 2026, HANDOFF 166 — the
    // object went idle with 12 verified records and an empty D1 mirror, and nothing said why). A mirror failure must
    // not hide the self-test result either: it is logged and stays visible as `unmirrored` in evidenceStats().
    try {
      await this.copyOut();
    } catch (e) {
      console.error(`[zlab] copy-out after self-test failed: ${String((e as Error).message ?? e)}`);
    }
    return rows;
  }

  /**
   * Operator's synchronous copy-out (M0 D-5): the same copyOut() the object schedules in the background, but awaited
   * and reported — a failure inside a waitUntil() is invisible, this makes it a legible answer (found live 15. 9. 2026:
   * the D1 mirror stayed empty while the object held verified records, and nothing said why).
   */
  async copyOutNow(): Promise<{ ok: true; evidencePending: number; evidenceUnmirroredAfter: number } | { ok: false; error: string; evidencePending: number }> {
    const evidencePending = this.evidenceStore.unmirrored().length;
    try {
      await this.copyOut();
      return { ok: true, evidencePending, evidenceUnmirroredAfter: this.evidenceStore.unmirrored().length };
    } catch (e) {
      return { ok: false, error: String((e as Error).stack ?? (e as Error).message ?? e), evidencePending };
    }
  }

  /** Žlab as held by THIS object (M0 D-5 live verification): counts per authority domain and how many records verify — never a value. */
  evidenceStats(): { records: number; verified: number; unmirrored: number; byDomain: Record<string, number> } {
    const ledger = this.wiring().evidence;
    const byDomain: Record<string, number> = {};
    let records = 0;
    let verified = 0;
    for (const tenantId of installation.profile.tenants) {
      for (const r of ledger?.forTenant(tenantId) ?? []) {
        records += 1;
        if (ledger?.verify(r).ok) verified += 1;
        const domain = r.authorityDomain ?? "inferred";
        byDomain[domain] = (byDomain[domain] ?? 0) + 1;
      }
    }
    // `unmirrored` > 0 for long means the D1 copy is behind the object — visible here, never silently "0 in D1".
    return { records, verified, unmirrored: this.evidenceStore.unmirrored().length, byDomain };
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
   * Write counterpart of artifact() above, for a remote executor host that derived an artifact out-of-process and
   * already copied its bytes to R2 itself (apf-document-host/src/artifact-relay.ts): registers it into THIS
   * instance's own artifact store under the id the host already minted, so a later GET .../artifact/:id (from
   * apf-email-executor, say) can resolve its tenant. Fixes RESOURCE_TENANT_UNRESOLVED on the notify step (found live
   * on farm-bass443, every mail-intake instance, all day 2026-09-17): document.stamp's derived artifact was never
   * registered back here at all. Same trust model as artifact() (reached only over the GATEWAY-internal Fetcher
   * binding), plus the checks in registerDerived() itself (GW-ARTIFACT-REG-001): a remote host cannot plant an
   * artifact into an instance that doesn't exist, claim a tenantId that contradicts this instance's real tenant, or
   * claim a derivedFrom this instance never held under that tenant.
   */
  registerDerivedArtifact(input: DerivedArtifactRegistration): RegisterDerivedResult {
    return registerDerived(this.artifacts, this.journal.list()[0]?.tenantId, input);
  }

  /**
   * Remove the instance and every artifact it holds (retention, or test data on the owner's request): R2 objects
   * this instance is the last remaining claimant of, then the object's whole storage. The shared D1 trail keeps
   * its append-only records and gets one more: PURGED.
   *
   * Reliability Gate R0 (commit 1d465dd, src/platform/r2-refcount.ts): an R2 object is content-addressed
   * (`${derived/originals}/${tenantId}/${sha256}`), and two Cases can come to share one — a forwarded email, a
   * resent PDF — by design (the same key formula is independently computed at copyOut(), startIntake() pre-DO, and
   * apf-document-host's relayDerivedArtifact()). Before this fix, purge() deleted every such object unconditionally,
   * so purging one Case could silently delete evidence another, still-live Case still pointed at. Now each artifact
   * releases this instance's own r2_ref claim first and only deletes the R2 object when releaseR2Ref() reports no
   * other workflow still claims that key. Fail-safe on the release/lookup itself: any D1 error here (this is a
   * rare, explicit, Cloudflare-Access-gated admin action — docs/POSUDKY.md — not a hot path, so a slightly delayed
   * delete costs nothing) is caught and treated as "not safe to delete" — an admin action degrading to leaving an
   * R2 object around a little longer is the right direction of failure, never over-eager deletion. Known residual
   * gap, not closed here (see this commit's message): if D1's own DELETE inside release() throws, this instance's
   * own r2_ref row can outlive this instance's ctx.storage.deleteAll() below, becoming a permanent (bounded,
   * cosmetic — not data loss) orphan row that makes the shared key look referenced forever.
   */
  async purge(by: string, reason: string): Promise<{ workflowId: string; artifacts: number; r2Deleted: number }> {
    const inst = this.journal.list()[0];
    if (!inst) throw new Error("no instance in this object");
    const artifacts = this.artifacts.list();
    let r2Deleted = 0;
    for (const a of artifacts) {
      const key = a.location ?? `${a.derivedFrom ? "derived" : "originals"}/${a.tenantId}/${a.sha256}`;
      let safeToDelete = true;
      try {
        await ensureD1R2Ref(this.env.AUDIT);
        safeToDelete = (await releaseR2Ref(key, inst.workflowId, r2RefCounterOf(this.env.AUDIT))).safeToDelete;
      } catch (e) {
        console.error("purge: r2_ref release failed (fail-safe: leaving the R2 object in place)", e);
        safeToDelete = false;
      }
      if (safeToDelete && (await this.env.ARTIFACTS.head(key))) {
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

  /**
   * RG2-D (2026-09-18, "stale RESERVED reconciliation"): `reconcilers` is now passed through from the Wiring.
   * Before this, no Orchestrator built here ever received OrchestratorOpts.reconcilers, so orchestrator.ts's
   * reconcile() — reached every alarm tick via alarm()'s recover() closure below for a stale RUNNING write step —
   * always found `this.opts.reconcilers?.[capability]` undefined and went to human review after ZERO reconciliation
   * attempts, never touching the ExecutorHost.reconcilerFor() hook that is the only thing able to clear a stuck
   * RESERVED idempotency row (executor-host.ts). See platform-wiring.ts's Wiring.reconcilers doc comment for what
   * the map holds today (mail.ingest only) and why.
   *
   * RG2-D follow-up (same day, adversarial review): the assembly itself no longer lives here. The review showed that
   * the `reconcilers` spread in this method was covered by NO test — index.ts cannot be loaded under plain-Node
   * vitest ("cloudflare:workers" at module scope), and the integration test carried a hand-written copy of the
   * literal, so deleting the spread here left every RG2-D test green. The literal now lives in platform-wiring.ts's
   * exported, pure orchestratorOptsFor()/buildOrchestrator(), which THIS method and the test both call; a
   * source-level trap in tests/gw-platform-wiring-fanout.test.ts pins this method to keep calling it (no hand-built
   * Orchestrator constructor call may reappear anywhere in index.ts). Only the Durable-Object-owned pieces are
   * supplied here.
   */
  private orchestratorFor(def: WorkflowDef, wiring: Wiring): Orchestrator {
    return buildOrchestrator(def, wiring, {
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
   *
   * R2R3 integration (owner's explicit merge spec, 2026-09-18 — see this commit's own message): renamed from
   * rearmReviewAlarm() by R2 (2026-09-18, folding in the stuck-RUNNING-step deadline alongside review deadlines —
   * a Durable Object gets exactly one pending alarm, setAlarm() always replaces it, confirmed against the
   * durable-objects skill, so the earliest deadline this object cares about of ANY kind has to be armed here or
   * an earlier one starves a later one), now folding in R3's fan-out retry time too — a third, independent source
   * feeding the SAME Math.min(...), not a third, competing setAlarm() caller.
   *
   * `pessimisticDeadlineMs`, when given (from intake()/mailIntake()/decideReview() above, BEFORE buildMessage()
   * has durably written the step's own precise notValidAfter), is a one-off upper bound for the call that is
   * about to start dispatch; when omitted (the no-arg call every other call site already makes, alarm() included),
   * the current instance's own RUNNING step's already-durable notValidAfter (or, if dispatch hasn't reached
   * buildMessage() yet for some other reason, its workflow's deadlineMs from startedAt) is used instead — the
   * same precise value isRunningStepStale() (orchestrator.ts) gates recover() on, so the alarm this object wakes
   * up on and the check that runs when it does agree on the same clock.
   *
   * Critically, EVERY value fed into nextAlarmWakeMs() (alarm-scheduler.ts) below is read FRESH on every call —
   * this.reviewStore.all(), this.journal.list()[0], this.fanoutJobStore.get() and (RG2-A) this.copyoutJobStore.get()
   * are never a value captured earlier in alarm()'s own body, they are read again right here. This is what makes the four race scenarios
   * this integration was explicitly asked to hold (see alarm()'s own doc comment) correct almost for free: a
   * deadline that only became true partway through THIS SAME tick — recovery converting a stale step into a
   * fresh WAITING(REVIEW) task, a fan-out retry that just ran and moved its own row's updatedAt forward — is
   * already reflected in the alarm armed at the end of the very tick that created it, because rearmAlarm() never
   * trusts a snapshot from before that happened.
   */
  private async rearmAlarm(pessimisticDeadlineMs?: number): Promise<void> {
    const openReviewDeadlinesMs = this.reviewStore.all().filter((t) => t.status === "OPEN").map((t) => Date.parse(t.expiresAt));
    let stuckStepDeadlineMs: number | undefined = pessimisticDeadlineMs;
    if (stuckStepDeadlineMs === undefined) {
      const inst = this.journal.list()[0];
      const step = inst?.status === "RUNNING" ? inst.steps.find((s) => s.status === "RUNNING") : undefined;
      if (inst && step) {
        stuckStepDeadlineMs = step.message?.notValidAfter ? Date.parse(step.message.notValidAfter) : Date.parse(step.startedAt) + workflowDef(inst.workflow).deadlineMs;
      }
    }
    const workflowId = this.journal.list()[0]?.workflowId;
    const fanoutJob = workflowId ? this.fanoutJobStore.get(workflowId) : undefined;
    // RG2-A: read fresh, same discipline as fanoutJob above — never a value captured earlier in this same tick
    // (this method's own doc comment explains why that matters for the four race scenarios this integration holds).
    const copyoutJob = workflowId ? this.copyoutJobStore.get(workflowId, WorkflowInstance.COPYOUT_JOB_KIND) : undefined;
    const wake = nextAlarmWakeMs(
      { openReviewDeadlinesMs, stuckStepDeadlineMs, fanoutJob, copyoutJob },
      { fanoutGraceMs: WorkflowInstance.FANOUT_RETRY_GRACE_MS, fanoutMaxAttempts: WorkflowInstance.FANOUT_MAX_ATTEMPTS, copyoutGraceMs: WorkflowInstance.COPYOUT_RETRY_GRACE_MS },
    );
    if (wake === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(wake);
  }

  /**
   * Fires at the earliest deadline rearmAlarm() knows about, of any of the three kinds it folds together — an
   * open review's expiry, a stuck-RUNNING-step's own notValidAfter, or a due fan-out retry. ESCALATE keeps the
   * instance waiting on a new task with a later deadline, so the alarm re-arms itself for that one too.
   *
   * R2R3 integration (owner's explicit spec, 2026-09-18 — this commit combines branches r2-automatic-recovery
   * @ 1162773 and r3-durable-outbox-fanout @ 7ea5d6e, which independently modified this same method for
   * different, both-legitimate reasons): FOUR separate steps, each in its own try/catch (runAlarmTick(),
   * alarm-scheduler.ts) — never one shared try/catch around all three subsystems — so that one subsystem's
   * failure can never prevent another from getting its own chance this same tick:
   *   1. recover stuck workflow state (R2)
   *   2. process a due durable fan-out job (R3)
   *   3. process review/deadline transitions (the existing, live WF-REV-003 path)
   *   4. persist/audit outcomes (copyOut())
   * and rearmAlarm() (above) runs unconditionally afterwards, in a `finally`, reading fresh durable state rather
   * than anything captured earlier in this same call.
   *
   * Deliberately REORDERED from R2's own original choice, which ran applyReviewExpiries() FIRST and
   * unconditionally, ahead of the stuck-step recovery check it added. The owner's own reasoning for this change
   * (2026-09-18): "nejdřív obnovit konzistentní stav execution enginu a až potom nad ním spouštět další práci"
   * [first restore the execution engine's own consistent state, only then run further work on top of it] —
   * recovery converts a stuck RUNNING step into a terminal/WAITING outcome, which is exactly the kind of state a
   * later review-expiry pass or fan-out retry could otherwise be reasoning about while it is still wrong. Safety
   * is preserved not by running reviews first (R2's original argument) but by giving reviews — and recovery, and
   * fan-out — their OWN isolated try/catch: a recovery or fan-out failure can still never prevent reviews from
   * running, the property R2's original ordering was actually protecting.
   *
   * Follow-up fix (adversarial review, 18.9.2026, same day): an isolated try/catch alone only protects against
   * recovery/fan-out THROWING — it does nothing if either just runs long (both cascade through real, unbudgeted
   * `transport.dispatch()` calls), which could still starve reviews/rearmAlarm of their own turn this same tick,
   * or in the worst case let the isolate's own CPU/wall-clock budget run out before reviews ever got one. The
   * `runAlarmTick(...)` call below now also passes `{ subsystemBudgetMs: ALARM_SUBSYSTEM_BUDGET_MS }` (see that
   * constant's own doc comment above): runAlarmTick() races `recover`/`retryFanout` against it internally, so a
   * timeout becomes a DependencyTimeout, caught exactly like any other subsystem failure, and this doc comment's
   * own claim ("a recovery or fan-out failure can still never prevent reviews from running") now holds for a
   * HUNG subsystem too, not only a thrown one.
   *
   * RG2-B follow-up (adversarial review, 2026-09-18, same day): the shape above still had two gaps in the code
   * that used to sit here directly (an `if (!inst) return` before the try, and `wiring()`/`orchestratorFor()`
   * calls also before it) — either could skip step 4 and rearmAlarm() entirely. Both moved inside
   * runAlarmCycle()'s (alarm-scheduler.ts) own try/finally via `buildTick()`; see that function's own doc comment
   * for the exact bug this closes and why. This method is now a thin wrapper handing runAlarmCycle() real
   * closures — the four-step shape and the ordering/isolation reasoning above are otherwise unchanged.
   */
  async alarm(): Promise<void> {
    await runAlarmCycle({
      buildTick: () => {
        // RG2-B (2026-09-18): `inst`, `wiring()` and `orchestratorFor()` all move INSIDE buildTick() so a throw
        // from any of them (a bad/missing GATEWAY_SIGNING_KEY, a workflowDef() lookup failure) is caught by
        // runAlarmCycle()'s own try, not skipped past it the way the pre-RG2-B code's `if (!inst) return` and
        // bare pre-try calls used to skip past `finally { copyOut(); rearmAlarm(); }` entirely. Returning
        // `undefined` for the journal-less self-test instance (no early `return` here any more) is itself the fix
        // for that same bug's other half: copyOut()/rearmAlarm() below still always run for that instance.
        const inst = this.journal.list()[0];
        if (!inst) return undefined;
        const wiring = this.wiring();
        const orchestrator = this.orchestratorFor(workflowDef(inst.workflow), wiring);
        const recordSubsystemFailure = (subsystem: "recovery" | "fanout" | "reviews", err: unknown) => {
          const reason =
            subsystem === "recovery"
              ? "alarm-triggered recover() failed"
              : subsystem === "fanout"
              ? "alarm-triggered fan-out retry failed"
              : "alarm-triggered review-expiry check failed";
          this.audit.append({
            kind: "reconciliation",
            workflowId: inst.workflowId,
            correlationId: inst.correlationId,
            tenantId: inst.tenantId,
            details: { reason, error: err instanceof Error ? err.message : String(err) },
          });
        };
        return {
          recover: async () => {
            // Re-read rather than reuse the outer `inst`: applyReviewExpiries() (step 3) has not run yet at this
            // point, but this same discipline (re-reading before acting, not trusting a value from before this
            // subsystem's own turn) is what R2's original code already did here, and is what keeps this step
            // correct regardless of what order these three subsystems end up running in.
            const current = this.journal.list()[0];
            if (current?.status === "RUNNING" && isRunningStepStale(current, workflowDef(current.workflow), this.clock.now())) {
              await orchestrator.recover();
            }
          },
          retryFanout: async () => {
            await this.maybeRetryFanoutJob(inst, wiring);
          },
          applyReviewExpiries: async () => {
            orchestrator.applyReviewExpiries();
          },
          onFailure: recordSubsystemFailure,
        };
      },
      tickOpts: { subsystemBudgetMs: ALARM_SUBSYSTEM_BUDGET_MS },
      // RG2-B: a NEW, separate audit path from recordSubsystemFailure above — this fires for a failure that
      // happens BEFORE any subsystem ever gets a chance to run at all (buildTick() itself throwing, or the
      // belt-over-braces case of runAlarmTick() somehow throwing despite its own per-subsystem isolation), so
      // `inst` may not even exist here. Kept as its own `kind: "reconciliation"` record (same audit kind the three
      // named subsystem failures above already use) with a distinct `reason` string, rather than a new AuditKind,
      // since this is still fundamentally the same "alarm tick didn't fully do its job, here's why" story.
      onBootstrapFailure: (err) => {
        const inst = this.journal.list()[0];
        this.audit.append({
          kind: "reconciliation",
          workflowId: inst?.workflowId,
          correlationId: inst?.correlationId,
          tenantId: inst?.tenantId,
          details: { reason: "alarm bootstrap failed (wiring/orchestrator construction, or an uncaught tick error)", error: err instanceof Error ? err.message : String(err) },
        });
      },
      // RG2-B: awaited here (via runAlarmCycle's own `finally { await copyOut(); ... }`) rather than the
      // pre-RG2-B `this.ctx.waitUntil(this.copyOut())` fire-and-forget — see runAlarmCycle()'s own doc comment
      // (alarm-scheduler.ts) for exactly why that's safe only for this specific call site.
      copyOut: () => this.copyOut(),
      onCopyOutFailure: (err) => {
        // copyOut() already durably keeps its own job PENDING on failure (RG2-A) and logs via console.error — this
        // is purely so an unexpected rejection escaping copyOut() itself can never skip rearmAlarm() below.
        console.error("[apf-gateway] alarm(): copyOut() rejected unexpectedly (its own durable job stays PENDING; rearmAlarm() still runs)", err);
      },
      rearm: () => this.rearmAlarm(),
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
    // R2 (2026-09-18 reliability audit): same pessimistic backstop as intake()/mailIntake() — resumeAfterReview()
    // below dispatches the next step, so this instance is about to go RUNNING again before its own precise
    // notValidAfter is written.
    await this.rearmAlarm(this.clock.now().getTime() + maxStepDeadlineMs(workflowDef(inst.workflow)) + STUCK_ALARM_SAFETY_MARGIN_MS);
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
    await this.rearmAlarm();
    return updated;
  }

  /**
   * Text artifacts to R2 (immutable, keyed by tenant + sha256), audit records and sealed evidence to the shared D1.
   * Idempotent. Also re-registers every artifact this instance holds (not just newly-copied ones — see
   * copyOutArtifacts()'s own doc comment) as a claim on its R2 key in the shared D1 r2_ref table, so purge()
   * (above) can tell a still-shared object from a truly orphaned one (Reliability Gate R0, commit 1d465dd: purge()
   * used to delete an R2 object unconditionally, even when another Case's artifact still pointed at the same
   * content-addressed key — src/platform/r2-refcount.ts's header has the full finding).
   *
   * Reliability Gate RG2-A (2026-09-18, this same audit's later, deeper finding): the pre-existing version of this
   * method registered every r2_ref claim LAST — after every R2 put()/markCopied() for this pass had already run —
   * wrapped in one try/catch that only logged on a D1 failure ("fail-safe: unregistered until the next copyOut()
   * call"). The problem: rearmAlarm() can delete this instance's alarm entirely once nothing else is outstanding,
   * so "the next copyOut() call" may never happen again for an instance whose LAST-EVER copyOut() hit exactly that
   * D1 failure — meanwhile a SIBLING Case sharing the same content-addressed R2 key (a forwarded email, a resent
   * PDF — real, by-design dedup, r2-refcount.ts's header) sees zero refs on its own purge() and deletes the shared
   * blob: permanent, silent evidence loss for the first Case, which still has a live pointer to now-deleted
   * content. Fixed two ways, both below:
   *   1. Ordering: copyOutArtifacts() (copyout-artifacts.ts) claims each artifact's r2_ref BEFORE ensuring its
   *      blob exists / marking it copied — never the other way around. An artifact whose claim fails this pass is
   *      simply left for the next attempt, never treated as "in use".
   *   2. Durability (closes C5 — copyOut() was otherwise fire-and-forget via ctx.waitUntil(), invisible to
   *      rearmAlarm()): `this.copyoutJobStore` (store.ts's `durable_job` table) durably tracks whether this
   *      instance still has outstanding copyOut work, recomputed fresh at the end of every call — the same
   *      "recompute, don't track a resume cursor" idiom rearmAlarm()/nextAlarmWakeMs() already use everywhere
   *      else, since every input here (`.uncopied()`, `.unmirrored()`) is already naturally idempotent. Unlike the
   *      fan-out job (fanout-retry.ts), this job NEVER gives up — see recordCopyoutOutcome()'s own doc comment.
   * The governing invariant for every ordering choice here, verbatim (durable-job.ts's own header):
   *
   *   "An orphaned reference-claim, or a blob nobody deletes because a stale claim says it's still used, is a
   *   bounded, cosmetic leak. A live reference pointing at a blob some OTHER Case's purge() has already deleted is
   *   unbounded, undetectable data loss. Every ordering decision in this file resolves in favor of the leak."
   *
   * Adversarial-review fix (2026-09-18, finding 1, BLOCKING): this method used to `return` immediately when this
   * object has no journal instance ("nothing to claim/copy on behalf of — every real call site already has an
   * instance by now"). That was false for two real call sites: selfTest() (below) and copyOutNow() (the operator's
   * `/farm/zlab/mirror` endpoint) both call this method specifically because the FIXED self-test Durable Object
   * (SELF_TEST_WORKFLOW_ID) has no journal entry by design (self-test.ts's own comment: "no journal entry, no
   * workflow instance created") while still holding real content-addressed artifacts (self-test.ts:235) and sealed
   * evidence that need exactly this ordering-safe claim/copy/mirror path. The early return made both call sites
   * silently no-op — the r2_ref claim this whole file exists to make durable was never even attempted for that
   * instance, and `/farm/zlab/mirror` always reported an unchanged count instead of "the answer, or the error".
   * A journal-less instance falls back to SELF_TEST_WORKFLOW_ID as its own identity here — the same fixed id
   * self-test.ts already stamps on every message for artifacts this instance receives, so the r2_ref claim and the
   * durable_job row are attributed to the identity that will actually be looked up under.
   */
  private async copyOut(): Promise<void> {
    const inst = this.journal.list()[0];
    const workflowId = inst?.workflowId ?? SELF_TEST_WORKFLOW_ID;
    let anyRefClaimFailed = false;
    let passFailed = false;
    let passFailedError: string | undefined;
    try {
      const artifacts = this.artifacts.list();
      if (artifacts.length > 0) {
        await ensureD1R2Ref(this.env.AUDIT);
        const uncopiedIds = new Set(this.artifacts.uncopied().map((a) => a.artifactId));
        const result = await copyOutArtifacts(
          {
            refCounter: r2RefCounterOf(this.env.AUDIT),
            blobs: this.env.ARTIFACTS,
            markCopied: (artifactId) => this.artifacts.markCopied(artifactId),
            onClaimFailed: (artifactId, e) =>
              console.error(
                `[apf-gateway] copyOut: r2_ref claim failed artifactId=${artifactId} workflowId=${workflowId} (ordering invariant: blob-write/markCopied skipped this pass, retried by the durable copyout job)`,
                e,
              ),
            onBlobWriteFailed: (artifactId, e) =>
              console.error(
                `[apf-gateway] copyOut: blob write failed artifactId=${artifactId} workflowId=${workflowId} (r2_ref claim already landed; artifact stays uncopied, retried by the durable copyout job)`,
                e,
              ),
          },
          { workflowId, artifacts, uncopiedIds },
        );
        anyRefClaimFailed = result.anyRefClaimFailed;
      }

      const pending = this.audit.unmirrored();
      if (pending.length > 0) {
        await ensureD1Audit(this.env.AUDIT);
        const insert = this.env.AUDIT.prepare(
          "INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        await this.env.AUDIT.batch(
          pending.map((r) => insert.bind(r.auditId, r.at, r.kind, r.correlationId ?? null, r.workflowId ?? null, r.tenantId ?? null, r.actorId ?? null, r.capability ?? null, JSON.stringify(r))),
        );
        this.audit.markMirrored(pending.map((r) => r.auditId));
      }
      // Durable Žlab (M0 D-5): sealed evidence goes to the shared D1 copy the same way — insert-only, replay-safe,
      // marked after (evidence-mirror.ts mirrorEvidence). The object's SQLite stays the source of truth.
      if (this.evidenceStore.unmirrored().length > 0) {
        await ensureD1Evidence(this.env.AUDIT);
        await mirrorEvidence(this.evidenceStore, evidenceMirrorOf(this.env.AUDIT));
      }
    } catch (e) {
      // RG2-A: a failure anywhere above (a thrown R2 put(), a D1 batch() rejection) must not skip
      // recordCopyoutOutcome() below — that write is what keeps this pass's failure durably visible to the next
      // alarm tick instead of silently vanishing the way a bare, unguarded ctx.waitUntil() rejection would.
      //
      // Adversarial-review fix (2026-09-18, finding 3, BLOCKING): `passFailed` is set for ANY throw here, not only
      // a ref-claim failure. Without it, a D1 outage in ensureD1R2Ref()'s bootstrap call above — thrown before
      // copyOutArtifacts() ever runs, so `anyRefClaimFailed` stays its default `false` — on a pass where every
      // held artifact was already `copied=1` computed "nothing outstanding": recordCopyoutOutcome() would flip
      // this job DONE (or never create a row), rearmAlarm() would then delete this instance's only remaining
      // alarm, and the never-actually-reconfirmed r2_ref claim would never be retried — reproducing the exact C5
      // data-loss scenario this whole change exists to close. `passFailedError` also fixes finding 2 (SHOULD_FIX):
      // a persistent non-ref-claim failure otherwise left `lastError` absent forever, indistinguishable in the row
      // from ordinary healthy backoff.
      passFailed = true;
      passFailedError = e instanceof Error ? e.message : String(e);
      console.error(`[apf-gateway] copyOut: pass failed workflowId=${workflowId} (durable copyout job stays PENDING; alarm() retries)`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    } finally {
      this.recordCopyoutOutcome(workflowId, { anyRefClaimFailed, passFailed, passFailedError });
      // Same discipline as fanOutAttachmentsIfAny()'s own trailing rearmAlarm() call (R3): a background task that
      // just durably changed a job row this object's alarm cares about must re-arm itself, rather than relying on
      // a caller that scheduled it via ctx.waitUntil() (and so already returned before this line ever runs).
      await this.rearmAlarm();
    }
  }

  /**
   * Freshly recomputes whether this instance still has outstanding copyOut work — never a resume cursor, the same
   * "recompute, don't remember" idiom every other alarm-facing check in this file already uses (rearmAlarm()'s
   * own doc comment) — and writes `this.copyoutJobStore` accordingly. PENDING while outstanding (an uncopied
   * artifact, an unmirrored audit/evidence record, or `anyRefClaimFailedThisPass`); DONE once nothing is left,
   * only if a row already existed (a fully clean instance that has never had trouble gets no row at all).
   *
   * Critical semantic difference from maybeRetryFanoutJob()'s job (fanout-retry.ts/index.ts): this job must NEVER
   * give up. Fan-out abandons after FANOUT_MAX_ATTEMPTS because it is bounded, best-effort AI work with an
   * accepted "some attachments may be permanently missing" outcome. copyOut() is REQUIRED durability work (R2
   * refs, the audit trail, the evidence mirror) — there is no acceptable give-up outcome, so `attempts` here is
   * observability only (surfaced via this row's own `lastError`/`attempts` if an operator ever inspects it),
   * never compared against a cap the way FanoutJobRecord.attempts is in fanoutRetryDecision().
   *
   * Adversarial-review fix (2026-09-18, finding 5): the actual give-up-prevention decision now lives in
   * nextCopyoutJobRecord() (durable-job.ts) — a pure function, extracted specifically so it is testable under
   * plain-Node vitest (this file imports "cloudflare:workers" and cannot be loaded there at all; see that
   * function's own doc comment for why the pre-extraction code was architecturally untestable). This method is now
   * just the thin I/O wrapper: gather this instance's own live counts, delegate the PENDING/DONE/no-row decision,
   * and write whatever comes back.
   */
  private recordCopyoutOutcome(workflowId: string, outcome: { anyRefClaimFailed: boolean; passFailed: boolean; passFailedError?: string }): void {
    const existing = this.copyoutJobStore.get(workflowId, WorkflowInstance.COPYOUT_JOB_KIND);
    const outstandingWork = this.artifacts.uncopied().length > 0 || this.audit.unmirrored().length > 0 || this.evidenceStore.unmirrored().length > 0;
    const next = nextCopyoutJobRecord(existing, workflowId, WorkflowInstance.COPYOUT_JOB_KIND, iso(this.clock.now()), { ...outcome, outstandingWork });
    if (next) this.copyoutJobStore.set(next);
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

const OPEN_PROBLEM_STATUSES = new Set(["WAITING", "FAILED", "UNKNOWN_OUTCOME"]);

/**
 * Every workflow currently WAITING/FAILED/UNKNOWN_OUTCOME (HANDOFF 94, MAJOR 4 of the second external review:
 * "monitoring data source nesmí být UI pagination") — independent of Ohrada's own instanceLimit/instanceWindow,
 * so an old open problem can't quietly fall out of Argos's view just because enough newer instances arrived.
 *
 * Pure SQL, no per-instance Durable Object round trip (unlike recentInstances()/farmRowOf() — that N+1 pattern
 * is exactly why that query IS limited): src/platform/orchestrator.ts writes a `kind: "state", capability: null`
 * audit row with `details.status` at every instance-level transition (RUNNING at start, SUCCEEDED/FAILED/the
 * terminal review outcome at the end) — capability-scoped records like a classify result use a real
 * `capability` value and are excluded here on purpose (the same distinction the existing farmStats() query
 * already relies on). The latest such row per workflow_id (SQLite's bare-column GROUP BY, same idiom as
 * recentInstances()'s MAX(at)) is the true current status — including "PURGED" once a purge appends its own
 * state row, so a purged instance naturally drops out with no extra filtering. Reads the whole state-transition
 * table once (no recency LIMIT before filtering — a LIMIT there would just reintroduce the same windowing bug);
 * acceptable at today's instance volume, revisit if that ever grows enough to make this slow.
 */
async function authoritativeOpenProblems(env: Env): Promise<OpenWorkflowProblem[]> {
  await ensureD1Audit(env.AUDIT);
  const rows = await env.AUDIT.prepare(
    "SELECT workflow_id, json, MAX(at) AS last_at FROM audit WHERE kind = 'state' AND capability IS NULL AND workflow_id IS NOT NULL AND workflow_id != ? GROUP BY workflow_id",
  )
    .bind(SELF_TEST_WORKFLOW_ID)
    .all<{ workflow_id: string; json: string; last_at: string }>();
  const problems: OpenWorkflowProblem[] = [];
  for (const r of rows.results) {
    const status = (JSON.parse(r.json) as { details?: { status?: string } }).details?.status;
    if (status && OPEN_PROBLEM_STATUSES.has(status)) problems.push({ workflowId: r.workflow_id, status, at: r.last_at });
  }
  return problems;
}

/** How many /audit relays in the given window were rejected as tenantId spoofing attempts (HANDOFF 95, MAJOR
 * 7 of the second external review) — the same "security" kind + "AUDIT_TENANT_MISMATCH" code the /audit
 * handler itself writes on rejection, read back here so computeWatchdog() can turn it into a finding. */
async function recentAuditTenantMismatchCount(env: Env, sinceIso: string): Promise<number> {
  await ensureD1Audit(env.AUDIT);
  const row = await env.AUDIT.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind = 'security' AND json_extract(json, '$.details.code') = 'AUDIT_TENANT_MISMATCH' AND at >= ?")
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Deník tab's own date-range picker (GET /farm ?denikFrom=&denikTo=) — separate from /audit.json's own ?limit=
 * cap for the live-tail terminal: a very wide date range picked on /farm itself must not be able to make that
 * page's own render pathologically slow. 500 matches /audit.json's existing ceiling in this same file — plenty
 * for a human reviewing a real day's or week's traffic, small enough to keep GET /farm's render fast. A genuine
 * full-period export belongs to GET /audit.csv below (its own, much higher, still-bounded ceiling), not this page.
 */
const DENIK_RANGE_LIMIT = 500;

/** A caller may pass either a full ISO 8601 timestamp (e.g. copied from an existing `at` value, the same idiom
 * /audit.json's own ?after= cursor already relies on) or a bare `YYYY-MM-DD` date — exactly what `<input
 * type=date>` produces, i.e. the Deník tab's own "Do" field and GET /audit.csv's own ?to=. Plain string `<=`
 * comparison against the `at` column needs the bare-date case widened to the END of that day first: comparing
 * `at <= '2026-09-05'` against a real timestamp like "2026-09-05T10:00:00.000Z" would lexicographically exclude
 * it (a longer string that starts with a shorter one sorts AFTER it), silently dropping the entire selected end
 * day from the results. A value that already carries a time component (any length other than exactly 10) is
 * trusted and passed through unchanged — this only ever widens a bare date, never touches anything else. */
const inclusiveDayEnd = (to: string): string => (to.length === 10 ? `${to}T23:59:59.999Z` : to);

/** The "deník": the shared audit trail as-is, same source as /audit.json, newest first. Optional `range.from`/
 * `range.to` narrow it to an ISO 8601 date-ish window (plain string >= / <= against the `at` column — same idiom
 * /audit.json's own ?after= already relies on) — GET /farm's denikFrom/denikTo. Existing callers that pass only
 * `limit` (or nothing) keep their exact prior behavior; `range` is additive. */
const toAuditLogRow = (full: AuditRecord): AuditLogRow => ({
  at: full.at,
  kind: full.kind,
  workflowId: full.workflowId ?? null,
  tenantId: full.tenantId ?? null,
  capability: full.capability ?? null,
  details: full.details,
});

const auditLog = async (env: Env, limit = 50, range?: { from?: string; to?: string }): Promise<AuditLogRow[]> => {
  await ensureD1Audit(env.AUDIT);
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (range?.from) {
    conditions.push("at >= ?");
    binds.push(range.from);
  }
  if (range?.to) {
    conditions.push("at <= ?");
    binds.push(inclusiveDayEnd(range.to));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")} ` : "";
  const rows = await env.AUDIT.prepare(`SELECT json FROM audit ${where}ORDER BY at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<{ json: string }>();
  return rows.results.map((r) => toAuditLogRow(JSON.parse(r.json) as AuditRecord));
};

/** Token/model usage for exactly the instances GET /farm is about to render (Ohrada/Výsledek/Stáj step rows) —
 * targeted by workflow_id instead of auditLog()'s shared farm-wide "last 50" window, which a busy farm can push a
 * step's own model-usage record out of within minutes even though the step itself is still on screen (owner's
 * report 2026-09-17: "nevidím spotřebu tokenů"). Bounded by how many instances the page ever renders
 * (instanceLimit, default 15) — never a farm-wide scan. */
const modelUsageFor = async (env: Env, workflowIds: string[]): Promise<AuditLogRow[]> => {
  if (workflowIds.length === 0) return [];
  await ensureD1Audit(env.AUDIT);
  const placeholders = workflowIds.map(() => "?").join(", ");
  const rows = await env.AUDIT.prepare(`SELECT json FROM audit WHERE kind = 'model-usage' AND workflow_id IN (${placeholders})`)
    .bind(...workflowIds)
    .all<{ json: string }>();
  return rows.results.map((r) => toAuditLogRow(JSON.parse(r.json) as AuditRecord));
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

/** ADR część 5's new ingress contract (POST /impulse) — see the route handler below for the full contract note. */
interface ImpulseRequest {
  channel: string;
  text?: string;
  attachments?: string[];
  metadata?: Record<string, string>;
}

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
    // Same DocumentExtractor mail.ingest uses for e-mail attachments (adapters/extract.ts) — one implementation of
    // "binary -> readable text" regardless of channel; only the error phrasing below stays specific to this path
    // ("tok nebyl spuštěn" — intake never even starts a workflow on a document it can't read).
    const extracted = await new WorkersAiExtractor(env.AI).extract({ name, bytes: new Uint8Array(buf), contentType });
    if (!extracted.ok) {
      const suffix = extracted.code === "EXTRACTION_EMPTY" ? "Workers AI ze souboru nezískala žádný text; originál je uložený, tok nebyl spuštěn." : "Workers AI dokument nepřevedla; originál je uložený, tok nebyl spuštěn.";
      return { ok: false, code: extracted.code, message: suffix, detail: { sha256: digest, contentType, ...extracted.detail } };
    }
    extraction = { text: extracted.text, format: extracted.format, tokens: extracted.tokens };
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

type ReplayOutcome = { ok: true; workflowId: string } | { ok: false; title: string; message: string; detail?: Record<string, unknown>; status: number };

/**
 * Re-submits an existing instance's own stored original e-mail through startMailIntake() as a brand-new instance —
 * same raw bytes, same notifyRef the original run used (Instance.input, set once at intake and never touched
 * again). mail-intake only: a document-intake instance's original isn't necessarily an e-mail. Split out from the
 * /workflow/:id/replay route (index.ts's fetch handler is one very large function; TypeScript's control-flow
 * narrowing on `stub.view()`'s result gave up and inferred `never` when this was inlined there — a separate,
 * ordinary async function has no such issue, same reasoning startMailIntake()/startIntake() are their own
 * functions rather than inlined into their routes).
 */
async function replayMailIntake(env: Env, workflowId: string): Promise<ReplayOutcome> {
  const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(workflowId));
  // stub.view()'s RPC-inferred return type collapses the InstanceView|null union to just null (workers-types quirk,
  // same cast every other caller in this file already needs).
  const view = (await stub.view()) as InstanceView | null;
  if (!view) return { ok: false, title: "Nelze přehrát", message: "Instance neexistuje.", detail: { workflowId }, status: 404 };
  if (view.instance.workflow !== "mail-intake") {
    return { ok: false, title: "Nelze přehrát", message: "Přehrání je dnes jen pro mail-intake instance (má uložený originální e-mail).", status: 400 };
  }
  const original = view.artifacts.find((a) => !a.derivedFrom);
  if (!original) return { ok: false, title: "Nelze přehrát", message: "Instance nemá uložený originální e-mail.", status: 400 };
  const notifyRef = typeof view.instance.input.notifyRef === "string" ? view.instance.input.notifyRef : undefined;
  if (!notifyRef) return { ok: false, title: "Nelze přehrát", message: "Původní instance nemá uložený příjemce notifikace.", status: 400 };
  const result = await startMailIntake(env, { rawMail: original.bytes, receivedFrom: "farm-replay", notifyRef });
  if (!result.ok) return { ok: false, title: INTAKE_ERROR_TITLE[result.code] ?? result.code, message: result.message, detail: result.detail, status: INTAKE_ERROR_STATUS[result.code] ?? 500 };
  return { ok: true, workflowId: result.workflowId };
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

/** Must equal the second entry of wrangler.jsonc's triggers.crons (HANDOFF 88) — how scheduled() tells the
 * self-test tick apart from the 5-minute inbox tick sharing the same handler. */
const SELF_TEST_CRON = "*/30 * * * *";

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

/**
 * Everything GET /farm needs to render, assembled once — split out (HANDOFF 88) so the scheduled self-test tick
 * can build the same FarmModel computeWatchdog()/reconcileAndPersistIncidents() need without a Request to read
 * instanceLimit/instanceWindow from. Never writes anything; the caller decides what to do with the result
 * (render it, reconcile incidents against it, or both).
 */
async function buildFarmModel(env: Env, instanceLimit: number, instanceWindow: string, denikRange?: { from?: string; to?: string }): Promise<FarmModel> {
  const now = iso(new SystemClock().now());
  const denikFrom = denikRange?.from;
  const denikTo = denikRange?.to;
  // Only widen past the live terminal's usual last-50 once a range is actually picked — an unfiltered Deník tab
  // keeps behaving exactly like before this feature existed.
  const denikRangeActive = Boolean(denikFrom || denikTo);
  const [documentHost, emailExecutor, mailIngest, fakes, instances, log, inbox, stats, documentHostCaps, emailExecutorCaps, selfTestSummary, alertHealth, openWorkflowProblems, recentAuditTenantMismatches, certifications, cowWorkshopModelKey, workshopSessions] = await Promise.all([
    deployableInfo(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
    deployableInfo(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
    deployableInfo(env.MAIL_INGEST, "https://apf-mail-ingest.internal"),
    deployableInfo(env.FAKES, FAKES_ORIGIN),
    recentInstances(env, instanceLimit, windowSince(instanceWindow, new SystemClock())),
    auditLog(env, denikRangeActive ? DENIK_RANGE_LIMIT : 50, denikRangeActive ? { from: denikFrom, to: denikTo } : undefined),
    inboxDetail(env),
    farmStats(env),
    capabilitiesOf(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
    capabilitiesOf(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
    latestSelfTestSummary(env),
    latestAlertHealth(env),
    authoritativeOpenProblems(env),
    recentAuditTenantMismatchCount(env, windowSince("24h", new SystemClock()) as string),
    latestCertifications(env),
    latestCowWorkshopModelKey(env),
    listWorkshopSessions(env),
  ]);
  // Žlab summary from D1 (M0 D-5) — an unreachable D1 shows as "nedostupný" on the page, never as zero.
  const [zlab, usageLog] = await Promise.all([
    zlabStats(env).catch(() => undefined),
    modelUsageFor(env, instances.map((i) => i.workflowId)),
  ]);
  // Admission Gate visibility (HANDOFF 70/71): the same LifecycleRegistry the Router enforces, read here only —
  // this page never writes it. Quarantining a module still means editing config/<installation>/lifecycle.json
  // and redeploying (a human decision with its own commit), not a button on this page.
  const selfTestAgg = selfTestAggregates(selfTestSummary);
  const fixturesOf = (predicate: (f: SelfTestFixtureState) => boolean): SelfTestFixtureState[] => (selfTestSummary?.fixtures ?? []).filter(predicate);
  const capabilities: CapabilityRow[] = [...gatewayCatalog(), ...documentHostCaps.capabilities, ...emailExecutorCaps.capabilities].map((c) => {
    const lifecycleStatus = installation.lifecycle.statusOf(c.module);
    const certification = certifications[c.capability];
    // Build-bound (CERT-004, certification.ts's own docstring): a certification from a PREVIOUS deploy's gitSha
    // must never appear to certify what's running now — still shown for transparency, just not fed into
    // deriveLifecycleStatus() as "this build passed".
    const currentBuildCertification = certification && certification.buildHash === env.GIT_SHA ? certification : undefined;
    return {
      ...c,
      lifecycleStatus,
      selfTest: selfTestAgg.byCapability[c.capability],
      selfTestFixtures: fixturesOf((f) => f.capability === c.capability),
      certification,
      derivedStatus: deriveLifecycleStatus({
        certification: currentBuildCertification,
        admitted: lifecycleStatus === "ACTIVE",
        degraded: false,
        quarantined: lifecycleStatus === "QUARANTINED",
      }),
    };
  });
  // MAJOR 5 (HANDOFF 93): which workers' /capabilities call failed this run — capabilitiesOf() no longer lets
  // that look identical to "genuinely zero capabilities", so computeWatchdog() can say so instead of the
  // affected capabilities just silently not being in the list above.
  const capabilitiesUnavailableFrom = [
    ...(documentHostCaps.ok ? [] : ["apf-document-host"]),
    ...(emailExecutorCaps.ok ? [] : ["apf-email-executor"]),
  ];
  const deployableName = (name: string): { name: string; selfTest: { passed: number; total: number } | undefined; selfTestFixtures: SelfTestFixtureState[] } => ({
    name,
    selfTest: selfTestAgg.byWorker[name],
    selfTestFixtures: fixturesOf((f) => f.worker === name),
  });
  return {
    installation: INSTALLATION,
    gitSha: env.GIT_SHA,
    gatewaySigning: signingMode(env),
    ...(zlab ? { zlab } : {}),
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
    usageLog,
    denikFrom,
    denikTo,
    inbox,
    workflows: [...WORKFLOW_NAMES],
    models: modelsOf(env),
    cowWorkshopModels: cowWorkshopModelsOf(env, cowWorkshopModelKey),
    workshopSessions,
    stats,
    selfTestAt: selfTestSummary?.updatedAt,
    now,
    alertHealth,
    capabilitiesUnavailableFrom,
    openWorkflowProblems,
    recentAuditTenantMismatches,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // RG2-E: /live = the process is alive, nothing more. No I/O, no env lookups beyond vars, and deliberately
    // ABOVE the installation-mismatch check: a mis-deployed bundle is still a running process (that is /ready's
    // and /health/details' problem to report — both sit below the check and fail closed with it: a mismatched
    // bundle answers BOTH with this 500 `{ error: "INSTALLATION_MISMATCH" }`, not a 503 with blockers and not
    // /health/details' otherwise-always-200 report. Deliberate: a load balancer dropping the node on that 500 is
    // the right outcome for a deployment that must not serve anything, and the body still names the cause).
    if (url.pathname === "/live") return Response.json({ ok: true, gitSha: env.GIT_SHA, installation: INSTALLATION });
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
    // RG2-E: /ready = "can I SAFELY accept a NEW Case right now?" — 200/503 with named blockers, bounded by the
    // slowest single probe budget (readinessProbes() above). /health/details = why not / what is degraded — always
    // 200, it is a report, not a gate; reads only what is already persisted (last self-test, last watchdog
    // reconcile) plus a bounded /health of each remote host, and names what it CANNOT see (readiness.ts
    // NOT_OBSERVABLE_GLOBALLY). Neither runs a self-test or touches any WorkflowInstance.
    // Both are unauthenticated exactly like /health and /version above, and both carry configuration detail a
    // stranger should not read (blocker/reason strings are the raw internal messages — credential refs, model
    // keys, D1 error text — plus open-incident texts and the git sha). That is acceptable ONLY because the whole
    // hostname sits behind Cloudflare Access (wrangler.jsonc: a custom domain is the only way in); do NOT exempt
    // these paths from Access for a load balancer or uptime prober — give it an Access service token instead.
    if (url.pathname === "/ready") {
      const report = await readinessReport(env);
      return Response.json(report, { status: report.ready ? 200 : 503 });
    }
    if (url.pathname === "/health/details") {
      const [readiness, remoteHosts, selfTest, incidents] = await Promise.all([
        readinessReport(env),
        runProbes(remoteHostProbes(env)),
        boundedRead(() => latestSelfTestSummary(env), READINESS_PROBE_TIMEOUT_MS),
        boundedRead(() => allIncidents(env), READINESS_PROBE_TIMEOUT_MS),
      ]);
      const trustedProviders = trustedProvidersCheck({ allowUnconfiguredTrustedProviders: installation.profile.allowUnconfiguredTrustedProviders, realAdaptersWired: GATEWAY_WIRES_REAL_TRUSTED_PROVIDERS });
      return Response.json(buildHealthDetails({ readiness, remoteHosts, trustedProviders, lastSelfTest: summarizeSelfTest(selfTest), watchdog: summarizeWatchdog(incidents) }));
    }
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
      // Deník tab's own date-range picker (owner's request: "vyvolat historii za období, exportovat CSV") — an
      // ISO 8601 date-ish string compared straight against the `at` column, same as /audit.json's ?after= already
      // does. Absent/blank means "no bound on that side", identical to today's behavior.
      const denikFrom = url.searchParams.get("denikFrom") || undefined;
      const denikTo = url.searchParams.get("denikTo") || undefined;
      const model = await buildFarmModel(env, instanceLimit, instanceWindow, { from: denikFrom, to: denikTo });
      // Incident Store (HANDOFF 84 continued): reconcile this render's watchdog findings against persisted
      // incident state before rendering, so the Argos banner can show "poprvé viděno / kolikrát" instead of
      // findings looking freshly discovered on every page load.
      model.incidents = await reconcileAndPersistIncidents(env, model, model.now);
      return html(renderFarm(model));
    }

    // Live self-test (owner's request 2026-09-08): a dedicated, fixed-name instance (SELF_TEST_WORKFLOW_ID, shape
    // wf-... so apf-document-host's artifact fetch-back resolves to it too) so it never pollutes "Poslední instance"
    // (recentInstances() excludes it explicitly) or clashes with a real document's workflowId; purgeable like any
    // instance at /workflow/wf-selftest/purge if its artifact store grows.
    // Durable Žlab (M0 D-5 live verification): what the shared D1 copy holds and what the self-test object holds
    // locally — counts, domains, how many records verify under the platform key. Never a value, never a result.
    // Operator's synchronous copy-out of the self-test object: the answer (or the error) instead of a silent waitUntil.
    if (url.pathname === "/farm/zlab/mirror" && request.method === "POST") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
      const outcome = await stub.copyOutNow();
      return Response.json({ gitSha: env.GIT_SHA, ...outcome }, { status: outcome.ok ? 200 : 503 });
    }
    if (url.pathname === "/farm/zlab.json" && request.method === "GET") {
      try {
        const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
        const [d1, selfTestObject] = await Promise.all([zlabStats(env), stub.evidenceStats()]);
        // ?verify=1: re-verify every row of the D1 copy with the platform's PUBLIC key only (M0 D3 — a row proves
        // nothing, the signature does). Edit one row in D1 and it shows up here by id with the reason; nothing else does.
        if (url.searchParams.get("verify") === "1") {
          if (!env.GATEWAY_SIGNING_KEY) return Response.json({ gitSha: env.GIT_SHA, d1, selfTestObject, error: "GATEWAY_SIGNING_KEY missing — cannot derive the public key" }, { status: 503 });
          const trusted = { keyId: env.SIGNING_KEY_ID, publicKey: createPublicKey(createPrivateKey(env.GATEWAY_SIGNING_KEY)) };
          const rows = await d1Sql(env.AUDIT).all("SELECT record_id, json FROM evidence_mirror ORDER BY observed_at LIMIT 1000");
          const invalid: { recordId: string; reason: string }[] = [];
          for (const row of rows) {
            const check = verifyEvidence(JSON.parse(row.json as string) as Evidence, trusted);
            if (!check.ok) invalid.push({ recordId: String(row.record_id), reason: check.reason });
          }
          return Response.json({ gitSha: env.GIT_SHA, d1: { ...d1, checked: rows.length, verified: rows.length - invalid.length, invalid }, selfTestObject });
        }
        return Response.json({ gitSha: env.GIT_SHA, d1, selfTestObject });
      } catch (e) {
        // A legible failure beats a bare 1101: say what broke (D1 DDL, the object, the key), never pretend "0 records".
        return Response.json({ gitSha: env.GIT_SHA, error: String((e as Error).message ?? e) }, { status: 503 });
      }
    }
    if (url.pathname === "/farm/self-test" && (request.method === "POST" || request.method === "GET")) {
      // Owner's request 2026-09-09: "chci vidět kontroly a i si je být schopen individuálně vyvolat" — an
      // Argos capability card or a Kravičky worker card can each post their own narrower run instead of
      // always the full suite. A single suite never gets near the subrequest-depth limit below (HANDOFF
      // 55-60: the phenomenon disappears when document.archive runs first/alone) — unaffected by the chaining.
      const only = { capability: url.searchParams.get("capability") ?? undefined, worker: url.searchParams.get("worker") ?? undefined };
      if (only.capability || only.worker) {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
        const rows = (await stub.selfTest(only)) as SelfTestRow[];
        await recordSelfTestSummary(env, rows);
        return html(renderSelfTest(rows));
      }

      // Full run across every capability, one at a time, each as its OWN top-level request (HANDOFF 55-60,
      // reconfirmed 2026-09-13 against today's SUITES order). Cloudflare's subrequest-depth counter
      // accumulates across an entire incoming request's whole call graph, not just how deep the Worker's own
      // code nests calls — looping over all of SUITES inside one stub.selfTest() call (the old behaviour)
      // reliably threw "Subrequest depth limit exceeded" once the cumulative cross-Worker dispatches reached
      // document.archive (document.stamp's ~16 fixtures, each with its own gateway<->document-host fetch-back,
      // run immediately before it). A 303 redirect makes the BROWSER issue the next capability as a genuinely
      // new request — resetting that budget the same way a lone capability run (above) or the 30-min scheduled
      // tick (selfTestCapabilityForTick) never accumulates it in the first place.
      const chainParam = url.searchParams.get("chain");
      const idx = chainParam ? Number(chainParam) : 0;
      if (!Number.isInteger(idx) || idx < 0 || idx >= SELF_TEST_CAPABILITIES.length) return new Response("invalid chain index", { status: 400 });
      if (idx === 0 && request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
      const rows = (await stub.selfTest({ capability: SELF_TEST_CAPABILITIES[idx] })) as SelfTestRow[];
      await recordSelfTestSummary(env, rows);
      const next = idx + 1;
      if (next < SELF_TEST_CAPABILITIES.length) return Response.redirect(new URL(`/farm/self-test?chain=${next}`, url).toString(), 303);
      const summary = await latestSelfTestSummary(env);
      return html(renderSelfTest(summary?.fixtures ?? rows));
    }

    // Admission Gate, made real (docs/POSUDKY.md Posudek 16 — "kde se zadává nová kráva?"): runs the real, live
    // conformance suite for exactly one already-deployed capability (same self-test run "/farm/self-test?capability="
    // already does) and additionally certifies the result — requiredTests comes ONLY from requiredTestsFor()
    // (self-test.ts), never from this request, so nothing posted here can shrink what's required (Posudek 16
    // P1-9). This does NOT register new code or flip lifecycle.json to ACTIVE: a build with no code behind it has
    // no capability row to certify, and admission (the "admitted" bit deriveLifecycleStatus() reads) stays the
    // deliberate human config-edit-and-redeploy step buildFarmModel()'s own comment already documents.
    if (url.pathname === "/farm/certify" && request.method === "POST") {
      const capability = url.searchParams.get("capability");
      if (!capability) return new Response("capability required", { status: 400 });
      const [documentHostCaps, emailExecutorCaps] = await Promise.all([
        capabilitiesOf(env.DOCUMENT_HOST, "https://apf-document-host.internal"),
        capabilitiesOf(env.EMAIL_EXECUTOR, "https://apf-email-executor.internal"),
      ]);
      const row = [...gatewayCatalog(), ...documentHostCaps.capabilities, ...emailExecutorCaps.capabilities].find((c) => c.capability === capability);
      if (!row) return new Response(`unknown capability ${capability}`, { status: 404 });
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
      const rows = (await stub.selfTest({ capability })) as SelfTestRow[];
      await recordSelfTestSummary(env, rows);
      const record = certifyFromSelfTest({ module: row.module, capability, riskProfile: row.riskClass ?? "UNKNOWN", buildHash: env.GIT_SHA, rows, clock: new SystemClock() });
      await recordCertification(env, record);
      return Response.redirect(new URL("/farm#staj", url).toString(), 303);
    }

    // Nastavení's first setting (docs/POSUDKY.md Posudek 16 follow-up, owner's request 2026-09-14): which model
    // Kravská dílna uses. Validated against the SAME describeModels()/modelTable() the read side renders from —
    // an unavailable option (no credential) or an unknown key is refused, never silently stored; installation.ts's
    // own "never without a model" guarantee means there's always at least one valid choice to fall back to.
    if (url.pathname === "/farm/settings/cow-workshop-model" && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const key = form.get("key");
      if (typeof key !== "string" || !key) return new Response("key required", { status: 400 });
      const view = cowWorkshopModelsOf(env, undefined);
      if ("error" in view) return new Response(view.error, { status: 500 });
      const choice = view.choices.find((c) => c.key === key);
      if (!choice) return new Response(`unknown model ${key}`, { status: 400 });
      if (choice.unavailable) return new Response(`model ${key} is unavailable: ${choice.unavailable}`, { status: 400 });
      await setCowWorkshopModelKey(env, key, iso(new SystemClock().now()));
      return Response.redirect(new URL("/farm#nastaveni", url).toString(), 303);
    }

    // Kravská dílna (owner's request 2026-09-14): a conversational drafting assistant, never a code-execution or
    // deploy surface — see workshop.ts's own header comment. Model comes from Nastavení's own runtime choice
    // (never a param here, same closed loop as certifyFromSelfTest's requiredTests: the caller can't override it).
    if (url.pathname === "/farm/workshop" && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const text = form.get("text");
      if (typeof text !== "string" || !text.trim()) return new Response("text required", { status: 400 });
      const clock = new SystemClock();
      const session = newSession(text, clock);
      const modelKey = await latestCowWorkshopModelKey(env);
      const { adapter } = modelAdapterFor(installation, secretsOf(env), env.AI, COW_WORKSHOP, modelKey, 4000);
      const withReply = await sendMessage(session, text, adapter, clock, installation.profile.assistant?.displayName ?? "Erwin");
      await saveWorkshopSession(env, withReply);
      return Response.redirect(new URL(`/farm/workshop/${withReply.sessionId}`, url).toString(), 303);
    }

    const workshopMessage = /^\/farm\/workshop\/(cow-[A-Za-z0-9]+)\/message$/.exec(url.pathname);
    if (workshopMessage && request.method === "POST") {
      const sessionId = workshopMessage[1] as string;
      const session = await getWorkshopSession(env, sessionId);
      if (!session) return new Response("unknown session", { status: 404 });
      const form = await request.formData().catch(() => new FormData());
      const text = form.get("text");
      if (typeof text !== "string" || !text.trim()) return new Response("text required", { status: 400 });
      const clock = new SystemClock();
      const modelKey = await latestCowWorkshopModelKey(env);
      const { adapter } = modelAdapterFor(installation, secretsOf(env), env.AI, COW_WORKSHOP, modelKey, 4000);
      const withReply = await sendMessage(session, text, adapter, clock, installation.profile.assistant?.displayName ?? "Erwin");
      await saveWorkshopSession(env, withReply);
      return Response.redirect(new URL(`/farm/workshop/${sessionId}`, url).toString(), 303);
    }

    const workshopView = /^\/farm\/workshop\/(cow-[A-Za-z0-9]+)$/.exec(url.pathname);
    if (workshopView && request.method === "GET") {
      const session = await getWorkshopSession(env, workshopView[1] as string);
      if (!session) return new Response("unknown session", { status: 404 });
      return html(renderWorkshopSession(session));
    }

    // Manual verification for the Argos alert wiring (HANDOFF 85) — "never deploy untested" for a real external
    // side effect means actually confirming an e-mail arrives, which nothing automated here can do. Goes through
    // the exact same sendArgosAlerts()/ArgosAlertPort path a real incident would (respects ARGOS_ALERT_MODE),
    // just with a synthetic IncidentRecord instead of a real one.
    if (url.pathname === "/farm/test-alert" && request.method === "POST") {
      if (!installation.profile.channels.operatorAlertTo) return Response.json({ error: "NO_ALERT_TO", message: "channels.operatorAlertTo not configured for this installation" }, { status: 400 });
      const now = iso(new SystemClock().now());
      const testIncident: IncidentRecord = { key: "test-alert", level: "WARN", text: "Testovací zpráva z /farm/test-alert — pokud tohle vidíš, doručení funguje.", firstSeenAt: now, lastSeenAt: now, occurrences: 1 };
      await sendArgosAlerts(env, [testIncident], [], now);
      return Response.json({ ok: true, mode: env.ARGOS_ALERT_MODE, to: installation.profile.channels.operatorAlertTo });
    }

    // "Known, accepted, not fixing today" (owner's request 2026-09-11, Argos tuning) — a human on /farm marking
    // one still-open incident acknowledged so it stops holding the banner at INCIDENT/DEGRADED red without
    // resolving it or touching occurrences/lastSeenAt (page.ts's acknowledgeIncident()/effectiveWatchdogLevel()).
    // `by` is the same Cloudflare Access header identity every other /farm action already trusts (decideReview,
    // purge) — no new authorization concept.
    if (url.pathname === "/farm/incidents/acknowledge" && request.method === "POST") {
      const form = await request.formData().catch(() => new FormData());
      const key = String(form.get("key") ?? "");
      const now = iso(new SystemClock().now());
      await ensureD1Audit(env.AUDIT);
      const existing = await allIncidents(env);
      const updated = acknowledgeIncident(existing, key, receivedFrom(request), now).find((i) => i.key === key);
      // Only persist when acknowledgeIncident() actually changed something — an unknown/resolved/already-
      // acknowledged key is a silent no-op here too, same contract as the pure function itself.
      if (updated?.acknowledgedAt) {
        await env.AUDIT.prepare("INSERT OR REPLACE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(watchdogIncidentAuditId(key), now, WATCHDOG_INCIDENT_KIND, null, null, null, "argos", null, JSON.stringify(updated))
          .run();
      }
      return Response.redirect(new URL("/farm#argos", url).toString(), 303);
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

    // Rebuild 13. 9. 2026 (vlastníkovo rozhodnutí, "nahradíme na stejnou adresu"): / je teď jen redirect na
    // Průsvitnou stáj, žádná samostatná plain-form stránka.
    if (url.pathname === "/" && request.method === "GET") return Response.redirect(new URL("/farm", url).toString(), 302);

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
        if (!text.trim()) return html(renderError("Prázdný požadavek", "Nahraj soubor, nebo vlož text — obojí bylo prázdné."), 400);
        content = { kind: "text", bytes: text, contentType: "text/plain" };
      }

      const result = await startIntake(env, { workflow, tenantId, receivedFrom: from, modelKey: modelKey || undefined, stampText: stampText || undefined, content });
      if (!result.ok) return html(renderError(INTAKE_ERROR_TITLE[result.code] ?? result.code, result.message, { ...(result.detail ?? {}) }), INTAKE_ERROR_STATUS[result.code] ?? 500);
      return Response.redirect(new URL(`/workflow/${result.workflowId}`, url).toString(), 303);
    }

    // AUTONOMOUS-RUNTIME-V1.md część 5's new ingress contract, additive alongside /intake above (which stays
    // completely unchanged — ADR's own decision, "/intake se nemění"). Deliberately the narrowest possible
    // request/response shape: { caseId } and NOTHING else — no workflow, goal or intent field anywhere in
    // request or response (AR-2). Does not start a workflow instance (no stub.intake()/startIntake() call
    // here) — the Case this creates is UNSTARTED with zero instances; what happens to it next (intent.resolve
    // → goal → plan → execution, part 3/6) is a later milestone's job, not this endpoint's.
    if (url.pathname === "/impulse" && request.method === "POST") {
      if (env.KILL_SWITCH === "true") return Response.json({ ok: false, code: "KILL_SWITCH", message: "Farma je vypnutá (KILL_SWITCH)." }, { status: 503 });
      const body = (await request.json().catch(() => undefined)) as Partial<ImpulseRequest> | undefined;
      if (!body || typeof body.channel !== "string") {
        return Response.json({ ok: false, code: "BAD_REQUEST", message: "expected { channel: string, text?: string, attachments?: string[], metadata?: Record<string,string> }" }, { status: 400 });
      }
      // tenantId resolved server-side (intakeTenant(), same as /intake and /mail-intake above) — never read
      // from the request body, even if a caller supplies one; there is no `tenantId` field on ImpulseRequest
      // to read in the first place.
      const tenantId = intakeTenant();
      const caseId = newId("case");
      let impulse: NormalizedImpulse;
      try {
        impulse = normalizeImpulse({
          channel: body.channel,
          tenantId,
          impulseId: newId("imp"),
          receivedAt: new Date().toISOString(),
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(Array.isArray(body.attachments) ? { attachments: body.attachments.filter((a): a is string => typeof a === "string") } : {}),
          // Deep-validated, not just typeof === "object" (adversarial review 19.9.2026 flagged the looser
          // check as a runtime gap against the Record<string,string> contract) — a non-string value is
          // dropped rather than smuggled through as-is; metadata is never read to make a decision today, but
          // a future consumer must be able to trust the type it was given.
          ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? { metadata: Object.fromEntries(Object.entries(body.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
            : {}),
        });
      } catch (e) {
        const message = e instanceof ImpulseError ? e.message : e instanceof Error ? e.message : String(e);
        return Response.json({ ok: false, code: "BAD_IMPULSE", message }, { status: 400 });
      }
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(caseId));
      await stub.createCase({ caseId, impulse });
      return Response.json({ caseId }, { status: 201 });
    }

    // Internal: only apf-mail-ingest's email() handler ever calls this, over the GATEWAY/MAIL_INGEST service
    // bindings — not a public form like /intake. Tenant is resolved server-side, never trusted from the caller.
    if (url.pathname === "/mail-intake" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as Partial<MailIntakeRequest> | undefined;
      if (!body?.rawMail || !body.receivedFrom || !body.notifyRef) return Response.json({ ok: false, code: "BAD_REQUEST", message: "expected { rawMail, receivedFrom, notifyRef }" }, { status: 400 });
      const result = await startMailIntake(env, { rawMail: body.rawMail, receivedFrom: body.receivedFrom, notifyRef: body.notifyRef });
      return Response.json(result, { status: result.ok ? 200 : (INTAKE_ERROR_STATUS[result.code] ?? 500) });
    }

    // Owner's request 17.9.2026: re-test the same e-mail repeatedly without re-sending it for real (Ohrada/Výsledek's
    // own "🔁 Přehrát" button, page.ts replayForm()) — replayMailIntake() below.
    const replayRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/replay$/.exec(url.pathname);
    if (replayRoute && request.method === "POST") {
      const result = await replayMailIntake(env, replayRoute[1] as string);
      if (!result.ok) return html(renderError(result.title, result.message, result.detail ?? {}), result.status);
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

    // Write counterpart of the read-only route above: a remote executor host (apf-document-host) registers an
    // artifact it derived out-of-process and already copied to R2 itself, so this instance's own store — the only
    // place the GET route above can answer from — knows about it too (the notify-step fix, GW-ARTIFACT-REG-001).
    // Same trust model as the GET route (internal Fetcher binding only); ownership is still checked inside the DO.
    const registerArtifactRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/artifact$/.exec(url.pathname);
    if (registerArtifactRoute && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as Partial<DerivedArtifactRegistration> | undefined;
      if (!body?.artifactId || !body.tenantId || !body.sha256 || !body.contentType || typeof body.byteLength !== "number" || !body.location || !body.receivedFrom) {
        return Response.json({ error: "BAD_REQUEST", message: "expected {artifactId, tenantId, sha256, contentType, byteLength, location, receivedFrom, derivedFrom?, name?}" }, { status: 400 });
      }
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(registerArtifactRoute[1] as string));
      const result = await stub.registerDerivedArtifact(body as DerivedArtifactRegistration);
      if (!result.ok) return Response.json({ error: result.reason }, { status: result.reason === "INSTANCE_NOT_FOUND" ? 404 : 403 });
      return Response.json(result.artifact, { status: 201 });
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

    // One individual attachment out of a mail-intake instance's raw RFC 822 original. Until now this was
    // impossible, not just inconvenient: mail.ingest (src/components/mail-ingest/handler.ts) stores the whole
    // raw mail via artifacts.put() with NO contentType, so the store defaults it to "text/plain" (never
    // "message/rfc822") and — because put(), unlike putExternal(), never sets `location` — /original above
    // ALWAYS 404s for a mail-intake instance, and page.ts never even shows that link for one. The full raw mail
    // IS already in memory though: view.artifacts (this.artifacts.list() inside the object) carries every
    // artifact's complete text inline (DO SQLite, synchronous, no R2 round-trip) — including the mail original —
    // so a real MIME parse of that text can serve the individual attachments directly. Same convention as the
    // sibling GET routes above: no in-code auth/tenant check beyond "a Durable Object instance exists for this
    // workflowId" — Cloudflare Access at the edge is the actual gate.
    const attachmentRoute = /^\/workflow\/(wf-[A-Za-z0-9]+)\/attachment\/(\d+)$/.exec(url.pathname);
    if (attachmentRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(attachmentRoute[1] as string));
      const view = (await stub.view()) as InstanceView | null;
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: attachmentRoute[1] }, { status: 404 });
      const original = view.artifacts.find((a) => !a.derivedFrom);
      if (!original) return Response.json({ error: "NOT_FOUND", message: "instance has no original artifact" }, { status: 404 });
      const index = Number(attachmentRoute[2]);
      const attachment = parseMimeMessage(original.bytes).attachments[index];
      if (!attachment) return Response.json({ error: "NOT_FOUND", message: `no attachment at index ${index} on this original` }, { status: 404 });
      // The filename came from the untrusted sender's MIME headers — sanitized before it goes anywhere near a
      // response header (CR/LF response-splitting, embedded `"` breaking out of the quoted value); see
      // sanitizeMimeFilename() in src/platform/mime.ts. Falls back to a synthetic name if sanitizing empties it.
      const filename = sanitizeMimeFilename(attachment.filename ?? "") || `attachment-${index}`;
      // A plain ArrayBuffer (not the Uint8Array view itself) sidesteps a @types/node vs @cloudflare/workers-types
      // BodyInit typing clash in this project's deploy/cloudflare/tsconfig.json (skipLibCheck merges node's generic
      // Uint8Array<TArrayBuffer> over lib.dom's non-generic one) — same bytes, just a type the two type packages agree on.
      const body = attachment.bytes.buffer.slice(attachment.bytes.byteOffset, attachment.bytes.byteOffset + attachment.bytes.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: { "content-type": attachment.contentType || "application/octet-stream", "cache-control": "no-store", "content-disposition": `attachment; filename="${filename}"` },
      });
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

    // Case wiring (Commit 3): read-only observability over a whole mail impulse — the Case grouping mail-intake
    // with every attachment-classify/attachment-extract instance it fanned out into, closing the gap a live test
    // confirmed 18.9.2026 (a fan-out sub-instance's own workflowId 404s off GET /workflow/:id.json — it looks up
    // a separate, nonexistent Durable Object by that id). `:id` is the mail-intake instance's own "wf-..."
    // workflowId, same id GET /workflow/:id.json above accepts (caseView()'s own doc comment explains why: Case
    // storage is DO-local, so routing needs the id that already names this object, not the Case's own caseId).
    const caseRoute = /^\/case\/(wf-[A-Za-z0-9]+)\.json$/.exec(url.pathname);
    if (caseRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(caseRoute[1] as string));
      const view = await stub.caseView(caseRoute[1] as string);
      if (!view) return Response.json({ error: "NOT_FOUND", workflowId: caseRoute[1] }, { status: 404 });
      return Response.json(view);
    }

    // Counterpart to caseRoute above, for a Case /impulse created — no workflowId exists yet to route by
    // (caseByCaseId()'s own doc comment on the DO class has the full "why"), so this looks up by the Case's
    // own "case-..." id instead, addressing the same DO createCase() named after it.
    const caseByIdRoute = /^\/case\/(case-[A-Za-z0-9]+)\.json$/.exec(url.pathname);
    if (caseByIdRoute && request.method === "GET") {
      const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(caseByIdRoute[1] as string));
      const c = await stub.caseByCaseId(caseByIdRoute[1] as string);
      if (!c) return Response.json({ error: "NOT_FOUND", caseId: caseByIdRoute[1] }, { status: 404 });
      return Response.json({ case: c, instances: [] });
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

    // Genuine full-period Deník export (owner's request: "mít možnost vyvolat historii za období, exportovat CSV
    // a podobně") — a different consumer from /audit.json above (that one is the live-tail terminal, its own
    // contract, unchanged) and from GET /farm's own denikFrom/denikTo (that one only ever loads up to
    // DENIK_RANGE_LIMIT rows for a page render). This route may legitimately return far more rows than either of
    // those — capped at AUDIT_CSV_ROW_CAP, never unbounded. No in-code auth beyond what every other GET route in
    // this family already relies on (Cloudflare Access in front of the Worker) — matches /audit.json exactly, not
    // stricter, not looser.
    if (url.pathname === "/audit.csv" && request.method === "GET") {
      await ensureD1Audit(env.AUDIT);
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const kind = url.searchParams.get("kind") || undefined;
      const capability = url.searchParams.get("capability") || undefined;
      const conditions: string[] = [];
      const binds: unknown[] = [];
      if (from) {
        conditions.push("at >= ?");
        binds.push(from);
      }
      if (to) {
        conditions.push("at <= ?");
        binds.push(inclusiveDayEnd(to));
      }
      if (kind) {
        conditions.push("kind = ?");
        binds.push(kind);
      }
      if (capability) {
        conditions.push("capability = ?");
        binds.push(capability);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")} ` : "";
      // AUDIT_CSV_ROW_CAP (20000): this endpoint exists FOR a genuine full-period export, so it is allowed to
      // return far more than GET /farm's own DENIK_RANGE_LIMIT (500) — but "for export" still isn't "unbounded":
      // an unfiltered from/to across a long-lived farm could otherwise try to pull the entire audit table into one
      // response. 20000 rows of this shape is comfortably multiple MB of CSV, already a lot for a human to open in
      // a spreadsheet, and a ceiling any caller who genuinely needs more can page past with from/to.
      // LIMIT (cap + 1): one extra row lets us tell "truncated by the cap" apart from "exactly cap rows existed",
      // without a separate COUNT(*) query — the extra row itself is dropped before building the CSV.
      const AUDIT_CSV_ROW_CAP = 20000;
      const rows = await env.AUDIT.prepare(`SELECT json FROM audit ${where}ORDER BY at DESC LIMIT ?`)
        .bind(...binds, AUDIT_CSV_ROW_CAP + 1)
        .all<{ json: string }>();
      const truncated = rows.results.length > AUDIT_CSV_ROW_CAP;
      const csvRows: AuditCsvRow[] = (truncated ? rows.results.slice(0, AUDIT_CSV_ROW_CAP) : rows.results).map((r) => {
        const full = JSON.parse(r.json) as AuditRecord;
        return { at: full.at, kind: full.kind, workflowId: full.workflowId ?? null, tenantId: full.tenantId ?? null, capability: full.capability ?? null, details: full.details };
      });
      const csv = auditRowsToCsv(csvRows);
      // from/to/kind/capability are attacker-reachable query params about to go straight into a response header —
      // sanitizeMimeFilename() (src/platform/mime.ts) strips CR/LF/quote for exactly this reason (same discipline
      // as GET /workflow/:id/attachment/:n's Content-Disposition above); ":" is additionally swapped for "-" only
      // for a tidier filename on Windows, which treats ":" as a drive-letter separator, not for security.
      const filenamePart = (v: string): string => sanitizeMimeFilename(v).replace(/:/g, "-");
      const filename = from || to ? `denik-${from ? filenamePart(from) : "zacatek"}-${to ? filenamePart(to) : "ted"}.csv` : "denik-export.csv";
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
          ...(truncated ? { "x-audit-csv-truncated": "true" } : {}),
        },
      });
    }

    // Shared append-only trail for remote hosts (celek D2, docs/NAVRHOVY-LIST-farma.md "žádný Worker nesahá do cizí DB"):
    // reached only through a service binding, no host's own config ever routes it to the public internet.
    if (url.pathname === "/audit" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as Partial<AuditRecord> | undefined;
      if (!body?.kind) return Response.json({ error: "BAD_REQUEST", message: "kind required" }, { status: 400 });
      await ensureD1Audit(env.AUDIT);
      // Trusted telemetry, first slice (HANDOFF 95, MAJOR 7 of the second external review, docs/SEVERKA.md
      // "Audit provenance"): a compromised or buggy COW relaying this record could claim any tenantId it
      // likes — Argos now acts on this data (incidents/alerts), so that claim is worth checking against
      // ground truth the gateway already has, not accepted verbatim. workflowId always originates from a
      // dispatch THIS gateway itself issued, so its own Durable Object's journal is the authoritative
      // tenantId — deliberately not a new signing scheme (document-host/email-executor hold no signing key
      // of their own by design: "the ONLY private signing key of the farm" lives only here). A workflowId
      // with no live instance (purged, or an id nobody ever dispatched) fails OPEN here — that's a known,
      // separate gap (an unlinked/forged workflowId), not the cross-tenant spoof this check targets.
      if (body.workflowId) {
        const view = (await env.WORKFLOW.get(env.WORKFLOW.idFromName(body.workflowId))
          .view()
          .catch(() => null)) as InstanceView | null;
        if (view && auditClaimContradicts(body.tenantId, view.instance.tenantId)) {
          const denyRecord: AuditRecord = {
            auditId: newId("aud"),
            at: iso(new Date()),
            kind: "security",
            workflowId: body.workflowId,
            tenantId: view.instance.tenantId,
            details: { code: "AUDIT_TENANT_MISMATCH", claimedTenantId: body.tenantId ?? null, claimedKind: body.kind, claimedActorId: body.actorId ?? null },
          };
          await env.AUDIT.prepare("INSERT OR IGNORE INTO audit (audit_id, at, kind, correlation_id, workflow_id, tenant_id, actor_id, capability, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(denyRecord.auditId, denyRecord.at, denyRecord.kind, null, denyRecord.workflowId, denyRecord.tenantId, null, null, JSON.stringify(denyRecord))
            .run();
          console.error(`[apf-gateway] /audit rejected: claimed tenantId ${String(body.tenantId)} contradicts workflow ${body.workflowId}'s real tenant ${view.instance.tenantId}`);
          return Response.json({ error: "TENANT_MISMATCH", message: "claimed tenantId does not match the workflow's real tenant" }, { status: 403 });
        }
      }
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

  // Two cron triggers on one Worker (wrangler.jsonc triggers.crons — free plan allows up to 3), told apart by
  // controller.cron. R2 inbox batch import (owner's request, 2026-09-07): every 5 min, pick up whatever landed
  // under inbox/ and run it through the same startIntake() as the web form (processInbox()). Scheduled self-test
  // (HANDOFF 88, oponentura item 1 "Argos dnes sám nic systematicky nehlídá" + item 6 "self-testy jsou zatím
  // ruční"): every 30 min, one capability's fixtures — never the whole 72-fixture suite (the known subrequest-
  // depth limit, self-test.ts) — then the same reconcile/alert path GET /farm uses, so an incident is found and
  // Argos e-mails about it even if nobody opens the page.
  async scheduled(controller, env, ctx): Promise<void> {
    if (env.KILL_SWITCH === "true") {
      console.log(`[apf-gateway] scheduled skipped: KILL_SWITCH cron=${controller.cron}`);
      return;
    }
    const t0 = Date.now();
    if (controller.cron === SELF_TEST_CRON) {
      try {
        // Deterministic rotation, no stored "which one is next" state: which 30-minute slot this tick landed in
        // picks the capability, so the whole farm cycles through once every 6 ticks (today: 3 h).
        const capability = selfTestCapabilityForTick(controller.scheduledTime);
        const stub = env.WORKFLOW.get(env.WORKFLOW.idFromName(SELF_TEST_WORKFLOW_ID));
        const rows = (await stub.selfTest({ capability })) as SelfTestRow[];
        await recordSelfTestSummary(env, rows);
        const model = await buildFarmModel(env, 15, "");
        await reconcileAndPersistIncidents(env, model, model.now);
        console.log(`[apf-gateway] scheduled self-test capability=${capability} rows=${rows.length} (${Date.now() - t0}ms) cron=${controller.cron}`);
      } catch (e) {
        console.error(`[apf-gateway] scheduled self-test threw (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        controller.noRetry();
      }
      return;
    }
    try {
      const r = await processInbox(env);
      console.log(`[apf-gateway] scheduled inbox picked=${r.picked} ok=${r.ok} failed=${r.failed} (${Date.now() - t0}ms) cron=${controller.cron}`);
    } catch (e) {
      console.error(`[apf-gateway] scheduled inbox threw (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      controller.noRetry(); // a thrown error here is a bug to look at in Workers Logs, not something an immediate retry fixes
    }
  },
} satisfies ExportedHandler<Env>;
