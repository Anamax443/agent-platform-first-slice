#!/usr/bin/env node
// Generates per-installation wrangler configs: deploy/cloudflare/<deployable>/wrangler.jsonc (code, identical for every
// installation) merged with config/<installation>/farm.json (routes, vars, ids bound to one account and zone).
// Output: .wrangler/generated/<installation>/<deployable>/wrangler.jsonc (git-ignored). Deploy and dry-run from there.
// Usage: node scripts/farm-config.mjs [installation ...]   (default: every config/*/farm.json)

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const farmDir = join(repoRoot, "deploy", "cloudflare");

/** Objects merge key by key, arrays and scalars from the overlay replace the base value. */
export function merge(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay) || typeof base !== "object" || typeof overlay !== "object" || base === null || overlay === null) return overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

export function installationsWithFarm(configDir = join(repoRoot, "config")) {
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir).filter((d) => statSync(join(configDir, d)).isDirectory() && existsSync(join(configDir, d, "farm.json")));
}

export function deployables() {
  return readdirSync(farmDir).filter((d) => statSync(join(farmDir, d)).isDirectory() && existsSync(join(farmDir, d, "wrangler.jsonc")));
}

/** Writes one config per deployable and returns their paths. A deployable named in farm.json must exist; one not named gets the base as is. */
export function generateFarmConfigs(installation, root = repoRoot) {
  const farmFile = join(root, "config", installation, "farm.json");
  if (!existsSync(farmFile)) throw new Error(`config/${installation}/farm.json does not exist`);
  const overlay = JSON.parse(readFileSync(farmFile, "utf8"));
  const known = deployables();
  for (const name of Object.keys(overlay)) {
    if (name.startsWith("$")) continue;
    if (!known.includes(name)) throw new Error(`config/${installation}/farm.json names ${name}, but deploy/cloudflare/${name}/wrangler.jsonc does not exist`);
  }
  const written = [];
  for (const d of known) {
    const baseFile = join(farmDir, d, "wrangler.jsonc");
    const base = parseJsonc(readFileSync(baseFile, "utf8"));
    const merged = merge(base, overlay[d] ?? {});
    const targetDir = join(root, ".wrangler", "generated", installation, d);
    mkdirSync(targetDir, { recursive: true });
    // Paths in a wrangler config are relative to the config file; the generated file lives elsewhere than the source.
    delete merged.$schema;
    if (typeof base.main === "string") merged.main = relative(targetDir, join(dirname(baseFile), base.main)).split("\\").join("/");
    const target = join(targetDir, "wrangler.jsonc");
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
    written.push(target);
  }
  return written;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : installationsWithFarm();
  if (!names.length) {
    console.log("farm-config: no config/*/farm.json, nothing to generate");
  }
  for (const name of names) {
    for (const file of generateFarmConfigs(name)) console.log(`generated ${relative(repoRoot, file)}`);
  }
}
