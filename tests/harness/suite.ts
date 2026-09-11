// Conformance package loader (VERIFICATION-CONTRACT §5): fixtures, golden, errors.md per capability.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DmsMode, DmsStatusMode } from "../../src/adapters/dms.js";
import type { RegistryMode } from "../../src/adapters/registry.js";
import type { SmtpMode, SmtpStatusMode } from "../../src/adapters/smtp.js";
import { projectRoot } from "./paths.js";

export type FixtureKind = "canonical" | "damaged" | "injection" | "boundary" | "error";

export interface AdapterModes {
  registry?: RegistryMode;
  dms?: DmsMode;
  dmsStatus?: DmsStatusMode;
  smtp?: SmtpMode;
  smtpStatus?: SmtpStatusMode;
}

export interface Fixture {
  id: string;
  kind: FixtureKind;
  description?: string;
  /** Why this check exists (CTR-WHY-001 requires it on every fixture) — mirrors the same field on self-test.ts's
   * own Fixture (duplicated there, not imported, so the Worker bundle never pulls in node:fs across the
   * deploy/cloudflare <-> tests boundary). */
  why?: string;
  /** What to do when this fixture goes red (CTR-WHY-001 requires it on every fixture too). */
  onFailure?: string;
  actor?: string;
  artifact?: { tenantId?: string; bytes: string };
  payload: Record<string, unknown>;
  adapters?: AdapterModes;
  storage?: { capacityBytes: number };
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

const cache = new Map<string, Suite>();

export function loadSuite(capability: string): Suite {
  const cached = cache.get(capability);
  if (cached) return cached;
  const dir = join(CONFORMANCE_DIR, capability);
  const fixtures = JSON.parse(readFileSync(join(dir, "fixtures", `${capability}.fixtures.json`), "utf8")) as Fixture[];
  const golden = JSON.parse(readFileSync(join(dir, "golden", `${capability}.golden.json`), "utf8")) as Record<string, Golden>;
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const version = /conformanceSuiteVersion:\s*`?([0-9.]+)`?/.exec(readme)?.[1] ?? "?";
  const suite = { capability, dir, version, fixtures, golden, errors: parseErrorsTable(readFileSync(join(dir, "errors.md"), "utf8")) };
  cache.set(capability, suite);
  return suite;
}

/** Text of a fixture: its artifact bytes, or the raw mail it carries. `ref` = "<capability>/<fixture id>". */
export function fixtureText(ref: string): string {
  const [capability, id] = ref.split("/") as [string, string];
  const f = loadSuite(capability).fixtures.find((x) => x.id === id);
  const text = f?.artifact?.bytes ?? (f?.payload.rawMail as string | undefined);
  if (text === undefined) throw new Error(`fixture ${ref} carries no text`);
  return text;
}

export function fixtureBytes(capability: string, id: string): string {
  return fixtureText(`${capability}/${id}`);
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
