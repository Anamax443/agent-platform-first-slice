// Test doubles of the external systems (registry, DMS, archive) behind a real network hop: the HTTP surface of the
// apf-fakes Worker (docs/NAVRHOVY-LIST-farma.md, D5) and, in tests, the same handler called in process over
// Request/Response so that the client adapters meet exactly the protocol they will meet on the farm. Every mode is read
// from a chaos source on every call (KV on the farm, a Map in tests): a test flips a failure mode without redeploying.
// Not a component of the norm: no descriptor, no policy; the platform only ever sees the adapter contracts.
import { createHash } from "node:crypto";
import type { DmsMode, DmsStatusMode } from "./dms.js";
import { FakeRegistryAdapter, RegistryBusinessError, RegistryUnavailable, type RegistryMode } from "./registry.js";

/** Chaos switches, read on every call. Keys: registry.mode, registry.delayMs, dms.mode, dms.status. */
export interface ChaosSource {
  get(key: string): Promise<string | null>;
}

/** Durable state of the doubles (what the DMS and the archive have written), keyed by clientRef. */
export interface FakesStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface FakesDeps {
  chaos: ChaosSource;
  store: FakesStore;
  /** Used when the chaos source has no value for a key. Strings on purpose: they come from Worker vars and are validated like KV values. */
  defaults?: { registry?: string; dms?: string; dmsStatus?: string; registryDelayMs?: number };
  /** Bearer values the doubles expect; the same values the document host holds as secrets. Absent = every write refused. */
  secrets: { dms?: string | undefined; archive?: string | undefined };
}

export const REGISTRY_MODES: readonly RegistryMode[] = ["ok", "timeout", "unavailable", "business", "nonsense-range", "nonsense-semantic"];
/** Over HTTP `crash-after-write` cannot kill the caller's process: the write happens and the answer is lost (= unknown-always). */
export const DMS_MODES: readonly DmsMode[] = ["ok", "unknown-once", "unknown-always", "crash-after-write", "auth-fail"];
export const DMS_STATUS_MODES: readonly DmsStatusMode[] = ["ok", "unknown"];
const DEFAULT_REGISTRY_DELAY_MS = 10_000;
export const CHAOS_KEYS = ["registry.mode", "registry.delayMs", "dms.mode", "dms.status"] as const;

interface Chaos {
  registry: RegistryMode;
  registryDelayMs: number;
  dms: DmsMode;
  dmsStatus: DmsStatusMode;
  /** Chaos keys whose value is not a known mode; a call under an invalid key is refused, never guessed. */
  invalid: string[];
}

async function readChaos(d: FakesDeps): Promise<Chaos> {
  const [registry, delay, dms, dmsStatus] = await Promise.all(CHAOS_KEYS.map((k) => d.chaos.get(k)));
  const invalid: string[] = [];
  const pick = <T extends string>(key: string, value: string | null | undefined, fallback: string | undefined, allowed: readonly T[]): T => {
    const v = value ?? fallback ?? allowed[0];
    if ((allowed as readonly string[]).includes(v as string)) return v as T;
    invalid.push(`${key}=${v}`);
    return allowed[0] as T;
  };
  const delayMs = delay === null || delay === undefined ? (d.defaults?.registryDelayMs ?? DEFAULT_REGISTRY_DELAY_MS) : Number(delay);
  const delayOk = Number.isFinite(delayMs) && delayMs >= 0;
  if (!delayOk) invalid.push(`registry.delayMs=${delay}`);
  return {
    registry: pick("registry.mode", registry, d.defaults?.registry, REGISTRY_MODES),
    registryDelayMs: delayOk ? delayMs : DEFAULT_REGISTRY_DELAY_MS,
    dms: pick("dms.mode", dms, d.defaults?.dms, DMS_MODES),
    dmsStatus: pick("dms.status", dmsStatus, d.defaults?.dmsStatus, DMS_STATUS_MODES),
    invalid,
  };
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const refOf = (prefix: string, clientRef: string): string => `${prefix}-${createHash("sha256").update(clientRef).digest("hex").slice(0, 12)}`;

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => undefined);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
};

/** Every named field present as a non-empty string, or nothing (400 at the caller). */
const strings = (body: Record<string, unknown>, keys: string[]): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = body[k];
    if (typeof v !== "string" || v.length === 0) return undefined;
    out[k] = v;
  }
  return out;
};

const bearer = (request: Request): string | undefined => {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : undefined;
};

/** The same clientRef always yields the same record: the DMS keeps clientRef as the identity of the write (W3). */
interface DmsRecord {
  bytes: string;
  ref: string;
}

export const ENDPOINTS = ["GET /version", "GET /health", "GET /chaos", "POST /registry/lookup", "POST /dms/stamp", "GET /dms/status?clientRef", "GET /dms/read?clientRef", "POST /archive/put"] as const;

const chaosView = (c: Chaos) => ({ registry: c.registry, registryDelayMs: c.registryDelayMs, dms: c.dms, dmsStatus: c.dmsStatus, invalid: c.invalid });

