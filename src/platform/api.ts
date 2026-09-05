// The only platform surface a component may import (ARCH-DEP-001, FOUNDATION-core F3).
export type { Handler, HandlerInput, HandlerOutcome, ErrorObject, ErrorClass, FieldValue, Provenance } from "./types.js";
export type { Clock } from "./clock.js";
export { iso } from "./clock.js";
export { capabilityError, platformError, UnknownOutcomeError } from "./errors.js";
export { sha256 } from "./artifacts.js";
export type { Artifact, ArtifactReader, ArtifactWriter } from "./artifacts.js";
export type { Reconciler, ReconcileResult } from "./orchestrator.js";
export type { CredentialAccess } from "./credentials.js";
export { loadJson } from "./schemas.js";

/** Race a dependency call against a deadline; timeouts become DEPENDENCY_TIMEOUT at the caller. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
