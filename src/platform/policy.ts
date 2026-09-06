import type { TrustedContext } from "./types.js";

/**
 * Platform policy: authority artefact (ADR-016). Descriptor is the claim; this decides who may call what.
 * Policies are part of the installation profile (config/<installation>/policy/*.json), never of the code.
 */
export interface Grant {
  actorId: string;
  actorType?: string;
  scopes: string[];
  tenants: string[];
  rateLimit?: { commandsPerMinute: number };
}

export interface Policy {
  $comment?: string;
  policyRef: string;
  capability: string;
  capabilityVersion: string;
  owner: string;
  validFrom?: string;
  grants: Grant[];
  approval?: { required: boolean; reviewerRole?: string; minAuthStrength?: string; approvalBoundTo?: string[] };
  effectFieldValidators?: Record<string, { validator: string; mustPass: boolean; params?: Record<string, unknown> }>;
  isolation?: { acceptedIsolationClass: string; isolationDecisionRef?: string };
  /** tenantId -> recipientRef -> address. Authority for effect field `recipientRef` of email.send (no payload names an address). */
  recipientAllowlist?: Record<string, Record<string, string>>;
  failClosed: boolean;
}

/** capability -> policy, assembled and cross-checked by the installation loader. */
export type PolicySet = Record<string, Policy>;

/** Fail-closed lookup: a capability without a policy for the requested version cannot be registered. */
export function policyFor(set: PolicySet, capability: string, version: string): Policy {
  const pol = set[capability];
  if (!pol) throw new Error(`policy missing for ${capability}/v${version} (fail-closed)`);
  if (pol.capability !== capability || pol.capabilityVersion !== version) {
    throw new Error(`policy ${pol.policyRef} does not match ${capability}/v${version}`);
  }
  return pol;
}

export type GrantCheck = { ok: true; grant: Grant } | { ok: false; code: "CAPABILITY_NOT_ALLOWED" | "TENANT_SCOPE_MISMATCH" };

export function checkGrant(policy: Policy, ctx: TrustedContext, capability: string): GrantCheck {
  const grant = policy.grants.find((g) => g.actorId === ctx.actorId && g.scopes.includes(capability));
  if (!grant) return { ok: false, code: "CAPABILITY_NOT_ALLOWED" };
  if (!grant.tenants.includes(ctx.tenantId)) return { ok: false, code: "TENANT_SCOPE_MISMATCH" };
  return { ok: true, grant };
}
