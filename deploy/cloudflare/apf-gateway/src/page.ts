// Server-rendered pages of the gateway (behind Cloudflare Access): Průsvitná stáj — the farm's own control
// plane — plus the single-instance detail view and the self-test report. No external assets, no framework:
// the page is evidence, not an app. Czech labels for the owner.
import type { Artifact } from "../../../../src/platform/artifacts.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import type { CertificationRecord, LifecycleStatus } from "../../../../src/platform/certification.js";
import type { Instance } from "../../../../src/platform/journal.js";
import type { WorkshopSession } from "./workshop.js";

export interface FarmStats {
  totalProcessed: number;
  processedToday: number;
  avgProcessingMs: number | null;
  byType: { type: string; count: number }[];
}

export interface InboxItem {
  key: string;
  name: string;
  size: number;
  uploaded: string;
  reason?: string;
  message?: string;
}

/** JSON shape of /version and /health — unrelated to any page, kept exactly as those two endpoints already contract it. */
export interface Wired {
  intake: boolean;
  extract: string;
  journal: string;
  audit: string;
  artifacts: string;
  dispatch: boolean;
  gateway: string;
  signing: string;
  fakes: string;
  hosts: boolean;
  accessJwtVerified: boolean;
}

/** The installation's models for classify as the operator sees them, or the reason none can be used. */
export type ModelsInfo =
  | { default: string; choices: Array<{ key: string; label: string; provider: string; model: string; isDefault: boolean; unavailable?: string }> }
  | { error: string };

export interface DeployableStatus {
  name: string;
  ok: boolean;
  status: number;
  body: unknown;
  /** Last stored self-test result for this worker (docs: owner 2026-09-09, "nevím, jestli jsou zdravé, jen je
   * zelené OK") — undefined when self-test was never run on this farm. */
  selfTest?: { passed: number; total: number };
  /** The individual fixtures behind that count, across every capability this worker serves. */
  selfTestFixtures?: SelfTestFixtureState[];
}

/** Purged instances still show up (D1 audit remembers them) but the Durable Object has nothing left to fetch. */
export type FarmInstanceRow =
  | { workflowId: string; purged: true; at: string }
  | {
      workflowId: string;
      purged?: false;
      workflow: string;
      workflowVersion: string;
      tenantId: string;
      actorId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      steps: Instance["steps"];
      originalName?: string;
      originalByteLength?: number;
    };

/** One row of the shared audit trail (D1 "audit" table), as-is — the "deník". */
export interface AuditLogRow {
  at: string;
  kind: string;
  workflowId: string | null;
  tenantId: string | null;
  capability: string | null;
  details: unknown;
}

/** One row of the Admission Gate table (Stáj tab): a registered capability + the descriptor's own risk/isolation
 * claim + its live lifecycleStatus (HANDOFF 70/71, docs/SEVERKA.md "Admission Gate") — read-only here, the Router
 * is what actually enforces it. */
export interface CapabilityRow {
  capability: string;
  version: string;
  module: string;
  componentVersion?: string;
  riskClass?: string;
  sideEffects?: string;
  isolationClass?: string;
  trustClass?: string;
  usesLlm?: boolean;
  lifecycleStatus: "ACTIVE" | "QUARANTINED";
  /** Last stored self-test result for this exact capability — undefined when self-test was never run. */
  selfTest?: { passed: number; total: number };
  /** The individual fixtures behind that count — owner's request 2026-09-09: "chci vidět kontroly". */
  selfTestFixtures?: SelfTestFixtureState[];
  /** Last real, live certification of this capability, ANY build (index.ts buildFarmModel) — shown even when
   * stale (a previous deploy) so the operator can see "certified, but not for what's running now", never
   * silently hidden. Posudek 16 P1-9 / docs/POSUDKY.md: made real 2026-09-14. */
  certification?: CertificationRecord;
  /** deriveLifecycleStatus() (src/platform/certification.ts) over certification + the real ACTIVE/QUARANTINED
   * this same row's lifecycleStatus carries — the full 6-state Admission Gate vocabulary, shown ALONGSIDE
   * lifecycleStatus (never replacing it): lifecycleStatus is what Router.route() actually enforces today,
   * derivedStatus is what Admission Gate says should eventually gate it. Only counts a certification toward
   * ACTIVE/CERTIFIED when its buildHash matches the currently running gitSha (build-bound, CERT-004). */
  derivedStatus: LifecycleStatus;
}

/** Durable Žlab as seen from the shared D1 copy (M0 D-5): counts and authority domains only — never a value, never a result. */
export interface ZlabStats {
  total: number;
  byDomain: { domain: string; records: number; last: string }[];
}

export interface FarmModel {
  installation: string;
  gitSha: string;
  gatewaySigning: string;
  /** Absent = D1 unreachable when the page was built (rendered as "nedostupný", never as zero). */
  zlab?: ZlabStats;
  deployables: DeployableStatus[];
  capabilities: CapabilityRow[];
  instances: FarmInstanceRow[];
  instanceLimit: number;
  instanceWindow: string;
  auditLog: AuditLogRow[];
  inbox: { pending: InboxItem[]; failed: InboxItem[]; batchLimit: number };
  workflows: string[];
  models: ModelsInfo;
  /** Nastavení's own runtime-editable model choice for Kravská dílna (cow.workshop, index.ts COW_WORKSHOP) —
   * never without a model (installation.ts's own guarantee): defaults to the installation's configured default
   * (Workers AI, free) until an operator picks something else in Nastavení. Separate from `models` above
   * (document.classify's per-document dropdown) on purpose — a different capability's own choice. */
  cowWorkshopModels: ModelsInfo;
  /** Newest first (index.ts listWorkshopSessions) — Kravská dílna's own session list. */
  workshopSessions: WorkshopSession[];
  stats: FarmStats;
  /** When the self-test summary carried on deployables[].selfTest/capabilities[].selfTest was recorded —
   * undefined when self-test was never run on this farm yet. Doubles as the scheduled self-test's own
   * heartbeat (HANDOFF 92, "watchdog watching itself"): a healthy 30-minute cron keeps this fresh on its own,
   * so computeWatchdog() escalates a STALE (not just absent) selfTestAt to its own INCIDENT finding. */
  selfTestAt?: string;
  /** Currently-open watchdog incidents (index.ts reconcileAndPersistIncidents, D1 kind "watchdog-incident") —
   * absent/empty is a valid state (a fresh farm, or the very first render before any run has persisted one). */
  incidents?: IncidentRecord[];
  /** When this FarmModel was assembled (index.ts buildFarmModel, ISO) — the single clock reference every
   * staleness check in computeWatchdog() compares against, so nothing drifts between two separate `new Date()`
   * calls in the same request. */
  now: string;
  /** Argos's own alerting channel health (HANDOFF 92, MAJOR 3 of the second external review) — last attempted
   * send and its outcome, so a broken alert channel becomes a watchdog finding instead of a silently swallowed
   * console.error. Absent = no send has ever been attempted yet on this installation. */
  alertHealth?: ArgosAlertHealth;
  /** Worker names whose /capabilities fetch failed this run (HANDOFF 93, MAJOR 5 of the second external
   * review) — distinguishes "capabilitiesOf() found zero" from "capabilitiesOf() couldn't ask", so a
   * capability that silently drops out of `capabilities` this run is visibly explained, not just missing. */
  capabilitiesUnavailableFrom?: string[];
  /** Every WAITING/FAILED/UNKNOWN_OUTCOME workflow farm-wide (HANDOFF 94, index.ts authoritativeOpenProblems)
   * — what computeWatchdog()'s ohrada-backlog finding is based on, NOT the same windowed `instances` the
   * Ohrada tab renders (MAJOR 4 of the second external review: "monitoring data source nesmí být UI
   * pagination" — an old open problem must stay visible to Argos even once it falls out of that window). */
  openWorkflowProblems: OpenWorkflowProblem[];
  /** How many POST /audit relays in the last 24h claimed a tenantId that contradicted the gateway's own
   * journal for that workflowId (HANDOFF 95, MAJOR 7 of the second external review, "Audit provenance" —
   * docs/SEVERKA.md) — index.ts rejects those (403) and logs them, this is what lets computeWatchdog() turn a
   * detected spoofing attempt into a finding instead of it only ever reaching Workers Logs. */
  recentAuditTenantMismatches: number;
}

