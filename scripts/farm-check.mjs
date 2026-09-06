#!/usr/bin/env node
// Validates every deployable of every installation without touching Cloudflare: scripts/farm-config.mjs binds the code
// to each config/<installation>/, then `wrangler deploy --dry-run` bundles each generated config. Catches config errors,
// missing binding shapes, an unresolvable installation module and bundling errors before anyone logs in. A dry run
// needs neither a login nor an account id, so nothing account-bound lives in this script.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployables, generateFarmConfigs, installations } from "./farm-config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const names = installations();
const targets = [];
for (const installation of names) {
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
const summary = `${targets.length} configs (${names.length} installations: ${names.join(", ") || "none"} × ${deployables().length} deployables)`;
console.log(failed ? `farm-check: ${failed} of ${summary} failed` : `farm-check: ${summary} OK`);
process.exit(failed ? 1 : 0);
