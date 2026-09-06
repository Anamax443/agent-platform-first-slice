// DispatchTransport: how a caller (orchestrator, harness) gets a command to the router. Three runtimes, one contract:
// in-process (gateway + router in the same object), HTTP (a gateway on the farm behind Cloudflare Access, client-side),
// and a Cloudflare service binding to a remote host in the same account (gateway-side: it still signs, the binding is
// just the wire).
import { iso, SystemClock } from "./clock.js";
import { platformError, type PlatformCode } from "./errors.js";
import type { Gateway } from "./gateway.js";
import { newId } from "./ids.js";
import type { Router } from "./router.js";
import { validateContract } from "./schemas.js";
import type { MessageEnvelope, ResultEnvelope } from "./types.js";

export interface DispatchTransport {
  /** Deliver one command as the given actor and return its result envelope. Never throws, never rejects: the
   * orchestrator (orchestrator.ts) calls this with no try/catch, exactly like Router.route() and NotWiredTransport
   * never throw — a transport that cannot reach its target must still resolve to a FAILED ResultEnvelope. */
  dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope>;
}

/**
 * A FAILED ResultEnvelope for a message that could not be delivered or served at all (unreachable, bad response,
 * a receiver's own wiring failure). Found the hard way (celek D2): the first RemoteHostTransport run threw on a
 * non-2xx response and crashed the whole orchestrator.run(), because nothing above a transport catches — the same
 * latent bug was already in HttpDispatchTransport, just never exercised (zero callers before this). Exported so a
 * remote host (apf-document-host) can build the same shape for its own wiring failures, not just transports.
 */
export function transportFailure(message: MessageEnvelope, code: PlatformCode, detail: string): ResultEnvelope {
  // Console output, not the audit trail: this is a transport-level event (nothing was dispatched yet, so no capability
  // was ever "denied" in the ADR-016 sense), and it must be visible in `wrangler tail`/Workers Logs on its own, without
  // needing to reconstruct it from a returned ResultEnvelope after the fact (found the hard way, celek D2).
  console.error(`[transport] FAILED ${message.capability} code=${code} correlationId=${message.correlationId} workflowId=${message.workflowId ?? "-"} :: ${detail}`);
  const now = iso(new SystemClock().now());
  const res: ResultEnvelope = {
    messageId: newId("res"),
    inReplyTo: message.messageId,
    correlationId: message.correlationId,
    status: "FAILED",
    capability: message.capability,
    capabilityVersion: message.capabilityVersion,
    schemaVersion: message.schemaVersion,
    completedAt: now,
    error: platformError(code, detail),
  };
  if (message.workflowId) res.workflowId = message.workflowId;
  if (message.stepId) res.stepId = message.stepId;
  return res;
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
      return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `transport is authenticated as ${this.opts.actorId}, cannot dispatch as ${actorId}`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.opts.headers() },
        body: JSON.stringify({ message }),
      });
    } catch (e) {
      return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `gateway unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `gateway answered HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => undefined);
    const v = validateContract("result-envelope", body);
    if (!v.ok) return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `gateway returned an invalid result envelope: ${v.errors}`);
    return body as ResultEnvelope;
  }
}

/** The minimum of fetch a Cloudflare service binding gives (`env.SOME_HOST.fetch(...)`), or a plain fetch client in tests. */
export interface ServiceBindingLike {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Gateway and a remote Router across a Cloudflare service binding (celek D). The private key never leaves this side:
 * `gateway.dispatch()` builds and signs the envelope exactly as `InProcessTransport` does, only the resulting
 * `DispatchEnvelope` crosses the binding as JSON. The remote Router verifies independently with its own public key.
 */
export class RemoteHostTransport implements DispatchTransport {
  constructor(
    private readonly gateway: Gateway,
    private readonly binding: ServiceBindingLike,
    private readonly origin: string = "https://internal",
    private readonly path: string = "/dispatch",
  ) {}

  async dispatch(message: MessageEnvelope, actorId: string): Promise<ResultEnvelope> {
    const envelope = this.gateway.dispatch(message, actorId);
    let res: Response;
    try {
      res = await this.binding.fetch(`${this.origin}${this.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
    } catch (e) {
      return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `remote host unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // The remote host's own uncaught error (e.g. a missing secret) surfaces as a plain HTTP 500, not a ResultEnvelope:
      // that is still "this dependency isn't available right now", never a crash of the caller.
      return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `remote host answered HTTP ${res.status}`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    const v = validateContract("result-envelope", body);
    if (!v.ok) return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `remote host returned an invalid result envelope: ${v.errors}`);
    return body as ResultEnvelope;
  }
}
