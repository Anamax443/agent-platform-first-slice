// The apf-fakes Worker without the Worker: chaos in a Map, state in a Map, the same protocol handler, a client that
// calls it directly over Request/Response. Shared by tests/fakes.test.ts (registry) and tests/dh.test.ts (DMS, archive,
// unit D) so both meet exactly the protocol the farm's apf-fakes deployable runs.
import { handleFakes, type FakesDeps } from "../../src/adapters/fakes-http.js";
import { HttpRegistryAdapter, type HttpClient } from "../../src/adapters/registry.js";
import { HttpDmsAdapter } from "../../src/adapters/dms.js";
import { HttpArchiveAdapter } from "../../src/adapters/archive.js";

export interface WorldOptions {
  chaos?: Record<string, string>;
  secrets?: FakesDeps["secrets"];
}

export function world(o: WorldOptions = {}) {
  const chaos = new Map<string, string>(Object.entries(o.chaos ?? {}));
  const store = new Map<string, string>();
  const deps: FakesDeps = {
    chaos: { get: async (k) => chaos.get(k) ?? null },
    store: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => {
        store.set(k, v);
      },
    },
    secrets: o.secrets ?? { dms: "dms-secret", archive: "archive-secret" },
  };
  const client: HttpClient = { fetch: (url, init) => handleFakes(new Request(url, init), deps) };
  const call = (path: string, init?: RequestInit) => handleFakes(new Request(`https://fakes.test${path}`, init), deps);
  return {
    chaos,
    store,
    deps,
    client,
    call,
    registry: new HttpRegistryAdapter(client),
    dms: new HttpDmsAdapter(client),
    archive: new HttpArchiveAdapter(client),
  };
}

export const postJson = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
