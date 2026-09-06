// apf-gateway: skeleton. Step 2 of docs/NAVRHOVY-LIST-farma.md wires src/platform (router, gateway, orchestrator) in here.
// Until then every request answers 501 so that a half-wired farm can never look like a working one.
import { DurableObject } from "cloudflare:workers";

export interface Env {
  WORKFLOW: DurableObjectNamespace;
  AUDIT: D1Database;
  ARTIFACTS: R2Bucket;
  AI: Ai;
  DOCUMENT_HOST: Fetcher;
  EMAIL_EXECUTOR: Fetcher;
  FAKES: Fetcher;
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
    if (url.pathname === "/version") {
      return Response.json({ deployable: "apf-gateway", contracts: env.CONTRACTS_VERSION, killSwitch: env.KILL_SWITCH === "true", wired: false });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    return Response.json({ error: "NOT_WIRED", message: "apf-gateway skeleton: platform not wired yet (NAVRHOVY-LIST-farma.md, step 2)" }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
