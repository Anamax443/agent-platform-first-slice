// The test installation: config/local-fakes loaded through the Node loader, fake secret values, and the identities the
// tests dispatch as. Every constant is derived from the profile, so the tests carry no installation literal of their own.
import { join } from "node:path";
import { loadInstallationFromDir } from "../../src/installation-node.js";
import type { Installation, SecretsSource } from "../../src/installation.js";
import { projectRoot } from "./paths.js";

export const LOCAL_FAKES: Installation = loadInstallationFromDir(join(projectRoot, "config", "local-fakes"));

/** Values the fake adapters expect (src/adapters/*.ts defaults). Keyed by the credential references of the profile. */
const FAKE_SECRET_VALUES: Record<string, string> = {
  "cred:dms-stamp": "dms-secret",
  "cred:archive-store": "archive-secret",
  "cred:smtp": "smtp-secret",
};
export const FAKE_SECRETS: SecretsSource = (ref) => FAKE_SECRET_VALUES[ref];

const profile = LOCAL_FAKES.profile;
const identity = (actorId: string) => {
  const id = profile.identities.find((i) => i.actorId === actorId);
  if (!id) throw new Error(`test installation has no identity ${actorId}`);
  return id;
};

/** The orchestrator identity of the primary tenant (roles.orchestrator). */
export const ORCHESTRATOR = profile.roles.orchestrator;
export const TENANT_A = identity(ORCHESTRATOR).tenantId;

/** The service identity of the other tenant: SEC-CTX tests need a legitimate actor that must still be kept apart. */
const orchestratorB = profile.identities.find((i) => i.actorType === "service" && i.tenantId !== TENANT_A);
if (!orchestratorB) throw new Error("test installation needs a service identity in a second tenant");
export const ORCHESTRATOR_B = orchestratorB.actorId;
export const TENANT_B = orchestratorB.tenantId;

/** The AI identity: holds exactly one read scope, no policy grants it a write (F1). */
const aiAgent = profile.identities.find((i) => i.actorType === "ai-agent");
if (!aiAgent) throw new Error("test installation needs an ai-agent identity");
export const AI_AGENT = aiAgent.actorId;
