// apf-mail-ingest: skeleton. Step 4 wires the email() handler: buffer message.raw once, run mail.ingest through the
// ExecutorHost (R2 put under sha256), then start mail-intake.v1 at the gateway. Until then inbound mail is rejected,
// which Email Routing reports back to the sender as a bounce: better than silently accepting and dropping.
export interface Env {
  ARTIFACTS: R2Bucket;
  GATEWAY: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  MAX_RAW_BYTES: string;
  MAX_MAILS_PER_DAY: string;
  SIGNING_PUBLIC_KEYS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, wired: false });
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    return Response.json({ error: "NOT_WIRED", message: "apf-mail-ingest skeleton" }, { status: 501 });
  },
  async email(message: ForwardableEmailMessage): Promise<void> {
    message.setReject("apf-mail-ingest is not wired yet");
  },
} satisfies ExportedHandler<Env>;
