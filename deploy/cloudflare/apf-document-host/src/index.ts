// apf-document-host (D2, docs/NAVRHOVY-LIST-farma.md): document.stamp and document.archive as their own Worker, reached
// only by a signed dispatch from apf-gateway over the DOCUMENT_HOST service binding. LOGICAL isolation: one Worker, two
// handlers, two secrets, the boundary between them is the CredentialResolver table, not the platform (SEC-HOST-001).
//
// Two problems this unit had to solve that the design sheet did not foresee (MEASUREMENT.md W21), found before writing
// any code: (1) the handlers read the document's bytes synchronously from ArtifactWriter/ArtifactReader, but this Worker
// has no local store — it pre-fetches the one artifact it needs from the gateway (GET /workflow/:id/artifact/:id) BEFORE
// building the Router, then hands the router a synchronous single-artifact reader; a derived artifact (the stamp) is
// likewise computed synchronously and copied to R2 afterwards via waitUntil, never awaited inline. (2) the gateway's
// public signing key must be known ahead of time: SIGNING_PUBLIC_KEYS (a var, populated from farm.json's
// $signingPublicKeys by scripts/farm-config.mjs) is the only source, so an installation without a real, persisted
// GATEWAY_SIGNING_KEY (local-fakes) cannot be verified against here — by design, not an oversight.
import { createPublicKey } from "node:crypto";
import { installation } from "apf:installation";
import { HttpArchiveAdapter } from "../../../../src/adapters/archive.js";
import { HttpDmsAdapter } from "../../../../src/adapters/dms.js";
import * as archiveHandler from "../../../../src/components/document-executor-host/archive-handler.js";
import * as host from "../../../../src/components/document-executor-host/stamp-handler.js";
import { credentialTable, type SecretsSource } from "../../../../src/installation.js";
import type { Artifact, ArtifactWriter } from "../../../../src/platform/artifacts.js";
import { sha256 } from "../../../../src/platform/artifacts.js";
import type { AuditRecord, AuditTrail } from "../../../../src/platform/audit.js";
import { iso, SystemClock, type Clock } from "../../../../src/platform/clock.js";
import { CredentialResolver } from "../../../../src/platform/credentials.js";
import { ExecutorHost } from "../../../../src/platform/executor-host.js";
import { newId } from "../../../../src/platform/ids.js";
import { policyFor } from "../../../../src/platform/policy.js";
import { Router } from "../../../../src/platform/router.js";
import { KeyRegistry } from "../../../../src/platform/signing.js";
import { transportFailure } from "../../../../src/platform/transport.js";
import type { DispatchEnvelope } from "../../../../src/platform/types.js";

export interface Env {
  ARTIFACTS: R2Bucket;
  GATEWAY: Fetcher;
  FAKES: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  /** JSON `{ keyId: { publicKeyPem, validFrom, validUntil? } }`, populated from config/<installation>/farm.json. */
  SIGNING_PUBLIC_KEYS: string;
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
  /** Secrets (wrangler secret put): values never appear in any file of this repo. */
  DMS_SECRET?: string;
  ARCHIVE_SECRET?: string;
}

const GATEWAY_ORIGIN = "https://apf-gateway.internal";
const SECRET_ENV_BY_REF: Record<string, keyof Env> = { "cred:dms-stamp": "DMS_SECRET", "cred:archive-store": "ARCHIVE_SECRET" };

