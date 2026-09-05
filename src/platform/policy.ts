import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadJson, projectRoot } from "./schemas.js";
import type { TrustedContext } from "./types.js";

/** Platform policy: authority artefact (ADR-016). Descriptor is the claim; this decides who may call what. */
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
  failClosed: boolean;
}

export function policyPath(capability: string, version: string): string {
  return join(projectRoot, "contracts", "policy", `${capability}.v${version}.policy.json`);
}

export function loadPolicy(capability: string, version: string): Policy {
  const p = policyPath(capability, version);
  if (!existsSync(p)) throw new Error(`policy missing for ${capability}/v${version}: ${p} (fail-closed)`);
  const pol = loadJson<Policy>(p);
  if (pol.capability !== capability || pol.capabilityVersion !== version) {
    throw new Error(`policy ${p} does not match ${capability}/v${version}`);
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
