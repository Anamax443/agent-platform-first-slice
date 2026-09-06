// apf-email-executor: skeleton. Step 4 wires ExecutorHost + email.send handler from src/components/email-executor
// with an SmtpAdapter over the Email Sending binding (SEND_MODE=live) or the fake with chaos modes (SEND_MODE=sandbox).
export interface Env {
  EMAIL: SendEmail;
  ARTIFACTS: R2Bucket;
  GATEWAY: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  SIGNING_PUBLIC_KEYS: string;
  SEND_MODE: "sandbox" | "live";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, sendMode: env.SEND_MODE, wired: false });
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    return Response.json({ error: "NOT_WIRED", message: "apf-email-executor skeleton" }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
