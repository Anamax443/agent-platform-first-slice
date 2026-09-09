import type { ErrorClass, ErrorObject } from "./types.js";

/** Platform error codes with their contract properties (FOUNDATION-core §4.5). */
export const PLATFORM_CODES = {
  SCHEMA_VALIDATION_FAILED: { class: "VALIDATION", retryable: false, reissuable: false },
  CAPABILITY_NOT_ALLOWED: { class: "SECURITY", retryable: false, reissuable: false },
  TENANT_SCOPE_MISMATCH: { class: "SECURITY", retryable: false, reissuable: false },
  CONTEXT_BINDING_INVALID: { class: "SECURITY", retryable: false, reissuable: true },
  CONTEXT_EXPIRED: { class: "SECURITY", retryable: false, reissuable: true },
  APPROVAL_REQUIRED: { class: "POLICY", retryable: false, reissuable: true },
  APPROVAL_MISMATCH: { class: "SECURITY", retryable: false, reissuable: false },
  COMMAND_EXPIRED: { class: "POLICY", retryable: false, reissuable: true },
  DUPLICATE_COMMAND: { class: "VALIDATION", retryable: false, reissuable: false },
  DEPENDENCY_TIMEOUT: { class: "DEPENDENCY", retryable: true, reissuable: false },
  DEPENDENCY_UNAVAILABLE: { class: "DEPENDENCY", retryable: true, reissuable: false },
  UNKNOWN_EXTERNAL_OUTCOME: { class: "UNKNOWN", retryable: false, reissuable: false },
  INCOMPATIBLE_VERSION: { class: "VALIDATION", retryable: false, reissuable: false },
  REVIEW_EXPIRED: { class: "POLICY", retryable: false, reissuable: false },
  CREDENTIAL_DENIED: { class: "SECURITY", retryable: false, reissuable: false },
  HANDLER_CRASHED: { class: "TECHNICAL", retryable: true, reissuable: false },
  // Found 2026-09-08 (Posudek 5/6, docs/POSUDKY.md): the same idempotencyKey reused with a
  // different payload must not silently replay the old outcome — a genuinely new intent needs a
  // new key, not a retry.
  IDEMPOTENCY_CONFLICT: { class: "VALIDATION", retryable: false, reissuable: false },
  // Another attempt for the same dedup key is currently reserved (mid-flight); the caller should
  // back off, not race the side effect.
  IDEMPOTENCY_IN_FLIGHT: { class: "TECHNICAL", retryable: true, reissuable: false },
  // resourceTenant() could not establish ownership of the targeted resource (missing, or a future
  // handler's lookup failed) — fail closed, same as an actual cross-tenant mismatch, rather than
  // silently skipping the tenant check.
  RESOURCE_TENANT_UNRESOLVED: { class: "SECURITY", retryable: false, reissuable: false },
  // A module was explicitly quarantined (config/<installation>/lifecycle.json, LifecycleRegistry) — the
  // descriptor's claim may still be valid, but the platform currently refuses to dispatch to it. Reissuable:
  // once the module is healed (a new, separately-admitted build/version reaches ACTIVE), the same logical
  // request can be retried.
  MODULE_QUARANTINED: { class: "POLICY", retryable: false, reissuable: true },
} as const satisfies Record<string, { class: ErrorClass; retryable: boolean; reissuable: boolean }>;

export type PlatformCode = keyof typeof PLATFORM_CODES;

export function platformError(code: PlatformCode, message: string, details?: Record<string, unknown>): ErrorObject {
  const p = PLATFORM_CODES[code];
  const e: ErrorObject = { code, class: p.class, retryable: p.retryable, message };
  if (p.reissuable) e.reissuable = true;
  if (details) e.details = details;
  return e;
}

/** Capability-specific error (must be listed in the capability's errorCodes). */
export function capabilityError(
  code: string,
  cls: ErrorClass,
  retryable: boolean,
  message: string,
  details?: Record<string, unknown>,
): ErrorObject {
  const e: ErrorObject = { code, class: cls, retryable, message };
  if (details) e.details = details;
  return e;
}

/** Thrown by an adapter when the side effect may or may not have happened. */
export class UnknownOutcomeError extends Error {
  constructor(public readonly reconciliationRef: string) {
    super(`unknown outcome, reconcile via ${reconciliationRef}`);
    this.name = "UnknownOutcomeError";
  }
}

/** Test-only: simulates the process dying in the middle of a step (RES-CRASH-001). */
export class ProcessCrash extends Error {
  constructor(public readonly at: string) {
    super(`process crashed at ${at}`);
    this.name = "ProcessCrash";
  }
}
