// Installation profile: what is bound to one customer or environment, kept out of the code and loaded fail-closed.
// Portable (no filesystem): a Worker bundles the JSON, Node reads it through installation-node.ts.
import profileSchema from "../config/profile.schema.json" with { type: "json" };
import type { Identity } from "./platform/gateway.js";
import { LifecycleRegistry, type LifecycleStatus } from "./platform/lifecycle.js";
import type { Policy, PolicySet } from "./platform/policy.js";
import { compileSchema } from "./platform/schemas.js";

/** One AI model an installation may call. The credential is a reference only; the value comes from the SecretsSource. */
export interface ModelOption {
  provider: "workers-ai" | "anthropic" | "fake";
  model: string;
  label?: string;
  credential?: string;
  /** Where inference may run (provider-specific, e.g. "eu"); a compliance setting, not a tuning knob. */
  inferenceGeo?: string;
  /** Who processes the data and how long they keep it: written down per option (NIS2 / ISO 27001 supplier control). */
  processor?: string;
}

/** Models per AI capability: the options the operator may pick from and the default. "Never without a model" holds per capability. */
export interface ModelConfig {
  default: string;
  options: Record<string, ModelOption>;
}

export interface InstallationProfile {
  installation: string;
  description?: string;
  tenants: string[];
  identities: Identity[];
  roles: { orchestrator: string };
  /** handlerId -> credential references it may resolve. Values come from a SecretsSource, never from the profile. */
  credentials: Record<string, string[]>;
  channels: { apiHost: string | null; intakeAddress: string | null; notifyFrom: string | null; notifyFromName?: string; operatorAlertTo?: string | null };
  retentionDays: { originals: number; journal: number; audit: number };
  policyRefs: string[];
  /** capability -> models. Absent only in installations that never call a model (tests with fakes). */
  models?: Record<string, ModelConfig>;
}

export interface Installation {
  profile: InstallationProfile;
  policies: PolicySet;
  /** module -> ACTIVE/QUARANTINED (config/<installation>/lifecycle.json). A mandatory allow-list: a module
   * missing from it is refused exactly like one explicitly QUARANTINED (changed 2026-09-10, see
   * platform/lifecycle.ts) — every module a Router actually dispatches to must have an explicit entry. */
  lifecycle: LifecycleRegistry;
}

/** Where secret values come from: env, wrangler secrets, a test map. Undefined = missing = fail-closed at wiring time. */
export type SecretsSource = (ref: string) => string | undefined;

const validateProfile = compileSchema(profileSchema);

/**
 * Assemble and cross-check an installation: profile against its schema, every policyRef present, every grant pointing
 * to a known identity that holds the granted scope, every granted tenant known. Anything else throws (fail-closed).
 */
export function assembleInstallation(profileJson: unknown, policies: Policy[], lifecycleStatuses: Record<string, LifecycleStatus> = {}): Installation {
  const v = validateProfile(profileJson);
  if (!v.ok) throw new Error(`installation profile invalid (fail-closed): ${v.errors}`);
  const profile = profileJson as InstallationProfile;

  const set: PolicySet = {};
  for (const pol of policies) {
    if (set[pol.capability]) throw new Error(`installation ${profile.installation}: two policies for ${pol.capability}`);
    if (!pol.failClosed) throw new Error(`installation ${profile.installation}: policy ${pol.policyRef} is not failClosed`);
    set[pol.capability] = pol;
  }
  for (const cap of profile.policyRefs) {
    if (!set[cap]) throw new Error(`installation ${profile.installation}: policy for ${cap} missing (fail-closed)`);
  }
  const identities = new Map(profile.identities.map((i) => [i.actorId, i]));
  if (identities.size !== profile.identities.length) throw new Error(`installation ${profile.installation}: duplicate actorId among identities`);
  for (const id of profile.identities) {
    if (!profile.tenants.includes(id.tenantId)) throw new Error(`identity ${id.actorId} belongs to tenant ${id.tenantId}, unknown to installation ${profile.installation}`);
  }
  for (const pol of Object.values(set)) {
    for (const g of pol.grants) {
      const id = identities.get(g.actorId);
      if (!id) throw new Error(`policy ${pol.policyRef} grants ${g.actorId}, which is not an identity of installation ${profile.installation}`);
      for (const scope of g.scopes) {
        if (!id.scopes.includes(scope)) throw new Error(`policy ${pol.policyRef} grants scope ${scope} to ${g.actorId}, whose identity does not hold it`);
      }
      for (const tenant of g.tenants) {
        if (!profile.tenants.includes(tenant)) throw new Error(`policy ${pol.policyRef} grants tenant ${tenant}, unknown to installation ${profile.installation}`);
      }
    }
  }
  if (!identities.has(profile.roles.orchestrator)) throw new Error(`roles.orchestrator ${profile.roles.orchestrator} is not an identity`);
  for (const [capability, cfg] of Object.entries(profile.models ?? {})) {
    if (!cfg.options[cfg.default]) throw new Error(`installation ${profile.installation}: default model ${cfg.default} of ${capability} is not among its options`);
  }
  return { profile, policies: set, lifecycle: new LifecycleRegistry(lifecycleStatuses) };
}

/**
 * Models of one capability with their credential values resolved. An option whose credential has no value is reported as
 * unavailable (the operator sees why) but never used; the default must be available, otherwise the wiring stops (fail-closed).
 */
export function modelTable(
  installation: Installation,
  secrets: SecretsSource,
  capability: string,
): { default: string; available: Record<string, ModelOption & { secret?: string }>; unavailable: Record<string, string> } {
  const cfg = installation.profile.models?.[capability];
  if (!cfg) throw new Error(`installation ${installation.profile.installation}: no models configured for ${capability} (never without a model, fail-closed)`);
  const available: Record<string, ModelOption & { secret?: string }> = {};
  const unavailable: Record<string, string> = {};
  for (const [key, opt] of Object.entries(cfg.options)) {
    if (!opt.credential) {
      available[key] = { ...opt };
      continue;
    }
    const secret = secrets(opt.credential);
    if (secret === undefined) unavailable[key] = `secret for ${opt.credential} not provided`;
    else available[key] = { ...opt, secret };
  }
  if (!available[cfg.default]) throw new Error(`installation ${installation.profile.installation}: default model ${cfg.default} of ${capability} is unavailable: ${unavailable[cfg.default] ?? "unknown"} (fail-closed)`);
  return { default: cfg.default, available, unavailable };
}

/**
 * Credential table for the handlers of one deployable. `required` says which references the code of each handler needs;
 * the profile says which it may resolve. Both must agree, and every listed reference must have a value now (fail-closed).
 */
export function credentialTable(installation: Installation, secrets: SecretsSource, required: Record<string, string[]>): Record<string, Record<string, string>> {
  const table: Record<string, Record<string, string>> = {};
  const name = installation.profile.installation;
  for (const [handlerId, needed] of Object.entries(required)) {
    const refs = installation.profile.credentials[handlerId];
    if (refs === undefined) throw new Error(`installation ${name}: no credential entry for handler ${handlerId} (fail-closed)`);
    for (const ref of needed) {
      if (!refs.includes(ref)) throw new Error(`installation ${name}: handler ${handlerId} needs ${ref}, which the profile does not grant it (fail-closed)`);
    }
    table[handlerId] = {};
    for (const ref of refs) {
      const value = secrets(ref);
      if (value === undefined) throw new Error(`secret for ${ref} (handler ${handlerId}) not provided (fail-closed)`);
      table[handlerId][ref] = value;
    }
  }
  return table;
}
