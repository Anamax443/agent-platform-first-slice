// Server-rendered pages of the gateway (behind Cloudflare Access): a form to hand a document to a workflow and the view of
// one workflow instance. No external assets, no scripts: the page is evidence, not an app. Czech labels for the owner.
import type { Artifact } from "../../../../src/platform/artifacts.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import type { Instance } from "../../../../src/platform/journal.js";
import { BANK_UI_CSS } from "./bank.js";
import { FARM_THEME_CSS } from "./farm-theme.js";

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

export interface HomeModel {
  installation: string;
  user: string;
  workflows: string[];
  wired: Wired;
  models: ModelsInfo;
}

export interface DeployableStatus {
  name: string;
  ok: boolean;
  status: number;
  body: unknown;
  /** Last stored self-test result for this worker (docs: owner 2026-09-09, "nevím, jestli jsou zdravé, jen je
   * zelené OK") — undefined when self-test was never run on this farm. */
  selfTest?: { passed: number; total: number };
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

/** One row of the Admission Gate table (Kravičky tab): a registered capability + the descriptor's own risk/isolation
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
}

export interface FarmModel {
  installation: string;
  gitSha: string;
  gatewaySigning: string;
  deployables: DeployableStatus[];
  capabilities: CapabilityRow[];
  instances: FarmInstanceRow[];
  instanceLimit: number;
  instanceWindow: string;
  auditLog: AuditLogRow[];
  inbox: { pending: InboxItem[]; failed: InboxItem[]; batchLimit: number };
  workflows: string[];
  models: ModelsInfo;
  stats: FarmStats;
  /** When the self-test summary carried on deployables[].selfTest/capabilities[].selfTest was recorded —
   * undefined when self-test was never run on this farm yet. */
  selfTestAt?: string;
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

const CSS = `
:root{color-scheme:light}body{margin:0;background:#f6f7f9;color:#1c1f24;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:64rem;margin:0 auto;padding:1.5rem}header{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
h1{font-size:1.25rem;margin:0}h2{font-size:1.05rem;margin:1.5rem 0 .5rem}small,.muted{color:#5b6472}code{font:.9em ui-monospace,Consolas,monospace;background:#eceff3;padding:.05em .3em;border-radius:3px}
.card{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:1rem 1.25rem;margin:.75rem 0}.card.err{border-color:#fca5a5;background:#fff5f5}
label{display:block;font-weight:600;margin:.75rem 0 .25rem}textarea,input[type=text],select{width:100%;box-sizing:border-box;border:1px solid #c5ccd5;border-radius:6px;padding:.5rem;font:inherit}
textarea{min-height:10rem;font-family:ui-monospace,Consolas,monospace}button{margin-top:1rem;background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font:inherit;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;vertical-align:top;padding:.4rem .5rem;border-bottom:1px solid #e6e9ee}th{color:#5b6472;font-weight:600}
.badge{display:inline-block;padding:.1em .55em;border-radius:999px;font-size:.8rem;font-weight:700;background:#e5e7eb}
.SUCCEEDED{background:#dcfce7;color:#166534}.FAILED{background:#fee2e2;color:#991b1b}.WAITING{background:#fef3c7;color:#92400e}.RUNNING,.PENDING{background:#dbeafe;color:#1e40af}.UNKNOWN_OUTCOME,.CANCELLED{background:#ede9fe;color:#5b21b6}
.wired li{margin:.15rem 0}.ok::before{content:"● ";color:#16a34a}.no::before{content:"● ";color:#dc2626}pre{white-space:pre-wrap;word-break:break-word;background:#f3f4f6;padding:.75rem;border-radius:6px;max-height:22rem;overflow:auto;font-size:.85rem}
nav a{margin-right:1rem}
`;

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

const wiredList = (w: Wired): string => {
  const row = (ok: boolean, label: string, detail: string) => `<li class="${ok ? "ok" : "no"}">${esc(label)} <small>${esc(detail)}</small></li>`;
  return `<ul class="wired">${[
    row(w.intake, "příjem dokumentu (formulář, originál do R2)", "hotovo"),
    row(true, "extrakce textu z PDF, fotky, docx", w.extract),
    row(true, "journal instance", w.journal),
    row(true, "audit", w.audit),
    row(true, "artefakty", w.artifacts),
    row(w.dispatch, "dispatch: router a podpis obálky", w.dispatch ? w.gateway : "zatím ne: každý krok toku skončí DEPENDENCY_UNAVAILABLE"),
    row(!w.signing.startsWith("MISSING"), "podpisový klíč gateway (Ed25519)", w.signing),
    row(true, "fakes: registr, DMS, archiv jako dvojníci za service bindingem", w.fakes),
    row(w.hosts, "hosty: document-host (stamp, archive), mail, e-mail", w.hosts ? "zapojeno" : "zatím ne: kroky stamp a dál skončí DEPENDENCY_UNAVAILABLE"),
    row(w.accessJwtVerified, "ověření Access JWT ve Workeru", w.accessJwtVerified ? "ano" : "zatím jen hlavička od Access"),
  ].join("")}</ul>`;
};

export function renderHome(m: HomeModel): string {
  const options = m.workflows.map((w) => `<option value="${esc(w)}"${w === "document-intake" ? " selected" : ""}>${esc(w)}</option>`).join("");
  return shell(
    `apf · ${m.installation}`,
    `<header><h1>agent-platform-first-slice · farma <code>${esc(m.installation)}</code></h1><small>${esc(m.user)}</small></header>
<div class="card"><form method="post" action="/intake" enctype="multipart/form-data">
<label for="file">Soubor: PDF, fotka (jpg, png, webp), docx, ISDOC / XML, txt, md, eml (do 4 MB)</label>
<input id="file" type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.isdoc,.xml,.txt,.md,.eml,application/pdf,image/*,application/xml,text/xml,text/plain,message/rfc822">
<label for="text">Nebo vložený text (faktura, smlouva, e-mail…)</label>
<textarea id="text" name="text" placeholder="Když je nahraný soubor, text se nepoužije."></textarea>
<label for="workflow">Tok</label>
<select id="workflow" name="workflow">${options}</select>
<label for="model">Model AI pro posouzení (classify)</label>
${
  "error" in m.models
    ? `<div class="card err"><b>Bez modelu nelze spustit tok.</b> ${esc(m.models.error)}</div>`
    : `<select id="model" name="model">${m.models.choices
        .map((c) =>
          c.unavailable
            ? `<option value="${esc(c.key)}" disabled>${esc(c.label)} — nedostupné: ${esc(c.unavailable)}</option>`
            : `<option value="${esc(c.key)}"${c.isDefault ? " selected" : ""}>${esc(c.label)}${c.isDefault ? " (výchozí)" : ""}</option>`,
        )
        .join("")}</select><small class="muted">Posouzení dělá vždy model; pravidla jsou jen druhý nezávislý signál ve validaci a záložní strategie. Použitý model a verze promptu jdou do provenance výsledku.</small>`
}
<label for="stampText">Text razítka (nepovinné)</label>
<input id="stampText" type="text" name="stampText" placeholder="VALIDATED INVOICE">
<button type="submit">Odeslat do toku</button>
</form></div>
<h2>Co je na farmě zapojené</h2><div class="card">${wiredList(m.wired)}</div>
<nav><a href="/farm">Farmář</a><a href="/VYVOJOVY-DIAGRAM.html">Jak to funguje</a><a href="/version">/version</a><a href="/audit.json">/audit.json</a></nav>`,
  );
}

/** State label → bank status class (docs/UI/predpis-saas-modern-side-nav.txt §8: "stav nese barvu i slovo", nikdy jen barva). */
const STATE_CLASS: Record<string, string> = {
  OK: "st-ok",
  "OK (dvojník)": "st-ok",
  SUCCEEDED: "st-ok",
  ACTIVE: "st-ok",
  QUARANTINED: "st-crit",
  DOWN: "st-crit",
  FAILED: "st-crit",
  WAITING: "st-warn",
  NEZAPOJENO: "st-warn",
  UNKNOWN_OUTCOME: "st-warn",
  CANCELLED: "st-warn",
  RUNNING: "st-man",
  PENDING: "st-man",
  NÁVRH: "st-man",
  SKIPPED: "st-man",
};
const stateBadge = (label: string): string => `<span class="${STATE_CLASS[label] ?? ""}"><span class="p-state"><span class="p-dot"></span>${esc(label)}</span></span>`;
const stateTd = (label: string): string => `<td class="c-state">${stateBadge(label)}</td>`;

/** What each "kravička" actually does, in plain Czech — the raw health table alone doesn't say. */
const DEPLOYABLE_ROLE: Record<string, string> = {
  "apf-gateway": "Přijme dokument, rozpozná typ (AI) a řídí celý průběh",
  "apf-document-host": "Orazítkuje dokument po ověření a zapíše ho — dnes proti testovacímu dvojníku DMS, ne ostrému systému. Umí i „document.archive“, ale v běžném toku se nevolá (existuje jen kvůli testu izolace)",
  "apf-email-executor": "Odesílá e-mailová upozornění",
  "apf-mail-ingest": "Přijímá dokumenty poslané e-mailem",
  "apf-fakes": "Testovací dvojník DMS/registru/archivu — jeho „OK“ znamená jen, že dvojník odpovídá, ne že je napojený skutečný systém",
};

/**
 * Ideas from docs/NAVRHOVY-LIST-farma.md that have no code yet (owner's request, 2026-09-07: "do seznamu agentů
 * dávej i nápady co mám v režimu návrh") — kept here by hand, in sync with the design doc, not parsed from it.
 */
const PLANNED_DEPLOYABLES: { name: string; role: string }[] = [
  { name: "cz.company.verify", role: "Ověří IČO v ARES (existence, právní forma, adresa) — krok 8b, návrh 7. 9. 2026, žádný kód" },
  { name: "cz.vat.verify", role: "Ověří DPH plátcovství, nespolehlivého plátce a zveřejněný bankovní účet u Finanční správy — krok 8b, návrh 7. 9. 2026, žádný kód" },
];

/** "Reachable" (HTTP 200 on /version) and "actually wired into the flow" are different claims — a skeleton answers fine but does nothing yet. */
const workerReady = (d: DeployableStatus): boolean => d.ok && (d.body as Record<string, unknown> | null)?.wired !== false;
const workerStateLabel = (d: DeployableStatus): string => {
  if (!d.ok) return "DOWN";
  if ((d.body as Record<string, unknown> | null)?.wired === false) return "NEZAPOJENO";
  return d.name === "apf-fakes" ? "OK (dvojník)" : "OK";
};

/** Isolation class → plain label + hover explanation (LOGICAL/PRINCIPAL are jargon on their own). */
const isolationLabel = (raw: string): { label: string; title?: string } => {
  if (raw === "self") return { label: "gateway", title: "toto je samotná gateway, hlásí vlastní zdraví" };
  if (raw === "LOGICAL") return { label: "sdílený proces", title: "LOGICAL: běží ve stejném Workeru jako další úkol, ale s odděleným přístupovým klíčem" };
  if (raw === "PRINCIPAL") return { label: "vlastní proces", title: "PRINCIPAL: běží zcela odděleně, s vlastním přístupovým klíčem — nejsilnější izolace" };
  return { label: raw };
};

/** Risk class → Czech label + a colour cue for HIGH/CRITICAL (docs/POSUDKY.md Posudek 7, Admission Gate discussion). */
const RISK_LABEL: Record<string, string> = { LOW: "nízké", MEDIUM: "střední", HIGH: "vysoké", CRITICAL: "kritické" };
const riskBadge = (raw: string | undefined): string => {
  if (!raw) return `<span class="dim">—</span>`;
  const cls = raw === "HIGH" || raw === "CRITICAL" ? "st-crit" : raw === "MEDIUM" ? "st-warn" : "st-ok";
  return `<span class="${cls}">${esc(RISK_LABEL[raw] ?? raw)}</span>`;
};

/** ISO timestamp, trimmed to "YYYY-MM-DD HH:MM:SS" — same trim used by the Deník terminal. */
const shortAt = (at: string): string => esc(at).replace("T", " ").replace(/\.\d+Z$|Z$/, "");

/** "OK"/"ACTIVE" alone proves only that the process answered, not that anything was actually verified (owner
 * 2026-09-09: "nevím, jestli jsou zdravé, jen je zelené OK" / "kde jsou slibované testy kraviček?"). Shows the
 * last stored self-test result — undefined means "never run", stated plainly rather than left implicit. */
const selfTestBadge = (st: { passed: number; total: number } | undefined): string => {
  if (!st) return `<span class="dim" title="Self-test nikdy neproběhl na téhle farmě">self-test: nikdy</span>`;
  const cls = st.total === 0 ? "dim" : st.passed === st.total ? "st-ok" : "st-crit";
  return `<span class="${cls}" title="Poslední self-test: ${esc(st.passed)}/${esc(st.total)} fixtures prošlo">self-test <b>${st.passed}/${st.total}</b></span>`;
};

/** One card of the Admission Gate pen: capability, its risk/isolation claim, live lifecycle. */
const capabilityRow = (c: CapabilityRow): string => {
  const iso = isolationLabel(c.isolationClass ?? "");
  return `<div class="p-card${c.lifecycleStatus === "QUARANTINED" ? " st-crit-card" : ""}"><div class="p-card-head"><code>${esc(c.capability)}</code>/v${esc(c.version)}${c.usesLlm ? ' <small title="volá jazykový model">🤖</small>' : ""}${stateBadge(c.lifecycleStatus)}</div><div class="p-card-meta"><span>riziko ${riskBadge(c.riskClass)}</span><span${iso.title ? ` title="${esc(iso.title)}"` : ""}>izolace <b>${esc(iso.label || "—")}</b></span><span>${esc(c.sideEffects ?? "—")}</span></div><div class="p-card-meta">${selfTestBadge(c.selfTest)}</div></div>`;
};

/**
 * Farmář na banku Interface-Par (Anamax443/Interface-Par, styl saas-modern, rozvržení side-nav — viz
 * docs/UI/predpis-saas-modern-side-nav.txt). Vlastní stránka, ne shell() — jiný vizuální jazyk než zbytek gatewaye.
 * Přehled + kravičky (pět Workerů) + poslední instance (seskupené kroky) + deník (sdílený audit, D1) na jedné stránce.
 */
export function renderFarm(m: FarmModel): string {
  // Answering /version (HTTP 200) only proves the Worker is alive — its own body can still say wired:false
  // (a skeleton that hasn't been wired into the flow yet). "OK" here must mean the second thing too.
  const up = m.deployables.filter((d) => workerReady(d)).length;

  // Declared first: penHead() (built further down, inside an IIFE that runs immediately) reads ICONS too —
  // a const only hoists its binding, not its value, so anything that reads it before this line throws
  // ReferenceError (found live on farm-bass443, this exact bug, HANDOFF 73's own first deploy).
  const icon = (paths: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    menu: icon('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
    // A cow face: two small ear/horn curves, a rounded muzzle, two spot dots, a smile — deliberately simple at 16px.
    kravicky: icon('<path d="M6 8.5a2.3 2.3 0 0 1 3-2.2M18 8.5a2.3 2.3 0 0 0-3-2.2"/><rect x="5" y="8" width="14" height="10" rx="5"/><circle cx="9.5" cy="13" r=".7" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r=".7" fill="currentColor" stroke="none"/><path d="M10 16.5c.7.5 1.3.5 2 0"/>'),
    // A dog face (Argos): ears, head, two eyes — same visual family as kravicky, so the two feel like they belong together.
    argos: icon('<path d="M6 9c-1.2-.8-1.6-2.4 0-3.2.8.4 1.2 1.2 1.2 2M18 9c1.2-.8 1.6-2.4 0-3.2-.8.4-1.2 1.2-1.2 2"/><path d="M6 10.5a6 6 0 0 1 12 0c0 3.5-2.7 6-6 6s-6-2.5-6-6Z"/><circle cx="10" cy="11" r=".6" fill="currentColor" stroke="none"/><circle cx="14" cy="11" r=".6" fill="currentColor" stroke="none"/>'),
    // A holding pen: three posts, two rails.
    ohrada: icon('<line x1="5" y1="4" x2="5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="19" y1="4" x2="19" y2="20"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>'),
    // Erwin's own hat: brim + dome, the same simple silhouette family as kravicky/argos.
    erwin: icon('<path d="M4 15.5c0-1 3.6-2 8-2s8 1 8 2"/><path d="M8 13.5c0-3.3 1.8-6 4-6s4 2.7 4 6"/>'),
    // A result: checkmark in a circle.
    vysledek: icon('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 10.8 15.3 16 9.5"/>'),
    denik: icon('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>'),
    novy: icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    diagram: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><line x1="8" y1="7.5" x2="10.5" y2="16.2"/><line x1="16" y1="7.5" x2="13.5" y2="16.2"/><line x1="8.5" y1="6" x2="15.5" y2="6"/>'),
  };

  const deployableCard = (d: DeployableStatus): string => {
    const b = (d.body ?? {}) as Record<string, unknown>;
    const caps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).join(", ") : undefined;
    const detail = caps ? `umí: ${caps}` : b.wired === false ? "zatím nezapojeno do toku" : b.error ? String(b.error) : "";
    const role = DEPLOYABLE_ROLE[d.name];
    const iso = isolationLabel(String(b.isolation ?? ""));
    const state = workerStateLabel(d);
    return `<div class="p-card${state === "DOWN" ? " st-crit-card" : ""}"><div class="p-card-head"><code>${esc(d.name)}</code>${stateBadge(state)}</div>${role ? `<div class="p-card-role">${esc(role)}</div>` : ""}<div class="p-card-meta"><span${iso.title ? ` title="${esc(iso.title)}"` : ""}>izolace <b>${esc(iso.label)}</b></span>${detail ? `<span>${esc(detail)}</span>` : ""}</div><div class="p-card-meta">${selfTestBadge(d.selfTest)}</div></div>`;
  };
  // apf-gateway IS Erwin (decides, plans, routes) — not one of the cows he directs. Owner's own observation
  // (2026-09-09, screenshot of the Kravičky tab): "toto je spíš farmář, ne?" — moved to Erwin's own section.
  const byName = (name: string) => m.deployables.find((d) => d.name === name);
  const gatewayRow = byName("apf-gateway");
  const hostNames = ["apf-document-host", "apf-email-executor", "apf-mail-ingest"];
  const cardSection = (label: string, cardsHtml: string): string => (cardsHtml ? `<div class="p-cardsec"><div class="p-cardsec-label">${esc(label)}</div><div class="p-cardgrid">${cardsHtml}</div></div>` : "");
  const plannedCard = (p: { name: string; role: string }): string => `<div class="p-card"><div class="p-card-head"><code>${esc(p.name)}</code>${stateBadge("NÁVRH")}</div><div class="p-card-role">${esc(p.role)}</div></div>`;
  const erwinGatewayCard = cardSection("Erwin sám (apf-gateway) — přijímá dokument a rozhoduje, kam ho poslat dál", gatewayRow ? deployableCard(gatewayRow) : "");
  const kravickyCards =
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

  // Kapability seskupené po modulu jako ohrady (owner's request 2026-09-09: karty, ne řádky tabulky —
  // vizuálně blíž skutečné farmě, jedna ohrada = jeden modul, uvnitř jeho kapability jako kravičky).
  // Pořadí modulů = pořadí prvního výskytu v m.capabilities (stabilní, žádné další řazení).
  const penGrid = (() => {
    const byModule = new Map<string, CapabilityRow[]>();
    for (const c of m.capabilities) {
      if (!byModule.has(c.module)) byModule.set(c.module, []);
      (byModule.get(c.module) as CapabilityRow[]).push(c);
    }
    return [...byModule.entries()]
      .map(([mod, caps]) => `<div class="pen"><div class="pen-label">${ICONS.kravicky}${esc(mod)}</div><div class="p-cardgrid">${caps.map(capabilityRow).join("")}</div></div>`)
      .join("");
  })();

  // Owner's request 2026-09-08: what carries the link belongs in column 1 (not buried mid-line), rows collapsed to a
  // one-line summary by default, click to see the steps — a document block is evidence to check, not to always read in full.
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
  // Ohrada (owner's request 2026-09-09, farm illustration: the pen for unclear/failed/waiting cases, "zde se nic
  // samo neprovede"): the same instances as Poslední instance, filtered to what actually needs a human decision.
  // Reads the same already-fetched m.instances — no separate query, so it only ever shows what's within
  // instanceLimit/instanceWindow, same honest limit as the full list.
  const ohradaInstances = m.instances.filter((i) => !i.purged && (i.status === "WAITING" || i.status === "FAILED" || i.status === "UNKNOWN_OUTCOME"));
  const ohradaRows = instanceRowsOf(ohradaInstances);

  const denikRows = m.auditLog
    .map((r) => {
      const link = r.workflowId ? `<a href="/workflow/${esc(r.workflowId)}">${esc(r.workflowId)}</a>` : "—";
      return `<tr><td class="c-date">${esc(r.at)}</td><td>${esc(r.kind)}</td><td>${link}</td><td>${esc(r.capability ?? "")}</td><td class="wrap">${auditSummary(r.kind, r.capability, r.details)}</td></tr>`;
    })
    .join("");
  // Live terminal (owner's request 2026-09-09: "vidět co se šustne") — same rows as denikRows, oldest first (tail -f
  // order), seeded server-side so the box isn't empty before the client's first poll picks up.
  const terminalLine = (r: AuditLogRow): string => {
    const time = esc(r.at).replace("T", " ").replace(/\.\d+Z$|Z$/, "");
    const link = r.workflowId ? ` <a href="/workflow/${esc(r.workflowId)}">${esc(r.workflowId)}</a>` : "";
    const cap = r.capability ? ` <code>${esc(r.capability)}</code>` : "";
    return `<div class="t-line" data-at="${esc(r.at)}"><span class="t-dim">${time}</span> ${esc(r.kind)}${cap}${link} <span class="t-dim">${auditSummary(r.kind, r.capability, r.details)}</span></div>`;
  };
  const terminalSeed = [...m.auditLog].reverse().map(terminalLine).join("");


  const bodyHtml = `<div class="ui" id="ui" data-layout="side-nav" data-style="farm">
  <div class="p-title">
    <button type="button" class="p-titlebtn" id="railToggle" title="Sbalit/rozbalit menu" aria-label="Sbalit/rozbalit menu">${ICONS.menu}</button>
    <span class="p-brand"><span class="mark"></span>🌾 Farmář<span class="sub">— farma ${esc(m.installation)}</span></span>
    <span class="vsep"></span>
    <span class="p-field">podpis ${esc(m.gatewaySigning)}</span>
    <span class="grow"></span>
    <span class="p-field" id="clock" title="Živý čas prohlížeče"></span>
    <span class="vsep"></span>
    <span class="p-field"><code title="Commit, ze kterého je tento build">${esc(m.gitSha)}</code></span>
    <span class="vsep"></span>
    <span class="p-field">${up}/${m.deployables.length} Workerů OK</span>
  </div>

  <nav class="p-nav">
    <a class="p-navitem" href="#zadani" data-view="zadani" title="Zadání požadavku">${ICONS.novy}<span class="lbl">Zadání požadavku</span></a>
    <a class="p-navitem" href="#erwin" data-view="erwin" title="Erwin — plánování">${ICONS.erwin}<span class="lbl">Erwin</span></a>
    <a class="p-navitem" href="#argos" data-view="argos" title="Argos — kontrola">${ICONS.argos}<span class="lbl">Argos</span></a>
    <a class="p-navitem" href="#kravicky" data-view="kravicky" title="Kravičky — práce">${ICONS.kravicky}<span class="lbl">Kravičky</span></a>
    <a class="p-navitem" href="#ohrada" data-view="ohrada" title="Ohrada — čeká na člověka">${ICONS.ohrada}<span class="lbl">Ohrada${ohradaInstances.length ? ` (${ohradaInstances.length})` : ""}</span></a>
    <a class="p-navitem" href="#vysledek" data-view="vysledek" title="Výsledek">${ICONS.vysledek}<span class="lbl">Výsledek</span></a>
    <a class="p-navitem" href="#denik" data-view="denik" title="Audit">${ICONS.denik}<span class="lbl">Audit</span></a>
    <div class="p-navsec">Farma</div>
    <a class="p-navitem" href="/VYVOJOVY-DIAGRAM.html" title="Jak to funguje — bezpečnostní řetězec a běh toku">${ICONS.diagram}<span class="lbl">Jak to funguje</span></a>
    <a class="p-navitem" href="/MATICE-ODPOVEDNOSTI.html" title="Kdo (kravička/kapabilita) odpovídá za co">${ICONS.diagram}<span class="lbl">Matice odpovědnosti</span></a>
  </nav>

  <main class="p-main">
    <div id="view-zadani">
      <img class="p-hero" src="/farm/ilustrace.png" alt="AI Farma — Erwin, Argos a kravičky ve svých ohradách" loading="lazy">
      <div class="p-panehead">${ICONS.novy}<span>Zadání požadavku</span><span class="n">1 · vstup</span></div>
      <div class="p-toolbar"><span class="meta">Ruční jednotlivé podání — stejná cesta (<code>startIntake</code>) jako dávkový příjem, jen výsledek uvidíš hned, ne až po dalším běhu cronu</span></div>
      <form class="p-form" method="post" action="/intake" enctype="multipart/form-data">
        <label for="novy-file">Soubor: PDF, fotka (jpg, png, webp), docx, ISDOC / XML, txt, md, eml (do 4 MB)</label>
        <input id="novy-file" type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.isdoc,.xml,.txt,.md,.eml,application/pdf,image/*,application/xml,text/xml,text/plain,message/rfc822">
        <label for="novy-text">Nebo vložený text (faktura, smlouva, e-mail…)</label>
        <textarea id="novy-text" name="text" placeholder="Když je nahraný soubor, text se nepoužije."></textarea>
        <label for="novy-workflow">Tok</label>
        <select id="novy-workflow" name="workflow">${m.workflows.map((w) => `<option value="${esc(w)}"${w === "document-intake" ? " selected" : ""}>${esc(w)}</option>`).join("")}</select>
        <label for="novy-model">Model AI pro posouzení (classify)</label>
        ${
          "error" in m.models
            ? `<div class="meta" style="color:var(--crit)">Bez modelu nelze spustit tok. ${esc(m.models.error)}</div>`
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
        <button class="p-btn" type="submit">Odeslat do toku</button>
      </form>

      <div class="p-panehead"><span>Dávkový příjem (inbox)</span><span class="n">${m.inbox.pending.length} čeká${m.inbox.failed.length ? ` · ${m.inbox.failed.length} selhalo` : ""}</span></div>
      <form class="p-toolbar" method="post" action="/farm/inbox" enctype="multipart/form-data">
        <input type="file" name="files" multiple>
        <button class="p-btn" type="submit">Nahrát do inboxu</button>
        <span class="vsep"></span>
        <span class="meta">kontrola každých 5 minut, max ${m.inbox.batchLimit} souborů na běh</span>
      </form>
      <div class="p-toolbar">
        <span class="meta">nebo přímo Cloudflare dashboard → R2 → <code>apf-artifacts</code> → <code>inbox/</code> (stejné místo, žádný rozdíl)</span>
      </div>
      ${
        m.inbox.pending.length
          ? `<div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Soubor</th><th>Velikost</th><th>Nahráno</th></tr></thead>
        <tbody>${m.inbox.pending.map((it) => `<tr><td class="wrap">${esc(it.name)}</td><td>${kb(it.size)}</td><td class="c-date">${esc(it.uploaded)}</td></tr>`).join("")}</tbody>
      </table></div>`
          : ""
      }
      ${
        m.inbox.failed.length
          ? `<div class="p-panehead"><span style="color:var(--crit)">Selhalo v inbox/failed/</span><span class="n">podívej se, co je špatně, a zkus znovu</span></div>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Soubor</th><th>Velikost</th><th>Důvod</th><th></th></tr></thead>
        <tbody>${m.inbox.failed
          .map(
            (it) =>
              `<tr><td class="wrap">${esc(it.name)}</td><td>${kb(it.size)}</td><td class="wrap">${esc(it.reason ?? "")}${it.message ? ` <small class="dim">${esc(it.message)}</small>` : ""}</td><td><form method="post" action="/farm/inbox/retry"><input type="hidden" name="key" value="${esc(it.key)}"><button class="p-btn" type="submit">Zkusit znovu</button></form></td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`
          : ""
      }
    </div>

    <div id="view-erwin" hidden>
      <div class="p-panehead">${ICONS.erwin}<span>Erwin</span><span class="n">2 · plánování</span></div>
      <div class="p-toolbar"><span class="meta">Rozumí požadavku, rozdělí ho na kroky (workflow) a pošle správné kravičce — instalace ${esc(m.installation)}, podpis ${esc(m.gatewaySigning)}</span></div>
      ${erwinGatewayCard}
      <div class="p-cardsec">
        <div class="p-cardsec-label">Toky, co Erwin umí naplánovat</div>
        <div class="p-cardgrid">${m.workflows.map((w) => `<div class="p-card"><div class="p-card-head"><code>${esc(w)}</code></div></div>`).join("")}</div>
      </div>
      <div class="p-cardsec">
        <div class="p-cardsec-label">Modely pro posouzení dokumentu (document.classify)</div>
        <div class="p-cardgrid">${
          "error" in m.models
            ? `<div class="p-card st-crit-card"><div class="p-card-role">${esc(m.models.error)}</div></div>`
            : m.models.choices
                .map(
                  (c) =>
                    `<div class="p-card${c.unavailable ? " st-crit-card" : ""}"><div class="p-card-head">${esc(c.label)}${c.isDefault ? stateBadge("ACTIVE") : ""}</div><div class="p-card-role">${esc(c.provider)} · <code>${esc(c.model)}</code>${c.unavailable ? `<br>nedostupné: ${esc(c.unavailable)}` : ""}</div></div>`,
                )
                .join("")
        }</div>
      </div>
      <div class="p-toolbar"><span class="meta">${up}/${m.deployables.length} Workerů OK · ${m.instances.length} instancí zpracováno · ${m.auditLog.length} v deníku</span></div>
    </div>

    <div id="view-argos" hidden>
      <div class="p-panehead">${ICONS.argos}<span>Argos hlídá — Kapability (Admission Gate)</span><span class="n">3 · kontrola · ${m.capabilities.length}, ${m.capabilities.filter((c) => c.lifecycleStatus === "QUARANTINED").length} v karanténě</span></div>
      <div class="p-toolbar"><span class="meta">Co každá kravička skutečně smí vykonat, seskupeno po modulu jako ohrada — riziko a izolace jsou vlastní tvrzení komponenty (descriptor), stav na kartě je to, co <b>Router doopravdy vynucuje</b> před každým dispatchem. Karanténa (config/&lt;instalace&gt;/lifecycle.json) se mění deploym, ne odsud — tahle stránka jen čte, nikdy nezapisuje</span></div>
      <div class="p-toolbar"><span class="meta">„self-test X/Y" na kartě = kolik vzorových případů té kapability naposledy skutečně prošlo proti reálnému běhu (ne jen že Worker odpověděl) — spusť ho na záložce Kravičky${m.selfTestAt ? `, naposledy ${shortAt(m.selfTestAt)}` : ""}</span></div>
      ${m.capabilities.length ? penGrid : '<div class="pen-empty">zatím žádné (vzdálení Workeři neodpověděli)</div>'}
    </div>

    <div id="view-kravicky" hidden>
      <div class="p-panehead"><span>Kravičky</span><span class="n">4 · práce · ${m.deployables.length - 1} Workerů</span></div>
      <div class="p-toolbar"><span class="meta">Zdraví a role jednotlivých Workerů, co Erwin volá — kdo co dělá a jestli běží</span></div>
      <form class="p-toolbar" method="post" action="/farm/self-test">
        <span class="meta">„OK" výš dokazuje jen, že proces odpovídá — self-test skutečně spustí <code>document.classify</code>/<code>document.validate</code> (na <code>apf-gateway</code>) i <code>document.stamp</code>/<code>document.archive</code> (na <code>apf-document-host</code>, přes síť) proti reálnému modelu a porovná s golden výsledkem${m.selfTestAt ? ` — naposledy proběhlo ${shortAt(m.selfTestAt)}` : " — ještě nikdy neproběhl"}</span>
        <span class="grow"></span>
        <button class="p-btn" type="submit">Spustit self-test</button>
      </form>
      ${kravickyCards}
    </div>

    <div id="view-ohrada" hidden>
      <div class="p-panehead">${ICONS.ohrada}<span>Ohrada</span><span class="n">${ohradaInstances.length} čeká na člověka</span></div>
      <div class="p-toolbar"><span class="meta">Instance, co čekají na rozhodnutí, nebo skončily s chybou, co si žádá pohled člověka — zde se nic samo neprovede. Stejný zdroj dat jako Poslední instance, jen vyfiltrovaný na ${esc("WAITING")}/${esc("FAILED")}/${esc("UNKNOWN_OUTCOME")}</span></div>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Krok</th><th>Capability</th><th class="c-state">Stav</th><th>Pokus</th><th>Výsledek</th></tr></thead>
        <tbody>${ohradaInstances.length ? ohradaRows : '<tr><td colspan="5" class="dim">prázdno — nic dnes nečeká na člověka</td></tr>'}</tbody>
      </table></div>
    </div>

    <div id="view-vysledek" hidden>
      <div class="p-panehead">${ICONS.vysledek}<span>Výsledek</span><span class="n">5 · ${m.instances.length} instancí</span></div>
      <div class="p-toolbar"><span class="meta">Výsledek se složí, uloží a zaznamená — statistika za celou dobu a poslední zpracované dokumenty</span></div>
      <div class="p-stats">
        <div class="p-stat"><b>${m.stats.totalProcessed}</b><span>zpracováno celkem</span></div>
        <div class="p-stat"><b>${m.stats.processedToday}</b><span>dnes</span></div>
        <div class="p-stat"><b>${formatDuration(m.stats.avgProcessingMs)}</b><span>průměrný čas zpracování</span></div>
      </div>
      ${
        m.stats.byType.length
          ? `<div class="p-toolbar"><span class="meta">Podle typu dokumentu (classify)</span></div>
      <div class="p-bars">${barChart(m.stats.byType)}</div>`
          : ""
      }
      <div class="p-panehead"><span>Poslední instance</span><span class="n">${m.instances.length}</span></div>
      <div class="p-toolbar"><span class="meta">Pohled na dokument: řádek se souborem a stavem, klikni pro rozbalení kroků (classify → validate → stamp)</span></div>
      <form class="p-toolbar" method="get" action="/farm#vysledek">
        <span class="meta">Zobrazit</span>
        <select name="limit" onchange="this.form.submit()">${[15, 30, 50, 100, 200].map((n) => `<option value="${n}"${n === m.instanceLimit ? " selected" : ""}>${n}</option>`).join("")}</select>
        <span class="meta">dokumentů</span>
        <span class="vsep"></span>
        <select name="window" onchange="this.form.submit()">${[
          ["", "celá historie"],
          ["24h", "posledních 24 h"],
          ["7d", "posledních 7 dní"],
          ["30d", "posledních 30 dní"],
        ]
          .map(([v, label]) => `<option value="${v}"${v === m.instanceWindow ? " selected" : ""}>${esc(label as string)}</option>`)
          .join("")}</select>
        <noscript><button class="p-btn" type="submit">Použít</button></noscript>
      </form>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Krok</th><th>Capability</th><th class="c-state">Stav</th><th>Pokus</th><th>Výsledek</th></tr></thead>
        <tbody>${m.instances.length ? instanceRows : '<tr><td colspan="5" class="dim">zatím žádná</td></tr>'}</tbody>
      </table></div>
    </div>

    <div id="view-denik" hidden>
      <div class="p-panehead">${ICONS.denik}<span>Audit — Deník</span><span class="n">posledních ${m.auditLog.length}</span></div>
      <div class="p-toolbar">
        <span class="meta">Živý terminál: syrový auditní záznam napříč celou farmou, jeden řádek = jedna událost, nejnovější dole (jako <code>tail -f</code>)</span>
        <span class="grow"></span>
        <button type="button" class="p-btn" id="denik-live-toggle" aria-pressed="true">⏸ Pozastavit</button>
      </div>
      <div class="p-term" id="denik-term" aria-live="polite">${terminalSeed}</div>
      <div class="p-toolbar"><span class="meta">Stejná data jako tabulka: nejnovější nahoře, pro dohledání konkrétní události</span></div>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th class="c-date">Čas</th><th>Druh</th><th>Instance</th><th>Capability</th><th>Detail</th></tr></thead>
        <tbody>${denikRows}</tbody>
      </table></div>
    </div>
  </main>

  <footer class="p-status">
    <span><b>${up}/${m.deployables.length}</b> Workerů</span>
    <span><b>${m.instances.length}</b> instancí</span>
    <span><b>${m.auditLog.length}</b> v deníku</span>
    <span><b>${m.inbox.pending.length}</b> v inboxu${m.inbox.failed.length ? ` <span class="dim">(${m.inbox.failed.length} selhalo)</span>` : ""}</span>
    <span class="grow"></span>
    <span>Farmář · ${esc(m.installation)}</span>
  </footer>
</div>`;

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farmář · ${esc(m.installation)}</title>
<style>
html,body{height:100%;margin:0}
.ui{height:100vh}
.ui a{color:inherit;text-decoration:none}
.ui a:hover:not(.p-navitem):not(.p-btn){text-decoration:underline}
.ui code{font-family:var(--font-data);background:var(--bordersoft);padding:.05em .35em;border-radius:4px;font-size:.92em}
.ui .p-titlebtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:0;border-radius:var(--radius);background:none;color:var(--dim);cursor:pointer}
.ui .p-titlebtn:hover{background:var(--hover);color:var(--text)}
.ui .p-table tbody td.wrap{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word;line-height:1.4;padding-top:8px;padding-bottom:8px}
.ui .p-table:has(tr.group-head) tbody tr:not(.group-head) td:first-child{padding-left:1.5rem}
.ui .gh-toggle{cursor:pointer}
.ui .gh-toggle:hover td{filter:brightness(0.97)}
.ui .gh-chevron{display:inline-block;width:.9em;transition:transform .15s}
.ui .gh-toggle[aria-expanded="true"] .gh-chevron{transform:rotate(90deg)}
.ui details{margin-top:3px}
.ui details summary{cursor:pointer;font-size:.85em;color:var(--dim)}
.ui details summary:hover{color:var(--text)}
.ui pre.wrap{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;font-size:.82em;max-width:100%;background:var(--bordersoft);padding:.5em .6em;border-radius:6px}
.ui .p-term{margin:0 14px 10px;height:22rem;overflow-y:auto;background:var(--chrome);border:var(--border-w) solid var(--border);border-radius:8px;padding:8px 10px;font-family:var(--font-data);font-size:var(--fs-data);line-height:1.6}
.ui .p-term .t-line{white-space:pre-wrap;word-break:break-word}
.ui .p-term .t-line.t-new{animation:term-flash 1.4s ease-out}
.ui .p-term .t-dim{color:var(--dim)}
@keyframes term-flash{from{background:var(--accsoft)}to{background:transparent}}
.ui .p-form{padding:0 14px 14px}
.ui .p-form label{display:block;font-weight:600;margin:.9rem 0 .3rem}
.ui .p-form textarea,.ui .p-form input[type=text],.ui .p-form select{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--radius);padding:.5rem;font:inherit;background:var(--pane);color:var(--text)}
.ui .p-form textarea{min-height:8rem;font-family:var(--font-data)}
.ui .p-form input[type=file]{margin-top:.2rem;max-width:100%}
.ui .p-form .p-btn{margin-top:1rem;border-color:var(--border)}
.ui .p-stats{display:flex;gap:1px;background:var(--border);border-bottom:var(--border-w) solid var(--border)}
.ui .p-stat{flex:1;background:var(--pane);padding:14px 16px;display:flex;flex-direction:column;gap:2px}
.ui .p-stat b{font-size:1.6rem;font-family:var(--font-display)}
.ui .p-stat span{color:var(--dim);font-size:calc(var(--fs-ui) - .5px)}
.ui .p-bars{padding:10px 14px 14px;background:var(--pane);border-bottom:var(--border-w) solid var(--border)}
.ui .p-bar-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.ui .p-bar-label{width:6rem;flex:none;font-size:.85em;color:var(--dim)}
.ui .p-bar-track{flex:1;height:14px;background:var(--bordersoft);border-radius:4px;overflow:hidden}
.ui .p-bar-fill{height:100%;background:var(--accent);border-radius:4px}
.ui .p-bar-count{width:2.5rem;flex:none;text-align:right;font:.85em var(--font-data)}
${BANK_UI_CSS}
${FARM_THEME_CSS}
</style>
</head><body>${bodyHtml}
<script>
(function () {
  var VIEWS = ["zadani", "erwin", "argos", "kravicky", "ohrada", "vysledek", "denik"];
  function applyView() {
    var v = (location.hash || "#zadani").slice(1);
    if (VIEWS.indexOf(v) === -1) v = "zadani";
    VIEWS.forEach(function (id) {
      var el = document.getElementById("view-" + id);
      if (el) el.hidden = id !== v;
    });
    document.querySelectorAll(".p-nav a[data-view]").forEach(function (a) {
      a.setAttribute("aria-current", a.dataset.view === v ? "true" : "false");
    });
  }
  window.addEventListener("hashchange", applyView);
  applyView();

  var ui = document.getElementById("ui");
  var rail = document.getElementById("railToggle");
  function setRail(on) {
    ui.dataset.layout = on ? "rail" : "side-nav";
    try { localStorage.setItem("farm-rail", on ? "1" : "0"); } catch (e) {}
  }
  if (rail) rail.addEventListener("click", function () { setRail(ui.dataset.layout !== "rail"); });
  try { if (localStorage.getItem("farm-rail") === "1") setRail(true); } catch (e) {}

  var clock = document.getElementById("clock");
  function tick() {
    if (clock) clock.textContent = new Date().toLocaleTimeString("cs-CZ");
  }
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

  // Deník live terminal (owner's request 2026-09-09: "vidět co se šustne"): poll /audit.json?after=<last>, append as
  // DOM nodes built with textContent (never innerHTML) — audit details can carry text lifted straight from an
  // untrusted document (F2), so this must never turn into an HTML-injection path into the operator's own console.
  var term = document.getElementById("denik-term");
  if (term) {
    var liveToggle = document.getElementById("denik-live-toggle");
    var live = true;
    var lastAt = term.lastElementChild ? term.lastElementChild.getAttribute("data-at") : null;
    function fmtTime(at) { return String(at || "").replace("T", " ").replace(/\.\d+Z$|Z$/, ""); }
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
})();
</script>
</body></html>`;
}

export function renderError(title: string, message: string, details: Record<string, unknown> = {}): string {
  const rows = Object.entries(details)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === "string" ? v : JSON.stringify(v))}</code></td></tr>`)
    .join("");
  return shell(
    title,
    `<header><h1>${esc(title)}</h1></header><div class="card err"><p>${esc(message)}</p>${rows ? `<table>${rows}</table>` : ""}</div><nav><a href="/">Zpět na formulář</a></nav>`,
  );
}

export interface SelfTestRow {
  capability: string;
  worker: string;
  id: string;
  kind: string;
  ok: boolean;
  skipped?: string;
  diff: string[];
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
  const rowHtml = (r: SelfTestRow): string =>
    `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.kind)}</td>${stateTd(r.skipped ? "SKIPPED" : r.ok ? "SUCCEEDED" : "FAILED")}<td class="wrap">${r.skipped ? esc(r.skipped) : r.diff.length ? `<pre class="wrap">${esc(r.diff.join("\n"))}</pre>` : "shoda s golden"}</td></tr>`;
  const capabilitySection = (cap: string, rs: SelfTestRow[]): string =>
    `<h3>${esc(cap)} <small class="muted">${rs.filter((r) => r.ok && !r.skipped).length}/${rs.filter((r) => !r.skipped).length}</small></h3>
