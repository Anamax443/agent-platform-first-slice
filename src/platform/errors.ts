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
  // FOUNDATION-core.md §1 F2 / §3.3 step 5, SEC-SEM-001 runtime layer: an effect field named in the
  // capability's policy.effectFieldValidators lacks validation.status:"passed" from the named validator.
  // The norm doesn't name an exact code for this branch (only the shape of the check) — this is a project
  // choice, not a normative one.
  EFFECT_FIELD_VALIDATION_FAILED: { class: "SECURITY", retryable: false, reissuable: false },
  // Reliability Gate R4 (owner's second, "months/years unattended" audit, 18.9.2026; "než dáme Farmě
  // větší autonomii, musí se nejdřív sama umět bezpečně probudit... a odhalit stagnaci" — the systemic
  // point cz.company.verify/cz.vat.verify became the concrete instance of): before this fix, an
  // installation that never opted a trusted provider in (no HttpAresAdapter/HttpMojeDaneAdapter
  // wired, no explicit "yes, fabricated data is fine here" flag) got FakeAresAdapter/FakeMojeDaneAdapter
  // silently, unconditionally, as its production fallback (platform-wiring.ts's `o.ares ?? new
  // FakeAresAdapter()` — the `??` hid a missing installation value behind a made-up company record with
  // no signal anywhere that it was fabricated). Self-test.ts's own comment already conceded this is not
  // hypothetical: cz.company.verify/cz.vat.verify's live conformance fixtures on HEAD 1d465dd run "against
  // FakeAresAdapter/FakeMojeDaneAdapter (no real ... baseUrl configured yet)" — i.e. farm-bass443's
  // self-test today reports SUCCEEDED against invented data, indistinguishable from a real ARES/MOJE daně
  // answer to anything reading the result. class DEPENDENCY (not POLICY): placed next to its closest
  // siblings DEPENDENCY_TIMEOUT/DEPENDENCY_UNAVAILABLE in each capability's errorCodes list, since the
  // shape of the failure — "a trusted external dependency this capability needs isn't reachable" — is the
  // same family; retryable:false/reissuable:true mirrors MODULE_QUARANTINED's shape rather than the
  // transient-dependency shape, because a bare retry cannot fix a missing installation config — only an
  // operator wiring the real adapter (or, for a deliberately-fake installation, setting
  // InstallationProfile.allowUnconfiguredTrustedProviders:true) makes the same request succeed later.
  TRUSTED_PROVIDER_NOT_CONFIGURED: { class: "DEPENDENCY", retryable: false, reissuable: true },
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

/**
 * Reliability Gate R4: thrown by NotConfiguredAresAdapter/NotConfiguredMojeDaneAdapter
 * (src/adapters/ares.ts, src/adapters/moje-dane.ts) when platform-wiring.ts's wirePlatform() has neither
 * a real adapter (`o.ares`/`o.mojeDane`) nor the installation's explicit opt-in
 * (InstallationProfile.allowUnconfiguredTrustedProviders) to fall back to the fakes. Lives here, not in
 * platform/api.ts alongside DependencyTimeout, because scripts/arch-dep.mjs's ARCH-DEP-001 `inAdapters`
 * import rule lets an adapter file import only "./", "../platform/errors.js", "node:*", or a bare vendor
 * specifier — never "../platform/api.js" (that's a components/*-only door) — the exact same constraint
 * that already put UnknownOutcomeError here instead of api.ts (thrown by src/adapters/dms.ts and
 * smtp.ts, re-exported by api.ts below for components to catch); this class follows that live precedent
 * rather than inventing a new placement.
 */
export class TrustedProviderNotConfigured extends Error {
  constructor(public readonly provider: "ares" | "mojeDane") {
    super(`${provider} adapter not configured for this installation (Reliability Gate R4, fail-closed — see PLATFORM_CODES.TRUSTED_PROVIDER_NOT_CONFIGURED)`);
    this.name = "TrustedProviderNotConfigured";
  }
}
