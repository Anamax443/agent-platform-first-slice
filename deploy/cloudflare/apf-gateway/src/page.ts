// Server-rendered pages of the gateway (behind Cloudflare Access): a form to hand a document to a workflow and the view of
// one workflow instance. No external assets, no scripts: the page is evidence, not an app. Czech labels for the owner.
import type { Artifact } from "../../../../src/platform/artifacts.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import type { Instance } from "../../../../src/platform/journal.js";

export interface Wired {
  intake: boolean;
  journal: string;
  audit: string;
  artifacts: string;
  dispatch: boolean;
  hosts: boolean;
  accessJwtVerified: boolean;
}

export interface HomeModel {
  installation: string;
  user: string;
  workflows: string[];
  wired: Wired;
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
.card{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:1rem 1.25rem;margin:.75rem 0}
label{display:block;font-weight:600;margin:.75rem 0 .25rem}textarea,input[type=text],select{width:100%;box-sizing:border-box;border:1px solid #c5ccd5;border-radius:6px;padding:.5rem;font:inherit}
textarea{min-height:12rem;font-family:ui-monospace,Consolas,monospace}button{margin-top:1rem;background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font:inherit;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;vertical-align:top;padding:.4rem .5rem;border-bottom:1px solid #e6e9ee}th{color:#5b6472;font-weight:600}
.badge{display:inline-block;padding:.1em .55em;border-radius:999px;font-size:.8rem;font-weight:700;background:#e5e7eb}
.SUCCEEDED{background:#dcfce7;color:#166534}.FAILED{background:#fee2e2;color:#991b1b}.WAITING{background:#fef3c7;color:#92400e}.RUNNING,.PENDING{background:#dbeafe;color:#1e40af}.UNKNOWN_OUTCOME,.CANCELLED{background:#ede9fe;color:#5b21b6}
.wired li{margin:.15rem 0}.ok::before{content:"● ";color:#16a34a}.no::before{content:"● ";color:#dc2626}pre{white-space:pre-wrap;word-break:break-word;background:#f3f4f6;padding:.75rem;border-radius:6px;max-height:20rem;overflow:auto;font-size:.85rem}
nav a{margin-right:1rem}
`;

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

const wiredList = (w: Wired): string => {
  const row = (ok: boolean, label: string, detail: string) => `<li class="${ok ? "ok" : "no"}">${esc(label)} <small>${esc(detail)}</small></li>`;
  return `<ul class="wired">${[
    row(w.intake, "příjem dokumentu (formulář, R2 originál)", "hotovo"),
    row(true, "journal instance", w.journal),
    row(true, "audit", w.audit),
    row(true, "artefakty", w.artifacts),
    row(w.dispatch, "dispatch: router, podpis obálky, classify a validate", w.dispatch ? "zapojeno" : "zatím ne: každý krok toku skončí DEPENDENCY_UNAVAILABLE"),
    row(w.hosts, "hosty: document-host (stamp, archive), fakes", w.hosts ? "zapojeno" : "zatím ne"),
    row(w.accessJwtVerified, "ověření Access JWT ve Workeru", w.accessJwtVerified ? "ano" : "zatím jen hlavička od Access"),
  ].join("")}</ul>`;
};

export function renderHome(m: HomeModel): string {
  const options = m.workflows.map((w) => `<option value="${esc(w)}"${w === "document-intake" ? " selected" : ""}>${esc(w)}</option>`).join("");
  return shell(
    `apf · ${m.installation}`,
    `<header><h1>agent-platform-first-slice · farma <code>${esc(m.installation)}</code></h1><small>${esc(m.user)}</small></header>
<div class="card"><form method="post" action="/intake" enctype="multipart/form-data">
<label for="text">Text dokumentu (faktura, smlouva, e-mail…)</label>
<textarea id="text" name="text" placeholder="Vlož text, nebo níže nahraj textový soubor."></textarea>
<label for="file">Nebo soubor (txt, md, eml; do 1 MB)</label>
<input id="file" type="file" name="file" accept=".txt,.md,.eml,text/plain,message/rfc822">
<label for="workflow">Tok</label>
<select id="workflow" name="workflow">${options}</select>
<label for="stampText">Text razítka (nepovinné)</label>
<input id="stampText" type="text" name="stampText" placeholder="VALIDATED INVOICE">
<button type="submit">Odeslat do toku</button>
</form></div>
<h2>Co je na farmě zapojené</h2><div class="card">${wiredList(m.wired)}</div>
<nav><a href="/version">/version</a><a href="/audit.json">/audit.json</a></nav>`,
  );
}

const fmtResult = (s: Instance["steps"][number]): string => {
  const r = s.result;
  if (!r) return "";
  if (r.error) return `<code>${esc(r.error.code)}</code> <small>${esc(r.error.class)}${r.error.retryable ? ", retryable" : ""}</small><br><small>${esc(r.error.message)}</small>`;
  if (r.status === "WAITING") return `čeká: ${esc(r.waitReason ?? "")}${r.reviewTaskId ? ` <code>${esc(r.reviewTaskId)}</code>` : ""}`;
  if (r.payload) return `<code>${esc(JSON.stringify(r.payload).slice(0, 400))}</code>`;
  return esc(r.status);
};

export function renderInstance(v: InstanceView): string {
  const i = v.instance;
  const steps = i.steps
    .map(
      (s) =>
        `<tr><td><b>${esc(s.stepId)}</b><br><small>${esc(s.capability)}/v${esc(s.capabilityVersion)}</small></td><td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td><td>${s.attempt} / ${s.logicalAttempt}<br><small>${esc(s.strategy)}</small></td><td>${fmtResult(s)}</td></tr>`,
    )
    .join("");
  const artifacts = v.artifacts
    .map(
      (a) =>
        `<div class="card"><b>${esc(a.artifactId)}</b> <span class="muted">${a.derivedFrom ? `derivace z ${esc(a.derivedFrom)} (${esc(a.producer)})` : "originál"}</span><br>
<small>sha256 <code>${esc(a.sha256)}</code> · ${a.bytes.length} znaků · přijato ${esc(a.receivedAt)} od <code>${esc(a.receivedFrom)}</code> · tenant <code>${esc(a.tenantId)}</code></small>
<pre>${esc(a.bytes.slice(0, 1500))}${a.bytes.length > 1500 ? "\n…" : ""}</pre></div>`,
    )
    .join("");
  const audit = v.audit
    .map((r) => `<tr><td><small>${esc(r.at)}</small></td><td><code>${esc(r.kind)}</code></td><td><small>${esc(r.capability ?? "")}</small></td><td><small>${esc(JSON.stringify(r.details ?? {}))}</small></td></tr>`)
    .join("");
  return shell(
    `${i.workflow} ${v.workflowId}`,
    `<header><h1>Instance toku <code>${esc(i.workflow)}/v${esc(i.workflowVersion)}</code></h1><span class="badge ${esc(i.status)}">${esc(i.status)}</span></header>
<div class="card"><small>id <code>${esc(v.workflowId)}</code> · korelace <code>${esc(i.correlationId)}</code> · tenant <code>${esc(i.tenantId)}</code> · aktér <code>${esc(i.actorId)}</code> · založeno ${esc(i.createdAt)} · změněno ${esc(i.updatedAt)} · publikovaný stav <code>${esc(JSON.stringify(i.published))}</code>${i.waiting ? ` · čeká na <code>${esc(i.waiting.reason)}</code> do ${esc(i.waiting.deadline)}` : ""}</small></div>
<h2>Kroky</h2><div class="card"><table><tr><th>Krok</th><th>Stav</th><th>Pokus / logický</th><th>Výsledek</th></tr>${steps}</table>
<small class="muted">Krok, který skončil <code>DEPENDENCY_UNAVAILABLE</code>, narazil na část farmy, která ještě není zapojená; orchestrátor ho zkusil tolikrát, kolik dovoluje definice toku, a pak instanci explicitně ukončil.</small></div>
<h2>Artefakty</h2>${artifacts || '<div class="card muted">žádné</div>'}
<h2>Audit této instance</h2><div class="card"><table><tr><th>Čas</th><th>Druh</th><th>Capability</th><th>Detail</th></tr>${audit}</table></div>
<nav><a href="/">Nový dokument</a><a href="/workflow/${esc(v.workflowId)}.json">JSON</a><a href="/audit.json">Společný audit (D1)</a></nav>`,
  );
}
