// DispatchTransport: how a caller (orchestrator, harness) gets a command to the router. Two runtimes, one contract:
// in-process (gateway + router in the same process) and HTTP (a gateway on the farm behind Cloudflare Access).
import type { Gateway } from "./gateway.js";
import type { Router } from "./router.js";
import { validateContract } from "./schemas.js";
import type { MessageEnvelope, ResultEnvelope } from "./types.js";

export interface DispatchTransport {
  /** Deliver one command as the given actor and return its result envelope. Never throws for a DENY: that is a FAILED result. */
  dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope>;
}

/** Gateway and router in one process. The trusted context is created here from the actor identity. */
export class InProcessTransport implements DispatchTransport {
  constructor(
    private readonly gateway: Gateway,
    private readonly router: Router,
  ) {}

  dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope> {
    return this.router.route(this.gateway.dispatch(message, actorId));
  }
}

export interface HttpTransportOptions {
  /** Gateway origin, e.g. https://apf.example (installation profile channels.apiHost). */
  baseUrl: string;
  /** The one identity this client is authenticated as (Access service token / API key). */
  actorId: string;
  /** Authentication headers per request; the gateway derives the actor from them, never from the body. */
  headers: () => Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * HTTP client to a remote gateway. The body carries ONLY the message: the actor is whoever the transport credentials
 * authenticate as, so a caller cannot pick another identity by argument (F4). The response must be a valid ResultEnvelope.
 */
export class HttpDispatchTransport implements DispatchTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpTransportOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope> {
    if (actorId !== this.opts.actorId) {
      throw new Error(`transport is authenticated as ${this.opts.actorId}, cannot dispatch as ${actorId}`);
    }
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.opts.headers() },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`gateway answered HTTP ${res.status}`);
    const body: unknown = await res.json();
    const v = validateContract("result-envelope", body);
    if (!v.ok) throw new Error(`gateway returned an invalid result envelope: ${v.errors}`);
    return body as ResultEnvelope;
  }
}
