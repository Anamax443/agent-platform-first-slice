// Conformance package loader (VERIFICATION-CONTRACT §5): fixtures, golden, errors.md per capability.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DmsMode, DmsStatusMode } from "../../src/adapters/dms.js";
import type { RegistryMode } from "../../src/adapters/registry.js";
import { projectRoot } from "../../src/platform/schemas.js";

export type FixtureKind = "canonical" | "damaged" | "injection" | "boundary" | "error";

export interface Fixture {
  id: string;
  kind: FixtureKind;
  description?: string;
  actor?: string;
  artifact?: { tenantId?: string; bytes: string };
  payload: Record<string, unknown>;
  adapters?: { registry?: RegistryMode; dms?: DmsMode; dmsStatus?: DmsStatusMode };
  deadlineMs?: number;
  capabilityVersion?: string;
}

export interface Golden {
  anyOf?: Golden[];
  status?: string;
  payload?: Record<string, unknown>;
  error?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface ErrorRow {
  input: string;
  code: string;
  class: string;
  retryable: boolean;
  reissuable: boolean;
  enforcedBy: string;
}

export interface Suite {
  capability: string;
  dir: string;
  version: string;
  fixtures: Fixture[];
  golden: Record<string, Golden>;
  errors: ErrorRow[];
}

export const CONFORMANCE_DIR = join(projectRoot, "conformance");

export function loadSuite(capability: string): Suite {
  const dir = join(CONFORMANCE_DIR, capability);
  const fixtures = JSON.parse(readFileSync(join(dir, "fixtures", `${capability}.fixtures.json`), "utf8")) as Fixture[];
  const golden = JSON.parse(readFileSync(join(dir, "golden", `${capability}.golden.json`), "utf8")) as Record<string, Golden>;
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const version = /conformanceSuiteVersion:\s*`?([0-9.]+)`?/.exec(readme)?.[1] ?? "?";
  return { capability, dir, version, fixtures, golden, errors: parseErrorsTable(readFileSync(join(dir, "errors.md"), "utf8")) };
}

export function fixtureBytes(capability: string, id: string): string {
  const f = loadSuite(capability).fixtures.find((x) => x.id === id);
  if (!f?.artifact) throw new Error(`fixture ${capability}/${id} has no artifact`);
  return f.artifact.bytes;
}

/** errors.md is the CTR-ERR-001 source: | input class | code | class | retryable | reissuable | enforced by | */
export function parseErrorsTable(md: string): ErrorRow[] {
  const rows: ErrorRow[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, ""));
    if (cells.length < 6 || cells[1] === "code" || /^-+$/.test(cells[0] ?? "")) continue;
    rows.push({ input: cells[0] as string, code: cells[1] as string, class: cells[2] as string, retryable: cells[3] === "true", reissuable: cells[4] === "true", enforcedBy: cells[5] as string });
  }
  return rows;
}
