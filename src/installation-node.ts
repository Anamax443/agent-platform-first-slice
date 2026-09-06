// Node-only loader of an installation directory (config/<installation>/). Reads the filesystem when called, never at
// import, so that src/installation.ts stays portable. A Worker bundles the same JSON files instead of calling this.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleInstallation, type Installation } from "./installation.js";
import type { Policy } from "./platform/policy.js";

/** `dir/profile.json` + every `dir/policy/*.policy.json`, assembled and cross-checked fail-closed. */
export function loadInstallationFromDir(dir: string): Installation {
  const profile: unknown = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const policyDir = join(dir, "policy");
  const policies = readdirSync(policyDir)
    .filter((f) => f.endsWith(".policy.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(policyDir, f), "utf8")) as Policy);
  return assembleInstallation(profile, policies);
}
