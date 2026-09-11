// apf-email-executor (SEVERKA.md item 3, second half): email.send as its own Worker, isolation PRINCIPAL — the only
// write capability it has is the Email Sending binding, reached only by a signed dispatch from apf-gateway over the
// EMAIL_EXECUTOR service binding. Mirrors apf-document-host's /dispatch structure (celek D2); the one structural
// difference is the artifact fetch-back is read-only here (email.send only references an artifact, never derives one).
import { createPublicKey } from "node:crypto";
import { installation } from "apf:installation";
import { FakeSmtpAdapter } from "../../../../src/adapters/smtp.js";
import * as email from "../../../../src/components/email-executor/handler.js";
import type { RecipientDirectory } from "../../../../src/components/email-executor/handler.js";
import { credentialTable, type SecretsSource } from "../../../../src/installation.js";
import type { Artifact, ArtifactReader } from "../../../../src/platform/artifacts.js";
import { SystemClock } from "../../../../src/platform/clock.js";
import { CredentialResolver } from "../../../../src/platform/credentials.js";
import { ExecutorHost } from "../../../../src/platform/executor-host.js";
import type { IdempotencyRecord, IdempotencyStore } from "../../../../src/platform/idempotency.js";
import { policyFor } from "../../../../src/platform/policy.js";
import { capabilityNamesOf, catalogOf } from "../../../../src/platform/registry.js";
import { Router } from "../../../../src/platform/router.js";
import { KeyRegistry } from "../../../../src/platform/signing.js";
import { transportFailure } from "../../../../src/platform/transport.js";
import type { DispatchEnvelope, HandlerOutcome } from "../../../../src/platform/types.js";
import { IdempotencyLedger } from "./idempotency-ledger.js";
import { GATEWAY_ORIGIN, RelayAudit } from "./relay-audit.js";
import { CloudflareSmtpAdapter } from "./smtp-adapter.js";

export { IdempotencyLedger };

export interface Env {
  EMAIL: SendEmail;
  ARTIFACTS: R2Bucket;
  IDEMPOTENCY: DurableObjectNamespace<IdempotencyLedger>;
  GATEWAY: Fetcher;
  HOST_ID: string;
  ISOLATION_CLASS: string;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  SIGNING_PUBLIC_KEYS: string;
  SEND_MODE: "sandbox" | "live";
  /** Set by scripts/farm-config.mjs; must equal the installation the bundle was built from. */
  INSTALLATION: string;
}

// "Secrets: none" is the point of PRINCIPAL (wrangler.jsonc) — the send_email binding itself is the authorization,
// there is no separate secret value to protect. This fixed value only satisfies CredentialResolver's fail-closed
// "no undefined secret" check; CloudflareSmtpAdapter ignores it, FakeSmtpAdapter's own default matches it exactly.
const SMTP_CREDENTIAL_VALUE = "smtp-secret";
const secretsOf = (): SecretsSource => (ref) => (ref === email.SMTP_CREDENTIAL ? SMTP_CREDENTIAL_VALUE : undefined);

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

interface FetchedArtifact {
  artifactId: string;
  tenantId: string;
  sha256: string;
  bytes: string;
  contentType?: string;
}

