#!/usr/bin/env node
// ARCH-DEP-001 (FOUNDATION-core F3) + clock lint (VERIFICATION-CONTRACT §8.1).
// A component may import only its own directory, platform/api and adapter contracts. Platform logic never reads the system clock directly.
// Usage: node scripts/arch-dep.mjs [srcDir]   (exit 1 on any violation)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm;
const CLOCK_EXEMPT = new Set(["platform/clock.ts", "platform/ids.ts"]);

/** Pure check over one file. Returns violations as strings; empty means clean. */
export function checkFile(relPath, source) {
  const p = relPath.split(sep).join("/");
  const out = [];
  const inComponent = p.startsWith("components/");
  const inPlatform = p.startsWith("platform/");
  const inAdapters = p.startsWith("adapters/");

  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1];
    if (inComponent) {
      const ok =
        spec.startsWith("./") ||
        spec === "../../platform/api.js" ||
        /^\.\.\/\.\.\/adapters\/[a-z-]+\.js$/.test(spec) ||
        spec === "node:path" ||
        spec === "node:url";
      if (!ok) out.push(`${p}: forbidden import "${spec}" (components may import ./, platform/api, adapters/*, node:path, node:url)`);
    } else if (inAdapters) {
      const ok = spec.startsWith("./") || spec === "../platform/errors.js" || spec.startsWith("node:");
      if (!ok) out.push(`${p}: adapter imports "${spec}" (adapters know platform/errors only)`);
    } else if (inPlatform) {
      if (spec.startsWith("../components/") || spec.startsWith("../adapters/")) out.push(`${p}: platform imports component or adapter "${spec}"`);
    }
  }

  if ((inComponent || inPlatform) && !CLOCK_EXEMPT.has(p)) {
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\bDate\.now\s*\(/.test(line) || /\bnew\s+Date\s*\(\s*\)/.test(line)) out.push(`${p}:${i + 1}: direct system clock (inject Clock instead, VC §8.1)`);
    });
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".ts")) yield full;
  }
}

export function checkTree(srcDir) {
  const violations = [];
  for (const file of walk(srcDir)) violations.push(...checkFile(relative(srcDir, file), readFileSync(file, "utf8")));
  return violations;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const srcDir = process.argv[2] ?? join(fileURLToPath(new URL("..", import.meta.url)), "src");
  const violations = checkTree(srcDir);
  if (violations.length) {
    console.error(`ARCH-DEP-001 FAILED (${violations.length}):`);
    for (const v of violations) console.error("  " + v);
    process.exit(1);
  }
  console.log(`ARCH-DEP-001 OK: ${srcDir}`);
}
