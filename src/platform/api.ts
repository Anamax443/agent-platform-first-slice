// The only platform surface a component may import (ARCH-DEP-001, FOUNDATION-core F3).
export type { Handler, HandlerInput, HandlerOutcome, ErrorObject, ErrorClass, FieldValue, Provenance } from "./types.js";
export type { Clock } from "./clock.js";
export { iso } from "./clock.js";
export { capabilityError, platformError, UnknownOutcomeError } from "./errors.js";
export { sha256, StorageFull } from "./artifacts.js";
export { stripMimeAttachments, parseMimeMessage } from "./mime.js";
export type { Artifact, ArtifactReader, ArtifactWriter } from "./artifacts.js";
export type { ReconcileResult, HostHandlerSpec } from "./executor-host.js";
export type { CredentialAccess } from "./credentials.js";
export { EvidenceWriter, type EvidenceClaim, type EvidenceWriteOptions } from "./evidence-writer.js";
export { CASE_SCOPE } from "./fact-catalog.js";
export type { FactAddress } from "./fact-address.js";
// P0 fact-scope-multi-doc pass (docs/AUTONOMOUS-RUNTIME-V1.md část 2, 18.9.2026 external audit): mail-ingest/
// handler.ts (a component, ARCH-DEP-001-restricted to this exact surface) needs to mint one opaque
// impulse.attachment entity id per parsed attachment at ingest time, so document.classify's later per-attachment
// evidence (document.type.invoiceConfirmed, contracts/facts.v1.json) can be addressed by FactAddress instead of
// Evidence.workflowId. newEntityId()/EntityId already existed (fact-address.ts, M0-FACT-CONTRACT-V1.md část A,
// krůček 1) but were never re-exported here — nothing under src/components/* could reach them before this line.
export { newEntityId, type EntityId } from "./fact-address.js";

/** Race a dependency call against a deadline; timeouts become DEPENDENCY_TIMEOUT at the caller. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DependencyTimeout(ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DependencyTimeout extends Error {
  constructor(public readonly ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = "DependencyTimeout";
  }
}
