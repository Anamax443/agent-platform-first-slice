// document.archive/1: the second handler in the shared host. Its only credential is the archive store (SEC-HOST-001).
import type { ArchiveAdapter } from "../../adapters/archive.js";
import { capabilityError } from "../../platform/api.js";
import type { ArtifactReader, Clock, CredentialAccess, HandlerOutcome, HostHandlerSpec } from "../../platform/api.js";
import { descriptor } from "./stamp-handler.js";

export const ARCHIVE_CREDENTIAL = "cred:archive-store";
export const ARCHIVE_HANDLER_ID = "document-archive-handler";

export interface ArchiveDeps {
  artifacts: ArtifactReader;
  archive: ArchiveAdapter;
  credentials: CredentialAccess;
  clock: Clock;
}

export function createArchiveHandler(deps: ArchiveDeps): HostHandlerSpec {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  return {
    capability: "document.archive",
    handlerId: ARCHIVE_HANDLER_ID,
    resourceTenant: (payload) => deps.artifacts.get(String(payload.artifactId ?? ""))?.tenantId,
    run: async ({ message }) => {
      const p = message.payload as { artifactId: string; sha256: string };
      const art = deps.artifacts.get(p.artifactId);
      if (!art) return failed(capabilityError("ARTIFACT_NOT_FOUND", "BUSINESS", false, "artifact not found", { artifactId: p.artifactId }));
      if (p.sha256 !== art.sha256) {
        return failed(capabilityError("ARTIFACT_HASH_MISMATCH", "SECURITY", false, "artifact hash differs from the stored original", { artifactId: art.artifactId }));
      }
      const credential = deps.credentials.resolve(ARCHIVE_CREDENTIAL);
      let ref: string;
      try {
        ref = (await deps.archive.put({ bytes: art.bytes, sha256: art.sha256, clientRef: message.idempotencyKey as string }, credential)).ref;
      } catch {
        return failed(capabilityError("ARCHIVE_REJECTED", "DEPENDENCY", true, "archive store rejected the request"));
      }
      return {
        status: "SUCCEEDED",
        payload: { artifactId: art.artifactId, sha256: art.sha256, archiveRef: ref },
        provenance: { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [art.artifactId] },
      };
    },
  };
}
