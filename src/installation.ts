// Installation profile: what is bound to one customer or environment, kept out of the code and loaded fail-closed.
// Portable (no filesystem): a Worker bundles the JSON, Node reads it through installation-node.ts.
import profileSchema from "../config/profile.schema.json" with { type: "json" };
import type { Identity } from "./platform/gateway.js";
import type { Policy, PolicySet } from "./platform/policy.js";
import { compileSchema } from "./platform/schemas.js";

export interface InstallationProfile {
  installation: string;
  description?: string;
  tenants: string[];
  identities: Identity[];
  roles: { orchestrator: string };
  /** handlerId -> credential references it may resolve. Values come from a SecretsSource, never from the profile. */
  credentials: Record<string, string[]>;
  channels: { apiHost: string | null; intakeAddress: string | null; notifyFrom: string | null; notifyFromName?: string };
  retentionDays: { originals: number; journal: number; audit: number };
  policyRefs: string[];
}

export interface Installation {
  profile: InstallationProfile;
  policies: PolicySet;
}

/** Where secret values come from: env, wrangler secrets, a test map. Undefined = missing = fail-closed at wiring time. */
export type SecretsSource = (ref: string) => string | undefined;

const validateProfile = compileSchema(profileSchema);

/**
 * Assemble and cross-check an installation: profile against its schema, every policyRef present, every grant pointing
 * to a known identity that holds the granted scope, every granted tenant known. Anything else throws (fail-closed).
 */
export function assembleInstallation(profileJson: unknown, policies: Policy[]): Installation {
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
  return { profile, policies: set };
}

/** Credential table for the handlers of one deployable: only their references, values resolved now, missing value = fail-closed. */
export function credentialTable(installation: Installation, secrets: SecretsSource, handlerIds: string[]): Record<string, Record<string, string>> {
  const table: Record<string, Record<string, string>> = {};
  for (const handlerId of handlerIds) {
    const refs = installation.profile.credentials[handlerId];
    if (refs === undefined) throw new Error(`installation ${installation.profile.installation}: no credential entry for handler ${handlerId} (fail-closed)`);
    table[handlerId] = {};
    for (const ref of refs) {
      const value = secrets(ref);
      if (value === undefined) throw new Error(`secret for ${ref} (handler ${handlerId}) not provided (fail-closed)`);
      table[handlerId][ref] = value;
    }
  }
  return table;
}
