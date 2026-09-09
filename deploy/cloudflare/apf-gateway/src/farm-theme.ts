// Farm theme for /farm (docs/POSUDKY.md Posudek 7 + owner's "AI FARMA" illustration, 2026-09-09): the same
// token contract as bank.ts's BANK_SAAS_MODERN_CSS (--l-*/--d-* names bank.ts's BANK_UI_CSS reads), a warm
// farm palette instead of the vendored Interface-Par indigo. bank.ts stays untouched (it is a verbatim,
// re-copyable vendor file) — this is a sibling "style", the same way Interface-Par itself carries more than
// one named style, applied via data-style="farm" instead of "saas-modern".
export const FARM_THEME_CSS = String.raw`
.ui[data-style="farm"], .ui {
    --l-pane:#fffdf7; --l-chrome:#f6efdd; --l-chromehi:#fdf9ee; --l-head:#f2e9d2;
    --l-zebra:#fffdf7; --l-hover:#f3ecd7; --l-border:#e3d5ac; --l-bordersoft:#eee3c4;
    --l-text:#2c2415; --l-dim:#7a6a45; --l-faint:#a5936a;
    --l-accent:#a6462a; --l-accsoft:#f6e2d2; --l-accfg:#fffaf3;
    --l-ok:#3f7d32; --l-warn:#b8790f; --l-crit:#b3341f;

    --d-pane:#221b12; --d-chrome:#17120b; --d-chromehi:#221b12; --d-head:#2c2416;
    --d-zebra:#221b12; --d-hover:#2c2416; --d-border:#3a2f1c; --d-bordersoft:#2c2416;
    --d-text:#f3ecd9; --d-dim:#b9a97e; --d-faint:#8a7a54;
    --d-accent:#e08055; --d-accsoft:#3a2416; --d-accfg:#221b12;
    --d-ok:#6cbb5a; --d-warn:#e0a53d; --d-crit:#e2665a;

    --radius:9px; --nav-radius:9px; --sel-bar:3px;
    --row-h:44px; --title-h:56px; --tb-h:52px; --panehead-h:44px; --status-h:34px;
    --font-ui:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
    --font-display:Georgia,"Iowan Old Style","Palatino Linotype",serif;
    --font-data:"Cascadia Mono","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
    --fs-ui:14px; --fs-data:13.5px; --fs-th:12px;
    --th-transform:uppercase; --th-ls:.4px; --th-weight:600;
    --nav-h:38px; --pane-shadow:0 1px 2px rgba(44,36,21,.12); --dot-radius:50%;
  }

.ui[data-style="farm"] .p-title { background: var(--l-accent); color: var(--l-accfg); border-bottom-color: var(--l-accent); }
@media (prefers-color-scheme: dark) { .ui[data-style="farm"] .p-title { background: var(--d-chromehi); color: var(--d-text); border-bottom-color: var(--d-border); } }
:root[data-theme="dark"] .ui[data-style="farm"] .p-title { background: var(--d-chromehi); color: var(--d-text); border-bottom-color: var(--d-border); }
.ui[data-style="farm"] .p-title .p-field { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.28); color: inherit; }
.ui[data-style="farm"] .p-brand .mark { border-color: currentColor; }
.ui[data-style="farm"] .p-brand .mark::after { background: currentColor; box-shadow: 0 3px 0 currentColor; }
.ui[data-style="farm"] .p-panehead { font-family: var(--font-display); font-size: 1.05em; letter-spacing: .2px; }
.ui[data-style="farm"] .p-state {
    padding: 3px 10px 3px 9px;
    border-radius: 999px;
    background: var(--accsoft);
    border: 1px solid var(--bordersoft);
    font-size: calc(var(--fs-ui) - 1.5px);
    font-weight: 600;
  }
.ui[data-style="farm"] .p-btn {
    background: var(--accent);
    color: var(--accfg);
    border-color: transparent;
    padding: 8px 16px;
    font-weight: 600;
    box-shadow: var(--pane-shadow);
  }
.ui[data-style="farm"] .p-btn .icon { color: currentColor; }
.ui[data-style="farm"] .p-btn:hover { filter: brightness(1.08); }
.ui[data-style="farm"] .p-field { border-radius: 999px; padding: 4px 12px; }
.ui[data-style="farm"] .p-table tbody tr.pen-head td {
    background: var(--head);
    font-family: var(--font-display);
    font-weight: 650;
    color: var(--dim);
  }
.ui[data-style="farm"] .p-table tbody tr.pen-head .icon { color: var(--accent); vertical-align: -3px; margin-right: 6px; }
.ui[data-style="farm"] .pen-empty { padding: 26px 14px; text-align: center; color: var(--dim); }

/* Cards, not tables (owner's request 2026-09-09: the farm illustration groups agents into pens, not rows of a
   grid). Kravičky/Kapability use these; Ohrada/Poslední instance/Deník stay tabular — that data is chronological
   or drill-down, not a herd to look at. */
.ui[data-style="farm"] .p-cardsec { padding: 14px 14px 4px; }
.ui[data-style="farm"] .p-cardsec-label { font-family: var(--font-display); font-weight: 650; color: var(--dim); margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
.ui[data-style="farm"] .p-cardsec-label .icon { color: var(--accent); }
.ui[data-style="farm"] .p-cardgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-bottom: 6px; }
.ui[data-style="farm"] .p-card {
    background: var(--pane);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 4px);
    padding: 12px 14px;
    box-shadow: var(--pane-shadow);
  }
.ui[data-style="farm"] .p-card.st-crit-card { border-color: var(--crit); }
.ui[data-style="farm"] .p-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 650; }
.ui[data-style="farm"] .p-card-head code { background: none; padding: 0; font-size: 1em; }
.ui[data-style="farm"] .p-card-role { color: var(--dim); font-size: calc(var(--fs-ui) - 1px); margin-top: 4px; line-height: 1.4; }
.ui[data-style="farm"] .p-card-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 8px; font-size: calc(var(--fs-ui) - 1.5px); color: var(--dim); }
.ui[data-style="farm"] .p-card-meta b { color: var(--text); font-weight: 600; }
.ui[data-style="farm"] .pen {
    border: 2px dashed var(--border);
    border-radius: calc(var(--radius) + 8px);
    padding: 12px 12px 4px;
    margin: 0 14px 14px;
    background: var(--chromehi);
  }
.ui[data-style="farm"] .pen-label { display: flex; align-items: center; gap: 7px; font-family: var(--font-display); font-weight: 650; margin-bottom: 10px; }
.ui[data-style="farm"] .pen-label .icon { color: var(--accent); }
.ui[data-style="farm"] .pen .p-cardgrid { margin-bottom: 6px; }

/* The owner's own "AI FARMA" concept art, top of Přehled — a fixed R2 asset, not generated. */
.ui[data-style="farm"] .p-hero { display: block; width: 100%; max-height: 260px; object-fit: cover; object-position: center 30%; border-bottom: var(--border-w) solid var(--border); }
`;
