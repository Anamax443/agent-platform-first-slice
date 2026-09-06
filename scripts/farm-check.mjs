#!/usr/bin/env node
// Validates every farm deployable without touching Cloudflare: `wrangler deploy --dry-run` over the base configs (code,
// identical for every installation) and over the configs generated per installation by scripts/farm-config.mjs
// (code + config/<installation>/farm.json). Catches config errors, missing binding shapes and bundling errors before
// anyone logs in. A dry run needs neither a login nor an account id, so nothing account-bound lives in this script.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployables, generateFarmConfigs, installationsWithFarm } from "./farm-config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const farm = join(root, "deploy", "cloudflare");

const base = deployables();
const targets = base.map((d) => ({ label: d, config: join(farm, d, "wrangler.jsonc"), outdir: join(root, ".wrangler", "dry-run", "base", d) }));
const installations = installationsWithFarm();
for (const installation of installations) {
  for (const file of generateFarmConfigs(installation)) {
    const d = basename(dirname(file));
    targets.push({ label: `${installation}/${d}`, config: file, outdir: join(root, ".wrangler", "dry-run", installation, d) });
  }
}

let failed = 0;
for (const t of targets) {
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "--dry-run", "--outdir", t.outdir, "-c", t.config], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${t.label}`);
  if (!ok) console.log((r.stdout + r.stderr).split("\n").filter((l) => /error|Error|✘/.test(l)).join("\n"));
}
const summary = `${targets.length} configs (${base.length} base + ${targets.length - base.length} generated for ${installations.join(", ") || "no installation"})`;
console.log(failed ? `farm-check: ${failed} of ${summary} failed` : `farm-check: ${summary} OK`);
process.exit(failed ? 1 : 0);
