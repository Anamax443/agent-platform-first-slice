// Server-rendered pages of the gateway (behind Cloudflare Access): a form to hand a document to a workflow and the view of
// one workflow instance. No external assets, no scripts: the page is evidence, not an app. Czech labels for the owner.
import type { Artifact } from "../../../../src/platform/artifacts.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import type { Instance } from "../../../../src/platform/journal.js";
import { BANK_SAAS_MODERN_CSS, BANK_UI_CSS } from "./bank.js";

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

export interface FarmModel {
  installation: string;
  gatewaySigning: string;
  deployables: DeployableStatus[];
  instances: FarmInstanceRow[];
  auditLog: AuditLogRow[];
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
<nav><a href="/farm">Farmář</a><a href="/version">/version</a><a href="/audit.json">/audit.json</a></nav>`,
  );
}

/** State label → bank status class (docs/UI/predpis-saas-modern-side-nav.txt §8: "stav nese barvu i slovo", nikdy jen barva). */
const STATE_CLASS: Record<string, string> = {
  OK: "st-ok",
  SUCCEEDED: "st-ok",
  DOWN: "st-crit",
  FAILED: "st-crit",
  WAITING: "st-warn",
  UNKNOWN_OUTCOME: "st-warn",
  CANCELLED: "st-warn",
  RUNNING: "st-man",
  PENDING: "st-man",
};
const stateBadge = (label: string): string => `<span class="${STATE_CLASS[label] ?? ""}"><span class="p-state"><span class="p-dot"></span>${esc(label)}</span></span>`;
const stateTd = (label: string): string => `<td class="c-state">${stateBadge(label)}</td>`;

/**
 * Farmář na banku Interface-Par (Anamax443/Interface-Par, styl saas-modern, rozvržení side-nav — viz
 * docs/UI/predpis-saas-modern-side-nav.txt). Vlastní stránka, ne shell() — jiný vizuální jazyk než zbytek gatewaye.
 * Přehled + kravičky (pět Workerů) + poslední instance (seskupené kroky) + deník (sdílený audit, D1) na jedné stránce.
 */
export function renderFarm(m: FarmModel): string {
  const up = m.deployables.filter((d) => d.ok).length;

  const kravickyRows = m.deployables
    .map((d) => {
      const b = (d.body ?? {}) as Record<string, unknown>;
      const caps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).join(", ") : undefined;
      const detail = caps ?? (b.wired === false ? "not wired" : b.error ? String(b.error) : "");
      return `<tr><td><b>${esc(d.name)}</b></td>${stateTd(d.ok ? "OK" : "DOWN")}<td>${esc(b.isolation ?? "")}</td><td class="dim">${esc(detail)}</td></tr>`;
    })
    .join("");

  const instanceRows = m.instances
    .map((i) => {
      if (i.purged) return `<tr class="group-head"><td colspan="5"><a href="/workflow/${esc(i.workflowId)}">${esc(i.workflowId)}</a> — smazáno (PURGED), poslední audit ${esc(i.at)}</td></tr>`;
      const head = `<tr class="group-head"><td colspan="5"><a href="/workflow/${esc(i.workflowId)}">${esc(i.workflowId)}</a> · ${esc(i.workflow)}/v${esc(i.workflowVersion)} · tenant ${esc(i.tenantId)} · aktér ${esc(i.actorId)} · ${stateBadge(i.status)} · založeno ${esc(i.createdAt)}, změněno ${esc(i.updatedAt)}</td></tr>`;
      const steps = i.steps
        .map((s) => `<tr><td>${esc(s.stepId)}</td><td>${esc(s.capability)}/v${esc(s.capabilityVersion)}</td>${stateTd(s.status)}<td>${s.attempt} / ${s.logicalAttempt} <span class="dim">${esc(s.strategy)}</span></td><td>${fmtResult(s)}</td></tr>`)
        .join("");
      return head + steps;
    })
    .join("");

  const denikRows = m.auditLog
    .map((r) => {
      const link = r.workflowId ? `<a href="/workflow/${esc(r.workflowId)}">${esc(r.workflowId)}</a>` : "—";
      const detail = JSON.stringify(r.details ?? {});
      return `<tr><td class="c-date">${esc(r.at)}</td><td>${esc(r.kind)}</td><td>${link}</td><td>${esc(r.capability ?? "")}</td><td><code>${esc(detail.length > 200 ? `${detail.slice(0, 200)}…` : detail)}</code></td></tr>`;
    })
    .join("");

  const icon = (paths: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    menu: icon('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
    prehled: icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    kravicky: icon('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>'),
    instance: icon('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>'),
    denik: icon('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>'),
    novy: icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    json: icon('<polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/>'),
  };

  const bodyHtml = `<div class="ui" id="ui" data-layout="side-nav" data-style="saas-modern">
  <div class="p-title">
    <button type="button" class="p-titlebtn" id="railToggle" title="Sbalit/rozbalit menu" aria-label="Sbalit/rozbalit menu">${ICONS.menu}</button>
    <span class="p-brand"><span class="mark"></span>Farmář<span class="sub">— farma ${esc(m.installation)}</span></span>
    <span class="vsep"></span>
    <span class="p-field">podpis ${esc(m.gatewaySigning)}</span>
    <span class="grow"></span>
    <span class="p-field">${up}/${m.deployables.length} Workerů OK</span>
  </div>

