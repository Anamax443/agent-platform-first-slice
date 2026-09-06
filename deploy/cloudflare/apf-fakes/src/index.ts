// apf-fakes: skeleton. Step 2 exposes FakeDmsAdapter / FakeRegistryAdapter / FakeArchiveAdapter from src/adapters over HTTP,
// reading their modes from KV CHAOS on every call so a test can flip a failure mode without redeploying.
export interface Env {
  CHAOS: KVNamespace;
  STORE: KVNamespace;
  DEFAULT_DMS_MODE: string;
  DEFAULT_REGISTRY_MODE: string;
  DMS_SECRET?: string;
  ARCHIVE_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ deployable: "apf-fakes", wired: false });
    if (url.pathname === "/health") return Response.json({ ok: true, wired: false });
    if (url.pathname === "/chaos") {
      return Response.json({
        dms: (await env.CHAOS.get("dms.mode")) ?? env.DEFAULT_DMS_MODE,
        registry: (await env.CHAOS.get("registry.mode")) ?? env.DEFAULT_REGISTRY_MODE,
      });
    }
    return Response.json({ error: "NOT_WIRED", message: "apf-fakes skeleton" }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
