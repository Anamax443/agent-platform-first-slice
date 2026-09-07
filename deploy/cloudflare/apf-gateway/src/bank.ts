// Verbatim copy of Anamax443/Interface-Par bank/ui.css + bank/tokens/style/saas-modern.css (2026-09-07), the owner's
// own design-system catalog. Generated there by scripts/build-bank.mjs — do not hand-edit; re-copy from Interface-Par
// if that style changes. fonts.css (vendored Inter/Cascadia Mono woff2) is deliberately NOT vendored here: this is a
// single-operator internal ops page, and the token stack already falls back to "Segoe UI Variable Text"/"Segoe UI" —
// close enough to Inter on the one Windows machine that will ever open this page. Say so if that stops being true.

export const BANK_UI_CSS = String.raw`
.ui {
    --border-w:1px;
    --pane:var(--l-pane); --chrome:var(--l-chrome); --chromehi:var(--l-chromehi);
    --head:var(--l-head); --zebra:var(--l-zebra); --hover:var(--l-hover);
    --border:var(--l-border); --bordersoft:var(--l-bordersoft);
    --text:var(--l-text); --dim:var(--l-dim); --faint:var(--l-faint);
    --accent:var(--l-accent); --accsoft:var(--l-accsoft); --accfg:var(--l-accfg);
    --ok:var(--l-ok); --warn:var(--l-warn); --crit:var(--l-crit);
  }
@media (prefers-color-scheme: dark) {
  .ui {
      --pane:var(--d-pane); --chrome:var(--d-chrome); --chromehi:var(--d-chromehi);
      --head:var(--d-head); --zebra:var(--d-zebra); --hover:var(--d-hover);
      --border:var(--d-border); --bordersoft:var(--d-bordersoft);
      --text:var(--d-text); --dim:var(--d-dim); --faint:var(--d-faint);
      --accent:var(--d-accent); --accsoft:var(--d-accsoft); --accfg:var(--d-accfg);
      --ok:var(--d-ok); --warn:var(--d-warn); --crit:var(--d-crit);
    }
}
:root[data-theme="light"] .ui {
    --pane:var(--l-pane); --chrome:var(--l-chrome); --chromehi:var(--l-chromehi);
    --head:var(--l-head); --zebra:var(--l-zebra); --hover:var(--l-hover);
    --border:var(--l-border); --bordersoft:var(--l-bordersoft);
    --text:var(--l-text); --dim:var(--l-dim); --faint:var(--l-faint);
    --accent:var(--l-accent); --accsoft:var(--l-accsoft); --accfg:var(--l-accfg);
    --ok:var(--l-ok); --warn:var(--l-warn); --crit:var(--l-crit);
  }
:root[data-theme="dark"] .ui {
    --pane:var(--d-pane); --chrome:var(--d-chrome); --chromehi:var(--d-chromehi);
    --head:var(--d-head); --zebra:var(--d-zebra); --hover:var(--d-hover);
    --border:var(--d-border); --bordersoft:var(--d-bordersoft);
    --text:var(--d-text); --dim:var(--d-dim); --faint:var(--d-faint);
    --accent:var(--d-accent); --accsoft:var(--d-accsoft); --accfg:var(--d-accfg);
    --ok:var(--d-ok); --warn:var(--d-warn); --crit:var(--d-crit);
  }
.ui { --viz-1:#2a78d6; --viz-2:#eb6834; --viz-pos:#2a78d6; --viz-neg:#e34948; }
@media (prefers-color-scheme: dark) {
  .ui { --viz-1:#3987e5; --viz-2:#d95926; --viz-pos:#3987e5; --viz-neg:#e66767; }
}
:root[data-theme="light"] .ui { --viz-1:#2a78d6; --viz-2:#eb6834; --viz-pos:#2a78d6; --viz-neg:#e34948; }
:root[data-theme="dark"] .ui { --viz-1:#3987e5; --viz-2:#d95926; --viz-pos:#3987e5; --viz-neg:#e66767; }
.ui {
    min-height: 240px;
    display: grid;
    grid-template-columns: 186px 1fr;
    grid-template-rows: var(--title-h) 1fr var(--status-h);
    grid-template-areas: "t t" "n m" "s s";
    background: var(--chrome);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--fs-ui);
    line-height: 1.35;
  }
.ui .icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.ui .icon-sm { width: 13px; height: 13px; }
.ui .p-title {
    grid-area: t;
    display: flex; align-items: center; gap: 9px;
    padding: 0 11px;
    background: var(--chromehi);
    border-bottom: var(--border-w) solid var(--border);
  }
.ui .p-brand {
    display: flex; align-items: center; gap: 7px;
    font-family: var(--font-display);
    font-weight: 650;
  }
.ui .p-brand .mark {
    width: 15px; height: 15px; flex: none;
    border: 1.5px solid var(--accent);
    border-radius: var(--radius);
    position: relative;
  }
.ui .p-brand .mark::after {
    content: ""; position: absolute; inset: 3px 3px auto 3px;
    height: 1.5px; background: var(--accent); box-shadow: 0 3px 0 var(--accent);
  }
.ui .p-brand .sub { color: var(--dim); font-weight: 400; }
.ui .p-title .vsep { width: 1px; align-self: stretch; margin: 7px 1px; background: var(--border); }
.ui .p-title .grow { flex: 1; }
.ui .p-field {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--pane);
    color: var(--dim);
    font-size: calc(var(--fs-ui) - .5px);
  }
.ui .p-nav {
    grid-area: n;
    background: var(--chrome);
    border-right: var(--border-w) solid var(--border);
    padding: 5px 6px;
    overflow-y: auto;
  }
.ui .p-navitem {
    display: flex; align-items: center; gap: 9px;
    width: 100%; height: var(--nav-h);
    padding: 0 8px;
    border: 0; border-radius: var(--nav-radius);
    background: none; color: var(--text);
    font: inherit; text-align: left; cursor: default;
    white-space: nowrap; overflow: hidden;
  }
.ui .p-navitem .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui .p-navitem:hover { background: var(--hover); }
.ui .p-navitem .icon { color: var(--dim); }
.ui .p-navitem[aria-current="true"] {
    background: var(--accsoft);
    box-shadow: inset var(--sel-bar) 0 0 var(--accent);
    font-weight: 650;
  }
.ui .p-navitem[aria-current="true"] .icon { color: var(--accent); }
.ui .p-navsec {
    padding: 12px 8px 4px;
    font-size: 10px; letter-spacing: .6px; text-transform: uppercase;
    color: var(--faint);
  }
.ui .p-main { grid-area: m; display: flex; flex-direction: column; min-width: 0; background: var(--pane); overflow-y: auto; }
.ui .p-panehead {
    display: flex; align-items: center; gap: 8px;
    height: var(--panehead-h); padding: 0 11px;
    background: var(--accsoft);
    border-bottom: var(--border-w) solid var(--border);
    font-family: var(--font-display);
    font-weight: 650;
  }
.ui .p-panehead .icon { color: var(--accent); }
.ui .p-panehead .n { margin-left: auto; font-weight: 400; color: var(--dim); font-family: var(--font-ui); font-size: calc(var(--fs-ui) - .5px); }
.ui .p-toolbar {
    display: flex; align-items: center; gap: 8px;
    height: var(--tb-h); padding: 0 8px;
    background: var(--chromehi);
    border-bottom: var(--border-w) solid var(--border);
    overflow-x: auto;
  }
.ui .p-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border: 1px solid transparent; border-radius: var(--radius);
    background: none; color: var(--text); font: inherit; white-space: nowrap; cursor: default;
    box-shadow: var(--pane-shadow);
  }
.ui .p-btn:hover { background: var(--pane); border-color: var(--border); }
.ui .p-btn .icon { color: var(--accent); }
.ui .p-toolbar .meta { color: var(--dim); font-size: calc(var(--fs-ui) - .5px); white-space: nowrap; }
.ui .p-toolbar .vsep { width: 1px; height: 15px; background: var(--border); flex: none; }
.ui .p-gridwrap { overflow: auto; }
.ui .p-table { border-collapse: collapse; width: 100%; min-width: 880px; }
.ui .p-table thead th {
    position: sticky; top: 0; z-index: 3;
    height: calc(var(--row-h) + 2px);
    padding: 0 10px;
    background: var(--head);
    border-bottom: var(--border-w) solid var(--border);
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: var(--fs-th);
    font-weight: var(--th-weight);
    letter-spacing: var(--th-ls);
    text-transform: var(--th-transform);
    text-align: left; white-space: nowrap;
  }
.ui .p-table tbody td {
    height: var(--row-h);
    padding: 0 10px;
    border-bottom: var(--border-w) solid var(--bordersoft);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
.ui .p-table tbody tr:nth-child(even) td { background: var(--zebra); }
.ui .p-table tbody tr:hover td { background: var(--hover); }
.ui .p-table tbody tr[data-sel="true"] td { background: var(--accsoft); }
.ui .p-table tbody tr[data-sel="true"] td:first-child { box-shadow: inset var(--sel-bar) 0 0 var(--accent); }
.ui .p-table tbody tr.group-head td { background: var(--head); white-space: normal; font-weight: 650; height: auto; padding: 7px 10px; }
.ui .c-date { font-family: var(--font-data); font-size: var(--fs-data); color: var(--dim); width: 148px; }
.ui .c-amt { font-family: var(--font-data); font-size: var(--fs-data); text-align: right; width: 108px; font-variant-numeric: tabular-nums; font-weight: 600; }
.ui .c-vs { font-family: var(--font-data); font-size: var(--fs-data); width: 108px; color: var(--dim); }
.ui .c-to { width: 168px; }
.ui .c-state { width: 148px; }
.ui th.c-amt { text-align: right; }
.ui .p-state { display: inline-flex; align-items: center; }
.ui .p-dot {
    display: inline-block; width: 7px; height: 7px; flex: none;
    margin-right: 7px; border-radius: var(--dot-radius);
    background: var(--faint);
  }
.ui .st-ok  .p-dot { background: var(--ok); }
.ui .st-warn .p-dot { background: var(--warn); }
.ui .st-crit .p-dot { background: var(--crit); }
.ui .st-man .p-dot { background: var(--accent); }
.ui .dim { color: var(--dim); }
.ui .p-status {
    grid-area: s;
    display: flex; align-items: center;
    padding: 0 11px;
    background: var(--chromehi);
    border-top: var(--border-w) solid var(--border);
    color: var(--dim);
    font-size: calc(var(--fs-ui) - 1px);
  }
.ui .p-status > span { padding: 0 10px; border-right: var(--border-w) solid var(--border); }
.ui .p-status > span:first-child { padding-left: 0; }
.ui .p-status > span:last-child { border-right: 0; }
.ui .p-status b { color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
.ui .p-status .grow { flex: 1; border-right: 0; }
.ui [hidden] { display: none !important; }
`;

