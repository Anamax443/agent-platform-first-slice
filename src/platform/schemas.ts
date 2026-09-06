// Contract schemas are bundled, never read from disk, and validated by an interpreter (no code generation): the same
// module runs under Node (tests) and in a Worker, where `new Function` is forbidden, which rules out Ajv-style compilers.
import { Validator, type Schema } from "@cfworker/json-schema";
import contractsPin from "../../contracts/CONTRACTS-VERSION.json" with { type: "json" };
import dispatchEnvelope from "../../contracts/dispatch-envelope.v1.schema.json" with { type: "json" };
import messageEnvelope from "../../contracts/message-envelope.v1.schema.json" with { type: "json" };
import moduleDescriptor from "../../contracts/module-descriptor.v1.schema.json" with { type: "json" };
import resultEnvelope from "../../contracts/result-envelope.v1.schema.json" with { type: "json" };
import trustedContext from "../../contracts/trusted-context.v1.schema.json" with { type: "json" };

const DRAFT = "2020-12";
const CONTRACT_SCHEMAS = [messageEnvelope, trustedContext, dispatchEnvelope, resultEnvelope, moduleDescriptor] as unknown as Schema[];

/** Pin of the frozen foundation contracts copied into contracts/ (source, version, commit). */
export const CONTRACTS_PIN = contractsPin;
export const CONTRACTS_VERSION = `${contractsPin.version} ${contractsPin.commit}`;

export type SchemaName =
  | "message-envelope"
  | "trusted-context"
  | "dispatch-envelope"
  | "result-envelope"
  | "module-descriptor";

const schemaId = (n: SchemaName) => `https://contracts.agent-platform-foundation.local/${n}.v1.schema.json`;

export type Validation = { ok: true } | { ok: false; errors: string };

/** One validator per root schema; the other contract schemas are registered so that `$ref` between contracts resolves. */
function validatorFor(root: Schema): Validator {
  const v = new Validator(root, DRAFT, false);
  for (const s of CONTRACT_SCHEMAS) if (s !== root) v.addSchema(s);
  return v;
}

const contractValidators = new Map<string, Validator>(CONTRACT_SCHEMAS.map((s) => [s.$id as string, validatorFor(s)]));

function run(v: Validator, data: unknown): Validation {
  const r = v.validate(data);
  if (r.valid) return { ok: true };
  return { ok: false, errors: r.errors.map((e) => `${e.instanceLocation} ${e.error}`).join("; ") };
}

export function validateContract(name: SchemaName, data: unknown): Validation {
  const v = contractValidators.get(schemaId(name));
  if (!v) throw new Error(`schema not loaded: ${name}`);
  return run(v, data);
}

/** Compile a capability-local schema (input/output). Kept separate from the contract schemas. */
export function compileSchema(schema: object): (data: unknown) => Validation {
  const v = new Validator(schema as Schema, DRAFT, false);
  return (data) => run(v, data);
}
