// document.stamp/1: single-purpose write executor (LOW, LOGICAL). The original stays immutable; the stamp is a derivation (F7).
import type { DmsAdapter } from "../../adapters/dms.js";
import { capabilityError, iso, UnknownOutcomeError } from "../../platform/api.js";
import type { ArtifactWriter, Clock, CredentialAccess, FieldValue, HandlerOutcome, HostHandlerSpec, ReconcileResult } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import stampInputSchema from "./stamp.input.schema.json" with { type: "json" };
import archiveInputSchema from "./archive.input.schema.json" with { type: "json" };

export { descriptor, stampInputSchema, archiveInputSchema };

export const STAMP_CREDENTIAL = "cred:dms-stamp";
export const STAMP_HANDLER_ID = "document-stamp-handler";
export const VALIDATOR_PROVIDER = "document-validator";

export interface StampDeps {
  artifacts: ArtifactWriter;
  dms: DmsAdapter;
  credentials: CredentialAccess;
  clock: Clock;
}

interface Input {
  artifactId: string;
  sha256: string;
  documentType: FieldValue<string>;
  stampText?: string;
}

export function createStampHandler(deps: StampDeps): HostHandlerSpec {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });

  return {
    capability: "document.stamp",
    handlerId: STAMP_HANDLER_ID,
    resourceTenant: (payload) => {
      const art = deps.artifacts.get(String(payload.artifactId ?? ""));
      return art ? { kind: "FOUND" as const, tenantId: art.tenantId } : { kind: "NOT_FOUND" as const };
    },

    run: async ({ message }) => {
      const p = message.payload as unknown as Input;
      const art = deps.artifacts.get(p.artifactId);
      if (!art) return failed(capabilityError("ARTIFACT_NOT_FOUND", "BUSINESS", false, "artifact not found", { artifactId: p.artifactId }));
      if (p.sha256 !== art.sha256) {
        return failed(capabilityError("ARTIFACT_HASH_MISMATCH", "SECURITY", false, "artifact hash differs from the stored original", { artifactId: art.artifactId }));
      }
      // The executor accepts only a value that carries validation evidence from the validator (F2 for LOW: policy, not schema).
      const v = p.documentType.validation;
      if (!v || v.status !== "passed" || v.provider !== VALIDATOR_PROVIDER) {
        return failed(capabilityError("VALIDATION_EVIDENCE_MISSING", "POLICY", false, "documentType has no passed validation from the validator", { provider: v?.provider ?? null }));
      }
      const stampText = p.stampText ?? `STAMPED ${p.documentType.value} ${iso(deps.clock.now())}`;
      const clientRef = message.idempotencyKey as string;

      const credential = deps.credentials.resolve(STAMP_CREDENTIAL);
      let out: { bytes: string; ref: string };
      try {
        out = await deps.dms.stamp({ bytes: art.bytes, stampText, clientRef }, credential);
      } catch (e) {
        if (e instanceof UnknownOutcomeError || (e as Error).name === "ProcessCrash") throw e;
        return failed(capabilityError("DMS_REJECTED", "DEPENDENCY", true, "DMS rejected the stamp request"));
      }
      const derived = deps.artifacts.derive(art.artifactId, out.bytes, descriptor.module);
      return {
        status: "SUCCEEDED",
        payload: payloadFor(art.artifactId, art.sha256, derived.artifactId, derived.sha256, stampText, out.ref),
        provenance: { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [art.artifactId] },
      };
    },

    /** unknownOutcomeRecovery = query-external-status: ask the DMS by client reference, never stamp again. */
    reconcile: async ({ idempotencyKey, payload }): Promise<ReconcileResult> => {
      const p = payload as unknown as Input;
      const status = await deps.dms.status(idempotencyKey);
      if (status === "UNKNOWN") return { status: "UNKNOWN" };
      if (status === "NOT_FOUND") return { status: "FAILED" };
      const stored = await deps.dms.read(idempotencyKey);
      const art = deps.artifacts.get(p.artifactId);
      if (!stored || !art) return { status: "UNKNOWN" };
      const derived = deps.artifacts.derive(art.artifactId, stored.bytes, descriptor.module);
      const stampText = stored.bytes.slice(stored.bytes.lastIndexOf("--- ") + 4, stored.bytes.lastIndexOf(" ---"));
      return { status: "SUCCEEDED", payload: payloadFor(art.artifactId, art.sha256, derived.artifactId, derived.sha256, stampText, stored.ref) };
    },
  };
}

function payloadFor(originalArtifactId: string, originalSha256: string, stampedArtifactId: string, stampedSha256: string, stampText: string, dmsRef: string) {
  return { originalArtifactId, originalSha256, stampedArtifactId, stampedSha256, stampText, dmsRef };
}
