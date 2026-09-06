#!/usr/bin/env node
// Validates every farm deployable without touching Cloudflare: `wrangler deploy --dry-run` per wrangler.jsonc.
// Catches config errors, missing bindings shapes and bundling errors before anyone logs in.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const farm = join(root, "deploy", "cloudflare");
const deployables = readdirSync(farm).filter((d) => statSync(join(farm, d)).isDirectory() && d.startsWith("apf-"));

let failed = 0;
for (const d of deployables) {
  const config = join(farm, d, "wrangler.jsonc");
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(root, ".wrangler", "dry-run", d), "-c", config], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "a37a36270aa2db7382f62912ba5a0130" },
  });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${d}`);
  if (!ok) console.log((r.stdout + r.stderr).split("\n").filter((l) => /error|Error|✘/.test(l)).join("\n"));
}
console.log(failed ? `farm-check: ${failed} of ${deployables.length} deployables failed` : `farm-check: ${deployables.length} deployables OK`);
process.exit(failed ? 1 : 0);