export interface InstanceView {
  workflowId: string;
  installation: string;
  instance: Instance;
  artifacts: Artifact[];
  audit: AuditRecord[];
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// ---------------------------------------------------------------------------------------------------------------
// Vizuální identita — Průsvitná stáj (rebuild 13. 9. 2026, vlastníkovo rozhodnutí "udělej to podle sebe").
// Jeden sdílený shell/CSS pro všechny stránky gatewaye (dřív dva different vizuální jazyky: /  vs. /farm) —
// žádná externí vendor CSS, žádný framework, jeden <style> blok, světlý i tmavý režim.
// ---------------------------------------------------------------------------------------------------------------

// No xmlns attribute (ARCH-DEP-001 would otherwise mistake the mandatory SVG namespace URI,
// "http://www.w3.org/2000/svg", for a hardcoded installation hostname) — every major browser
// renders an inline data: SVG favicon fine without it, since the image/svg+xml MIME type in the
// URI itself already establishes SVG parsing.
const FAVICON =
  "data:image/svg+xml,%3Csvg viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23c17f2b'/%3E%3Cpath d='M8 13c0-1.8 1.8-3.2 3.6-2.6.5-1.7 3.3-1.7 3.8 0C17.2 9.8 19 11.2 19 13' stroke='%23fff8ea' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3Crect x='7' y='13' width='18' height='11' rx='5.5' fill='%23fff8ea'/%3E%3Ccircle cx='12.2' cy='18' r='1.1' fill='%23c17f2b'/%3E%3Ccircle cx='19.8' cy='18' r='1.1' fill='%23c17f2b'/%3E%3Cpath d='M13.6 21.2c1 .8 2.8.8 3.8 0' stroke='%23c17f2b' stroke-width='1.3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";

const APP_CSS = String.raw`
:root{
  /* Dark green, unconditionally default (owner's explicit request 13. 9. 2026: apf.maxferit.cz — the
     real thing — should look like ai-farma-web's dark demo, not follow prefers-color-scheme into a
     light shell nobody asked for). Palette lifted straight from deploy/cloudflare/ai-farma-web/styles.css
     so the two stay visually one family. Light stays reachable at [data-theme="light"] below, dormant
     until something actually sets that attribute (no toggle wired yet). */
  --bg:#07110e; --panel:#0c1814; --panel-2:#102019; --chrome:#0a1712; --border:#20392f; --border-soft:#17251e;
  --text:#edf7f1; --dim:#8fa79d; --faint:#5b7267;
  --accent:#45d483; --accent-fg:#06120d; --accent-soft:#132a1f;
  --ok:#45d483; --ok-soft:#123321; --warn:#f0bd4f; --warn-soft:#332809; --crit:#ff6b6b; --crit-soft:#2b1515;
  --shadow:0 18px 50px rgba(0,0,0,.30);
  --radius:11px; --radius-lg:18px;
  --font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --font-head:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --font-mono:"Cascadia Mono","Consolas",ui-monospace,monospace;
  color-scheme:dark;
}
:root[data-theme="light"]{
  --bg:#f7f4ec; --panel:#fffdf8; --panel-2:#fbf6ea; --chrome:#f0e9d6; --border:#e2d6b8; --border-soft:#ece3c9;
  --text:#26210f; --dim:#75694a; --faint:#a89a72;
  --accent:#a8551f; --accent-fg:#fff8ea; --accent-soft:#f3e0c9;
  --ok:#2f7a3d; --ok-soft:#e3f1e0; --warn:#a06a00; --warn-soft:#f7ecd2; --crit:#b23a2e; --crit-soft:#fbe4df;
  --shadow:0 1px 2px rgba(38,33,15,.06), 0 1px 8px rgba(38,33,15,.05);
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 var(--font)}
code,kbd{font:.92em var(--font-mono);background:var(--border-soft);color:#b9efd0;padding:.08em .38em;border-radius:5px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{font-family:var(--font-head);font-weight:800;letter-spacing:-.02em;margin:0}
button,input,select,textarea{font:inherit;color:inherit}
.dim{color:var(--dim)}
.mono{font-family:var(--font-mono)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:.22em .7em .22em .55em;border-radius:999px;font-size:.82em;font-weight:650;white-space:nowrap}
.badge .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.b-ok{background:var(--ok-soft);color:var(--ok)}
.b-warn{background:var(--warn-soft);color:var(--warn)}
.b-crit{background:var(--crit-soft);color:var(--crit)}
.b-neutral{background:var(--border-soft);color:var(--dim)}
.btn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:var(--radius);padding:9px 12px;background:var(--panel);color:var(--text);font-weight:600;cursor:pointer}
.btn:hover{background:var(--chrome)}
.btn-primary{background:#1f6d49;border-color:#2b895e;color:#eaf6ef}
.btn-primary:hover{filter:brightness(1.1)}
.btn-danger{background:#351a1a;border-color:#653232;color:#ff9a9a}
.btn-sm{padding:.3em .7em;font-size:.85em;font-weight:600}
.card{background:linear-gradient(180deg,var(--panel),#091511);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;box-shadow:var(--shadow)}
.card.crit{border-color:var(--crit)}
table{width:100%;border-collapse:collapse;font-size:.93em}
th,td{text-align:left;vertical-align:top;padding:10px .6em;border-bottom:1px solid var(--border-soft)}
th{color:#718b7e;font-weight:650;font-size:11px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
label{display:block;font-weight:650;margin:.9em 0 .3em}
input[type=text],input[type=file],textarea,select{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--radius);padding:.55em .65em;background:var(--panel);color:var(--text)}
textarea{min-height:8rem;font-family:var(--font-mono)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--border-soft);padding:.7em .85em;border-radius:8px;max-height:22rem;overflow:auto;font-size:.85em;font-family:var(--font-mono)}
details summary{cursor:pointer;color:var(--dim);font-size:.88em}
details summary:hover{color:var(--text)}
hr{border:0;border-top:1px solid var(--border-soft);margin:1.1em 0}
`;

const SHELL_CSS = String.raw`
.app{min-height:100vh;display:grid;grid-template-columns:252px 1fr;grid-template-rows:68px 1fr 34px;grid-template-areas:"top top" "rail main" "foot foot";background:var(--bg)}
.app[data-rail="collapsed"]{grid-template-columns:60px 1fr}
.app-top{grid-area:top;display:flex;align-items:center;gap:12px;padding:0 26px;background:rgba(7,17,14,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20}
.app-top .railbtn{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:8px;background:none;color:var(--dim);cursor:pointer;flex:none}
.app-top .railbtn:hover{background:var(--chrome);color:var(--text)}
.brand{display:flex;align-items:center;gap:9px;font-family:var(--font-head);font-weight:700;font-size:1.02em;white-space:nowrap}
.brand .mark{width:26px;height:26px;flex:none}
.brand .sub{color:var(--dim);font-weight:400;font-size:.86em}
.app-top .fill{flex:1}
.app-top .meta{display:flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid #2b4c3d;border-radius:999px;background:#10241b;color:#b9cec4;font-size:12px;white-space:nowrap}
.app-rail{grid-area:rail;background:rgba(7,17,14,.93);backdrop-filter:blur(12px);border-right:1px solid var(--border);padding:20px 14px;overflow-y:auto;position:sticky;top:0;height:100vh}
.app[data-rail="collapsed"] .app-rail{padding:10px 6px}
.navlink{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;color:#abc0b6;font-weight:600;font-size:.93em;white-space:nowrap;overflow:hidden;margin:2px 0}
.navlink:hover{background:#0f2019;color:var(--text);text-decoration:none}
.navlink .ic{width:18px;height:18px;flex:none;color:var(--dim)}
.navlink[aria-current="true"]{background:#153126;color:#fff;box-shadow:inset 3px 0 0 var(--accent)}
.navlink[aria-current="true"] .ic{color:var(--accent)}
.app[data-rail="collapsed"] .navlink .lbl,.app[data-rail="collapsed"] .navsec,.app[data-rail="collapsed"] .navlink .count{display:none}
.navsec{margin:16px 0 8px;padding:0 10px;font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:#607a6d}
.navlink .count{margin-left:auto;background:var(--crit-soft);color:var(--crit);border-radius:999px;padding:0 7px;font-size:.78em;font-weight:700}
.app-main{grid-area:main;overflow-y:auto;padding:28px}
.app-main>section{max-width:1600px;margin:0 auto}
.app-foot{grid-area:foot;display:flex;align-items:center;gap:14px;padding:0 16px;background:var(--panel);border-top:1px solid var(--border);color:var(--dim);font-size:.8em;white-space:nowrap;overflow-x:auto}
.app-foot b{color:var(--text)}
.app-foot .fill{flex:1}
.icon{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.mascot{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;flex:none;box-shadow:var(--shadow)}
.mascot-sm{width:28px;height:28px}
.mascot-sm svg{width:19px;height:19px}
.mascot-lg{width:56px;height:56px}
.mascot-lg svg{width:38px;height:38px}
.navlink .mascot-sm{margin:0}
.pagehead{display:flex;align-items:center;gap:14px;margin-bottom:7px;flex-wrap:wrap}
.pagehead h1{font-size:30px;line-height:1.1;letter-spacing:-.03em;display:flex;align-items:center;gap:10px}
.pagehead .lede{color:var(--dim);font-size:.94em;max-width:900px;margin:0 0 22px}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0}
.toolbar .fill{flex:1}
.grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin:16px 0}
.stat{background:linear-gradient(180deg,var(--panel),#091511);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;box-shadow:var(--shadow)}
.stat b{display:block;font-family:var(--font-head);font-weight:800;font-size:1.7rem;letter-spacing:-.03em}
.stat span{color:var(--dim);font-size:.85em}
.pen{border:1.5px dashed var(--border);border-radius:calc(var(--radius-lg) + 4px);padding:12px 12px 4px;margin:0 0 16px;background:var(--panel-2)}
.pen-label{display:flex;align-items:center;gap:7px;font-family:var(--font-head);font-weight:800;margin-bottom:10px}
.pen-label .icon{color:var(--accent)}
.p-card{background:linear-gradient(180deg,var(--panel),#091511);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 16px;box-shadow:var(--shadow)}
.p-card.crit{border-color:var(--crit)}
.p-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:650}
.p-card-head code{background:none;padding:0}
.p-card-role{color:var(--dim);font-size:.87em;margin-top:4px;line-height:1.4}
.p-card-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:8px;font-size:.85em;color:var(--dim)}
.p-card-meta b{color:var(--text)}
.p-card details,.p-card form{margin-top:8px}
.fx-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:.85em;border-bottom:1px dotted var(--border-soft)}
.fx-row:last-child{border-bottom:0}
.fx-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fx-why{color:var(--dim);font-size:.85em}
.fx-reco{color:var(--crit);font-size:.85em}
.hero{border-radius:var(--radius-lg);overflow:hidden;margin-bottom:16px;box-shadow:var(--shadow)}
.hero img{display:block;width:100%;max-height:190px;object-fit:cover;object-position:center 30%;background:var(--panel-2)}
.attn-item{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-soft)}
.attn-item:last-child{border-bottom:0}
.feed-item{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--border-soft);font-size:.92em}
.feed-item:last-child{border-bottom:0}
.feed-item .t{color:var(--dim);font-family:var(--font-mono);font-size:.85em;flex:none;width:5.4em}
.gridwrap{overflow:auto}
.gh-toggle{cursor:pointer}
.gh-toggle:hover td{background:var(--chrome)}
.gh-chevron{display:inline-block;width:.9em;transition:transform .15s}
.gh-toggle[aria-expanded="true"] .gh-chevron{transform:rotate(90deg)}
tr.group-head td{background:var(--panel-2);white-space:normal;font-weight:650}
.wrap{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;word-break:break-word;line-height:1.4}
.term{margin:0;height:22rem;overflow-y:auto;background:var(--chrome);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;font-family:var(--font-mono);font-size:.87em;line-height:1.6}
.term .t-line{white-space:pre-wrap;word-break:break-word}
.term .t-line.t-new{animation:flash 1.4s ease-out}
.term .t-dim{color:var(--dim)}
@keyframes flash{from{background:var(--accent-soft)}to{background:transparent}}
.bar-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.bar-label{width:7rem;flex:none;font-size:.85em;color:var(--dim)}
.bar-track{flex:1;height:12px;background:var(--border-soft);border-radius:4px;overflow:hidden}
.bar-fill{height:100%;background:var(--accent);border-radius:4px}
.bar-count{width:2.4rem;flex:none;text-align:right;font:.85em var(--font-mono)}
[hidden]{display:none!important}
@media (max-width:820px){
  .app{grid-template-columns:1fr;grid-template-areas:"top" "main" "foot"}
  .app-rail{display:none}
}
`;

/** One shared shell for every page — /farm, a single instance, a self-test report, an error. `bodyHtml` is the
 * `<section>`/full page-specific markup; `wide` uses the side-nav app shell (only renderFarm), everything else
 * gets a simple centered document. */
const shell = (title: string, bodyHtml: string, opts: { wide?: boolean; script?: string } = {}): string =>
  `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="${FAVICON}">
<style>${APP_CSS}${opts.wide ? SHELL_CSS : DOC_CSS}</style></head><body>${bodyHtml}${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;

const DOC_CSS = String.raw`
body{padding:0}
.doc{max-width:52rem;margin:0 auto;padding:28px 20px 60px}
.doc header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.doc header h1{font-size:1.3rem}
.doc nav{margin-top:1.5rem;display:flex;gap:14px;flex-wrap:wrap}
.doc h2{font-size:1.05rem;margin:1.6rem 0 .6rem}
.doc h3{font-size:.98rem;margin:1.2rem 0 .4rem}
`;

/** A small inline SVG icon, 24x24 viewport, currentColor stroke — same convention throughout. */
const icon = (paths: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  menu: icon('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
  prehled: icon('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="4.5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="13.5" width="7" height="6.5" rx="1.5"/>'),
  podatelna: icon('<path d="M4 12V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><path d="M4 12h4.5l1.2 2.4h4.6L15.5 12H20"/><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>'),
  ohrada: icon('<line x1="5" y1="4" x2="5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="19" y1="4" x2="19" y2="20"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>'),
  staj: icon('<path d="M6 9.5a2.3 2.3 0 0 1 3-2.2M18 9.5a2.3 2.3 0 0 0-3-2.2"/><rect x="5" y="9" width="14" height="10" rx="5"/><circle cx="9.5" cy="14" r=".7" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14" r=".7" fill="currentColor" stroke="none"/><path d="M10 17.2c.7.5 1.3.5 2 0"/>'),
  argos: icon('<path d="M6 9c-1.2-.8-1.6-2.4 0-3.2.8.4 1.2 1.2 1.2 2M18 9c1.2-.8 1.6-2.4 0-3.2-.8.4-1.2 1.2-1.2 2"/><path d="M6 10.5a6 6 0 0 1 12 0c0 3.5-2.7 6-6 6s-6-2.5-6-6Z"/><circle cx="10" cy="11" r=".6" fill="currentColor" stroke="none"/><circle cx="14" cy="11" r=".6" fill="currentColor" stroke="none"/>'),
  vysledek: icon('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 10.8 15.3 16 9.5"/>'),
  denik: icon('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>'),
  nastaveni: icon('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>'),
  dilna: icon('<path d="M4 19l6-6"/><path d="M13.5 4.5c-1.6-.6-3.4-.2-4.6 1-1.5 1.5-1.7 3.7-.6 5.4l-6 6 1.8 1.8 6-6c1.7 1.1 3.9.9 5.4-.6 1.2-1.2 1.6-3 1-4.6l-3 3-2-2 3-3Z"/>'),
  diagram: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><line x1="8" y1="7.5" x2="10.5" y2="16.2"/><line x1="16" y1="7.5" x2="13.5" y2="16.2"/><line x1="8.5" y1="6" x2="15.5" y2="6"/>'),
  wheat: icon('<path d="M12 21V9"/><path d="M12 9c-2-2-2-4 0-6 2 2 2 4 0 6Z"/><path d="M12 13c-2.2-1.2-3-3-2.4-5.4 2.3.6 3.4 2 3 4.4Z"/><path d="M12 13c2.2-1.2 3-3 2.4-5.4-2.3.6-3.4 2-3 4.4Z"/><path d="M12 17c-2.2-1.2-3-3-2.4-5.4 2.3.6 3.4 2 3 4.4Z"/><path d="M12 17c2.2-1.2 3-3 2.4-5.4-2.3.6-3.4 2-3 4.4Z"/>'),
};

/**
 * Actual little illustrated characters (owner's explicit request 13. 9. 2026 after seeing the first
 * rebuild draft: "pokud tam nebudou vyobrazené krávy, hlídací pes, farmář a tak, celá terminologie
 * ztrácí kouzlo" — thin monochrome line icons alone don't carry the farm metaphor, they need actual
 * faces). Flat, filled, 48x48 — a cow (Stáj), a dog (Argos), a farmer (Přehled/Farmář). Deliberately
 * simple geometry (circles/ellipses/paths), no external art asset, same "no framework, no build step"
 * constraint as the rest of the page.
 */
const MASCOT_SVG = {
  krava: `<ellipse cx="10" cy="17" rx="6.5" ry="4.5" fill="#e8dcc0" transform="rotate(-30 10 17)"/><ellipse cx="38" cy="17" rx="6.5" ry="4.5" fill="#e8dcc0" transform="rotate(30 38 17)"/><rect x="8" y="14" width="32" height="27" rx="13.5" fill="#fff8ea"/><ellipse cx="14.5" cy="23" rx="4.2" ry="3.2" fill="#a8551f" opacity=".5"/><ellipse cx="34.5" cy="31" rx="5.2" ry="3.6" fill="#a8551f" opacity=".5"/><rect x="12.5" y="29" width="23" height="11.5" rx="5.75" fill="#fbeede"/><circle cx="19" cy="35" r="1.5" fill="#8a5a26"/><circle cx="29" cy="35" r="1.5" fill="#8a5a26"/><circle cx="16.5" cy="22" r="2.4" fill="#2c2415"/><circle cx="31.5" cy="22" r="2.4" fill="#2c2415"/><circle cx="17.3" cy="21.1" r=".8" fill="#fff"/><circle cx="32.3" cy="21.1" r=".8" fill="#fff"/><path d="M20 38c2 1.7 6 1.7 8 0" stroke="#8a5a26" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  argos: `<path d="M10 21 L5 5 L19 15 Z" fill="#8a4a1c"/><path d="M38 21 L43 5 L29 15 Z" fill="#8a4a1c"/><circle cx="24" cy="25" r="15.5" fill="#c17f2b"/><ellipse cx="24" cy="31" rx="9.5" ry="7.5" fill="#fff8ea"/><ellipse cx="24" cy="30" rx="2.8" ry="2.1" fill="#2c2415"/><circle cx="17" cy="22" r="2.5" fill="#2c2415"/><circle cx="31" cy="22" r="2.5" fill="#2c2415"/><circle cx="17.8" cy="21.1" r=".8" fill="#fff"/><circle cx="31.8" cy="21.1" r=".8" fill="#fff"/><path d="M19.5 34.5c1.8 1.5 7.2 1.5 9 0" stroke="#2c2415" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  farmar: `<ellipse cx="24" cy="19" rx="21" ry="5.2" fill="#6b4a26"/><path d="M13 19c0-7.5 22-7.5 22 0Z" fill="#8a5f32"/><circle cx="24" cy="30" r="12.5" fill="#fff3e2" stroke="#c9a06b" stroke-width="1.3"/><circle cx="18.5" cy="29" r="1.9" fill="#2c2415"/><circle cx="29.5" cy="29" r="1.9" fill="#2c2415"/><path d="M17.5 34c2.2-1.6 4.3-1.6 6.5 0c2.2-1.6 4.3-1.6 6.5 0" stroke="#6b4a26" stroke-width="2.1" fill="none" stroke-linecap="round"/><path d="M19 37c2.6 2.3 7.4 2.3 10 0" stroke="#8a5a26" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
};
/** Wraps a MASCOT_SVG in a colored round badge — `size` "lg" for page headers, default small for the nav rail. */
const mascot = (which: keyof typeof MASCOT_SVG, bg: string, size: "lg" | "sm" = "sm"): string =>
  `<span class="mascot mascot-${size}" style="background:${bg}"><svg viewBox="0 0 48 48" aria-hidden="true">${MASCOT_SVG[which]}</svg></span>`;
// Dark, per-section-tinted badge backgrounds (owner's 13. 9. 2026 "dark demo as default" request) —
// darkened versions of the old light tones, same hue families, so the mascot faces (light cream/white
// fills) read with even more contrast than they did on the old light badges, not less.
const MASCOT_BG: Record<"prehled" | "podatelna" | "ohrada" | "staj" | "argos" | "vysledek" | "denik" | "nastaveni" | "teletnik" | "dilna", string> = {
  prehled: "#2a2015",
  podatelna: "#16241c",
  ohrada: "#241f18",
  staj: "#1c2a1e",
  argos: "#2a2116",
  vysledek: "#16241a",
  denik: "#1a2028",
  nastaveni: "#241a28",
  teletnik: "#1e2618",
  dilna: "#1a2420",
};
/** Same round-badge treatment as mascot(), for the sections with no animal face of their own (Ohrada/
 * Výsledek/Deník/Podatelna) — a plain line icon() in a colored circle, so the whole nav rail reads as
 * one consistent, colorful cast rather than three characters plus four grey glyphs. */