export const BANK_SAAS_MODERN_CSS = String.raw`
.ui[data-style="saas-modern"], .ui {
    --l-pane:#ffffff; --l-chrome:#f8fafc; --l-chromehi:#ffffff; --l-head:#f8fafc;
    --l-zebra:#ffffff; --l-hover:#f1f5f9; --l-border:#e2e8f0; --l-bordersoft:#f1f5f9;
    --l-text:#0f172a; --l-dim:#64748b; --l-faint:#94a3b8;
    --l-accent:#6366f1; --l-accsoft:#eef2ff; --l-accfg:#ffffff;
    --l-ok:#16a34a; --l-warn:#d97706; --l-crit:#dc2626;

    --d-pane:#0f172a; --d-chrome:#020617; --d-chromehi:#0f172a; --d-head:#1e293b;
    --d-zebra:#0f172a; --d-hover:#1e293b; --d-border:#1e293b; --d-bordersoft:#1e293b;
    --d-text:#f1f5f9; --d-dim:#94a3b8; --d-faint:#64748b;
    --d-accent:#818cf8; --d-accsoft:#1e1b4b; --d-accfg:#0f172a;
    --d-ok:#4ade80; --d-warn:#fbbf24; --d-crit:#f87171;

    --radius:8px; --nav-radius:8px; --sel-bar:0px;
    --row-h:44px; --title-h:56px; --tb-h:52px; --panehead-h:44px; --status-h:34px;
    --font-ui:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
    --font-display:var(--font-ui);
    --font-data:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
    --fs-ui:14px; --fs-data:13.5px; --fs-th:12.5px;
    --th-transform:none; --th-ls:0; --th-weight:500;
    --nav-h:38px; --pane-shadow:0 1px 3px rgba(15,23,42,.1); --dot-radius:50%;
  }

.ui[data-style="saas-modern"] .p-state {
    padding: 3px 10px 3px 9px;
    border-radius: 999px;
    background: var(--accsoft);
    border: 1px solid var(--bordersoft);
    font-size: calc(var(--fs-ui) - 1.5px);
    font-weight: 500;
  }
.ui[data-style="saas-modern"] .p-btn {
    background: var(--accent);
    color: var(--accfg);
    border-color: transparent;
    padding: 8px 16px;
    font-weight: 500;
    box-shadow: var(--pane-shadow);
  }
.ui[data-style="saas-modern"] .p-btn .icon { color: currentColor; }
.ui[data-style="saas-modern"] .p-btn:hover { filter: brightness(1.1); }
.ui[data-style="saas-modern"] .p-field { border-radius: 999px; padding: 4px 12px; }
`;
