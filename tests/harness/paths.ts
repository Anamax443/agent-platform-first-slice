// Filesystem helpers for tests only. Platform and components never know where the repo is (they run in a Worker too).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadJson<T = unknown>(absolutePath: string): T {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}
