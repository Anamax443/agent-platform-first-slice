// document.validate/1: deterministic module. Checks artifact integrity and the classified type against the registry.
// Every registry answer is untrusted until it passes range and semantic checks (F2, INT-FAIL-004).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryBusinessError, RegistryUnavailable, type RegistryAdapter, type RegistryRecord } from "../../adapters/registry.js";
import { capabilityError, DependencyTimeout, iso, loadJson, platformError, withTimeout } from "../../platform/api.js";
import type { ArtifactReader, Clock, FieldValue, Handler, HandlerOutcome, Provenance } from "../../platform/api.js";

const here = dirname(fileURLToPath(import.meta.url));

export const descriptor = loadJson<{ module: string; componentVersion: string }>(join(here, "descriptor.json"));
export const inputSchema = loadJson<object>(join(here, "input.schema.json"));
export const outputSchema = loadJson<{ properties: { retentionDays: { minimum: number; maximum: number } } }>(join(here, "output.schema.json"));

const RETENTION = outputSchema.properties.retentionDays;

export interface ValidatorDeps {
  artifacts: ArtifactReader;
  registry: RegistryAdapter;
  clock: Clock;
  registryTimeoutMs?: number;
  /**
   * Second, deterministic signal for values that came from a model (W4 in MEASUREMENT): a rules classifier over the
   * document text. Disagreement is a QUALITY failure that the workflow routes to review; it is a heuristic, not proof.
   */
  crossCheck?: (text: string) => string;
}

const INSTRUCTION_LINE = /(ignore (all |any )?(previous|prior|above|earlier) instructions|^\s*system\s*:|classify (this |it )?as\b|^\s*assistant\s*:)/i;

/** Lines that read like instructions are data too, but they must not feed the second signal (an injected keyword would satisfy both). */
export function stripInstructionLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !INSTRUCTION_LINE.test(line))
    .join("\n");
}

interface Input {
  artifactId: string;
  sha256: string;
  documentType: FieldValue<string>;
  strategy?: string;
  correctedDocumentType?: string;
}

export function createDocumentValidator(deps: ValidatorDeps): Handler {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });

  return async ({ message, context }) => {
    const p = message.payload as unknown as Input;
    const art = deps.artifacts.get(p.artifactId);
    if (!art) return failed(capabilityError("ARTIFACT_NOT_FOUND", "BUSINESS", false, "artifact not found", { artifactId: p.artifactId }));
    if (art.tenantId !== context.tenantId) {
      return failed(capabilityError("TENANT_SCOPE_MISMATCH", "SECURITY", false, "artifact belongs to another tenant than the trusted context"));
    }
    // SEC-ART-001: the hash the previous step saw must be the hash of the stored original.
    if (p.sha256 !== art.sha256) {
      return failed(capabilityError("ARTIFACT_HASH_MISMATCH", "SECURITY", false, "artifact hash differs from the stored original", { artifactId: art.artifactId }));
    }

    const type: FieldValue<string> =
      p.strategy === "human-corrected" && p.correctedDocumentType
        ? { value: p.correctedDocumentType, source: "human", confidence: 1, trustLevel: "human-corrected" }
        : { value: p.documentType.value, source: p.documentType.source ?? "llm", trustLevel: "untrusted-derived", ...(p.documentType.confidence !== undefined ? { confidence: p.documentType.confidence } : {}) };

    if (deps.crossCheck && type.source !== "human") {
      const second = deps.crossCheck(stripInstructionLines(art.bytes));
      if (second !== type.value) {
        return failed(capabilityError("CLASSIFICATION_DISPUTED", "QUALITY", false, "deterministic cross-check disagrees with the classifier", { classifier: type.value, rules: second, source: type.source }));
      }
    }

    let record: RegistryRecord;
    try {
      record = await withTimeout(deps.registry.lookup(type.value), deps.registryTimeoutMs ?? 5_000);
    } catch (e) {
      if (e instanceof DependencyTimeout) return failed(platformError("DEPENDENCY_TIMEOUT", "registry did not answer before the deadline", { ms: e.ms }));
      if (e instanceof RegistryUnavailable) return failed(platformError("DEPENDENCY_UNAVAILABLE", "registry unavailable", { httpStatus: e.httpStatus }));
      if (e instanceof RegistryBusinessError) return failed(capabilityError("REGISTRY_REJECTED", "BUSINESS", false, "registry rejected the document type", { registryCode: e.code }));
      throw e;
    }

    // INT-FAIL-004 (a): schema-valid nonsense outside the business range -> VALIDATION
    if (!Number.isInteger(record.retentionDays) || record.retentionDays < RETENTION.minimum || record.retentionDays > RETENTION.maximum) {
      return failed(capabilityError("REGISTRY_RESPONSE_INVALID", "VALIDATION", false, "registry returned a retention outside the allowed range", { retentionDays: record.retentionDays }));
    }
    // INT-FAIL-004 (b): formally fine, semantically impossible -> QUALITY, the workflow sends it to review
    if (record.documentType !== type.value) {
      return failed(capabilityError("REGISTRY_TYPE_CONFLICT", "QUALITY", false, "registry answered for a different document type", { requested: type.value, answered: record.documentType }));
    }
    if (!record.stampAllowed) {
      return failed(capabilityError("STAMP_NOT_ALLOWED", "BUSINESS", false, "registry does not allow stamping this document type", { documentType: type.value }));
    }

    const validated: FieldValue<string> = {
      ...type,
      trustLevel: type.source === "human" ? "human-corrected" : "validated",
      validation: { status: "passed", provider: descriptor.module, at: iso(deps.clock.now()) },
    };
    const provenance: Provenance = { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [art.artifactId] };
    return {
      status: "SUCCEEDED",
      payload: { artifactId: art.artifactId, sha256: art.sha256, documentType: validated, stampAllowed: true, retentionDays: record.retentionDays },
      provenance,
    };
  };
}