const iconBadge = (svgIcon: string, bg: string, size: "lg" | "sm" = "sm"): string => `<span class="mascot mascot-${size}" style="background:${bg}">${svgIcon}</span>`;

/** State label -> badge class + human-friendly rendering, one function every page uses (dřív dvě různé konvence). */
const STATE_CLASS: Record<string, string> = {
  OK: "b-ok",
  "OK (dvojník)": "b-ok",
  SUCCEEDED: "b-ok",
  ACTIVE: "b-ok",
  HEALTHY: "b-ok",
  CERTIFIED: "b-ok",
  NEW: "b-neutral",
  QUARANTINED: "b-crit",
  DOWN: "b-crit",
  FAILED: "b-crit",
  INCIDENT: "b-crit",
  WARN: "b-warn",
  WAITING: "b-warn",
  NEZAPOJENO: "b-warn",
  UNKNOWN_OUTCOME: "b-warn",
  DEGRADED: "b-warn",
  CANCELLED: "b-warn",
  RUNNING: "b-neutral",
  PENDING: "b-neutral",
  NÁVRH: "b-neutral",
  SKIPPED: "b-neutral",
};
const stateBadge = (label: string): string => `<span class="badge ${STATE_CLASS[label] ?? "b-neutral"}"><span class="dot"></span>${esc(label)}</span>`;
const stateTd = (label: string): string => `<td>${stateBadge(label)}</td>`;

/** What each "kravička" actually does, in plain Czech — the raw health table alone doesn't say. */
const DEPLOYABLE_ROLE: Record<string, string> = {
  "apf-document-host": "Orazítkuje dokument po ověření a zapíše ho — dnes proti testovacímu dvojníku DMS, ne ostrému systému. Umí i „document.archive“, ale v běžném toku se nevolá (existuje jen kvůli testu izolace)",
  "apf-email-executor": "Odesílá e-mailová upozornění",
  "apf-mail-ingest": "Přijímá dokumenty poslané e-mailem",
  "apf-fakes": "Testovací dvojník DMS/registru/archivu — jeho „OK“ znamená jen, že dvojník odpovídá, ne že je napojený skutečný systém",
};

/**
 * Ideas from docs/NAVRHOVY-LIST-farma.md that have no code yet (owner's request, 2026-09-07: "do seznamu agentů
 * dávej i nápady co mám v režimu návrh") — kept here by hand, in sync with the design doc, not parsed from it.
 * Found stale 2026-09-14 (owner, over a screenshot: "to je taky tele" / "krávou se stane tele automaticky,
 * pokud splňuje všechny atributy krávy"): cz.company.verify/cz.vat.verify sat here claiming "žádný kód" long
 * after src/components/cz-company-verify, cz-vat-verify were actually built (HANDOFF c030d60/9e68529) — true
 * code, tested, just not yet wired into any live Cloudflare deployable (only src/slice.ts, the Node harness
 * root). Removed rather than relabeled: this list is the ONE hand-maintained "is it real" state left on the
 * page, and it drifted the moment nobody remembered to update it by hand. Everything else (Stáj/Teletník) reads
 * live Router state, never a list a human has to keep in sync — once these two are wired into apf-gateway,
 * they appear in Teletník automatically, no entry here to remember to delete.
 */
const PLANNED_DEPLOYABLES: { name: string; role: string }[] = [];

/** "Reachable" (HTTP 200 on /version) and "actually wired into the flow" are different claims — a skeleton answers fine but does nothing yet. */
const workerReady = (d: DeployableStatus): boolean => d.ok && (d.body as Record<string, unknown> | null)?.wired !== false;
const workerStateLabel = (d: DeployableStatus): string => {
  if (!d.ok) return "DOWN";
  if ((d.body as Record<string, unknown> | null)?.wired === false) return "NEZAPOJENO";
  return d.name === "apf-fakes" ? "OK (dvojník)" : "OK";
};

/** Isolation class -> plain label + hover explanation (LOGICAL/PRINCIPAL are jargon on their own). */
const isolationLabel = (raw: string): { label: string; title?: string } => {
  if (raw === "self") return { label: "gateway", title: "toto je samotná gateway, hlásí vlastní zdraví" };
  if (raw === "LOGICAL") return { label: "sdílený proces", title: "LOGICAL: běží ve stejném Workeru jako další úkol, ale s odděleným přístupovým klíčem" };
  if (raw === "PRINCIPAL") return { label: "vlastní proces", title: "PRINCIPAL: běží zcela odděleně, s vlastním přístupovým klíčem — nejsilnější izolace" };
  return { label: raw };
};

/** Risk class -> Czech label + a colour cue for HIGH/CRITICAL (docs/POSUDKY.md Posudek 7, Admission Gate discussion). */
const RISK_LABEL: Record<string, string> = { LOW: "nízké", MEDIUM: "střední", HIGH: "vysoké", CRITICAL: "kritické" };
const riskBadge = (raw: string | undefined): string => {
  if (!raw) return `<span class="dim">—</span>`;
  const cls = raw === "HIGH" || raw === "CRITICAL" ? "b-crit" : raw === "MEDIUM" ? "b-warn" : "b-ok";
  return `<span class="badge ${cls}">${esc(RISK_LABEL[raw] ?? raw)}</span>`;
};

/** ISO timestamp, trimmed to "YYYY-MM-DD HH:MM:SS" — same trim used by the Deník terminal. */
const shortAt = (at: string): string => esc(at).replace("T", " ").replace(/\.\d+Z$|Z$/, "");

/** "OK"/"ACTIVE" alone proves only that the process answered, not that anything was actually verified (owner
 * 2026-09-09: "nevím, jestli jsou zdravé, jen je zelené OK" / "kde jsou slibované testy kraviček?"). Shows the
 * last stored self-test result — undefined means "never run", stated plainly rather than left implicit. */
const selfTestBadge = (st: { passed: number; total: number } | undefined): string => {
  if (!st) return `<span class="dim" title="Self-test nikdy neproběhl na téhle farmě">self-test: nikdy</span>`;
  const cls = st.total === 0 ? "dim" : st.passed === st.total ? "" : "";
  const color = st.total === 0 ? "var(--dim)" : st.passed === st.total ? "var(--ok)" : "var(--crit)";
  return `<span class="${cls}" style="color:${color}" title="Poslední self-test: ${esc(st.passed)}/${esc(st.total)} fixtures prošlo">self-test <b>${st.passed}/${st.total}</b></span>`;
};

/** One line of a card's drill-down — owner's request 2026-09-09: "chci vidět kontroly", ne jen souhrnné číslo. */
const fixtureLine = (f: SelfTestFixtureState): string => {
  const label = f.skipped ? "SKIPPED" : f.ok ? "SUCCEEDED" : "FAILED";
  // A passing check with no description said only "shoda s golden" — useless to someone who wants to know
  // what it actually verified (owner 2026-09-09, this same request). A failing check still shows the diff:
  // that's the actionable part, more useful than the fixture's own description of the happy path.
  const detail = f.skipped ? esc(f.skipped) : f.diff.length ? esc(f.diff.join(" · ")) : f.description ? esc(f.description) : "shoda s golden";
  // Owner 2026-09-10: PASS/FAIL alone doesn't say what's protected or what to do about red — "why" survives
  // even a green result, "recommendation" only ever matters once something actually failed.
  const why = f.why ? `<div class="fx-why">Proč: ${esc(f.why)}</div>` : "";
  const reco = !f.ok && !f.skipped && f.onFailure ? `<div class="fx-reco">Doporučení: ${esc(f.onFailure)}</div>` : "";
  return `<div class="fx-row">${stateBadge(label)}<code>${esc(f.id)}</code><span class="dim">${esc(f.kind)}</span><span class="fx-detail dim" title="${detail}">${detail}</span></div>${why}${reco}`;
};

/** Individual checks behind a card's "self-test N/M" — owner's request 2026-09-09: "chci vidět kontroly". */
const selfTestList = (fixtures: SelfTestFixtureState[] | undefined): string =>
  fixtures?.length ? `<details><summary>Zobrazit kontroly (${fixtures.length})</summary>${fixtures.map(fixtureLine).join("")}</details>` : "";

/** The list above + a button to (re-)run just this card's own suite instead of always all 72 fixtures —
 * owner's request 2026-09-09: "i si je být schopen individuálně vyvolat". Only meaningful where a real
 * capability suite exists behind the scope (Stáj's capability cards) — worker cards get selfTestList() alone. */
const selfTestDrilldown = (fixtures: SelfTestFixtureState[] | undefined, capability: string): string =>
  `${selfTestList(fixtures)}<form method="post" action="/farm/self-test?capability=${encodeURIComponent(capability)}"><button class="btn btn-sm" type="submit">Spustit jen ${esc(capability)}</button></form>`;

/** Admission Gate's real, build-bound certification (Posudek 16 P1-9, index.ts certifyFromSelfTest) — separate
 * badge from `lifecycleStatus` on purpose: lifecycleStatus is what Router.route() actually enforces today
 * (ACTIVE/QUARANTINED from lifecycle.json), derivedStatus is Admission Gate's own opinion, never conflated
 * with what's really gating dispatch. A certification from an OLDER build (buildHash != today's gitSha) still
 * shows, marked stale, rather than silently vanishing after every deploy. */
const certificationLine = (c: CapabilityRow, gitSha: string): string => {
  const cert = c.certification;
  const badge = stateBadge(c.derivedStatus);
  if (!cert) return `<span title="Certifikace nikdy neproběhla pro tuhle kapabilitu">Admission Gate: ${badge} <span class="dim">nikdy certifikováno</span></span>`;
  const passed = Object.values(cert.actualResults).filter((r) => r === "PASS").length;
  const stale = cert.buildHash !== gitSha ? ` <span class="dim" title="Poslední certifikace patří jinému buildu (${esc(cert.buildHash)}), ne dnešnímu ${esc(gitSha)}">(starší build)</span>` : "";
  const color = cert.decision === "PASS" ? "var(--ok)" : "var(--crit)";
  return `<span title="Certifikace buildu ${esc(cert.buildHash)}, ${esc(shortAt(cert.certifiedAt))}">Admission Gate: ${badge} <span style="color:${color}">${passed}/${cert.requiredTests.length} povinných testů</span>${stale}</span>`;
};

const certifyForm = (capability: string): string =>
  `<form method="post" action="/farm/certify?capability=${encodeURIComponent(capability)}"><button class="btn btn-sm" type="submit">Spustit certifikaci</button></form>`;

/** One card of the Admission Gate pen: capability, its risk/isolation claim, live lifecycle, and — separately —
 * Argos's own live health opinion on top of it (HANDOFF 89), when there's an open finding to show. */
const capabilityRow = (c: CapabilityRow, watchdog: WatchdogSnapshot, incidents: IncidentRecord[], gitSha: string): string => {
  const iso = isolationLabel(c.isolationClass ?? "");
  const argos = capabilityWatchdogLevel(c.capability, watchdog, incidents);
  const argosBadge = argos ? `<span title="Argosův živý nález, ne formální stav Admission Gate">Argos: ${stateBadge(argos)}</span>` : "";
  return `<div class="p-card${c.lifecycleStatus === "QUARANTINED" ? " crit" : ""}"><div class="p-card-head"><code>${esc(c.capability)}</code>/v${esc(c.version)}${c.usesLlm ? ' <small title="volá jazykový model">🤖</small>' : ""}${stateBadge(c.lifecycleStatus)}</div><div class="p-card-meta"><span>riziko ${riskBadge(c.riskClass)}</span><span${iso.title ? ` title="${esc(iso.title)}"` : ""}>izolace <b>${esc(iso.label || "—")}</b></span><span>${esc(c.sideEffects ?? "—")}</span></div><div class="p-card-meta">${selfTestBadge(c.selfTest)}${argosBadge}</div><div class="p-card-meta">${certificationLine(c, gitSha)}</div>${certifyForm(c.capability)}${selfTestDrilldown(c.selfTestFixtures, c.capability)}</div>`;
};

/** How long something lasted between two ISO timestamps, for a human reading a finding — minutes/hours/days,
 * not a raw ms diff. Used by computeWatchdog()'s staleness checks and composeIncidentAlert()'s resolved text. */