  <nav class="p-nav">
    <a class="p-navitem" href="#prehled" data-view="prehled" title="Přehled">${ICONS.prehled}<span class="lbl">Přehled</span></a>
    <a class="p-navitem" href="#kravicky" data-view="kravicky" title="Kravičky">${ICONS.kravicky}<span class="lbl">Kravičky</span></a>
    <a class="p-navitem" href="#instance" data-view="instance" title="Poslední instance">${ICONS.instance}<span class="lbl">Poslední instance</span></a>
    <a class="p-navitem" href="#denik" data-view="denik" title="Deník">${ICONS.denik}<span class="lbl">Deník</span></a>
    <div class="p-navsec">Farma</div>
    <a class="p-navitem" href="/" title="Nový dokument">${ICONS.novy}<span class="lbl">Nový dokument</span></a>
    <a class="p-navitem" href="/audit.json" title="/audit.json">${ICONS.json}<span class="lbl">/audit.json</span></a>
  </nav>

  <main class="p-main">
    <div id="view-prehled">
      <div class="p-panehead"><span>Přehled</span><span class="n">farma ${esc(m.installation)}</span></div>
      <div class="p-toolbar">
        <span class="meta">instalace ${esc(m.installation)}</span>
        <span class="vsep"></span>
        <span class="meta">podpis ${esc(m.gatewaySigning)}</span>
        <span class="vsep"></span>
        <span class="meta">${up}/${m.deployables.length} Workerů OK · ${m.instances.length} instancí · ${m.auditLog.length} v deníku</span>
        <span class="grow"></span>
        <a class="p-btn" href="/">Nový dokument</a>
      </div>
    </div>

    <div id="view-kravicky" hidden>
      <div class="p-panehead"><span>Kravičky</span><span class="n">${m.deployables.length} Workerů</span></div>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Worker</th><th class="c-state">Stav</th><th>Isolation</th><th>Detail</th></tr></thead>
        <tbody>${kravickyRows}</tbody>
      </table></div>
    </div>

    <div id="view-instance" hidden>
      <div class="p-panehead"><span>Poslední instance</span><span class="n">${m.instances.length}</span></div>
      <div class="p-gridwrap"><table class="p-table">
        <thead><tr><th>Krok</th><th>Capability</th><th class="c-state">Stav</th><th>Pokus</th><th>Výsledek</th></tr></thead>
        <tbody>${m.instances.length ? instanceRows : '<tr><td colspan="5" class="dim">zatím žádná</td></tr>'}</tbody>
      </table></div>
    </div>

