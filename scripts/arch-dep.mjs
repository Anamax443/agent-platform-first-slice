#!/usr/bin/env node
// ARCH-DEP-001 (FOUNDATION-core F3) + clock lint (VERIFICATION-CONTRACT §8.1) + installation-value lint (owner rule
// 6. 9. 2026, docs/NAVRHOVY-LIST-farma.md "Instalační profil"):
//   - a component may import only its own directory, platform/api and adapter contracts; nothing from node:*;
//   - platform logic never reads the system clock directly;
//   - no value bound to an installation (tenant, actor id, channel address, host, recipient) and no e-mail address or
//     public hostname appears as a literal in src/**, deploy/cloudflare/*/src/** or a base wrangler.jsonc. Those values
//     live in config/<installation>/; the code must be identical for every installation.
// Usage: node scripts/arch-dep.mjs [srcDir]   (exit 1 on any violation; without srcDir checks src, the farm sources and configs)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const IMPORT = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm;
const CLOCK_EXEMPT = new Set(["platform/clock.ts", "platform/ids.ts"]);
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const HOSTNAME = /(?:^|[^A-Za-z0-9.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cz|sk|com|org|net|eu|io|dev|app|de|at|pl|uk|info)(?![A-Za-z0-9.-])/;

/** Every value bound to an installation, read from config/<installation>/profile.json and policy/*.json. value -> origin. */
export function installationValues(configDir = join(repoRoot, "config")) {
  const values = new Map();
  const add = (v, where) => {
    if (typeof v === "string" && v.length >= 3 && !values.has(v)) values.set(v, where);
  };
  if (!existsSync(configDir)) return values;
  for (const name of readdirSync(configDir)) {
    const dir = join(configDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const profileFile = join(dir, "profile.json");
    if (existsSync(profileFile)) {
      const p = JSON.parse(readFileSync(profileFile, "utf8"));
      add(p.installation, `${name}/profile.json installation`);
      for (const t of p.tenants ?? []) add(t, `${name}/profile.json tenants`);
      for (const i of p.identities ?? []) add(i.actorId, `${name}/profile.json identities`);
      for (const [k, v] of Object.entries(p.channels ?? {})) add(v, `${name}/profile.json channels.${k}`);
    }
    const policyDir = join(dir, "policy");
    if (!existsSync(policyDir)) continue;
    for (const f of readdirSync(policyDir).filter((x) => x.endsWith(".json"))) {
      const pol = JSON.parse(readFileSync(join(policyDir, f), "utf8"));
      for (const g of pol.grants ?? []) add(g.actorId, `${name}/policy/${f} grants`);
      for (const [tenant, refs] of Object.entries(pol.recipientAllowlist ?? {})) {
        add(tenant, `${name}/policy/${f} recipientAllowlist`);
        for (const [ref, address] of Object.entries(refs)) {
          add(ref, `${name}/policy/${f} recipientAllowlist ref`);
          add(address, `${name}/policy/${f} recipientAllowlist address`);
        }
      }
    }
  }
  return values;
}

/** One finding per literal: an installation value wins over the generic e-mail / hostname patterns. */
function literalFinding(text, values) {
  for (const [v, where] of values) if (text.includes(v)) return `installation value "${v}" (${where})`;
  if (EMAIL.test(text)) return "e-mail address";
  if (HOSTNAME.test(text)) return "public hostname";
  return undefined;
}

function* jsonStrings(value, path = "$") {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) yield* jsonStrings(value[i], `${path}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* jsonStrings(v, `${path}.${k}`);
}

/** Pure check over one file. Returns violations as strings; empty means clean. */
export function checkFile(relPath, source, values = new Map()) {
  const p = relPath.split(sep).join("/");
  const out = [];

  if (p.endsWith(".json")) {
    for (const [path, text] of jsonStrings(JSON.parse(source))) {
      const f = literalFinding(text, values);
      if (f) out.push(`${p}: ${path} carries ${f}; installation values belong to config/<installation>/`);
    }
    return out;
  }

  const inComponent = p.startsWith("components/");
  const inPlatform = p.startsWith("platform/");
  const inAdapters = p.startsWith("adapters/");

  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1];
    if (inComponent) {
      const ok = spec.startsWith("./") || spec === "../../platform/api.js" || /^\.\.\/\.\.\/adapters\/[a-z-]+\.js$/.test(spec);
      if (!ok) out.push(`${p}: forbidden import "${spec}" (components may import ./, platform/api, adapters/*; no node:*)`);
    } else if (inAdapters) {
      const ok = spec.startsWith("./") || spec === "../platform/errors.js" || spec.startsWith("node:");
      if (!ok) out.push(`${p}: adapter imports "${spec}" (adapters know platform/errors only)`);
    } else if (inPlatform) {
      if (spec.startsWith("../components/") || spec.startsWith("../adapters/")) out.push(`${p}: platform imports component or adapter "${spec}"`);
    }
  }

  const lines = source.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    if ((inComponent || inPlatform) && !CLOCK_EXEMPT.has(p)) {
      if (/\bDate\.now\s*\(/.test(line) || /\bnew\s+Date\s*\(\s*\)/.test(line)) out.push(`${p}:${i + 1}: direct system clock (inject Clock instead, VC §8.1)`);
    }
    for (const lit of line.match(STRING_LITERAL) ?? []) {
      const f = literalFinding(lit.slice(1, -1), values);
      if (f) out.push(`${p}:${i + 1}: literal ${lit} is ${f}; installation values belong to config/<installation>/`);
    }
  });
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".ts") || name.endsWith(".json")) yield full;
  }
}

export function checkTree(srcDir, values = new Map()) {
  const violations = [];
  for (const file of walk(srcDir)) violations.push(...checkFile(relative(srcDir, file), readFileSync(file, "utf8"), values));
  return violations;
}

/** Base wrangler configs are code: no routes (they come from config/<installation>/farm.json) and no installation literal. */
export function checkWranglerConfigs(farmDir, values = new Map()) {
  const out = [];
  if (!existsSync(farmDir)) return out;
  for (const d of readdirSync(farmDir)) {
    const file = join(farmDir, d, "wrangler.jsonc");
    if (!existsSync(file)) continue;
    const cfg = parseJsonc(readFileSync(file, "utf8"));
    const p = `deploy/cloudflare/${d}/wrangler.jsonc`;
    if ("routes" in cfg || "route" in cfg) out.push(`${p}: routes belong to config/<installation>/farm.json, not to the base config`);
    for (const [path, text] of jsonStrings(cfg)) {
      const f = literalFinding(text, values);
      if (f) out.push(`${p}: ${path} carries ${f}; put it in config/<installation>/farm.json`);
    }
  }
  return out;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const values = installationValues();
  const explicit = process.argv[2];
  const farmDir = join(repoRoot, "deploy", "cloudflare");
  const trees = explicit
    ? [explicit]
    : [join(repoRoot, "src"), ...(existsSync(farmDir) ? readdirSync(farmDir).map((d) => join(farmDir, d, "src")).filter((d) => existsSync(d)) : [])];
  const violations = trees.flatMap((t) => checkTree(t, values));
  if (!explicit) violations.push(...checkWranglerConfigs(farmDir, values));
  if (violations.length) {
    console.error(`ARCH-DEP-001 FAILED (${violations.length}):`);
    for (const v of violations) console.error("  " + v);
    process.exit(1);
  }
  console.log(`ARCH-DEP-001 OK: ${trees.map((t) => relative(repoRoot, t) || t).join(", ")}${explicit ? "" : ", deploy/cloudflare/*/wrangler.jsonc"} (${values.size} installation values)`);
}
