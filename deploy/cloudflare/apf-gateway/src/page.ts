// Server-rendered pages of the gateway (behind Cloudflare Access): a form to hand a document to a workflow and the view of
// one workflow instance. No external assets, no scripts: the page is evidence, not an app. Czech labels for the owner.
import type { Artifact } from "../../../../src/platform/artifacts.js";
import type { AuditRecord } from "../../../../src/platform/audit.js";
import type { Instance } from "../../../../src/platform/journal.js";

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

export interface FarmInstanceRow {
  workflowId: string;
  tenantId: string | null;
  at: string;
  kind: string;
  capability: string | null;
  status?: string;
}

export interface FarmModel {
  installation: string;
  gatewaySigning: string;
  deployables: DeployableStatus[];
  instances: FarmInstanceRow[];
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

/** Known badge colors from the CSS (see .SUCCEEDED/.FAILED/… above); anything else (a "kind (capability)" fallback for a not-yet-terminal instance) gets the neutral "in progress" color. */
const KNOWN_STATUS_BADGES = new Set(["SUCCEEDED", "FAILED", "WAITING", "RUNNING", "PENDING", "UNKNOWN_OUTCOME", "CANCELLED"]);
const badgeClassFor = (status: string | undefined, kind: string): string => status ?? (KNOWN_STATUS_BADGES.has(kind) ? kind : "PENDING");

/** Farmář (přehled farmy nahoře) + kravičky (pět Workerů farmy) + poslední instance na jedné stránce. */
export function renderFarm(m: FarmModel): string {
  const up = m.deployables.filter((d) => d.ok).length;
  const counts = new Map<string, number>();
  for (const i of m.instances) {
    const key = i.status ?? `${i.kind}${i.capability ? ` (${i.capability})` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const farmar = `<div class="card"><b>Farmář</b> — souhrn farmy <code>${esc(m.installation)}</code><br>
Workery: <span class="badge ${up === m.deployables.length ? "SUCCEEDED" : "FAILED"}">${up}/${m.deployables.length} OK</span> ·
podpis <code>${esc(m.gatewaySigning)}</code> · posledních ${m.instances.length} instancí:
${[...counts.entries()].map(([k, n]) => `<span class="badge ${badgeClassFor(KNOWN_STATUS_BADGES.has(k) ? k : undefined, k)}">${esc(k)} × ${n}</span>`).join(" ")}
</div>`;

  const kravicky = m.deployables
    .map((d) => {
      const b = (d.body ?? {}) as Record<string, unknown>;
      const caps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).join(", ") : undefined;
      return `<tr><td><b>${esc(d.name)}</b></td><td><span class="badge ${d.ok ? "SUCCEEDED" : "FAILED"}">${d.ok ? "OK" : "DOWN"}</span> <small>HTTP ${d.status || "—"}</small></td><td><small>${esc(b.isolation ?? "")}</small></td><td><small>${caps ? esc(caps) : b.wired === false ? "not wired" : b.error ? esc(String(b.error)) : ""}</small></td></tr>`;
    })
    .join("");

  const instances = m.instances
    .map((i) => {
      const cls = badgeClassFor(i.status, i.kind);
      const label = i.status ?? `${i.kind}${i.capability ? ` · ${i.capability}` : ""}`;
      return `<tr><td><a href="/workflow/${esc(i.workflowId)}">${esc(i.workflowId)}</a></td><td><code>${esc(i.tenantId ?? "—")}</code></td><td><span class="badge ${esc(cls)}">${esc(label)}</span></td><td><small>${esc(i.at)}</small></td></tr>`;
    })
    .join("");

  return shell(
    `Farmář · ${m.installation}`,
    `<header><h1>Farmář · farma <code>${esc(m.installation)}</code></h1></header>
${farmar}
<h2>Kravičky</h2><div class="card"><table><tr><th>Worker</th><th>Stav</th><th>Isolation</th><th>Detail</th></tr>${kravicky}</table></div>
<h2>Poslední instance</h2><div class="card">${
      m.instances.length
        ? `<table><tr><th>Instance</th><th>Tenant</th><th>Stav</th><th>Poslední aktivita</th></tr>${instances}</table>`
        : '<span class="muted">zatím žádná</span>'
    }</div>
<nav><a href="/">Nový dokument</a><a href="/audit.json">Společný audit (D1)</a></nav>`,
  );
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

export function renderInstance(v: InstanceView): string {
  const i = v.instance;
  const steps = i.steps
    .map(
      (s) =>
        `<tr><td><b>${esc(s.stepId)}</b><br><small>${esc(s.capability)}/v${esc(s.capabilityVersion)}</small></td><td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td><td>${s.attempt} / ${s.logicalAttempt}<br><small>${esc(s.strategy)}</small></td><td>${fmtResult(s)}</td></tr>`,
    )
    .join("");
  const audit = v.audit
    .map((r) => `<tr><td><small>${esc(r.at)}</small></td><td><code>${esc(r.kind)}</code></td><td><small>${esc(r.capability ?? "")}</small></td><td><small>${esc(JSON.stringify(r.details ?? {}))}</small></td></tr>`)
    .join("");
  return shell(
    `${i.workflow} ${v.workflowId}`,
    `<header><h1>Instance toku <code>${esc(i.workflow)}/v${esc(i.workflowVersion)}</code></h1><span class="badge ${esc(i.status)}">${esc(i.status)}</span></header>
<div class="card"><small>id <code>${esc(v.workflowId)}</code> · korelace <code>${esc(i.correlationId)}</code> · tenant <code>${esc(i.tenantId)}</code> · aktér <code>${esc(i.actorId)}</code> · založeno ${esc(i.createdAt)} · změněno ${esc(i.updatedAt)} · publikovaný stav <code>${esc(JSON.stringify(i.published))}</code>${i.waiting ? ` · čeká na <code>${esc(i.waiting.reason)}</code> do ${esc(i.waiting.deadline)}` : ""}</small></div>
${renderOutput(v)}
<h2>Kroky</h2><div class="card"><table><tr><th>Krok</th><th>Stav</th><th>Pokus / logický</th><th>Výsledek</th></tr>${steps}</table>
<small class="muted">Krok, který skončil <code>DEPENDENCY_UNAVAILABLE</code>, narazil na část farmy, která ještě není zapojená; orchestrátor ho zkusil tolikrát, kolik dovoluje definice toku, a pak instanci explicitně ukončil.</small></div>
<h2>Artefakty</h2>${v.artifacts.map(artifactCard).join("") || '<div class="card muted">žádné</div>'}
<h2>Audit této instance</h2><div class="card"><table><tr><th>Čas</th><th>Druh</th><th>Capability</th><th>Detail</th></tr>${audit}</table></div>
<nav><a href="/">Nový dokument</a><a href="/workflow/${esc(v.workflowId)}.json">JSON</a><a href="/audit.json">Společný audit (D1)</a></nav>
<form method="post" action="/workflow/${esc(v.workflowId)}/purge" onsubmit="return confirm('Smazat instanci včetně originálu a derivací? Ve společném auditu zůstane záznam PURGED.')"><input type="hidden" name="reason" value="owner request from instance page"><button type="submit" style="background:#991b1b;margin-top:1.5rem">Smazat instanci (originál, derivace, objekt)</button></form>`,
  );
}
