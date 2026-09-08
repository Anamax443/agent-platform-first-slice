// apf-mail-ingest (SEVERKA.md item 3, second real write-type, first event-driven case): receives real mail through
// Email Routing, buffers the raw message once, and forwards it to the gateway's POST /mail-intake — the gateway
// resolves the tenant and dispatches mail.ingest (step 1 of mail-intake.v2) itself. This Worker never touches the
// artifact store directly; it is the event source, not the executor.
export interface Env {
  ARTIFACTS: R2Bucket;
  GATEWAY: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  MAX_RAW_BYTES: string;
  MAX_MAILS_PER_DAY: string;
  SIGNING_PUBLIC_KEYS: string;
  /** Installation value (config/<installation>/farm.json): who mail-intake.v2's notify step tells when it finishes. */
  DEFAULT_NOTIFY_REF: string;
}

const GATEWAY_ORIGIN = "https://apf-gateway.internal";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, wired: true });
    if (url.pathname === "/health") return Response.json({ ok: true, wired: true });
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },

  // Note (known gap, not addressed by this step): MAX_MAILS_PER_DAY is declared but not enforced — real rate
  // limiting needs durable per-day state (KV/DO), out of scope for finishing the skeleton.
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const maxBytes = Number(env.MAX_RAW_BYTES) || 1_048_576;
    if (message.rawSize > maxBytes) {
      console.error(`[apf-mail-ingest] rejected: message too large (${message.rawSize} > ${maxBytes} bytes) from=${message.from}`);
      message.setReject(`message too large (limit ${maxBytes} bytes)`);
      return;
    }

    let rawMail: string;
    try {
      rawMail = await new Response(message.raw).text();
    } catch (e) {
      console.error(`[apf-mail-ingest] could not buffer message.raw from=${message.from}: ${e instanceof Error ? e.message : String(e)}`);
      message.setReject("could not read message body");
      return;
    }
    if (!rawMail.trim()) {
      message.setReject("empty message");
      return;
    }

    let res: Response;
    try {
      res = await env.GATEWAY.fetch(`${GATEWAY_ORIGIN}/mail-intake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawMail, receivedFrom: message.from, notifyRef: env.DEFAULT_NOTIFY_REF }),
      });
    } catch (e) {
      console.error(`[apf-mail-ingest] gateway unreachable from=${message.from}: ${e instanceof Error ? e.message : String(e)}`);
      message.setReject("intake temporarily unavailable");
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[apf-mail-ingest] gateway rejected intake HTTP ${res.status} from=${message.from}: ${body}`);
      message.setReject("intake rejected the message");
      return;
    }
    const result = (await res.json().catch(() => undefined)) as { workflowId?: string } | undefined;
    console.log(`[apf-mail-ingest] mail-intake started workflowId=${result?.workflowId ?? "-"} from=${message.from}`);
  },
} satisfies ExportedHandler<Env>;