<table><thead><tr><th>Fixture</th><th>Druh</th><th>Stav</th><th>Detail</th></tr></thead><tbody>${rs.map(rowHtml).join("")}</tbody></table>`;
  const sections = [...byWorker.entries()]
    .map(([worker, workerRows]) => {
      const byCapability = new Map<string, SelfTestRow[]>();
      for (const r of workerRows) byCapability.set(r.capability, [...(byCapability.get(r.capability) ?? []), r]);
      const n = workerRows.filter((r) => !r.skipped).length;
      const ok = workerRows.filter((r) => r.ok && !r.skipped).length;
      return `<h2>🐄 ${esc(worker)} <small class="muted">${ok}/${n} — kontrola opravdu proběhla přes tenhle Worker, ne jen odsud</small></h2>
${[...byCapability.entries()].map(([cap, rs]) => capabilitySection(cap, rs)).join("")}`;
    })
    .join("");
  return shell(
    "Self-test kravičky",
    `<header><h1>Self-test kravičky</h1><small>${ran.length - failed.length}/${ran.length} fixtures prošlo (${rows.length - ran.length} přeskočeno — vyžadují adapter chaos mode, jen Node testy)</small></header>${sections}<nav><a href="/farm#kravicky">Zpět na Kravičky</a></nav>`,
  );
}

const kb = (n: number | undefined): string => (n === undefined ? "?" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);

const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 1000) return "< 1 s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

/** No SVG, no JS, no chart library — CSS width bars, same "server-rendered evidence" ethos as the rest of /farm. */
const barChart = (rows: { type: string; count: number }[]): string => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows
    .map(
      (r) =>
        `<div class="p-bar-row"><span class="p-bar-label">${esc(r.type)}</span><div class="p-bar-track"><div class="p-bar-fill" style="width:${Math.round((r.count / max) * 100)}%"></div></div><span class="p-bar-count">${r.count}</span></div>`,
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
    ? `<p class="muted">Binární originál je uložen neměnně v R2 pod <code>${esc(a.location)}</code>; text z něj je v derivaci níže.</p>`
    : `<pre>${esc(a.bytes.slice(0, 2500))}${a.bytes.length > 2500 ? "\n…" : ""}</pre>`;
  return `<div class="card"><b>${esc(a.artifactId)}</b> <span class="muted">${kind}</span><br><small>${meta}</small>${body}</div>`;
};

const pick = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), o);

/** Raw JSON, but never dumped inline unwrapped — collapsed behind a toggle, wraps if opened. Used where a payload has no known human phrasing. */
const rawJson = (value: unknown, cap = 600): string => {
  const s = JSON.stringify(value ?? {});
  return `<details><summary class="dim">podrobnosti (JSON)</summary><pre class="wrap">${esc(s.length > cap ? `${s.slice(0, cap)}…` : s)}</pre></details>`;
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
  // Visual stamp is additive to document.stamp (owner's decision 2026-09-07): if the real stamp never succeeded
  // (still WAITING on review, or the flow ended before reaching it), there is nothing to show — don't offer a link
  // that can only 404.
  const stampSucceeded = lastOf("document.stamp")?.status === "SUCCEEDED";
  const stepCell = (capability: string, ok: (payload: Record<string, unknown>) => string): string => {
    const s = lastOf(capability);
    if (!s) return planned.size === 0 ? '<span class="muted">tok ještě nezačal</span>' : '<span class="muted">nedosaženo, tok skončil dřív</span>';
    if (s.status === "SUCCEEDED" && s.result?.payload) return ok(s.result.payload);
    if (s.status === "FAILED") return `<span class="badge FAILED">FAILED</span> <code>${esc(s.result?.error?.code ?? "")}</code> <small>${esc(s.result?.error?.message ?? "")}</small>`;
    if (s.status === "WAITING") return `<span class="badge WAITING">WAITING</span> ${esc(s.result?.waitReason ?? "")}`;
    return `<span class="badge ${esc(s.status)}">${esc(s.status)}</span>`;
  };
  const rows = [
    [
      "Vstup",
      original
        ? `${original.name ? `<b>${esc(original.name)}</b> · ` : ""}${esc(original.contentType ?? "text/plain")} · ${kb(original.byteLength ?? original.bytes.length)} · od <code>${esc(original.receivedFrom)}</code>${original.location ? ` · <a href="/workflow/${esc(v.workflowId)}/original" target="_blank" rel="noopener">zobrazit originál</a>` : ""}${original.location && stampSucceeded ? ` · <a href="/workflow/${esc(v.workflowId)}/original-stamped" target="_blank" rel="noopener">zobrazit vizuálně orazítkovaný originál</a>` : ""}`
        : '<span class="muted">žádný</span>',
    ],
    [
      "Text dokumentu",
      subject
        ? `${derived ? `vytěžen z originálu (<code>${esc(derived.producer)}</code>)` : "vložený text"}, ${subject.bytes.length} znaků<details><summary>zobrazit</summary><pre>${esc(subject.bytes.slice(0, 6000))}${subject.bytes.length > 6000 ? "\n…" : ""}</pre></details>`
        : '<span class="muted">žádný</span>',
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
    ["Stav toku", `<span class="badge ${esc(i.status)}">${esc(i.status)}</span> <small>${i.status === "SUCCEEDED" ? "všechny kroky proběhly" : i.status === "WAITING" ? `čeká na ${esc(i.waiting?.reason)}` : i.status === "FAILED" ? "tok skončil explicitně, viz kroky níže" : ""}</small>`],
  ];
  const reviewForm =
    i.status === "WAITING" && i.waiting?.reason === "REVIEW" && i.waiting.reviewTaskId
      ? `<div class="card">
      <h3>Rozhodnutí (review)</h3>
      <p class="muted">Úkol <code>${esc(i.waiting.reviewTaskId)}</code> čeká do <code>${esc(i.waiting.deadline)}</code>. Dřív tahle stránka jen zobrazovala, že se čeká — teď jde skutečně rozhodnout.</p>
      <form method="post" action="/workflow/${esc(v.workflowId)}/review/decide">
        <input type="hidden" name="reviewTaskId" value="${esc(i.waiting.reviewTaskId)}">
        <label for="correctedType">Opravený typ dokumentu (jen pro „Opravit a zopakovat")</label>
        <select id="correctedType" name="correctedType"><option value="">—</option><option>INVOICE</option><option>CONTRACT</option><option>OTHER</option></select>
        <div style="margin-top:.75rem;display:flex;gap:.5rem;flex-wrap:wrap">
          <button type="submit" name="decision" value="RECLASSIFY">Opravit a zopakovat</button>
          <button type="submit" name="decision" value="APPROVE" style="background:#166534">Schválit tak, jak je</button>
          <button type="submit" name="decision" value="REJECT" style="background:#991b1b">Zamítnout (ukončit)</button>
        </div>
      </form>
    </div>`
      : "";
  return `<h2>Výstup</h2><div class="card"><table>${rows.map(([k, val]) => `<tr><th style="width:14rem">${k}</th><td>${val}</td></tr>`).join("")}</table></div>${reviewForm}`;
};

/** Shared by the instance page and /farm's per-instance detail: one row per step, same columns both places. */
const stepsTable = (steps: Instance["steps"]): string =>
  `<table><tr><th>Krok</th><th>Stav</th><th>Pokus / logický</th><th>Výsledek</th></tr>${steps
    .map(
      (s) =>
        `<tr><td><b>${esc(s.stepId)}</b><br><small>${esc(s.capability)}/v${esc(s.capabilityVersion)}</small></td><td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td><td>${s.attempt} / ${s.logicalAttempt}<br><small>${esc(s.strategy)}</small></td><td>${fmtResult(s)}</td></tr>`,
    )
    .join("")}</table>`;

export function renderInstance(v: InstanceView): string {
  const i = v.instance;
  const audit = v.audit
    .map((r) => `<tr><td><small>${esc(r.at)}</small></td><td><code>${esc(r.kind)}</code></td><td><small>${esc(r.capability ?? "")}</small></td><td><small>${esc(JSON.stringify(r.details ?? {}))}</small></td></tr>`)
    .join("");
  return shell(
    `${i.workflow} ${v.workflowId}`,
    `<header><h1>Instance toku <code>${esc(i.workflow)}/v${esc(i.workflowVersion)}</code></h1><span class="badge ${esc(i.status)}">${esc(i.status)}</span></header>
<div class="card"><small>id <code>${esc(v.workflowId)}</code> · korelace <code>${esc(i.correlationId)}</code> · tenant <code>${esc(i.tenantId)}</code> · aktér <code>${esc(i.actorId)}</code> · založeno ${esc(i.createdAt)} · změněno ${esc(i.updatedAt)} · publikovaný stav <code>${esc(JSON.stringify(i.published))}</code>${i.waiting ? ` · čeká na <code>${esc(i.waiting.reason)}</code> do ${esc(i.waiting.deadline)}` : ""}</small></div>
${renderOutput(v)}
<h2>Kroky</h2><div class="card">${stepsTable(i.steps)}
<small class="muted">Krok, který skončil <code>DEPENDENCY_UNAVAILABLE</code>, narazil na část farmy, která ještě není zapojená; orchestrátor ho zkusil tolikrát, kolik dovoluje definice toku, a pak instanci explicitně ukončil.</small></div>
<h2>Artefakty</h2>${v.artifacts.map(artifactCard).join("") || '<div class="card muted">žádné</div>'}
<h2>Audit této instance</h2><div class="card"><table><tr><th>Čas</th><th>Druh</th><th>Capability</th><th>Detail</th></tr>${audit}</table></div>
<nav><a href="/">Nový dokument</a><a href="/workflow/${esc(v.workflowId)}.json">JSON</a><a href="/audit.json">Společný audit (D1)</a></nav>
<form method="post" action="/workflow/${esc(v.workflowId)}/purge" onsubmit="return confirm('Smazat instanci včetně originálu a derivací? Ve společném auditu zůstane záznam PURGED.')"><input type="hidden" name="reason" value="owner request from instance page"><button type="submit" style="background:#991b1b;margin-top:1.5rem">Smazat instanci (originál, derivace, objekt)</button></form>`,
  );
}