const humanDuration = (fromIso: string, toIso: string): string => {
  const minutes = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} dní`;
};

// -----------------------------------------------------------------------------------------------------------
// Argos — beze změny logiky (jen prezentace výš/níž je nová). Tahle sekce je 1:1 stejná jako před rebuildem:
// computeWatchdog/reconcileIncidents/acknowledgeIncident/composeIncidentAlert/effectiveWatchdogLevel jsou
// testované čistě funkce (tests/page.test.ts) a rebuild vizuální vrstvy na nich nesmí nic změnit.
// -----------------------------------------------------------------------------------------------------------

export type WatchdogLevel = "HEALTHY" | "DEGRADED" | "INCIDENT";
export interface WatchdogFinding {
  /** Stable identity for the underlying problem, independent of the human-readable text (which carries mutable
   * counts like "17/18") — what lets reconcileIncidents() recognize "still the same problem" across runs. */
  key: string;
  level: "WARN" | "INCIDENT";
  text: string;
}
export interface WatchdogSnapshot {
  level: WatchdogLevel;
  findings: WatchdogFinding[];
}

/** How stale m.selfTestAt can get before it stops meaning "the 30-minute scheduled self-test is healthy" and
 * starts meaning "the scheduled tick itself has probably stopped firing" — 3 missed ticks' worth of slack
 * (HANDOFF 92), wide enough that one transient miss or a slow deploy doesn't false-alarm. */
const WATCHDOG_HEARTBEAT_STALE_MS = 90 * 60 * 1000;

/**
 * True when a POST /audit relay claims a tenantId that contradicts the gateway's own WorkflowInstance journal
 * for that workflowId (HANDOFF 95, MAJOR 7 of the second external review, docs/SEVERKA.md "Audit provenance").
 * `undefined` claimedTenantId is not itself a contradiction — a record simply missing one is today's existing
 * (accepted) shape, not a new thing to start rejecting. Pure — index.ts does the actual journal lookup and
 * only calls this with what it found; no Workers/Durable Object runtime needed to test the comparison itself.
 */
export const auditClaimContradicts = (claimedTenantId: string | undefined, actualTenantId: string): boolean => claimedTenantId !== undefined && claimedTenantId !== actualTenantId;

/**
 * Argos's own verdict over what /farm already knows — first slice of "Argos jako skutečný watchdog"
 * (external review + owner 2026-09-10, HANDOFF 82/83): today a human has to read every card to notice
 * something's wrong; this computes one rollup instead. Deterministic rules only, no AI, no new data source —
 * mostly the same facts the cards already show (deployable health, Admission Gate lifecycle, self-test
 * results, the Ohrada backlog), plus two watchdog-of-watchdog signals added in HANDOFF 92 (second external
 * review MAJOR 2/3): the scheduled self-test's own heartbeat, and Argos's alert channel's own health — so
 * Argos noticing it can't watch or can't speak is itself a finding, not silence (docs/SEVERKA.md zero-trust
 * section: detection must stay a rule, never an LLM guess).
 */
export function computeWatchdog(m: FarmModel): WatchdogSnapshot {
  const findings: WatchdogFinding[] = [];

  for (const d of m.deployables) {
    if (!workerReady(d)) findings.push({ key: `worker:${d.name}`, level: "INCIDENT", text: `${d.name} neodpovídá nebo není zapojen (${workerStateLabel(d)})` });
  }

  for (const c of m.capabilities) {
    if (c.lifecycleStatus === "QUARANTINED") findings.push({ key: `quarantined:${c.capability}`, level: "INCIDENT", text: `${c.capability} je v karanténě (Admission Gate)` });
    if (c.selfTest && c.selfTest.total > 0) {
      if (c.selfTest.passed === 0) findings.push({ key: `selftest-broken:${c.capability}`, level: "INCIDENT", text: `${c.capability}: self-test 0/${c.selfTest.total} — capabilita vypadá úplně nefunkční` });
      else if (c.selfTest.passed < c.selfTest.total)
        findings.push({ key: `selftest-degraded:${c.capability}`, level: "WARN", text: `${c.capability}: self-test ${c.selfTest.passed}/${c.selfTest.total}, ${c.selfTest.total - c.selfTest.passed} kontrol selhává` });
    }
  }

  // MAJOR 5 (HANDOFF 93): makes a failed capabilitiesOf() fetch visible instead of just an absence — the
  // capabilities that worker serves are missing from m.capabilities this run too, but their existing incidents
  // (if any) stay open rather than silently resolving, since reconcileIncidents() checks this same set.
  for (const worker of m.capabilitiesUnavailableFrom ?? []) {
    findings.push({ key: `capabilities-unavailable:${worker}`, level: "WARN", text: `${worker}: /capabilities se nepodařilo přečíst — jeho kapability chybí v tomhle přehledu, ne že by zmizely` });
  }

  if (!m.selfTestAt) {
    findings.push({ key: "selftest-stale", level: "WARN", text: "self-test nikdy neproběhl na téhle farmě — Argos nemá žádný živý důkaz, že kapability doopravdy fungují" });
  } else if (Date.parse(m.now) - Date.parse(m.selfTestAt) > WATCHDOG_HEARTBEAT_STALE_MS) {
    // Dead-man switch (HANDOFF 92, MAJOR 2): a healthy 30-min cron keeps selfTestAt fresh on its own — this
    // stale means the scheduled tick itself has likely stopped firing, not just "nobody looked in a while".
    findings.push({ key: "selftest-stale", level: "INCIDENT", text: `self-test naposledy proběhl před ${humanDuration(m.selfTestAt, m.now)} — scheduled self-test (každých 30 min) zřejmě přestal fungovat` });
  }

  // Authoritative, not the same windowed instanceLimit/instanceWindow the Ohrada tab renders (HANDOFF 94,
  // MAJOR 4 of the second external review: "monitoring data source nesmí být UI pagination") — an old open
  // problem stays visible here even once enough newer instances pushed it out of that window.
  if (m.openWorkflowProblems.length > 0)
    findings.push({ key: "ohrada-backlog", level: "WARN", text: `${m.openWorkflowProblems.length} ${m.openWorkflowProblems.length === 1 ? "instance čeká" : "instancí čeká"} v Ohradě na člověka nebo skončila chybou` });

  // Alert channel health (HANDOFF 92, MAJOR 3): a send failure alone only logs (sendArgosAlerts, index.ts) —
  // this is what turns "Argos couldn't speak" into something visible on /farm even when the alert itself
  // couldn't go out. "Unhealthy" = the most recent attempt failed and no later attempt has since succeeded.
  const alertHealth = m.alertHealth;
  if (alertHealth?.lastFailureAt && (!alertHealth.lastSuccessAt || Date.parse(alertHealth.lastFailureAt) > Date.parse(alertHealth.lastSuccessAt))) {
    findings.push({ key: "alert-channel", level: "INCIDENT", text: `Argosovo vlastní odesílání e-mailu selhává: ${alertHealth.lastFailureReason ?? "neznámý důvod"} (naposledy ${shortAt(alertHealth.lastFailureAt)})` });
  }

  // Trusted telemetry (HANDOFF 95, MAJOR 7): index.ts's /audit handler rejects (403) and logs any relay that
  // claims a tenantId contradicting the gateway's own journal for that workflowId — SEV1 territory
  // (docs/SEVERKA.md zero-trust: cross-tenant access attempt), so a rejected attempt becomes its own INCIDENT
  // instead of only reaching Workers Logs.
  if (m.recentAuditTenantMismatches > 0)
    findings.push({
      key: "audit-tenant-mismatch",
      level: "INCIDENT",
      text: `${m.recentAuditTenantMismatches} ${m.recentAuditTenantMismatches === 1 ? "pokus" : "pokusy"} o /audit záznam s cizím tenantId za posledních 24 h — možná kompromitovaná nebo vadná COW`,
    });

  const level: WatchdogLevel = findings.some((f) => f.level === "INCIDENT") ? "INCIDENT" : findings.length > 0 ? "DEGRADED" : "HEALTHY";
  return { level, findings };
}

/** True once a human has acknowledged the still-open incident behind this finding key (owner's request
 * 2026-09-11, Argos tuning) — "known, accepted, not fixing today", not "resolved". A key with no incidents
 * entry at all (first render before reconcileAndPersistIncidents() ever ran) is never acknowledged. */
const isAcknowledgedFinding = (key: string, incidents: IncidentRecord[]): boolean => !!incidents.find((i) => i.key === key && !i.resolvedAt)?.acknowledgedAt;

/** One capability's own live health, as Argos currently sees it — INCIDENT/DEGRADED/undefined (healthy), read
 * off the same findings computeWatchdog() already produced for that capability's keys (quarantined:/
 * selftest-broken:/selftest-degraded:), excluding any the owner already acknowledged as known. Deliberately NOT
 * a LifecycleStatus: this is Argos's live opinion shown next to the Admission Gate's own ACTIVE/QUARANTINED
 * badge, never a replacement for it (HANDOFF 89). */
const capabilityWatchdogLevel = (capability: string, watchdog: WatchdogSnapshot, incidents: IncidentRecord[]): "INCIDENT" | "DEGRADED" | undefined => {
  // Exact keys, matching computeWatchdog()'s own scheme precisely — not a loose endsWith(), which could
  // over-match if one capability name were ever a suffix of another.
  const ownKeys = new Set([`quarantined:${capability}`, `selftest-broken:${capability}`, `selftest-degraded:${capability}`]);
  const own = watchdog.findings.filter((f) => ownKeys.has(f.key) && !isAcknowledgedFinding(f.key, incidents));
  if (own.some((f) => f.level === "INCIDENT")) return "INCIDENT";
  if (own.some((f) => f.level === "WARN")) return "DEGRADED";
  return undefined;
};

/** One persisted incident (config/<installation>-independent, lives in D1 audit as kind "watchdog-incident") —
 * gives a WatchdogFinding an identity across runs instead of it being recomputed from scratch every page load. */
export interface IncidentRecord {
  key: string;
  level: "WARN" | "INCIDENT";
  text: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  resolvedAt?: string;
  /** Owner's own judgment call: "known, accepted, not fixing today" (e.g. the self-test harness's documented
   * subrequest-depth-limit artifact, HANDOFF 55-60/101) — never set by computeWatchdog()/reconcileIncidents()
   * itself, only by acknowledgeIncident() below, and only reachable through a human clicking the button on
   * /farm. Purely a display concern (see effectiveWatchdogLevel): reconcileIncidents() keeps tracking
   * occurrences/lastSeenAt on an acknowledged incident exactly as before, and reconcileIncidents() itself drops
   * these two fields whenever a key is reopened after a prior resolution (upsert only spreads `...prior` for a
   * STILL-open incident) — a genuinely new occurrence of an old key never inherits a stale acknowledgment. */
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

/** Argos's own alerting channel health (HANDOFF 92, D1 audit kind "argos-alert-health", one fixed row) — the
 * last attempted send's outcome, independent of whether there was anything to report that run. */
export interface ArgosAlertHealth {
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

/** One workflow currently WAITING/FAILED/UNKNOWN_OUTCOME (HANDOFF 94, index.ts authoritativeOpenProblems) —
 * independent of Ohrada's own instanceLimit/instanceWindow, so computeWatchdog() can't miss an old open
 * problem just because enough newer instances arrived and pushed it out of the windowed "Poslední instance". */
export interface OpenWorkflowProblem {
  workflowId: string;
  status: string;
  at: string;
}

/** Key prefixes computeWatchdog() only ever emits for a capability actually present in that run's m.capabilities
 * — the ones at risk of the MAJOR 5 bug (second external review, HANDOFF 93): capabilitiesOf() (index.ts)
 * returns [] on ANY fetch failure, not a distinguishable error, so a capability can silently vanish from a run
 * without the fetch failure itself producing a finding. Kept as the single authoritative list so
 * reconcileIncidents()'s scope check can never quietly drift from computeWatchdog()'s own key scheme. */
const CAPABILITY_SCOPED_FINDING_PREFIXES = ["quarantined:", "selftest-broken:", "selftest-degraded:"] as const;

/**
 * Turns this run's watchdog findings into incident state, given what was already known — Incident Store, first
 * slice (oponentura item 2, HANDOFF 84 continued). A finding that keeps showing up updates the SAME incident
 * (lastSeenAt, occurrences+1) instead of looking like a fresh problem on every page load; a finding that stops
 * appearing closes its incident (resolvedAt) — but ONLY if this run was actually able to re-evaluate it
 * (`knownCapabilities`, HANDOFF 93/MAJOR 5): "the capability wasn't in this run's findings" must mean "checked,
 * currently fine", never "we couldn't tell" — an incident whose capability fell out of the model this run
 * (a transient capabilitiesOf() fetch failure, not a fix) stays open instead of silently, incorrectly resolving.
 * Pure — no clock, no storage; the caller supplies `now` and persists the result (index.ts). Returns only the
 * records that changed this run (new, updated or newly resolved) — already-resolved history is untouched.
 */
export function reconcileIncidents(existing: IncidentRecord[], findings: WatchdogFinding[], now: string, knownCapabilities: readonly string[]): IncidentRecord[] {
  const openByKey = new Map(existing.filter((i) => !i.resolvedAt).map((i) => [i.key, i]));
  const seenKeys = new Set<string>();
  const upserted: IncidentRecord[] = findings.map((f) => {
    seenKeys.add(f.key);
    const prior = openByKey.get(f.key);
    return prior
      ? { ...prior, level: f.level, text: f.text, lastSeenAt: now, occurrences: prior.occurrences + 1 }
      : { key: f.key, level: f.level, text: f.text, firstSeenAt: now, lastSeenAt: now, occurrences: 1 };
  });
  const knownCapabilitySet = new Set(knownCapabilities);
  const wasEvaluated = (key: string): boolean => {
    const prefix = CAPABILITY_SCOPED_FINDING_PREFIXES.find((p) => key.startsWith(p));
    // Worker/global keys (selftest-stale, ohrada-backlog, alert-channel, worker:*) have no silent-absence
    // failure mode today — their own sources fail loudly (buildFarmModel throws) rather than vanishing — so
    // they're always considered evaluated.
    return prefix === undefined || knownCapabilitySet.has(key.slice(prefix.length));
  };
  const resolved: IncidentRecord[] = [...openByKey.values()].filter((i) => !seenKeys.has(i.key) && wasEvaluated(i.key)).map((i) => ({ ...i, resolvedAt: now }));
  return [...upserted, ...resolved];
}

/**
 * "Known, accepted, not fixing today" (owner's request 2026-09-11, Argos tuning) — a human on /farm marking one
 * still-open incident as understood, so it stops demanding attention (effectiveWatchdogLevel below) without
 * hiding it or touching occurrences/lastSeenAt tracking. No-op (returns `existing` unchanged) for a key that
 * doesn't exist, is already resolved, or is already acknowledged — the caller (index.ts) doesn't need to
 * special-case any of those before calling. Pure — index.ts supplies `now`/`by` (the Access identity) and
 * persists only the one record this actually changes.
 */
export function acknowledgeIncident(existing: IncidentRecord[], key: string, by: string, now: string): IncidentRecord[] {
  return existing.map((i) => (i.key === key && !i.resolvedAt && !i.acknowledgedAt ? { ...i, acknowledgedAt: now, acknowledgedBy: by } : i));
}

/**
 * Argos's own e-mail alert (oponentura bod 11, "hlídací pes potřebuje štěkat") — composed here, pure and
 * testable, so index.ts's job is only to actually call the send binding. `newlyOpened`/`newlyResolved` are the
 * subset of reconcileIncidents()'s output that's actually new information (an incident on its first occurrence,
 * or one that just got resolvedAt) — a continuing incident being seen again is not, by itself, news. Returns
 * undefined when there is nothing to report; the caller must not send an empty e-mail.
 */
export function composeIncidentAlert(newlyOpened: IncidentRecord[], newlyResolved: IncidentRecord[]): { subject: string; body: string } | undefined {
  if (newlyOpened.length === 0 && newlyResolved.length === 0) return undefined;

  const incidentCount = newlyOpened.filter((i) => i.level === "INCIDENT").length;
  const icon = incidentCount > 0 ? "🔴" : newlyOpened.length > 0 ? "🟡" : "🟢";
  const parts: string[] = [];
  if (newlyOpened.length) parts.push(`${newlyOpened.length} ${newlyOpened.length === 1 ? "nový nález" : "nové nálezy"}`);
  if (newlyResolved.length) parts.push(`${newlyResolved.length} ${newlyResolved.length === 1 ? "vyřešený nález" : "vyřešené nálezy"}`);
  const subject = `${icon} Argos: ${parts.join(", ")}`;

  const lines: string[] = [];
  if (newlyOpened.length) {
    lines.push("NOVÉ:");
    for (const i of newlyOpened) lines.push(`  [${i.level}] ${i.text}`);
    lines.push("");
  }
  if (newlyResolved.length) {
    lines.push("VYŘEŠENO:");
    // i.text is frozen at whatever it said the LAST time the incident was still open (e.g. "self-test 12/14, 2
    // kontrol selhává") — reused as-is here, a "VYŘEŠENO:" line reporting a failure count reads as if the
    // problem still exists (owner's report 2026-09-14, over a real e-mail: "nic z nich nepoznám"). "— teď OK"
    // makes explicit what changed: this WAS the finding, it is not anymore.
    for (const i of newlyResolved) lines.push(`  ${i.text} — teď OK (trvalo ${humanDuration(i.firstSeenAt, i.resolvedAt as string)})`);
    lines.push("");
  }
  lines.push("— Argos, /farm");
  return { subject, body: lines.join("\n") };
}

/** Display-only severity that treats an acknowledged finding as no longer demanding attention (owner's request
 * 2026-09-11, Argos tuning — document.stamp/document.archive's documented, long-standing self-test-harness
 * artifact, HANDOFF 55-60/101, was sitting at INCIDENT red for 7+ hours with no way to say "yes, known, not
 * fixing today"). Never changes reconcileIncidents()/sendArgosAlerts() themselves — those keep tracking and
 * alerting on raw truth; this only changes what a human sees as "still needs attention" on /farm. */
export const effectiveWatchdogLevel = (snapshot: WatchdogSnapshot, incidents: IncidentRecord[]): WatchdogLevel => {
  const active = snapshot.findings.filter((f) => !isAcknowledgedFinding(f.key, incidents));
  return active.some((f) => f.level === "INCIDENT") ? "INCIDENT" : active.length > 0 ? "DEGRADED" : "HEALTHY";
};

const watchdogFindingLine = (f: WatchdogFinding, incidents: IncidentRecord[]): string => {
  const record = incidents.find((i) => i.key === f.key && !i.resolvedAt);
  const age = record && record.occurrences > 1 ? ` <span class="dim">(poprvé ${shortAt(record.firstSeenAt)}, ${record.occurrences}×)</span>` : "";
  if (record?.acknowledgedAt) {
    const by = record.acknowledgedBy ? `${esc(record.acknowledgedBy)}, ` : "";
    return `<li class="dim">${esc(f.text)}${age} — ✓ potvrzeno jako známé (${by}${shortAt(record.acknowledgedAt)})</li>`;
  }
  const ackForm = `<form method="post" action="/farm/incidents/acknowledge" style="display:inline"><input type="hidden" name="key" value="${esc(f.key)}"><button class="btn btn-sm" type="submit" title="Potvrdit jako známý/přijatý nález — zůstane vidět, přestane počítat do celkového stavu">potvrdit jako známé</button></form>`;
  return `<li style="color:var(--${f.level === "INCIDENT" ? "crit" : "warn"})">${esc(f.text)}${age} ${ackForm}</li>`;
};

/** The banner at the top of Argos's own page — one verdict instead of reading every card, plus (once an
 * incident has been seen more than once) how long it's actually been going on. */
const watchdogBanner = (snapshot: WatchdogSnapshot, incidents: IncidentRecord[]): string => {
  const level = effectiveWatchdogLevel(snapshot, incidents);
  const activeCount = snapshot.findings.filter((f) => !isAcknowledgedFinding(f.key, incidents)).length;
  const ackCount = snapshot.findings.length - activeCount;
  const summary =
    snapshot.findings.length === 0
      ? "žádné otevřené nálezy"
      : `${activeCount} ${activeCount === 1 ? "otevřený nález" : "otevřené nálezy"}` + (ackCount > 0 ? `, ${ackCount} potvrzeno jako známé` : "");
  return `<div class="toolbar">${stateBadge(level)}<span class="dim">${summary}</span></div>${
    snapshot.findings.length ? `<ul style="margin:.25rem 0 1rem 1.25rem;padding:0">${snapshot.findings.map((f) => watchdogFindingLine(f, incidents)).join("")}</ul>` : ""
  }`;
};

/** Nastavení's own model picker (Kravská dílna) — radio per choice, unavailable ones shown disabled with their
 * reason (same "never silently skip an option" rule ModelChoice.unavailable already carries for the Podatelna
 * dropdown), posts straight to index.ts's /farm/settings/cow-workshop-model. An `error` ModelsInfo (fail-closed:
 * the capability's own configured default is itself unavailable) shows plainly rather than a broken form. */
const cowWorkshopModelForm = (models: ModelsInfo): string => {
  if ("error" in models) return `<p style="color:var(--crit)">Nelze načíst modely: ${esc(models.error)}</p>`;
  const rows = models.choices
    .map((c) => {
      const disabled = c.unavailable ? " disabled" : "";
      const reason = c.unavailable ? `<span class="dim" style="color:var(--crit)"> — nedostupné: ${esc(c.unavailable)}</span>` : "";
      return `<label style="display:flex;gap:8px;align-items:center;padding:6px 0"><input type="radio" name="key" value="${esc(c.key)}"${c.isDefault ? " checked" : ""}${disabled}><span>${esc(c.label)}</span>${reason}</label>`;
    })
    .join("");
  return `<form method="post" action="/farm/settings/cow-workshop-model">${rows}<button class="btn btn-primary btn-sm" type="submit" style="margin-top:8px">Uložit</button></form>`;
};

// -----------------------------------------------------------------------------------------------------------
/** Žlab one-liner for Přehled (M0 D-5): honest words for "unreachable" and "empty", counts per authority domain otherwise. */
const zlabSummary = (z: ZlabStats | undefined): string => {
  if (z === undefined) return "nedostupný";
  if (z.total === 0) return "zatím prázdný";
  const noun = z.total === 1 ? "záznam" : z.total < 5 ? "záznamy" : "záznamů";
  return `${z.total} ${noun} (${z.byDomain.map((d) => `${esc(d.domain)} ${d.records}`).join(", ")})`;
};

// Průsvitná stáj — nová IA (13. 9. 2026): Přehled · Podatelna · Ohrada · Stáj · Argos · Výsledek · Deník.
// -----------------------------------------------------------------------------------------------------------

export function renderFarm(m: FarmModel): string {
  const up = m.deployables.filter((d) => workerReady(d)).length;
  const watchdog = computeWatchdog(m);
  const incidents = m.incidents ?? [];
  const effectiveLevel = effectiveWatchdogLevel(watchdog, incidents);

  const byName = (name: string) => m.deployables.find((d) => d.name === name);
  const gatewayRow = byName("apf-gateway");
  const hostNames = ["apf-document-host", "apf-email-executor", "apf-mail-ingest"];

  const deployableCard = (d: DeployableStatus): string => {
    const b = (d.body ?? {}) as Record<string, unknown>;
    const caps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).join(", ") : undefined;
    const detail = caps ? `umí: ${caps}` : b.wired === false ? "zatím nezapojeno do toku" : b.error ? String(b.error) : "";
    const role = DEPLOYABLE_ROLE[d.name];
    const iso = isolationLabel(String(b.isolation ?? ""));
    const state = workerStateLabel(d);
    return `<div class="p-card${state === "DOWN" ? " crit" : ""}"><div class="p-card-head"><code>${esc(d.name)}</code>${stateBadge(state)}</div>${role ? `<div class="p-card-role">${esc(role)}</div>` : ""}<div class="p-card-meta"><span${iso.title ? ` title="${esc(iso.title)}"` : ""}>izolace <b>${esc(iso.label)}</b></span>${detail ? `<span>${esc(detail)}</span>` : ""}</div><div class="p-card-meta">${selfTestBadge(d.selfTest)}</div>${selfTestList(d.selfTestFixtures)}</div>`;
  };
  const plannedCard = (p: { name: string; role: string }): string => `<div class="p-card"><div class="p-card-head"><code>${esc(p.name)}</code>${stateBadge("NÁVRH")}</div><div class="p-card-role">${esc(p.role)}</div></div>`;
  const cardSection = (label: string, cardsHtml: string): string => (cardsHtml ? `<div style="margin:16px 0"><div class="dim" style="font-family:var(--font-head);font-weight:650;margin-bottom:8px">${esc(label)}</div><div class="grid-cards">${cardsHtml}</div></div>` : "");

  const stajCards =
    cardSection(
      "Hostitelé, které gateway volá",
      hostNames
        .map((n) => byName(n))
        .filter((d): d is DeployableStatus => !!d)
        .map(deployableCard)
        .join(""),
    ) +
    cardSection("Testovací dvojník (jen pro vývoj a testy)", byName("apf-fakes") ? deployableCard(byName("apf-fakes") as DeployableStatus) : "") +
    cardSection("Návrh — zatím nepostaveno, jen v docs/NAVRHOVY-LIST-farma.md", PLANNED_DEPLOYABLES.map(plannedCard).join(""));

  // Kapability seskupené po modulu jako ohrady (owner's request 2026-09-09: karty, ne řádky tabulky).
  // Teletník/Stáj split (owner's request 2026-09-14: "co není hotová kráva, je tele") — derivedStatus:"NEW"
  // (Admission Gate never certified THIS build, certification.ts's deriveLifecycleStatus) means the capability
  // has never been through admission at all, ever: a tele. QUARANTINED stays in Stáj on purpose — a capability
  // that WAS certified and is now failing is a sick cow, not an uncertified calf; only "never even tried" moves.
  const penGridOf = (caps: CapabilityRow[]): string => {
    const byModule = new Map<string, CapabilityRow[]>();
    for (const c of caps) {
      if (!byModule.has(c.module)) byModule.set(c.module, []);
      (byModule.get(c.module) as CapabilityRow[]).push(c);
    }
    return [...byModule.entries()]
      .map(([mod, ms]) => `<div class="pen"><div class="pen-label">${ICONS.staj}${esc(mod)}</div><div class="grid-cards">${ms.map((c) => capabilityRow(c, watchdog, incidents, m.gitSha)).join("")}</div></div>`)
      .join("");
  };
  const teletnikCapabilities = m.capabilities.filter((c) => c.derivedStatus === "NEW");
  const stajCapabilities = m.capabilities.filter((c) => c.derivedStatus !== "NEW");
  const penGrid = penGridOf(stajCapabilities);
  const teletnikGrid = penGridOf(teletnikCapabilities);

  // Owner's request 2026-09-08: what carries the link belongs in column 1, rows collapsed to a one-line summary
  // by default, click to see the steps — a document block is evidence to check, not to always read in full.
  const instanceRowsOf = (rows: FarmInstanceRow[]): string =>
    rows
      .map((i) => {
        if (i.purged) return `<tr class="group-head"><td><a href="/workflow/${esc(i.workflowId)}"><code>${esc(i.workflowId)}</code></a></td><td colspan="4" class="dim">smazáno (PURGED), poslední audit ${esc(i.at)}</td></tr>`;
        const size = i.originalByteLength !== undefined ? ` · ${kb(i.originalByteLength)}` : "";
        const linkText = i.originalName ? esc(i.originalName) : `<code>${esc(i.workflowId)}</code>`;
        const head = `<tr class="group-head gh-toggle" data-wf="${esc(i.workflowId)}" aria-expanded="false"><td><span class="gh-chevron" aria-hidden="true">▸</span> <a href="/workflow/${esc(i.workflowId)}">${linkText}</a>${i.originalName ? ` <small class="dim"><code>${esc(i.workflowId)}</code></small>` : ""}</td><td colspan="4" class="dim">${esc(i.workflow)}/v${esc(i.workflowVersion)}${size} · tenant ${esc(i.tenantId)} · aktér ${esc(i.actorId)} · ${stateBadge(i.status)} · založeno ${esc(i.createdAt)}, změněno ${esc(i.updatedAt)}</td></tr>`;
        const steps = i.steps
          .map((s) => `<tr class="step-row" data-wf="${esc(i.workflowId)}" hidden><td>${esc(s.stepId)}</td><td>${esc(s.capability)}/v${esc(s.capabilityVersion)}</td>${stateTd(s.status)}<td>${s.attempt} / ${s.logicalAttempt} <span class="dim">${esc(s.strategy)}</span></td><td class="wrap">${humanStepResult(s)}</td></tr>`)
          .join("");
        return head + steps;
      })
      .join("");
  const instanceRows = instanceRowsOf(m.instances);
  const ohradaInstances = m.instances.filter((i) => !i.purged && (i.status === "WAITING" || i.status === "FAILED" || i.status === "UNKNOWN_OUTCOME"));
  const ohradaRows = instanceRowsOf(ohradaInstances);

  const denikRows = m.auditLog
    .map((r) => {
      const link = r.workflowId ? `<a href="/workflow/${esc(r.workflowId)}">${esc(r.workflowId)}</a>` : "—";
      return `<tr><td class="dim mono">${esc(r.at)}</td><td>${esc(r.kind)}</td><td>${link}</td><td>${esc(r.capability ?? "")}</td><td class="wrap">${auditSummary(r.kind, r.capability, r.details)}</td></tr>`;
    })
    .join("");
  const terminalLine = (r: AuditLogRow): string => {
    const time = esc(r.at).replace("T", " ").replace(/\.\d+Z$|Z$/, "");
    const link = r.workflowId ? ` <a href="/workflow/${esc(r.workflowId)}">${esc(r.workflowId)}</a>` : "";
    const cap = r.capability ? ` <code>${esc(r.capability)}</code>` : "";
    return `<div class="t-line" data-at="${esc(r.at)}"><span class="t-dim">${time}</span> ${esc(r.kind)}${cap}${link} <span class="t-dim">${auditSummary(r.kind, r.capability, r.details)}</span></div>`;
  };
  const terminalSeed = [...m.auditLog].reverse().map(terminalLine).join("");

  // Přehled: needs-attention feed (open incidents + ohrada backlog + failed inbox) — the dashboard-first landing
  // the operator sees before drilling into anything (vlastníkovo rozhodnutí 13. 9. 2026: "je farma zdravá, co
  // potřebuje pozornost" má být první, ne formulář).
  const activeFindings = watchdog.findings.filter((f) => !isAcknowledgedFinding(f.key, incidents));
  const attnItems: string[] = [];
  for (const f of activeFindings) attnItems.push(`<div class="attn-item">${stateBadge(f.level)}<span>${esc(f.text)}</span></div>`);
  if (m.inbox.failed.length) attnItems.push(`<div class="attn-item">${stateBadge("WARN")}<span>${m.inbox.failed.length} ${m.inbox.failed.length === 1 ? "soubor selhal" : "souborů selhalo"} v dávkovém příjmu — viz Podatelna</span></div>`);
  const recentFeed = [...m.instances]
    .filter((i): i is Extract<FarmInstanceRow, { purged?: false }> => !i.purged)
    .slice(0, 8)
    .map((i) => `<div class="feed-item"><span class="t">${shortAt(i.updatedAt).slice(11)}</span>${stateBadge(i.status)}<a href="/workflow/${esc(i.workflowId)}">${i.originalName ? esc(i.originalName) : esc(i.workflowId)}</a><span class="dim">${esc(i.workflow)}</span></div>`)
    .join("");

  const views: { id: string; icon: string; label: string; count?: number; body: string }[] = [
    {
      id: "prehled",
      icon: mascot("farmar", MASCOT_BG.prehled),
      label: "Přehled",
      body: `<div class="pagehead"><h1>${mascot("farmar", MASCOT_BG.prehled, "lg")} Přehled farmy</h1></div><p class="lede">${esc(m.installation)} · ${up}/${m.deployables.length} Workerů OK · podpis ${esc(m.gatewaySigning)} · Žlab ${zlabSummary(m.zlab)}</p>
      <div class="toolbar" style="margin-top:0">${stateBadge(effectiveLevel)}<span class="dim">${activeFindings.length === 0 ? "žádné otevřené nálezy" : `${activeFindings.length} ${activeFindings.length === 1 ? "nález" : "nálezy"} vyžaduje pozornost`}</span></div>
      <div class="stat-row">
        <div class="stat"><b>${m.stats.processedToday}</b><span>zpracováno dnes</span></div>
        <div class="stat"><b>${m.stats.totalProcessed}</b><span>celkem</span></div>
        <div class="stat"><b>${ohradaInstances.length}</b><span>čeká v Ohradě</span></div>
        <div class="stat"><b>${formatDuration(m.stats.avgProcessingMs)}</b><span>průměrný čas</span></div>
      </div>
      ${
        attnItems.length
          ? `<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:6px">Vyžaduje pozornost</h3>${attnItems.join("")}</div>`
          : `<div class="card" style="margin-bottom:16px">${stateBadge("HEALTHY")} <span class="dim">Nic dnes nevyžaduje pozornost.</span></div>`
      }
      <div class="card" style="margin-bottom:16px"><div class="p-card-head"><span>Farmář <code>apf-gateway</code></span>${stateBadge(gatewayRow ? workerStateLabel(gatewayRow) : "DOWN")}</div><div class="p-card-role">Přijme dokument, rozpozná typ (AI) a řídí celý průběh — ${m.workflows.length} toků, ${("error" in m.models ? 0 : m.models.choices.length)} modelů pro posouzení</div><div class="p-card-meta">${selfTestBadge(gatewayRow?.selfTest)}</div></div>
      <div class="card"><h3 style="margin-bottom:6px">Nedávné operace</h3>${recentFeed || '<span class="dim">zatím žádné</span>'}</div>`,
    },
    {
      id: "podatelna",
      icon: iconBadge(ICONS.podatelna, MASCOT_BG.podatelna),
      label: "Podatelna",
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.podatelna, MASCOT_BG.podatelna, "lg")} Podatelna</h1></div><p class="lede">Ruční jednotlivé podání — stejná cesta (<code>startIntake</code>) jako dávkový příjem, jen výsledek uvidíš hned, ne až po dalším běhu cronu.</p>
      <div class="hero"><img src="/farm/ilustrace.png" alt="AI Farma — Farmář, Argos a kravičky ve svých ohradách" loading="lazy"></div>
      <form method="post" action="/intake" enctype="multipart/form-data">
        <label for="novy-file">Soubor: PDF, fotka (jpg, png, webp), docx, ISDOC / XML, txt, md, eml (do 4 MB)</label>
        <input id="novy-file" type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.isdoc,.xml,.txt,.md,.eml,application/pdf,image/*,application/xml,text/xml,text/plain,message/rfc822">
        <label for="novy-text">Nebo vložený text (faktura, smlouva, e-mail…)</label>
        <textarea id="novy-text" name="text" placeholder="Když je nahraný soubor, text se nepoužije."></textarea>
        <label for="novy-workflow">Tok</label>
        <select id="novy-workflow" name="workflow">${m.workflows.map((w) => `<option value="${esc(w)}"${w === "document-intake" ? " selected" : ""}>${esc(w)}</option>`).join("")}</select>
        <label for="novy-model">Model AI pro posouzení (classify)</label>
        ${
          "error" in m.models
            ? `<div class="dim" style="color:var(--crit)">Bez modelu nelze spustit tok. ${esc(m.models.error)}</div>`
            : `<select id="novy-model" name="model">${m.models.choices
                .map((c) =>
                  c.unavailable
                    ? `<option value="${esc(c.key)}" disabled>${esc(c.label)} — nedostupné: ${esc(c.unavailable)}</option>`
                    : `<option value="${esc(c.key)}"${c.isDefault ? " selected" : ""}>${esc(c.label)}${c.isDefault ? " (výchozí)" : ""}</option>`,
                )
                .join("")}</select>`
        }
        <label for="novy-stampText">Text razítka (nepovinné)</label>
        <input id="novy-stampText" type="text" name="stampText" placeholder="VALIDATED INVOICE">
        <button class="btn btn-primary" type="submit" style="margin-top:12px">Odeslat do toku</button>
      </form>
      <hr>
      <div class="toolbar" style="margin-top:0"><h3 class="fill">Dávkový příjem (inbox)</h3><span class="dim">${m.inbox.pending.length} čeká${m.inbox.failed.length ? ` · ${m.inbox.failed.length} selhalo` : ""}</span></div>
      <form class="toolbar" method="post" action="/farm/inbox" enctype="multipart/form-data">
        <input type="file" name="files" multiple style="width:auto">
        <button class="btn" type="submit">Nahrát do inboxu</button>
        <span class="dim">kontrola každých 5 minut, max ${m.inbox.batchLimit} souborů na běh, nebo přímo R2 → <code>apf-artifacts</code> → <code>inbox/</code></span>
      </form>
      ${
        m.inbox.pending.length
          ? `<div class="gridwrap"><table><thead><tr><th>Soubor</th><th>Velikost</th><th>Nahráno</th></tr></thead><tbody>${m.inbox.pending.map((it) => `<tr><td class="wrap">${esc(it.name)}</td><td>${kb(it.size)}</td><td class="dim mono">${esc(it.uploaded)}</td></tr>`).join("")}</tbody></table></div>`
          : ""
      }
      ${
        m.inbox.failed.length
          ? `<h3 style="color:var(--crit);margin-top:16px">Selhalo v inbox/failed/</h3><div class="gridwrap"><table><thead><tr><th>Soubor</th><th>Velikost</th><th>Důvod</th><th></th></tr></thead><tbody>${m.inbox.failed
              .map(
                (it) =>
                  `<tr><td class="wrap">${esc(it.name)}</td><td>${kb(it.size)}</td><td class="wrap">${esc(it.reason ?? "")}${it.message ? ` <small class="dim">${esc(it.message)}</small>` : ""}</td><td><form method="post" action="/farm/inbox/retry"><input type="hidden" name="key" value="${esc(it.key)}"><button class="btn btn-sm" type="submit">Zkusit znovu</button></form></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : ""
      }`,
    },
    {
      id: "ohrada",
      icon: iconBadge(ICONS.ohrada, MASCOT_BG.ohrada),
      label: "Ohrada",
      count: ohradaInstances.length || undefined,
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.ohrada, MASCOT_BG.ohrada, "lg")} Ohrada</h1></div><p class="lede">Instance, co čekají na rozhodnutí, nebo skončily s chybou, co si žádá pohled člověka — zde se nic samo neprovede.</p>
      <div class="gridwrap"><table><thead><tr><th>Krok</th><th>Capability</th><th>Stav</th><th>Pokus</th><th>Výsledek</th></tr></thead><tbody>${ohradaInstances.length ? ohradaRows : '<tr><td colspan="5" class="dim">prázdno — nic dnes nečeká na člověka</td></tr>'}</tbody></table></div>`,
    },
    {
      id: "staj",
      icon: mascot("krava", MASCOT_BG.staj),
      label: "Stáj",
      body: `<div class="pagehead"><h1>${mascot("krava", MASCOT_BG.staj, "lg")} Stáj</h1></div><p class="lede">Zavedené krávy — kapability, co aspoň jednou prošly Admission Gate certifikací (klidně i s výsledkem FAIL, nemocná kráva je pořád kráva). Nové, nikdy necertifikované jsou v <a href="#teletnik">Teletníku</a>. Seskupeno po modulu jako ohrada — riziko a izolace jsou vlastní tvrzení komponenty (descriptor), stav na kartě je to, co <b>Router doopravdy vynucuje</b> před každým dispatchem.</p>
      <form class="toolbar" method="post" action="/farm/self-test">
        <span class="dim">„OK“ dokazuje jen, že proces odpovídá — self-test skutečně spustí kapability proti reálnému modelu a porovná s golden výsledkem${m.selfTestAt ? ` — naposledy proběhlo ${shortAt(m.selfTestAt)}` : " — ještě nikdy neproběhl"}</span>
        <span class="fill"></span>
        <button class="btn btn-primary" type="submit">Spustit self-test</button>
      </form>
      ${stajCards}
      <h3 style="margin:18px 0 8px">Kapability (Admission Gate)</h3>
      ${stajCapabilities.length ? penGrid : '<p class="dim">zatím žádná zavedená kráva — vše nasazené čeká na první certifikaci v Teletníku</p>'}`,
    },
    {
      id: "teletnik",
      icon: mascot("krava", MASCOT_BG.teletnik),
      label: "Teletník",
      count: teletnikCapabilities.length || undefined,
      body: `<div class="pagehead"><h1>${mascot("krava", MASCOT_BG.teletnik, "lg")} Teletník</h1></div><p class="lede">Co není hotová kráva, je tele — kapabilita už nasazená v kódu, ale ještě nikdy neprošla Admission Gate certifikací pro tenhle build. Jakmile projde (i s výsledkem FAIL), přestává být tele a stěhuje se do <a href="#staj">Stáje</a> natrvalo.</p>
      <div class="card" style="margin-bottom:14px"><h3 style="margin-bottom:4px">Nová kráva</h3><p class="dim" style="font-size:12px;margin:0">Nová kráva se sem nedostane kliknutím na téhle stránce — potřebuje reálný kód (nový modul, policy, položku v <code>config/${esc(m.installation)}/lifecycle.json</code>) a deploy, to zůstává lidský krok s vlastním commitem. Co „Spustit certifikaci“ u každé karty dělá doopravdy: spustí živý konformanční test proti přesně tomuhle nasazenému buildu (<code>${esc(m.gitSha)}</code>) a certifikaci uloží — <b>certifikace sama nic nezapíná</b>, „ACTIVE“ ve Stáji pořád znamená jen to, co doopravdy vynucuje Router z <code>lifecycle.json</code>.</p></div>
      ${teletnikCapabilities.length ? teletnikGrid : '<p class="dim">žádná telata — všechno nasazené už aspoň jednou prošlo certifikací</p>'}`,
    },
    {
      id: "argos",
      icon: mascot("argos", MASCOT_BG.argos),
      label: "Argos",
      body: `<div class="pagehead"><h1>${mascot("argos", MASCOT_BG.argos, "lg")} Argos hlídá</h1></div><p class="lede">Argosův vlastní verdikt a nálezy — deterministická pravidla, žádné AI. Karanténa (config/&lt;instalace&gt;/lifecycle.json) se mění deployem, ne odsud — tahle stránka jen čte, nikdy nezapisuje.</p>
      ${watchdogBanner(watchdog, incidents)}
      <div class="stat-row">
        <div class="stat"><b>${m.selfTestAt ? shortAt(m.selfTestAt).slice(11) : "—"}</b><span>poslední self-test</span></div>
        <div class="stat"><b>${m.alertHealth?.lastSuccessAt ? "OK" : m.alertHealth ? "?" : "—"}</b><span>alertovací kanál</span></div>
        <div class="stat"><b>${m.recentAuditTenantMismatches}</b><span>pokusů o cizí tenant (24 h)</span></div>
      </div>`,
    },
    {
      id: "vysledek",
      icon: iconBadge(ICONS.vysledek, MASCOT_BG.vysledek),
      label: "Výsledek",
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.vysledek, MASCOT_BG.vysledek, "lg")} Výsledek</h1></div><p class="lede">Výsledek se složí, uloží a zaznamená — statistika za celou dobu a poslední zpracované dokumenty.</p>
      <div class="stat-row">
        <div class="stat"><b>${m.stats.totalProcessed}</b><span>zpracováno celkem</span></div>
        <div class="stat"><b>${m.stats.processedToday}</b><span>dnes</span></div>
        <div class="stat"><b>${formatDuration(m.stats.avgProcessingMs)}</b><span>průměrný čas zpracování</span></div>
      </div>
      ${m.stats.byType.length ? `<h3>Podle typu dokumentu (classify)</h3><div>${barChart(m.stats.byType)}</div>` : ""}
      <div class="toolbar"><h3 class="fill">Poslední instance</h3>
        <form method="get" action="/farm#vysledek" style="display:flex;gap:8px;align-items:center">
          <select name="limit" onchange="this.form.submit()" style="width:auto">${[15, 30, 50, 100, 200].map((n) => `<option value="${n}"${n === m.instanceLimit ? " selected" : ""}>${n}</option>`).join("")}</select>
          <select name="window" onchange="this.form.submit()" style="width:auto">${[
            ["", "celá historie"],
            ["24h", "posledních 24 h"],
            ["7d", "posledních 7 dní"],
            ["30d", "posledních 30 dní"],
          ]
            .map(([v, label]) => `<option value="${v}"${v === m.instanceWindow ? " selected" : ""}>${esc(label as string)}</option>`)
            .join("")}</select>
          <noscript><button class="btn btn-sm" type="submit">Použít</button></noscript>
        </form>
      </div>
      <div class="gridwrap"><table><thead><tr><th>Krok</th><th>Capability</th><th>Stav</th><th>Pokus</th><th>Výsledek</th></tr></thead><tbody>${m.instances.length ? instanceRows : '<tr><td colspan="5" class="dim">zatím žádné</td></tr>'}</tbody></table></div>`,
    },
    {
      id: "denik",
      icon: iconBadge(ICONS.denik, MASCOT_BG.denik),
      label: "Deník",
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.denik, MASCOT_BG.denik, "lg")} Audit — Deník</h1></div><p class="lede">Živý terminál: syrový auditní záznam napříč celou farmou, jeden řádek = jedna událost, nejnovější dole (jako <code>tail -f</code>).</p>
      <div class="toolbar" style="margin-top:0"><span class="fill"></span><button type="button" class="btn btn-sm" id="denik-live-toggle" aria-pressed="true">⏸ Pozastavit</button></div>
      <div class="term" id="denik-term" aria-live="polite">${terminalSeed}</div>
      <h3 style="margin-top:16px">Stejná data jako tabulka</h3>
      <div class="gridwrap"><table><thead><tr><th>Čas</th><th>Druh</th><th>Instance</th><th>Capability</th><th>Detail</th></tr></thead><tbody>${denikRows}</tbody></table></div>`,
    },
    {
      id: "nastaveni",
      icon: iconBadge(ICONS.nastaveni, MASCOT_BG.nastaveni),
      label: "Nastavení",
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.nastaveni, MASCOT_BG.nastaveni, "lg")} Nastavení</h1></div><p class="lede">Co se může měnit bez nového deploye, patří sem — první takové nastavení je model pro Kravskou dílnu.</p>
      <div class="card"><h3 style="margin-bottom:4px">Kravská dílna — AI model</h3><p class="dim" style="font-size:12px;margin:0 0 12px">Používá se v Kravské dílně (návrh nové krávy z promptu/kódu/dokumentace). Vždy je vybraný nějaký model — minimum je Workers AI zdarma, nikdy žádný.</p>
      ${cowWorkshopModelForm(m.cowWorkshopModels)}
      </div>`,
    },
    {
      id: "kravska-dilna",
      icon: iconBadge(ICONS.dilna, MASCOT_BG.dilna),
      label: "Kravská dílna",
      count: m.workshopSessions.length || undefined,
      body: `<div class="pagehead"><h1>${iconBadge(ICONS.dilna, MASCOT_BG.dilna, "lg")} Kravská dílna</h1></div><p class="lede">Popiš, co má nová (nebo upravovaná) kráva dělat — kód API dotazu, prompt, nebo přiložená dokumentace. Asistent se doptá na detaily a navrhne soubory podle konvencí platformy (vzor: <code>cz.company.verify</code>). <b>Nic se tím nenasazuje</b> — návrh projde přes commit/PR/testy jako každá jiná změna.</p>
      <div class="card"><h3 style="margin-bottom:8px">Nová konverzace</h3>
      <form method="post" action="/farm/workshop">
        <textarea name="text" rows="4" placeholder="Např.: Potřebuju krávu, co ověří datovou schránku firmy podle IČO přes API ISDS..." required></textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:8px">Odeslat</button>
      </form></div>
      <h3 style="margin:18px 0 8px">Dřívější konverzace</h3>
      ${
        m.workshopSessions.length
          ? `<div class="gridwrap"><table><thead><tr><th>Zadání</th><th>Zpráv</th><th>Naposledy</th></tr></thead><tbody>${m.workshopSessions
              .map((s) => `<tr><td><a href="/farm/workshop/${esc(s.sessionId)}">${esc(s.title)}</a></td><td>${s.messages.length}</td><td class="dim mono">${shortAt(s.updatedAt)}</td></tr>`)
              .join("")}</tbody></table></div>`
          : '<p class="dim">zatím žádná</p>'
      }`,
    },
  ];

  const navHtml = views
    .map((v) => `<a class="navlink" href="#${v.id}" data-view="${v.id}" title="${esc(v.label)}">${v.icon}<span class="lbl">${esc(v.label)}</span>${v.count ? `<span class="count">${v.count}</span>` : ""}</a>`)
    .join("");
  const sectionsHtml = views.map((v, i) => `<section id="view-${v.id}"${i === 0 ? "" : " hidden"}>${v.body}</section>`).join("");

  const bodyHtml = `<div class="app" id="app">
  <div class="app-top">
    <button type="button" class="railbtn" id="railToggle" title="Sbalit/rozbalit menu" aria-label="Sbalit/rozbalit menu">${ICONS.menu}</button>
    <span class="brand">${ICONS.wheat}<span>Průsvitná stáj</span><span class="sub">${esc(m.installation)}</span></span>
    <span class="fill"></span>
    <span class="meta" id="clock" title="Živý čas prohlížeče"></span>
    <span class="meta"><code title="Commit, ze kterého je tento build">${esc(m.gitSha)}</code></span>
    <span class="meta">${up}/${m.deployables.length} Workerů OK</span>
  </div>
  <nav class="app-rail">${navHtml}
    <div class="navsec">Farma</div>
    <a class="navlink" href="/VYVOJOVY-DIAGRAM.html" title="Jak to funguje">${ICONS.diagram}<span class="lbl">Jak to funguje</span></a>
    <a class="navlink" href="/MATICE-ODPOVEDNOSTI.html" title="Kdo odpovídá za co">${ICONS.diagram}<span class="lbl">Matice odpovědnosti</span></a>
  </nav>
  <main class="app-main">${sectionsHtml}</main>
  <footer class="app-foot">
    <span><b>${up}/${m.deployables.length}</b> Workerů</span>
    <span><b>${m.instances.length}</b> instancí</span>
    <span><b>${m.auditLog.length}</b> v deníku</span>
    <span><b>${m.inbox.pending.length}</b> v inboxu${m.inbox.failed.length ? ` <span class="dim">(${m.inbox.failed.length} selhalo)</span>` : ""}</span>
    <span class="fill"></span>
    <span>Průsvitná stáj · ${esc(m.installation)}</span>
  </footer>
</div>`;

  const script = `(function () {
  var VIEWS = ${JSON.stringify(views.map((v) => v.id))};
  function applyView() {
    var v = (location.hash || "#prehled").slice(1);
    if (VIEWS.indexOf(v) === -1) v = "prehled";
    VIEWS.forEach(function (id) {
      var el = document.getElementById("view-" + id);
      if (el) el.hidden = id !== v;
    });
    document.querySelectorAll(".navlink[data-view]").forEach(function (a) {
      a.setAttribute("aria-current", a.dataset.view === v ? "true" : "false");
    });
  }
  window.addEventListener("hashchange", applyView);
  applyView();

  var app = document.getElementById("app");
  var rail = document.getElementById("railToggle");
  function setRail(on) {
    app.dataset.rail = on ? "collapsed" : "expanded";
    try { localStorage.setItem("stroj-rail", on ? "1" : "0"); } catch (e) {}
  }
  if (rail) rail.addEventListener("click", function () { setRail(app.dataset.rail !== "collapsed"); });
  try { if (localStorage.getItem("stroj-rail") === "1") setRail(true); } catch (e) {}

  var clock = document.getElementById("clock");
  function tick() { if (clock) clock.textContent = new Date().toLocaleTimeString("cs-CZ"); }
  if (clock) { tick(); setInterval(tick, 1000); }

  document.querySelectorAll(".gh-toggle").forEach(function (row) {
    row.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      var wf = row.getAttribute("data-wf");
      var open = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", open ? "false" : "true");
      document.querySelectorAll('tr.step-row[data-wf="' + wf + '"]').forEach(function (r) { r.hidden = open; });
    });
  });

  // Deník live terminal (owner's request 2026-09-09: "vidět co se šustne"): poll /audit.json?after=<last>, append
  // as DOM nodes built with textContent (never innerHTML) — audit details can carry text lifted straight from an
  // untrusted document (F2), so this must never turn into an HTML-injection path into the operator's own console.
  var term = document.getElementById("denik-term");
  if (term) {
    var liveToggle = document.getElementById("denik-live-toggle");
    var live = true;
    var lastAt = term.lastElementChild ? term.lastElementChild.getAttribute("data-at") : null;
    function fmtTime(at) { return String(at || "").replace("T", " ").replace(/\\.\\d+Z$|Z$/, ""); }
    function lineEl(rec) {
      var div = document.createElement("div");
      div.className = "t-line t-new";
      div.setAttribute("data-at", rec.at || "");
      var time = document.createElement("span");
      time.className = "t-dim";
      time.textContent = fmtTime(rec.at);
      div.appendChild(time);
      div.appendChild(document.createTextNode(" " + (rec.kind || "")));
      if (rec.capability) {
        div.appendChild(document.createTextNode(" "));
        var code = document.createElement("code");
        code.textContent = rec.capability;
        div.appendChild(code);
      }
      if (rec.workflowId) {
        div.appendChild(document.createTextNode(" "));
        var a = document.createElement("a");
        a.href = "/workflow/" + encodeURIComponent(rec.workflowId);
        a.textContent = rec.workflowId;
        div.appendChild(a);
      }
      var detail = document.createElement("span");
      detail.className = "t-dim";
      var hasDetails = rec.details && typeof rec.details === "object" && Object.keys(rec.details).length;
      detail.textContent = hasDetails ? " " + JSON.stringify(rec.details) : "";
      div.appendChild(detail);
      return div;
    }
    function poll() {
      if (!live || document.hidden) return;
      var url = "/audit.json?limit=200" + (lastAt ? "&after=" + encodeURIComponent(lastAt) : "");
      fetch(url).then(function (r) { return r.json(); }).then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        rows.forEach(function (rec) {
          term.appendChild(lineEl(rec));
          lastAt = rec.at;
        });
        while (term.children.length > 500) term.removeChild(term.firstElementChild);
        term.scrollTop = term.scrollHeight;
      }).catch(function () {});
    }
    if (liveToggle) {
      liveToggle.addEventListener("click", function () {
        live = !live;
        liveToggle.textContent = live ? "⏸ Pozastavit" : "▶ Živě";
        liveToggle.setAttribute("aria-pressed", live ? "true" : "false");
      });
    }
    term.scrollTop = term.scrollHeight;
    setInterval(poll, 3000);
  }
})();`;

  return shell(`Průsvitná stáj · ${m.installation}`, bodyHtml, { wide: true, script });
}

