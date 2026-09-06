// apf-fakes (docs/NAVRHOVY-LIST-farma.md, D5): the doubles of registry, DMS and archive behind a real network hop.
// Reachable only through service bindings (no route, no workers.dev). Chaos switches live in KV CHAOS and are read on
// every call (`wrangler kv key put registry.mode unavailable --namespace-id <id> --remote`); the doubles' state in KV
// STORE. Protocol and modes: src/adapters/fakes-http.ts; this file only binds them to the Worker's env.
import { handleFakes, type FakesStore } from "../../../../src/adapters/fakes-http.js";

export interface Env {
  CHAOS: KVNamespace;
  STORE: KVNamespace;
  DEFAULT_DMS_MODE: string;
  DEFAULT_REGISTRY_MODE: string;
  /** Secrets (wrangler secret put): the bearer values the doubles expect; the document host holds the same values. */
  DMS_SECRET?: string;
  ARCHIVE_SECRET?: string;
}

// KV is eventually consistent (edge cache up to 60 s). A status check right after a stamp must see that stamp, so the
// isolate keeps what it wrote in memory in front of KV (read-your-writes within one isolate; service-binding calls from
// one gateway object land in one location). Chaos keys are never written here, so they always come from KV.
const memory = new Map<string, string>();
const storeOf = (kv: KVNamespace): FakesStore => ({
  get: async (key) => memory.get(key) ?? (await kv.get(key)),
  put: async (key, value) => {
    memory.set(key, value);
    await kv.put(key, value);
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFakes(request, {
      chaos: { get: (key) => env.CHAOS.get(key) },
      store: storeOf(env.STORE),
      defaults: { registry: env.DEFAULT_REGISTRY_MODE, dms: env.DEFAULT_DMS_MODE },
      secrets: { dms: env.DMS_SECRET, archive: env.ARCHIVE_SECRET },
    });
  },
} satisfies ExportedHandler<Env>;
