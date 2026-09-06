// apf-document-host: skeleton. Step 2 wires ExecutorHost + stamp/archive handlers from src/components/document-executor-host.
export interface Env {
  ARTIFACTS: R2Bucket;
  GATEWAY: Fetcher;
  FAKES: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  SIGNING_PUBLIC_KEYS: string;
  DMS_SECRET?: string;
  ARCHIVE_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, wired: false });
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    return Response.json({ error: "NOT_WIRED", message: "apf-document-host skeleton" }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