export function renderError(title: string, message: string, details: Record<string, unknown> = {}): string {
  const rows = Object.entries(details)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === "string" ? v : JSON.stringify(v))}</code></td></tr>`)
    .join("");
  return shell(
    title,
    `<div class="doc"><header><h1>${esc(title)}</h1></header><div class="card crit"><p>${esc(message)}</p>${rows ? `<table>${rows}</table>` : ""}</div><nav><a href="/farm">Zpět na Průsvitnou stáj</a></nav></div>`,
  );
}

export interface SelfTestRow {
  capability: string;
  worker: string;
  id: string;
  kind: string;
  description?: string;
  /** Why this check exists — shown regardless of PASS/FAIL (owner 2026-09-10: a red/green alone doesn't say
   * what's actually being protected). Optional: most conformance fixtures are routine, not every one earns it. */
  why?: string;
  /** What to do when this fixture is FAILED — shown only on failure. */
  onFailure?: string;
  ok: boolean;
  skipped?: string;
  diff: string[];
}

/** One fixture's last known result, merged across self-test runs (index.ts recordSelfTestSummary/
 * latestSelfTestSummary) — the same shape as a fresh SelfTestRow, plus when it was last checked. */
export interface SelfTestFixtureState extends SelfTestRow {
  at: string;
}

/**
 * Live self-test result page (owner's request 2026-09-08: test a kravička's health from the GUI, not just /version;
 * "chci otestovat samostatnou kravičku, aby u ní bylo vidět, že probíhají kontroly" — grouped by WORKER first, so
 * it's visible that apf-document-host was actually reached over the network, not just apf-gateway in-process).
 */
export function renderSelfTest(rows: SelfTestRow[]): string {
  const failed = rows.filter((r) => !r.ok);
  const ran = rows.filter((r) => !r.skipped);
  const byWorker = new Map<string, SelfTestRow[]>();
  for (const r of rows) byWorker.set(r.worker, [...(byWorker.get(r.worker) ?? []), r]);
  const rowHtml = (r: SelfTestRow): string => {
    const detail = r.skipped ? esc(r.skipped) : r.diff.length ? `<pre class="wrap">${esc(r.diff.join("\n"))}</pre>` : r.description ? esc(r.description) : "shoda s golden";
    const why = r.why ? `<div class="dim">Proč: ${esc(r.why)}</div>` : "";
    const reco = !r.ok && !r.skipped && r.onFailure ? `<div style="color:var(--crit)">Doporučení: ${esc(r.onFailure)}</div>` : "";
    return `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.kind)}</td>${stateTd(r.skipped ? "SKIPPED" : r.ok ? "SUCCEEDED" : "FAILED")}<td class="wrap">${detail}${why}${reco}</td></tr>`;
  };
  const capabilitySection = (cap: string, rs: SelfTestRow[]): string =>
    `<h3>${esc(cap)} <small class="dim">${rs.filter((r) => r.ok && !r.skipped).length}/${rs.filter((r) => !r.skipped).length}</small></h3>
