#!/usr/bin/env node
// Regenerates the COW catalog cards on kravy.html (full catalog) and index.html (homepage preview) from
// docs/cow-catalog.json at the repo root — that's the platform's own source of truth for what's actually
// live vs. planned vs. future; this site must not invent or duplicate that judgment by hand. This site is
// deployed independently (plain `wrangler deploy` from this directory, see wrangler.jsonc) but lives inside
// this repo specifically so this generator can read that file with a plain relative path, not a cross-repo one.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const catalogPath = path.resolve(root, "../../../docs/cow-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const PILL = {
  live: '<span class="pill secure">živý základ</span>',
  plan: '<span class="pill plan">plánovaná capability</span>',
  future: '<span class="pill plan">budoucí</span>',
};

// Card shows a status pill on every card, always — a future/plan COW is fine to show (it's honestly labeled),
// inventing one nowhere in the catalog or hiding the label would not be (owner 2026-09-10: no fabricated
// numbers/claims anywhere on this site, the same rule that killed the fake -70%/99%/200+ stats section).
const catalogCard = (cow) =>
  `<article class="card cow-card"><div class="cow-head"><div class="cow-emoji">${cow.emoji}</div><span class="tag">${cow.tag}</span><span class="cow-icon-badge">${cow.icon}</span></div><div class="cow-body"><h3>${cow.title}</h3><p>${cow.description}</p><div class="cow-meta">${PILL[cow.status]}</div></div></article>`;

function replaceBetweenMarkers(html, marker, replacement) {
  const start = `<!-- COW-CATALOG:START ${marker} -->`;
  const end = `<!-- COW-CATALOG:END ${marker} -->`;
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1) throw new Error(`markers ${marker} not found`);
  return html.slice(0, startIdx + start.length) + replacement + html.slice(endIdx);
}

const cardsHtml = catalog.map(catalogCard).join("\n");

// kravy.html: the full catalog. index.html: same cards, same order — the homepage teaser used to filter out
// "future" cows, but the status pill already says what's live/planned/future honestly, so hiding rows added
// nothing; showing the whole catalog (owner's later reference design also does this) is simpler and matches.
const kravyPath = path.join(root, "kravy.html");
writeFileSync(kravyPath, replaceBetweenMarkers(readFileSync(kravyPath, "utf8"), "full", cardsHtml), "utf8");

const indexPath = path.join(root, "index.html");
writeFileSync(indexPath, replaceBetweenMarkers(readFileSync(indexPath, "utf8"), "home", cardsHtml), "utf8");

console.log(`cow-catalog: ${catalog.length} entries from ${catalogPath}`);
console.log(`  kravy.html: ${catalog.length} cards`);
console.log(`  index.html: ${catalog.length} cards`);