const secretsOf =
  (env: Env): SecretsSource =>
  (ref) => {
    const name = SECRET_ENV_BY_REF[ref];
    const value = name ? env[name] : undefined;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

/** Public keys only, ever. A malformed or unknown entry is dropped, never guessed: verifyBinding then fails closed for it. */
function keyRegistryFrom(json: string): { registry: KeyRegistry; keyIds: string[] } {
  const registry = new KeyRegistry();
  const keyIds: string[] = [];
  let parsed: Record<string, { publicKeyPem: string; validFrom: string; validUntil?: string }>;
  try {
    parsed = JSON.parse(json || "{}") as typeof parsed;
  } catch {
    parsed = {};
  }
  for (const [keyId, rec] of Object.entries(parsed)) {
    try {
      registry.add({ keyId, publicKey: createPublicKey(rec.publicKeyPem), validFrom: rec.validFrom, ...(rec.validUntil ? { validUntil: rec.validUntil } : {}) });
      keyIds.push(keyId);
    } catch {
      /* malformed key material for this id: leave it unregistered rather than fail the whole registry */
    }
  }
  return { registry, keyIds };
}

/** Appends locally (for this request's evidence) and relays to the gateway's shared trail; never blocks the caller. */
class RelayAudit implements AuditTrail {
  private readonly records: AuditRecord[] = [];
  constructor(
    private readonly clock: Clock,
    private readonly gateway: Fetcher,
    private readonly ctx: ExecutionContext,
  ) {}

  append(record: Omit<AuditRecord, "auditId" | "at">): AuditRecord {
    const full: AuditRecord = { auditId: newId("aud"), at: iso(this.clock.now()), ...record };
    this.records.push(full);
    console.log(`[apf-document-host] ${full.kind} ${full.capability ?? ""} workflowId=${full.workflowId ?? "-"} correlationId=${full.correlationId ?? "-"} :: ${JSON.stringify(full.details ?? {})}`);
    this.ctx.waitUntil(
      this.gateway
        .fetch(`${GATEWAY_ORIGIN}/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(full) })
        .then((res) => {
          if (!res.ok) console.error(`[apf-document-host] audit relay to gateway answered HTTP ${res.status} for ${full.auditId}`);
        })
        .catch((e) => console.error(`[apf-document-host] audit relay to gateway unreachable for ${full.auditId}: ${e instanceof Error ? e.message : String(e)}`)),
    );
    return full;
  }
  all(): readonly AuditRecord[] {
    return [...this.records];
  }
  byKind(kind: AuditRecord["kind"]): AuditRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }
  byCorrelation(correlationId: string): AuditRecord[] {
    return this.records.filter((r) => r.correlationId === correlationId);
  }
}

interface FetchedArtifact {
  artifactId: string;
  tenantId: string;
  sha256: string;
  bytes: string;
  contentType?: string;
}

/** GET the one artifact this dispatch needs from the instance that owns it, before the synchronous Router ever runs. */
async function fetchArtifact(gateway: Fetcher, workflowId: string, artifactId: string): Promise<FetchedArtifact | undefined> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await gateway.fetch(`${GATEWAY_ORIGIN}/workflow/${workflowId}/artifact/${artifactId}`);
  } catch (e) {
    console.error(`[apf-document-host] artifact fetch unreachable workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms): ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (!res.ok) {
    console.error(`[apf-document-host] artifact fetch HTTP ${res.status} workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms)`);
    return undefined;
  }
  console.log(`[apf-document-host] artifact fetch ok workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms)`);
  return (await res.json().catch(() => undefined)) as FetchedArtifact | undefined;
}

/**
 * Synchronous ArtifactReader/Writer over exactly one pre-fetched artifact (W21). `derive()` computes the new artifact
 * in memory (the handler needs its id and hash immediately) and copies the bytes to R2 in the background; nothing here
 * ever awaits network I/O inline, so the synchronous Router/ExecutorHost chain never has to.
 */
class SingleArtifactStore implements ArtifactWriter {
  private readonly derived = new Map<string, Artifact>();
  constructor(
    private readonly original: FetchedArtifact | undefined,
    private readonly bucket: R2Bucket,
    private readonly ctx: ExecutionContext,
  ) {}

  get(artifactId: string): Artifact | undefined {
    if (this.original && this.original.artifactId === artifactId) {
      return {
        artifactId: this.original.artifactId,
        tenantId: this.original.tenantId,
        sha256: this.original.sha256,
        bytes: this.original.bytes,
        receivedAt: "",
        receivedFrom: "apf-gateway",
        ...(this.original.contentType ? { contentType: this.original.contentType } : {}),
      };
    }
    return this.derived.get(artifactId);
  }

  derive(originalId: string, bytes: string, producer: string, contentType = "text/plain"): Artifact {
    const orig = this.get(originalId);
    if (!orig) throw new Error(`original ${originalId} not found`);
    const a: Artifact = { artifactId: newId("art"), tenantId: orig.tenantId, sha256: sha256(bytes), bytes, receivedAt: new Date().toISOString(), receivedFrom: producer, derivedFrom: originalId, producer, contentType };
    this.derived.set(a.artifactId, a);
    const key = `derived/${a.tenantId}/${a.sha256}`;
    this.ctx.waitUntil(
      this.bucket
        .head(key)
        .then((exists) => (exists ? undefined : this.bucket.put(key, a.bytes, { httpMetadata: { contentType }, customMetadata: { artifactId: a.artifactId, derivedFrom: originalId, producer } })))
        .catch(() => undefined),
    );
    return a;
  }

  put(): Artifact {
    throw new Error("apf-document-host never ingests a new original; it only derives from one the gateway already holds");
  }
}

const artifactIdOf = (envelope: DispatchEnvelope): string | undefined => {
  const v = (envelope.message.payload as { artifactId?: unknown } | undefined)?.artifactId;
  return typeof v === "string" ? v : undefined;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (env.INSTALLATION !== installation.profile.installation) {
      return Response.json({ error: "INSTALLATION_MISMATCH", bundle: installation.profile.installation, vars: env.INSTALLATION }, { status: 500 });
    }

    if (url.pathname === "/version") {
      const { keyIds } = keyRegistryFrom(env.SIGNING_PUBLIC_KEYS);
      return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, wired: true, capabilities: ["document.stamp", "document.archive"], signingKeys: keyIds, secrets: { dms: Boolean(env.DMS_SECRET), archive: Boolean(env.ARCHIVE_SECRET) } });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: true });

    if (url.pathname === "/dispatch" && request.method === "POST") {
      const t0 = Date.now();
      const envelope = (await request.json().catch(() => undefined)) as DispatchEnvelope | undefined;
      if (!envelope?.message?.capability || !envelope.context || !envelope.binding) {
        console.error(`[apf-document-host] /dispatch received a malformed body (missing message/context/binding)`);
        return Response.json({ error: "BAD_REQUEST", message: "expected a DispatchEnvelope {message, context, binding}" }, { status: 400 });
      }
      console.log(`[apf-document-host] /dispatch received ${envelope.message.capability} correlationId=${envelope.message.correlationId} workflowId=${envelope.message.workflowId ?? "-"} actor=${envelope.context.actorId}`);

      const clock = new SystemClock();
      const audit = new RelayAudit(clock, env.GATEWAY, ctx);
      // Wiring (missing secret, bad policy) must never surface as an uncaught exception: RemoteHostTransport on the
      // gateway side has no try/catch around transport.dispatch() (orchestrator.ts calls it bare, like Router.route()),
      // so an uncaught throw here would crash the whole intake, not just this one step (found running this locally).
      try {
        const artifactId = artifactIdOf(envelope);
        const fetched = artifactId && envelope.message.workflowId ? await fetchArtifact(env.GATEWAY, envelope.message.workflowId, artifactId) : undefined;
        const artifacts = new SingleArtifactStore(fetched, env.ARTIFACTS, ctx);

        const credentials = new CredentialResolver(
          credentialTable(installation, secretsOf(env), { [host.STAMP_HANDLER_ID]: [host.STAMP_CREDENTIAL], [archiveHandler.ARCHIVE_HANDLER_ID]: [archiveHandler.ARCHIVE_CREDENTIAL] }),
          audit,
        );
        const executor = new ExecutorHost({ hostId: env.HOST_ID, clock, audit, credentials });
        executor.register(host.createStampHandler({ artifacts, dms: new HttpDmsAdapter(env.FAKES), credentials, clock }));
        executor.register(archiveHandler.createArchiveHandler({ artifacts, archive: new HttpArchiveAdapter(env.FAKES), credentials, clock }));

        const policy = (capability: string) => policyFor(installation.policies, capability, "1");
        const { registry } = keyRegistryFrom(env.SIGNING_PUBLIC_KEYS);
        const router = new Router({ registry, clock, audit });
        router.register({
          descriptor: host.descriptor as never,
          policies: { "document.stamp": policy("document.stamp"), "document.archive": policy("document.archive") },
          capabilities: [
            { name: "document.stamp", version: "1", inputSchema: host.stampInputSchema, handler: executor.handlerFor("document.stamp") },
            { name: "document.archive", version: "1", inputSchema: host.archiveInputSchema, handler: executor.handlerFor("document.archive") },
          ],
        });

        const result = await router.route(envelope);
        console.log(`[apf-document-host] /dispatch done ${envelope.message.capability} status=${result.status} correlationId=${envelope.message.correlationId} (${Date.now() - t0}ms)`);
        return Response.json(result);
      } catch (e) {
        console.error(`[apf-document-host] /dispatch wiring threw for ${envelope.message.capability} correlationId=${envelope.message.correlationId} (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return Response.json(transportFailure(envelope.message, "DEPENDENCY_UNAVAILABLE", `apf-document-host wiring failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