<table><thead><tr><th>Fixture</th><th>Druh</th><th>Stav</th><th>Detail</th></tr></thead><tbody>${rs.map(rowHtml).join("")}</tbody></table>`;
  const sections = [...byWorker.entries()]
    .map(([worker, workerRows]) => {
      const byCapability = new Map<string, SelfTestRow[]>();
      for (const r of workerRows) byCapability.set(r.capability, [...(byCapability.get(r.capability) ?? []), r]);
      const n = workerRows.filter((r) => !r.skipped).length;
      const ok = workerRows.filter((r) => r.ok && !r.skipped).length;
      return `<h2>🐄 ${esc(worker)} <small class="dim">${ok}/${n} — kontrola opravdu proběhla přes tenhle Worker, ne jen odsud</small></h2>
${[...byCapability.entries()].map(([cap, rs]) => capabilitySection(cap, rs)).join("")}`;
    })
    .join("");
  return shell(
    "Self-test kravičky",
    `<div class="doc"><header><h1>Self-test kravičky</h1><small class="dim">${ran.length - failed.length}/${ran.length} fixtures prošlo (${rows.length - ran.length} přeskočeno — vyžadují adapter chaos mode, jen Node testy)</small></header>${sections}<nav><a href="/farm">Zpět na farmu</a></nav></div>`,
  );
}

const kb = (n: number | undefined): string => (n === undefined ? "?" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);

const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 1000) return "< 1 s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

/** No SVG, no JS, no chart library — CSS width bars, same "server-rendered evidence" ethos as the rest of the app. */
const barChart = (rows: { type: string; count: number }[]): string => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows
    .map(
      (r) =>
        `<div class="bar-row"><span class="bar-label">${esc(r.type)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((r.count / max) * 100)}%"></div></div><span class="bar-count">${r.count}</span></div>`,
    )
    .join("");
};

