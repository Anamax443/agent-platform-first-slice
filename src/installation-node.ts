// Node-only loader of an installation directory (config/<installation>/). Reads the filesystem when called, never at
// import, so that src/installation.ts stays portable. A Worker bundles the same JSON files instead of calling this.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleInstallation, type Installation } from "./installation.js";
import type { LifecycleStatus } from "./platform/lifecycle.js";
import type { Policy } from "./platform/policy.js";

/** `dir/profile.json` + every `dir/policy/*.policy.json` + optional `dir/lifecycle.json`, assembled and
 * cross-checked fail-closed. `lifecycle.json` absent = no module quarantined (same as `{}`). */
export function loadInstallationFromDir(dir: string): Installation {
  const profile: unknown = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const policyDir = join(dir, "policy");
  const policies = readdirSync(policyDir)
    .filter((f) => f.endsWith(".policy.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(policyDir, f), "utf8")) as Policy);
  const lifecyclePath = join(dir, "lifecycle.json");
  const lifecycle: Record<string, LifecycleStatus> = existsSync(lifecyclePath) ? (JSON.parse(readFileSync(lifecyclePath, "utf8")) as Record<string, LifecycleStatus>) : {};
  return assembleInstallation(profile, policies, lifecycle);
}
