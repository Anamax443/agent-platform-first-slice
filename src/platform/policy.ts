import type { ReviewTask } from "./review.js";
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

export type EffectFieldCheck = { ok: true } | { ok: false; field: string; reason: string };

/**
 * FOUNDATION-core.md §1 F2 / §3.3 step 5, SEC-SEM-001 runtime layer (VC §5 line 130, layer c):
 * every field named in `effectFieldValidators` must carry `validation.status: "passed"` from the
 * validator the policy names, or the executor rejects the command before the side effect. A field
 * that fails its own structural check upstream (e.g. invoice.extract) is simply absent from the
 * payload, which fails this check the same as an explicit "failed" — untrusted until proven passed.
 */
export function checkEffectFieldValidators(policy: Policy, payload: Record<string, unknown>): EffectFieldCheck {
  const validators = policy.effectFieldValidators;
  if (!validators) return { ok: true };
  for (const [field, spec] of Object.entries(validators)) {
    if (!spec.mustPass) continue;
    const raw = payload[field] as { validation?: { status?: string; provider?: string } } | undefined;
    if (!raw || typeof raw !== "object") return { ok: false, field, reason: "field missing" };
    if (raw.validation?.status !== "passed") return { ok: false, field, reason: "validation.status is not passed" };
    if (raw.validation.provider !== spec.validator) return { ok: false, field, reason: `validation.provider ${raw.validation.provider} does not match policy validator ${spec.validator}` };
  }
  return { ok: true };
}

export type ApprovalCheck = { ok: true } | { ok: false; code: "APPROVAL_REQUIRED" | "APPROVAL_MISMATCH"; reason: string };

/**
 * FOUNDATION-core.md §3.3 step 6: if the capability requires approval, the command must carry an
 * `approvalId` (the norm's own example: `{ paymentId, approvalId }`) resolving to a DECIDED,
 * APPROVE review task for the same tenant. `approvalBoundTo` is checked structurally for the two
 * field names the norm's own worked example uses (`reviewTaskId`, `workflowId`); other names are
 * accepted but not independently verifiable without a wider binding table, so they are noted, not
 * silently treated as passing. `minAuthStrength` is compared for exact equality — AuthStrength
 * (`oidc-user | client-credentials | certificate | session | mtls`) has no defined ordering in the
 * norm, so "at least this strong" cannot be computed; this is a deliberate simplification, not an
 * oversight.
 */
export function checkApproval(
  policy: Policy,
  message: { payload: Record<string, unknown>; workflowId?: string },
  task: ReviewTask | undefined,
  ctx: TrustedContext,
): ApprovalCheck {
  const approval = policy.approval;
  if (!approval?.required) return { ok: true };
  const approvalId = message.payload.approvalId;
  if (typeof approvalId !== "string" || approvalId.length === 0) return { ok: false, code: "APPROVAL_REQUIRED", reason: "no approvalId on command" };
  if (!task || task.reviewTaskId !== approvalId) return { ok: false, code: "APPROVAL_REQUIRED", reason: "approvalId does not resolve to a review task" };
  if (task.tenantId !== ctx.tenantId) return { ok: false, code: "APPROVAL_MISMATCH", reason: "review task belongs to another tenant" };
  if (task.status !== "DECIDED" || !task.decision) return { ok: false, code: "APPROVAL_MISMATCH", reason: `review task is ${task.status}, not a decided approval` };
  if (task.decision.decision !== "APPROVE") return { ok: false, code: "APPROVAL_MISMATCH", reason: `review task was decided ${task.decision.decision}, not APPROVE` };
  if (approval.reviewerRole && task.decision.role !== approval.reviewerRole) return { ok: false, code: "APPROVAL_MISMATCH", reason: "decided by a role other than the required reviewerRole" };
  if (approval.minAuthStrength && task.decision.authStrength !== approval.minAuthStrength) {
    return { ok: false, code: "APPROVAL_MISMATCH", reason: `approver authStrength ${task.decision.authStrength ?? "unrecorded"} does not match required ${approval.minAuthStrength}` };
  }
  for (const bound of approval.approvalBoundTo ?? []) {
    if (bound === "workflowId" && task.workflowId !== message.workflowId) return { ok: false, code: "APPROVAL_MISMATCH", reason: "approval is bound to a different workflowId" };
    // "reviewTaskId" is implicit in the lookup above; other bound field names are the policy
    // author's responsibility until a wider binding table exists (not invented here).
  }
  return { ok: true };
}
