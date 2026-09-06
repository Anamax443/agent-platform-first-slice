// Contract schemas are bundled, never read from disk: the same module runs under Node (tests) and in a Worker (farm).
import Ajv2020Exports from "ajv/dist/2020.js";
import addFormatsExports from "ajv-formats";
import type { ValidateFunction } from "ajv";
import contractsPin from "../../contracts/CONTRACTS-VERSION.json" with { type: "json" };
import dispatchEnvelope from "../../contracts/dispatch-envelope.v1.schema.json" with { type: "json" };
import messageEnvelope from "../../contracts/message-envelope.v1.schema.json" with { type: "json" };
import moduleDescriptor from "../../contracts/module-descriptor.v1.schema.json" with { type: "json" };
import resultEnvelope from "../../contracts/result-envelope.v1.schema.json" with { type: "json" };
import trustedContext from "../../contracts/trusted-context.v1.schema.json" with { type: "json" };

// ajv is CommonJS: under NodeNext the default import is the exports object, the class sits on `.default`.
const Ajv2020 = Ajv2020Exports.default;
const addFormats = addFormatsExports.default;

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
for (const schema of [messageEnvelope, trustedContext, dispatchEnvelope, resultEnvelope, moduleDescriptor]) ajv.addSchema(schema);

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
