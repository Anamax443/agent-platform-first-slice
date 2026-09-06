// apf-gateway: skeleton with the installation bound. Step 2 of docs/NAVRHOVY-LIST-farma.md wires src/platform (router,
// gateway, orchestrator) in here. Until then every request answers 501 so that a half-wired farm can never look like a working one.
// The installation (profile + policies) comes from the build-time alias apf:installation and is assembled fail-closed at import:
// a broken profile means this Worker does not start at all.
import { DurableObject } from "cloudflare:workers";
import { INSTALLATION, installation } from "apf:installation";

export interface Env {
  WORKFLOW: DurableObjectNamespace;
  AUDIT: D1Database;
  ARTIFACTS: R2Bucket;
  AI: Ai;
  DOCUMENT_HOST: Fetcher;
  EMAIL_EXECUTOR: Fetcher;
  FAKES: Fetcher;
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
  KILL_SWITCH: string;
  SIGNING_KEY_ID: string;
  CONTRACTS_VERSION: string;
  WORKFLOW_DEADLINE_MS: string;
  GATEWAY_SIGNING_KEY?: string;
}

/** One Durable Object per workflow instance: the journal of the slice becomes SQLite storage, alarms replace polling. */
export class WorkflowInstance extends DurableObject<Env> {
  async ping(): Promise<{ ok: true; deployable: "apf-gateway" }> {
    return { ok: true, deployable: "apf-gateway" };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Bundle and vars must name the same installation; anything else is a deployment mistake and stops here (fail-closed).
    if (env.INSTALLATION !== INSTALLATION) {
      return Response.json({ error: "INSTALLATION_MISMATCH", bundle: INSTALLATION, vars: env.INSTALLATION }, { status: 500 });
    }
    if (url.pathname === "/version") {
      return Response.json({
        deployable: "apf-gateway",
        installation: INSTALLATION,
        tenants: installation.profile.tenants.length,
        identities: installation.profile.identities.length,
        policies: Object.keys(installation.policies).length,
        contracts: env.CONTRACTS_VERSION,
        killSwitch: env.KILL_SWITCH === "true",
        wired: false,
      });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    return Response.json({ error: "NOT_WIRED", message: "apf-gateway skeleton: platform not wired yet (NAVRHOVY-LIST-farma.md, step 2)" }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