export async function handleFakes(request: Request, deps: FakesDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/version" && method === "GET") {
    return json({ deployable: "apf-fakes", wired: true, endpoints: ENDPOINTS, chaos: chaosView(await readChaos(deps)), secrets: { dms: Boolean(deps.secrets.dms), archive: Boolean(deps.secrets.archive) } });
  }
  if (path === "/health" && method === "GET") return json({ ok: true, wired: true });
  if (path === "/chaos" && method === "GET") {
    return json({ ...chaosView(await readChaos(deps)), keys: CHAOS_KEYS, modes: { registry: REGISTRY_MODES, dms: DMS_MODES, dmsStatus: DMS_STATUS_MODES } });
  }

  if (path === "/registry/lookup" && method === "POST") {
    const input = strings(await readJson(request), ["documentType"]);
    if (!input) return json({ error: "BAD_REQUEST", message: "documentType (string) required" }, 400);
    const chaos = await readChaos(deps);
    if (chaos.invalid.length) return json({ error: "CHAOS_MODE_UNKNOWN", invalid: chaos.invalid }, 500);
    // A timeout is the caller's deadline, not ours: the double just answers late (and after the delay it answers as "ok").
    if (chaos.registry === "timeout") await sleep(chaos.registryDelayMs);
    const registry = new FakeRegistryAdapter(chaos.registry === "timeout" ? "ok" : chaos.registry);
    try {
      return json(await registry.lookup(input.documentType as string));
    } catch (e) {
      if (e instanceof RegistryUnavailable) return json({ error: "REGISTRY_UNAVAILABLE" }, 503);
      if (e instanceof RegistryBusinessError) return json({ error: "REGISTRY_BUSINESS", code: e.code }, 422);
      throw e;
    }
  }

  if (path.startsWith("/dms/")) {
    const chaos = await readChaos(deps);
    if (chaos.invalid.length) return json({ error: "CHAOS_MODE_UNKNOWN", invalid: chaos.invalid }, 500);
    if (!deps.secrets.dms) return json({ error: "AUTH_FAILED", message: "the DMS double has no DMS_SECRET; nothing can authenticate" }, 401);
    if (bearer(request) !== deps.secrets.dms || chaos.dms === "auth-fail") return json({ error: "AUTH_FAILED" }, 401);

    if (path === "/dms/stamp" && method === "POST") {
      const input = strings(await readJson(request), ["bytes", "stampText", "clientRef"]);
      if (!input) return json({ error: "BAD_REQUEST", message: "bytes, stampText, clientRef (strings) required" }, 400);
      const clientRef = input.clientRef as string;
      const key = `dms:${clientRef}`;
      const existing = await deps.store.get(key);
      const record: DmsRecord = existing ? (JSON.parse(existing) as DmsRecord) : { bytes: `${input.bytes}\n--- ${input.stampText} ---`, ref: refOf("dms", clientRef) };
      if (!existing) await deps.store.put(key, JSON.stringify(record)); // the side effect happened, whatever the answer below
      if (chaos.dms === "unknown-once") {
        const seen = await deps.store.get(`dms-unknown:${clientRef}`);
        if (!seen) {
          await deps.store.put(`dms-unknown:${clientRef}`, "1");
          return json({ error: "UNKNOWN_OUTCOME", reconciliationRef: clientRef }, 500);
        }
      }
      if (chaos.dms === "unknown-always" || chaos.dms === "crash-after-write") return json({ error: "UNKNOWN_OUTCOME", reconciliationRef: clientRef }, 500);
      return json(record);
    }
    const clientRef = url.searchParams.get("clientRef");
    if (!clientRef) return json({ error: "BAD_REQUEST", message: "clientRef required" }, 400);
    if (path === "/dms/status" && method === "GET") {
      if (chaos.dmsStatus === "unknown") return json({ status: "UNKNOWN" });
      return json({ status: (await deps.store.get(`dms:${clientRef}`)) ? "DONE" : "NOT_FOUND" });
    }
    if (path === "/dms/read" && method === "GET") {
      const record = await deps.store.get(`dms:${clientRef}`);
      return record ? json(JSON.parse(record) as DmsRecord) : json({ error: "NOT_FOUND", clientRef }, 404);
    }
  }

  if (path === "/archive/put" && method === "POST") {
    if (!deps.secrets.archive) return json({ error: "AUTH_FAILED", message: "the archive double has no ARCHIVE_SECRET; nothing can authenticate" }, 401);
    if (bearer(request) !== deps.secrets.archive) return json({ error: "AUTH_FAILED" }, 401);
    const input = strings(await readJson(request), ["bytes", "sha256", "clientRef"]);
    if (!input) return json({ error: "BAD_REQUEST", message: "bytes, sha256, clientRef (strings) required" }, 400);
    const clientRef = input.clientRef as string;
    const key = `archive:${clientRef}`;
    const existing = await deps.store.get(key);
    const record = existing ? (JSON.parse(existing) as { bytes: string; sha256: string; ref: string }) : { bytes: input.bytes as string, sha256: input.sha256 as string, ref: refOf("arch", clientRef) };
    if (!existing) await deps.store.put(key, JSON.stringify(record));
    return json({ ref: record.ref });
  }

  return json({ error: "NOT_FOUND", endpoints: ENDPOINTS }, 404);
}
