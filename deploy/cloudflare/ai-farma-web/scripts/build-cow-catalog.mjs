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

const catalogCard = (cow) =>
  `<article class="card cow-card"><div class="cow-head"><div class="cow-emoji">${cow.emoji}</div><span class="tag">${cow.tag}</span></div><div class="cow-body"><h3>${cow.title}</h3><p>${cow.description}</p><div class="cow-meta">${PILL[cow.status]}</div></div></article>`;

const homeCard = (cow) =>
  `<article class="card cow-card"><div class="cow-head"><div class="cow-emoji">${cow.emoji}</div><span class="tag">${cow.tag}</span></div><div class="cow-body"><h3>${cow.title}</h3><p>${cow.description}</p><div class="cow-meta">${PILL[cow.status]}${cow.status === "live" ? '<span class="pill">audit</span>' : ""}</div></div></article>`;

function replaceBetweenMarkers(html, marker, replacement) {
  const start = `<!-- COW-CATALOG:START ${marker} -->`;
  const end = `<!-- COW-CATALOG:END ${marker} -->`;
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1) throw new Error(`markers ${marker} not found`);
  return html.slice(0, startIdx + start.length) + replacement + html.slice(endIdx);
}

// kravy.html: the full catalog, in catalog order.
const kravyPath = path.join(root, "kravy.html");
const kravyHtml = readFileSync(kravyPath, "utf8");
writeFileSync(kravyPath, replaceBetweenMarkers(kravyHtml, "full", catalog.map(catalogCard).join("\n")), "utf8");

// index.html: homepage teaser — only cows with a real status claim (live/plan), never the purely aspirational ones.
const indexPath = path.join(root, "index.html");
const indexHtml = readFileSync(indexPath, "utf8");
const teaser = catalog.filter((c) => c.status !== "future");
writeFileSync(indexPath, replaceBetweenMarkers(indexHtml, "home", teaser.map(homeCard).join("\n")), "utf8");

console.log(`cow-catalog: ${catalog.length} entries from ${catalogPath}`);
console.log(`  kravy.html: ${catalog.length} cards`);
console.log(`  index.html: ${teaser.length} cards (live/plan only)`);
