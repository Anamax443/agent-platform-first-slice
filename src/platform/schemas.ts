import Ajv2020Exports from "ajv/dist/2020.js";
import addFormatsExports from "ajv-formats";
import type { ValidateFunction } from "ajv";

// ajv is CommonJS: under NodeNext the default import is the exports object, the class sits on `.default`.
const Ajv2020 = Ajv2020Exports.default;
const addFormats = addFormatsExports.default;
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = join(projectRoot, "contracts");

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

for (const f of readdirSync(contractsDir).filter((x) => x.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, f), "utf8")));
}

export const CONTRACTS_VERSION = readFileSync(join(contractsDir, "CONTRACTS-VERSION"), "utf8").trim();

export type SchemaName =
  | "message-envelope"
  | "trusted-context"
  | "dispatch-envelope"
  | "result-envelope"
  | "module-descriptor";

const schemaId = (n: SchemaName) => `https://contracts.agent-platform-foundation.local/${n}.v1.schema.json`;

export type Validation = { ok: true } | { ok: false; errors: string };

export function validateContract(name: SchemaName, data: unknown): Validation {
  const v = ajv.getSchema(schemaId(name));
  if (!v) throw new Error(`schema not loaded: ${name}`);
  return v(data) ? { ok: true } : { ok: false, errors: ajv.errorsText(v.errors) };
}

/** Compile a capability-local schema (input/output). Kept separate from the contract schemas. */
export function compileSchema(schema: object): (data: unknown) => Validation {
  const v: ValidateFunction = ajv.compile(schema);
  return (data) => (v(data) ? { ok: true } : { ok: false, errors: ajv.errorsText(v.errors) });
}

export function loadJson<T = unknown>(absolutePath: string): T {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}