    <div id="view-denik" hidden>
      <div class="p-panehead"><span>Deník</span><span class="n">posledních ${m.auditLog.length}</span></div>
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
${BANK_UI_CSS}
${BANK_SAAS_MODERN_CSS}
</style>
</head><body>${bodyHtml}
<script>
(function () {
  var VIEWS = ["prehled", "kravicky", "instance", "denik"];
  function applyView() {
    var v = (location.hash || "#prehled").slice(1);
    if (VIEWS.indexOf(v) === -1) v = "prehled";
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

const kb = (n: number | undefined): string => (n === undefined ? "?" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);

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

/** What the flow produced so far, in the owner's words: input, text, type, validation, stamp, notification, state. */
const renderOutput = (v: InstanceView): string => {
  const i = v.instance;
  const original = v.artifacts.find((a) => !a.derivedFrom);
  const derived = v.artifacts.find((a) => a.derivedFrom);
  const subject = v.artifacts.find((a) => a.artifactId === i.input.artifactId) ?? derived ?? original;
  const lastOf = (capability: string) => [...i.steps].reverse().find((s) => s.capability === capability);
  const planned = new Set(i.steps.map((s) => s.capability));
  const stepCell = (capability: string, ok: (payload: Record<string, unknown>) => string): string => {
    const s = lastOf(capability);
    if (!s) return planned.size === 0 ? '<span class="muted">tok ještě nezačal</span>' : '<span class="muted">nedosaženo, tok skončil dřív</span>';
    if (s.status === "SUCCEEDED" && s.result?.payload) return ok(s.result.payload);
    if (s.status === "FAILED") return `<span class="badge FAILED">FAILED</span> <code>${esc(s.result?.error?.code ?? "")}</code> <small>${esc(s.result?.error?.message ?? "")}</small>`;
    if (s.status === "WAITING") return `<span class="badge WAITING">WAITING</span> ${esc(s.result?.waitReason ?? "")}`;
    return `<span class="badge ${esc(s.status)}">${esc(s.status)}</span>`;
  };
  const rows = [
    ["Vstup", original ? `${esc(original.contentType ?? "text/plain")} · ${kb(original.byteLength ?? original.bytes.length)} · od <code>${esc(original.receivedFrom)}</code>` : '<span class="muted">žádný</span>'],
    [
      "Text dokumentu",
      subject
        ? `${derived ? `vytěžen z originálu (<code>${esc(derived.producer)}</code>)` : "vložený text"}, ${subject.bytes.length} znaků<details><summary>zobrazit</summary><pre>${esc(subject.bytes.slice(0, 6000))}${subject.bytes.length > 6000 ? "\n…" : ""}</pre></details>`
        : '<span class="muted">žádný</span>',
    ],
    ["Typ dokumentu (classify)", stepCell("document.classify", (p) => `<b>${esc(pick(p, "documentType", "value"))}</b> <small>zdroj ${esc(pick(p, "documentType", "source"))}, jistota ${esc(pick(p, "documentType", "confidence"))}</small>`)],
    ["Validace (validate)", stepCell("document.validate", (p) => `<b>${esc(pick(p, "documentType", "validation", "status"))}</b> <small>${esc(pick(p, "documentType", "validation", "provider"))}, razítko ${pick(p, "stampAllowed") ? "povoleno" : "zamítnuto"}</small>`)],
    ["Razítko (stamp)", stepCell("document.stamp", (p) => `<b>${esc(pick(p, "stampText"))}</b> <small>DMS <code>${esc(pick(p, "dmsRef"))}</code>, orazítkovaný artefakt <code>${esc(pick(p, "stampedArtifactId"))}</code></small>`)],
    ...(i.workflow === "mail-intake" ? [["Notifikace (email.send)", stepCell("email.send", (p) => `<b>odesláno</b> <small>příjemce <code>${esc(pick(p, "recipientRef"))}</code>, id <code>${esc(pick(p, "smtpMessageId"))}</code></small>`)]] : []),
    ["Stav toku", `<span class="badge ${esc(i.status)}">${esc(i.status)}</span> <small>${i.status === "SUCCEEDED" ? "všechny kroky proběhly" : i.status === "WAITING" ? `čeká na ${esc(i.waiting?.reason)}` : i.status === "FAILED" ? "tok skončil explicitně, viz kroky níže" : ""}</small>`],
  ];
  return `<h2>Výstup</h2><div class="card"><table>${rows.map(([k, val]) => `<tr><th style="width:14rem">${k}</th><td>${val}</td></tr>`).join("")}</table></div>`;
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
