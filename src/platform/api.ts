// The only platform surface a component may import (ARCH-DEP-001, FOUNDATION-core F3).
export type { Handler, HandlerInput, HandlerOutcome, ErrorObject, ErrorClass, FieldValue, Provenance } from "./types.js";
export type { Clock } from "./clock.js";
export { iso } from "./clock.js";
export { capabilityError, platformError, UnknownOutcomeError } from "./errors.js";
export { sha256, StorageFull } from "./artifacts.js";
export type { Artifact, ArtifactReader, ArtifactWriter } from "./artifacts.js";
export type { ReconcileResult, HostHandlerSpec } from "./executor-host.js";
export type { CredentialAccess } from "./credentials.js";

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