const fmtResult = (s: Instance["steps"][number]): string => {
  const r = s.result;
  if (!r) return "";
  if (r.error) return `<code>${esc(r.error.code)}</code> <small>${esc(r.error.class)}${r.error.retryable ? ", retryable" : ""}</small><br><small>${esc(r.error.message)}</small>`;
  if (r.status === "WAITING") return `čeká: ${esc(r.waitReason ?? "")}${r.reviewTaskId ? ` <code>${esc(r.reviewTaskId)}</code>` : ""}`;
  if (r.payload) return `<code>${esc(JSON.stringify(r.payload).slice(0, 400))}</code>`;
  return esc(r.status);
};

const artifactCard = (a: Artifact): string => {
  const kind = a.derivedFrom ? `derivace z <code>${esc(a.derivedFrom)}</code>, výrobce <code>${esc(a.producer)}</code>` : "originál";
  const meta = `sha256 <code>${esc(a.sha256)}</code> · ${esc(a.contentType ?? "text/plain")} · ${kb(a.byteLength ?? a.bytes.length)} · přijato ${esc(a.receivedAt)} od <code>${esc(a.receivedFrom)}</code> · tenant <code>${esc(a.tenantId)}</code>`;
  const body = a.location
    ? `<p class="dim">Binární originál je uložen neměnně v R2 pod <code>${esc(a.location)}</code>; text z něj je v derivaci níže.</p>`
    : `<pre>${esc(a.bytes.slice(0, 2500))}${a.bytes.length > 2500 ? "\n…" : ""}</pre>`;
  return `<div class="card" style="margin:10px 0"><b>${esc(a.artifactId)}</b> <span class="dim">${kind}</span><br><small class="dim">${meta}</small>${body}</div>`;
};