/** GET the one artifact this dispatch references from the instance that owns it, before the synchronous Router ever runs. */
async function fetchArtifact(gateway: Fetcher, workflowId: string, artifactId: string): Promise<FetchedArtifact | undefined> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await gateway.fetch(`${GATEWAY_ORIGIN}/workflow/${workflowId}/artifact/${artifactId}`);
  } catch (e) {
    console.error(`[apf-email-executor] artifact fetch unreachable workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms): ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (!res.ok) {
    console.error(`[apf-email-executor] artifact fetch HTTP ${res.status} workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms)`);
    return undefined;
  }
  console.log(`[apf-email-executor] artifact fetch ok workflowId=${workflowId} artifactId=${artifactId} (${Date.now() - t0}ms)`);
  return (await res.json().catch(() => undefined)) as FetchedArtifact | undefined;
}

/** Read-only: email.send only references an artifact via payload.params.artifactId, never derives one (unlike
 * apf-document-host's SingleArtifactStore, which also needs derive() for the stamp/archive write). */
class ReadOnlyArtifactStore implements ArtifactReader {
  constructor(private readonly fetched: FetchedArtifact | undefined) {}
  get(artifactId: string): Artifact | undefined {
    if (!this.fetched || this.fetched.artifactId !== artifactId) return undefined;
    return {
      artifactId: this.fetched.artifactId,
      tenantId: this.fetched.tenantId,
      sha256: this.fetched.sha256,
      bytes: this.fetched.bytes,
      receivedAt: "",
      receivedFrom: "apf-gateway",
      ...(this.fetched.contentType ? { contentType: this.fetched.contentType } : {}),
    };
  }
}

const artifactIdOf = (envelope: DispatchEnvelope): string | undefined => {
  const params = (envelope.message.payload as { params?: unknown } | undefined)?.params as { artifactId?: unknown } | undefined;
  return typeof params?.artifactId === "string" ? params.artifactId : undefined;
};

/** Adapts the durable per-key IdempotencyLedger object to ExecutorHost's IdempotencyStore contract.
 * Duplicated from apf-document-host/src/index.ts's DurableIdempotencyStore — same reasoning as
 * idempotency-ledger.ts itself: each deployable stays self-contained. */
class DurableIdempotencyStore implements IdempotencyStore {
  constructor(private readonly namespace: DurableObjectNamespace<IdempotencyLedger>) {}

  private stubFor(dedupKey: string): DurableObjectStub<IdempotencyLedger> {
    return this.namespace.get(this.namespace.idFromName(dedupKey));
  }

  async peek(dedupKey: string): Promise<IdempotencyRecord | undefined> {
    const r = await this.stubFor(dedupKey).peek(dedupKey);
    return r && { status: r.status, fingerprint: r.fingerprint, ...(r.outcomeJson ? { outcome: JSON.parse(r.outcomeJson) as HandlerOutcome } : {}) };
  }

  async reserveOrGet(dedupKey: string, fingerprint: string): Promise<IdempotencyRecord | undefined> {
    const r = await this.stubFor(dedupKey).reserveOrGet(dedupKey, fingerprint);
    return r && { status: r.status, fingerprint: r.fingerprint, ...(r.outcomeJson ? { outcome: JSON.parse(r.outcomeJson) as HandlerOutcome } : {}) };
  }

  async resolve(dedupKey: string, outcome: HandlerOutcome): Promise<void> {
    await this.stubFor(dedupKey).resolve(dedupKey, JSON.stringify(outcome));
  }

  async release(dedupKey: string): Promise<void> {
    await this.stubFor(dedupKey).release(dedupKey);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (env.INSTALLATION !== installation.profile.installation) {
      return Response.json({ error: "INSTALLATION_MISMATCH", bundle: installation.profile.installation, vars: env.INSTALLATION }, { status: 500 });
    }

    if (url.pathname === "/version") {
      const { keyIds } = keyRegistryFrom(env.SIGNING_PUBLIC_KEYS);
      return Response.json({ deployable: env.HOST_ID, isolation: env.ISOLATION_CLASS, wired: true, capabilities: capabilityNamesOf(email.descriptor), signingKeys: keyIds, sendMode: env.SEND_MODE });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, wired: true });
    // Agent Registry (SEVERKA.md item 4): the descriptor's own declared endpoint (endpoints.capabilities), read-only, no live Router needed.
    if (url.pathname === "/capabilities") return Response.json({ deployable: env.HOST_ID, capabilities: catalogOf(email.descriptor) });

    if (url.pathname === "/dispatch" && request.method === "POST") {
      const t0 = Date.now();
      const envelope = (await request.json().catch(() => undefined)) as DispatchEnvelope | undefined;
      if (!envelope?.message?.capability || !envelope.context || !envelope.binding) {
        console.error(`[apf-email-executor] /dispatch received a malformed body (missing message/context/binding)`);
        return Response.json({ error: "BAD_REQUEST", message: "expected a DispatchEnvelope {message, context, binding}" }, { status: 400 });
      }
      console.log(`[apf-email-executor] /dispatch received ${envelope.message.capability} correlationId=${envelope.message.correlationId} workflowId=${envelope.message.workflowId ?? "-"} actor=${envelope.context.actorId}`);

      const clock = new SystemClock();
      const audit = new RelayAudit(clock, env.GATEWAY, ctx);
      // Wiring failures must never surface as an uncaught exception (same reasoning as apf-document-host,
      // celek D2): RemoteHostTransport on the gateway side has no try/catch around transport.dispatch().
      try {
        const artifactId = artifactIdOf(envelope);
        const fetched = artifactId && envelope.message.workflowId ? await fetchArtifact(env.GATEWAY, envelope.message.workflowId, artifactId) : undefined;
        const artifacts = new ReadOnlyArtifactStore(fetched);

        const credentials = new CredentialResolver(credentialTable(installation, secretsOf(), { [email.SEND_HANDLER_ID]: [email.SMTP_CREDENTIAL] }), audit);
        // Defined before ExecutorHost below: its own §3.3 steps 5-6 (effect-field validation, approval)
        // need policy too, not just Router.register(). No review-task store is wired on this deployable
        // today (email.send has approval.required:false) — checkApproval() still fails closed
        // (APPROVAL_REQUIRED) if a future policy ever sets approval.required:true here.
        const policy = policyFor(installation.policies, "email.send", "1");
        const executor = new ExecutorHost({ hostId: env.HOST_ID, clock, audit, credentials, idempotency: new DurableIdempotencyStore(env.IDEMPOTENCY), policyFor: () => policy });

        const recipients: RecipientDirectory = (tenantId, ref) => policy.recipientAllowlist?.[tenantId]?.[ref];
        const smtp = env.SEND_MODE === "live" ? new CloudflareSmtpAdapter(env.EMAIL, env.EMAIL_FROM, env.EMAIL_FROM_NAME) : new FakeSmtpAdapter();
        executor.register(email.createEmailSendHandler({ artifacts, smtp, credentials, recipients, clock }));

        const { registry } = keyRegistryFrom(env.SIGNING_PUBLIC_KEYS);
        const router = new Router({ registry, clock, audit, lifecycle: installation.lifecycle });
        router.register({
          descriptor: email.descriptor as never,
          policies: { "email.send": policy },
          capabilities: [{ name: "email.send", version: "1", inputSchema: email.inputSchema, handler: executor.handlerFor("email.send") }],
        });

        const result = await router.route(envelope);
        console.log(`[apf-email-executor] /dispatch done ${envelope.message.capability} status=${result.status} correlationId=${envelope.message.correlationId} (${Date.now() - t0}ms)`);
        await audit.flush();
        return Response.json(result);
      } catch (e) {
        console.error(`[apf-email-executor] /dispatch wiring threw for ${envelope.message.capability} correlationId=${envelope.message.correlationId} (${Date.now() - t0}ms): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        await audit.flush();
        return Response.json(transportFailure(envelope.message, "DEPENDENCY_UNAVAILABLE", `apf-email-executor wiring failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
