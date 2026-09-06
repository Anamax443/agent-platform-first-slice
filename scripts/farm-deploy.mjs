#!/usr/bin/env node
// Deploys one installation from its generated configs (scripts/farm-config.mjs), in dependency order:
// fakes -> document-host -> email-executor -> mail-ingest -> gateway (a service binding needs its target to exist).
// The gateway and the hosts bind each other, so a first deployment needs two passes: `--bootstrap` deploys every Worker
// once without `services`, then the full configs go out. Nothing account-bound lives here; it all comes from
// config/<installation>/ and the wrangler login. Usage: node scripts/farm-deploy.mjs <installation> [--bootstrap] [--dry-run]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFarmConfigs } from "./farm-config.mjs";

const ORDER = ["apf-fakes", "apf-document-host", "apf-email-executor", "apf-mail-ingest", "apf-gateway"];
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const installation = args.find((a) => !a.startsWith("--"));
if (!installation) {
  console.error("usage: node scripts/farm-deploy.mjs <installation> [--bootstrap] [--dry-run]");
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
const bootstrap = args.includes("--bootstrap");

const byName = new Map(generateFarmConfigs(installation).map((f) => [basename(dirname(f)), f]));
const targets = [...ORDER.filter((d) => byName.has(d)), ...[...byName.keys()].filter((d) => !ORDER.includes(d))];

function deploy(configFile, label) {
  const extra = dryRun ? ["--dry-run", "--outdir", join(root, ".wrangler", "dry-run", installation, label.split(" ")[0])] : [];
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "-c", configFile, ...extra], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const lines = `${r.stdout}${r.stderr}`.split("\n").filter((l) => /Uploaded|Deployed|Current Version|https?:\/\/|error|Error|✘|WARNING|custom domain|Custom Domain/i.test(l));
  console.log(`--- ${label}`);
  for (const l of lines) console.log(l.trimEnd());
  if (r.status !== 0) {
    console.error(`farm-deploy: ${label} FAILED`);
    console.error(`${r.stdout}${r.stderr}`.split("\n").slice(-30).join("\n"));
    process.exit(r.status ?? 1);
  }
}

if (bootstrap) {
  for (const d of targets) {
    const cfg = JSON.parse(readFileSync(byName.get(d), "utf8"));
    delete cfg.services;
    const file = join(dirname(byName.get(d)), "wrangler.bootstrap.jsonc");
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    deploy(file, `${d} bootstrap (without service bindings)`);
  }
}
for (const d of targets) deploy(byName.get(d), d);
console.log(`farm-deploy: ${installation} ${dryRun ? "dry-run OK" : "deployed"} (${targets.join(" -> ")})`);