const pick = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), o);

/** Raw JSON, but never dumped inline unwrapped — collapsed behind a toggle, wraps if opened. Used where a payload has no known human phrasing. */
const rawJson = (value: unknown, cap = 600): string => {
  const s = JSON.stringify(value ?? {});
  return `<details><summary>podrobnosti (JSON)</summary><pre class="wrap">${esc(s.length > cap ? `${s.slice(0, cap)}…` : s)}</pre></details>`;
};

/** Step result in plain Czech, per capability — for /farm, where there's no renderOutput() above it to carry the human summary. Falls back to collapsed raw JSON for an unknown capability. */
const humanStepResult = (s: Instance["steps"][number]): string => {
  const r = s.result;
  if (!r) return "";
  if (r.error) return `<span class="dim">${esc(r.error.code)}</span>${r.error.retryable ? " <small>(lze zopakovat)</small>" : ""}`;
  if (r.status === "WAITING") return `čeká na ${esc(r.waitReason ?? "schválení")}`;
  const p = r.payload as Record<string, unknown> | undefined;
  if (!p) return esc(r.status);
  switch (s.capability) {
    case "document.classify":
      return `typ: <b>${esc(pick(p, "documentType", "value"))}</b> <small class="dim">jistota ${esc(pick(p, "documentType", "confidence"))}</small>`;
    case "document.validate":
      return `${esc(pick(p, "documentType", "validation", "status"))} <small class="dim">razítko ${pick(p, "stampAllowed") ? "povoleno" : "zamítnuto"}</small>`;
    case "document.stamp":
      return `<b>${esc(pick(p, "stampText"))}</b> <small class="dim">DMS ${esc(pick(p, "dmsRef"))}</small>`;
    case "document.archive":
      return "archivováno";
    case "mail.ingest":
      return "e-mail přijat";
    case "email.send":
      return `odesláno · příjemce <code>${esc(pick(p, "recipientRef"))}</code>`;
    default:
      return rawJson(p);
  }
};

/** Audit "deník" row detail in plain Czech, falling back to collapsed raw JSON when a kind has no phrasing here. */
const auditSummary = (kind: string, capability: string | null, details: unknown): string => {
  const d = (details ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "dispatch":
      return `požadavek odeslán${capability ? ` na <code>${esc(capability)}</code>` : ""}`;
    case "write-intent":
      return "zápis začíná";
    case "write-done":
      return `zápis dokončen <small class="dim">${esc(d.status)}</small>`;
    case "state":
      return d.status ? `stav: <b>${esc(d.status)}</b>` : rawJson(d);
    case "review-created":
      return `čeká na schválení <small class="dim">${esc(d.reasonCode ?? "")}</small>`;
    default:
      return rawJson(d);
  }
};

/** What the flow produced so far, in the owner's words: input, text, type, validation, stamp, notification, state. */
const renderOutput = (v: InstanceView): string => {
  const i = v.instance;
  const original = v.artifacts.find((a) => !a.derivedFrom);
  const derived = v.artifacts.find((a) => a.derivedFrom);
  const subject = v.artifacts.find((a) => a.artifactId === i.input.artifactId) ?? derived ?? original;
  const lastOf = (capability: string) => [...i.steps].reverse().find((s) => s.capability === capability);
  const planned = new Set(i.steps.map((s) => s.capability));
  const stampSucceeded = lastOf("document.stamp")?.status === "SUCCEEDED";
  const stepCell = (capability: string, ok: (payload: Record<string, unknown>) => string): string => {
    const s = lastOf(capability);
    if (!s) return planned.size === 0 ? '<span class="dim">tok ještě nezačal</span>' : '<span class="dim">nedosaženo, tok skončil dřív</span>';
    if (s.status === "SUCCEEDED" && s.result?.payload) return ok(s.result.payload);
    if (s.status === "FAILED") return `${stateBadge("FAILED")} <code>${esc(s.result?.error?.code ?? "")}</code> <small>${esc(s.result?.error?.message ?? "")}</small>`;
    if (s.status === "WAITING") return `${stateBadge("WAITING")} ${esc(s.result?.waitReason ?? "")}`;
    return stateBadge(s.status);
  };
  const rows = [
    [
      "Vstup",
      original
        ? `${original.name ? `<b>${esc(original.name)}</b> · ` : ""}${esc(original.contentType ?? "text/plain")} · ${kb(original.byteLength ?? original.bytes.length)} · od <code>${esc(original.receivedFrom)}</code>${original.location ? ` · <a href="/workflow/${esc(v.workflowId)}/original" target="_blank" rel="noopener">zobrazit originál</a>` : ""}${original.location && stampSucceeded ? ` · <a href="/workflow/${esc(v.workflowId)}/original-stamped" target="_blank" rel="noopener">zobrazit vizuálně orazítkovaný originál</a>` : ""}`
        : '<span class="dim">žádný</span>',
    ],
    [
      "Text dokumentu",
      subject
        ? `${derived ? `vytěžen z originálu (<code>${esc(derived.producer)}</code>)` : "vložený text"}, ${subject.bytes.length} znaků<details><summary>zobrazit</summary><pre>${esc(subject.bytes.slice(0, 6000))}${subject.bytes.length > 6000 ? "\n…" : ""}</pre></details>`
        : '<span class="dim">žádný</span>',
    ],
    ["Typ dokumentu (classify)", stepCell("document.classify", (p) => `<b>${esc(pick(p, "documentType", "value"))}</b> <small>zdroj ${esc(pick(p, "documentType", "source"))}, jistota ${esc(pick(p, "documentType", "confidence"))}</small>`)],
    ["Validace (validate)", stepCell("document.validate", (p) => `<b>${esc(pick(p, "documentType", "validation", "status"))}</b> <small>${esc(pick(p, "documentType", "validation", "provider"))}, razítko ${pick(p, "stampAllowed") ? "povoleno" : "zamítnuto"}</small>`)],
    [
      "Razítko (stamp)",
      stepCell(
        "document.stamp",
        (p) =>
          `<b>${esc(pick(p, "stampText"))}</b> <small>DMS <code>${esc(pick(p, "dmsRef"))}</code>, orazítkovaný artefakt <code>${esc(pick(p, "stampedArtifactId"))}</code></small><br><a href="/workflow/${esc(v.workflowId)}/stamped">zobrazit orazítkovaný text</a>`,
      ),
    ],
    ...(i.workflow === "mail-intake" ? [["Notifikace (email.send)", stepCell("email.send", (p) => `<b>odesláno</b> <small>příjemce <code>${esc(pick(p, "recipientRef"))}</code>, id <code>${esc(pick(p, "smtpMessageId"))}</code></small>`)]] : []),
    ["Stav toku", `${stateBadge(i.status)} <small>${i.status === "SUCCEEDED" ? "všechny kroky proběhly" : i.status === "WAITING" ? `čeká na ${esc(i.waiting?.reason)}` : i.status === "FAILED" ? "tok skončil explicitně, viz kroky níže" : ""}</small>`],
  ];
  const reviewForm =
    i.status === "WAITING" && i.waiting?.reason === "REVIEW" && i.waiting.reviewTaskId
      ? `<div class="card" style="margin-top:12px">
      <h3 style="margin-bottom:6px">Rozhodnutí (review)</h3>
      <p class="dim">Úkol <code>${esc(i.waiting.reviewTaskId)}</code> čeká do <code>${esc(i.waiting.deadline)}</code>.</p>
      <form method="post" action="/workflow/${esc(v.workflowId)}/review/decide">
        <input type="hidden" name="reviewTaskId" value="${esc(i.waiting.reviewTaskId)}">
        <label for="correctedType">Opravený typ dokumentu (jen pro „Opravit a zopakovat“)</label>
        <select id="correctedType" name="correctedType"><option value="">—</option><option>INVOICE</option><option>CONTRACT</option><option>OTHER</option></select>
        <div style="margin-top:.75rem;display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn" type="submit" name="decision" value="RECLASSIFY">Opravit a zopakovat</button>
          <button class="btn" type="submit" name="decision" value="APPROVE" style="background:var(--ok);color:#fff">Schválit tak, jak je</button>
          <button class="btn" type="submit" name="decision" value="REJECT" style="background:var(--crit);color:#fff">Zamítnout (ukončit)</button>
        </div>
      </form>
    </div>`
      : "";
  return `<h2>Výstup</h2><div class="card">${rows.map(([k, val]) => `<div style="display:flex;gap:14px;padding:7px 0;border-bottom:1px solid var(--border-soft)"><div class="dim" style="width:12rem;flex:none;font-weight:650">${k}</div><div>${val}</div></div>`).join("")}</div>${reviewForm}`;
};

/** Shared by the instance page and /farm's per-instance detail: one row per step, same columns both places. */
const stepsTable = (steps: Instance["steps"]): string =>
  `<table><tr><th>Krok</th><th>Stav</th><th>Pokus / logický</th><th>Výsledek</th></tr>${steps
    .map(
      (s) =>
        `<tr><td><b>${esc(s.stepId)}</b><br><small>${esc(s.capability)}/v${esc(s.capabilityVersion)}</small></td><td>${stateBadge(s.status)}</td><td>${s.attempt} / ${s.logicalAttempt}<br><small>${esc(s.strategy)}</small></td><td>${fmtResult(s)}</td></tr>`,
    )
    .join("")}</table>`;

/** Kravská dílna's own chat page (its own URL, /farm/workshop/<id>, same pattern as /workflow/<id> — a growing
 * transcript doesn't belong pre-rendered-and-hidden in every /farm load the way the tab-switched sections are).
 * No markdown rendering (this codebase has no such library, deliberately) — esc() + white-space:pre-wrap keeps
 * the AI's own "### FILE:" fenced blocks legible without a parser that could itself become an injection surface. */
export function renderWorkshopSession(session: WorkshopSession): string {
  const messages = session.messages
    .map(
      (m) =>
        `<div class="card" style="margin-bottom:10px${m.role === "ai" ? ";border-color:var(--accent)" : ""}"><b>${m.role === "admin" ? "Admin" : "Asistent"}</b> <span class="dim">${shortAt(m.at)}</span><div style="white-space:pre-wrap;margin-top:6px">${esc(m.text)}</div></div>`,
    )
    .join("");
  return shell(
    `Kravská dílna — ${session.title}`,
    `<div class="doc"><header><h1>🐄💬 ${esc(session.title)}</h1><small class="dim">založeno ${shortAt(session.createdAt)}, naposledy ${shortAt(session.updatedAt)}</small></header>
    ${messages}
    <form method="post" action="/farm/workshop/${esc(session.sessionId)}/message">
      <textarea name="text" rows="4" placeholder="Odpověz asistentovi — uprav zadání, vlož kód/dokumentaci, nebo odpověz na doptání." required></textarea>
      <button class="btn btn-primary" type="submit" style="margin-top:8px">Odeslat</button>
    </form>
    <nav style="margin-top:16px"><a href="/farm#kravska-dilna">Zpět do Kravské dílny</a></nav></div>`,
  );
}

export function renderInstance(v: InstanceView): string {
  const i = v.instance;
  const audit = v.audit
    .map((r) => `<tr><td><small>${esc(r.at)}</small></td><td><code>${esc(r.kind)}</code></td><td><small>${esc(r.capability ?? "")}</small></td><td><small>${esc(JSON.stringify(r.details ?? {}))}</small></td></tr>`)
    .join("");
  return shell(
    `${i.workflow} ${v.workflowId}`,
    `<div class="doc"><header><h1>Instance toku <code>${esc(i.workflow)}/v${esc(i.workflowVersion)}</code></h1>${stateBadge(i.status)}</header>
<div class="card" style="margin-bottom:14px"><small class="dim">id <code>${esc(v.workflowId)}</code> · korelace <code>${esc(i.correlationId)}</code> · tenant <code>${esc(i.tenantId)}</code> · aktér <code>${esc(i.actorId)}</code> · založeno ${esc(i.createdAt)} · změněno ${esc(i.updatedAt)}${i.waiting ? ` · čeká na <code>${esc(i.waiting.reason)}</code> do ${esc(i.waiting.deadline)}` : ""}</small></div>
${renderOutput(v)}
<h2>Kroky</h2><div class="card">${stepsTable(i.steps)}
<small class="dim">Krok, který skončil <code>DEPENDENCY_UNAVAILABLE</code>, narazil na část farmy, která ještě není zapojená; orchestrátor ho zkusil tolikrát, kolik dovoluje definice toku, a pak instanci explicitně ukončil.</small></div>
<h2>Artefakty</h2>${v.artifacts.map(artifactCard).join("") || '<div class="card dim">žádné</div>'}
<h2>Audit této instance</h2><div class="card"><table><tr><th>Čas</th><th>Druh</th><th>Capability</th><th>Detail</th></tr>${audit}</table></div>
<nav><a href="/farm">Nový dokument</a><a href="/workflow/${esc(v.workflowId)}.json">JSON</a><a href="/audit.json">Společný audit (D1)</a></nav>
<form method="post" action="/workflow/${esc(v.workflowId)}/purge" onsubmit="return confirm('Smazat instanci včetně originálu a derivací? Ve společném auditu zůstane záznam PURGED.')"><input type="hidden" name="reason" value="owner request from instance page"><button class="btn btn-danger" type="submit" style="margin-top:1.5rem">Smazat instanci (originál, derivace, objekt)</button></form></div>`,
  );
}
