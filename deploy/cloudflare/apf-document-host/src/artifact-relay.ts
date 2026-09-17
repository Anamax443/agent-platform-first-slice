// Split out of index.ts so it can be unit-tested without pulling in the "apf:installation" wrangler alias — same
// reasoning as relay-audit.ts (see its header comment), and reusing its GatewayFetcher/GATEWAY_ORIGIN rather than
// redeclaring them.
//
// Fixes the notify-step production bug (found live on farm-bass443, every mail-intake instance, all day
// 2026-09-17): document.stamp's derived artifact (SingleArtifactStore.derive() in index.ts) was minted in this
// Worker's memory and its bytes copied to R2 via ctx.waitUntil ALONE — never awaited before /dispatch responded, and
// never registered with the gateway at all. The gateway's WorkflowInstance object is the only place
// GET /workflow/:id/artifact/:id can answer from, so a derived artifact that never reaches it 404s forever: the
// later email.send step's resourceTenant() check (handler.ts) got NOT_FOUND from that 404 and executor-host.ts
// failed closed with RESOURCE_TENANT_UNRESOLVED — SECURITY class, retryable:false, so it never self-healed.
//
// The first fix attempted here awaited the relay only right before the /dispatch handler responded (mirroring
// RelayAudit's fix for the 2026-09-07 audit-loss incident). Review the same day (2026-09-17) found that was not
// enough on its own: ExecutorHost commits a SUCCEEDED outcome to its idempotency ledger the instant the handler
// returns (executor-host.ts step 9-10) — strictly before any /dispatch-level check runs — and the gateway
// orchestrator reuses the same idempotencyKey across technical/DEPENDENCY retries. So a relay that failed AFTER a
// handler had already returned SUCCEEDED would resolve the ledger with an artifactId nobody could look up, and a
// retry would then replay that cached outcome forever (executor-host.ts's reserveOrGet cache hit never calls the
// handler again) — permanently poisoned, worse than the original always-fails bug. The real fix is in
// stamp-handler.ts: `ArtifactWriter.flush()` is now awaited INSIDE the handler, before it decides SUCCEEDED vs
// FAILED, so a relay failure becomes a genuine handler FAILED and the reservation is released (retryable), never
// resolved. What remains here is `relayDerivedArtifact` (the actual work: R2 write + gateway registration, used by
// SingleArtifactStore's flush() in index.ts) and `settleRelayOrFail`, a dispatch-level backstop that awaits
// whatever relay flush() started (a no-op if the handler already awaited it — flush() only ever awaits its own
// already-started promises, never re-relays) so the HTTP response itself is never sent while anything is still
// genuinely in flight.
import { transportFailure } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";
import { GATEWAY_ORIGIN, type GatewayFetcher } from "./relay-audit.js";
import type { Artifact } from "../../../../src/platform/artifacts.js";

/** The subset of R2Bucket's head/put this module needs. Structural, like relay-audit.ts's GatewayFetcher: the real
 * binding satisfies it, and a test double can too, without pulling in @cloudflare/workers-types here. */
export interface DerivedArtifactBucket {
  head(key: string): Promise<unknown>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}

export class RelayFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayFailedError";
  }
}

/**
 * Copies one derived artifact's bytes to R2 (head-then-put dedup — the same key scheme and dedup check
 * SingleArtifactStore.derive() used to do internally, in index.ts, before this split) and registers it with the
 * gateway's POST /workflow/:id/artifact route. Both steps are awaited in full: on any failure this throws
 * RelayFailedError rather than resolving, so the caller (SingleArtifactStore.flush() in index.ts, awaited inline by
 * stamp-handler.ts) can turn a would-be SUCCEEDED handler outcome into a genuine, retryable FAILED one instead of
 * reporting success for a derived artifact nobody else can ever look up.
 */
export async function relayDerivedArtifact(artifact: Artifact, workflowId: string, bucket: DerivedArtifactBucket, gateway: GatewayFetcher): Promise<void> {
  const key = `derived/${artifact.tenantId}/${artifact.sha256}`;
  let exists: unknown;
  try {
    exists = await bucket.head(key);
  } catch {
    exists = undefined; // same "assume absent, let put() settle it" fallback SingleArtifactStore.derive() used
  }
  if (!exists) {
    try {
      await bucket.put(key, artifact.bytes, {
        httpMetadata: { contentType: artifact.contentType },
        customMetadata: { artifactId: artifact.artifactId, ...(artifact.derivedFrom ? { derivedFrom: artifact.derivedFrom } : {}), ...(artifact.producer ? { producer: artifact.producer } : {}) },
      });
    } catch (e) {
      throw new RelayFailedError(`R2 write failed for derived artifact ${artifact.artifactId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const body = {
    artifactId: artifact.artifactId,
    tenantId: artifact.tenantId,
    sha256: artifact.sha256,
    contentType: artifact.contentType ?? "text/plain",
    byteLength: new TextEncoder().encode(artifact.bytes).byteLength,
    location: key,
    receivedFrom: artifact.receivedFrom,
    ...(artifact.derivedFrom ? { derivedFrom: artifact.derivedFrom } : {}),
    ...(artifact.name ? { name: artifact.name } : {}),
  };
  let res: Response;
  try {
    res = await gateway.fetch(`${GATEWAY_ORIGIN}/workflow/${workflowId}/artifact`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new RelayFailedError(`gateway unreachable registering derived artifact ${artifact.artifactId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new RelayFailedError(`gateway answered HTTP ${res.status} registering derived artifact ${artifact.artifactId}`);
}

/**
 * Dispatch-level backstop: awaits whatever relay(s) `flush` already knows about and folds a SUCCEEDED router result
 * into a retryable FAILED one if any relay fails — the same shape transportFailure() already builds for this
 * Worker's other wiring failures (index.ts's own catch block), so the gateway orchestrator's existing
 * technicalRetries path retries document.stamp exactly as it would any other DEPENDENCY failure.
 *
 * `flush` is SingleArtifactStore.flush() (index.ts): it only ever awaits promises `derive()` already started, never
 * starts a new relay — so calling it again here after stamp-handler.ts already awaited it inline is a genuine no-op
 * (no double R2 write, no double gateway registration attempt, which would 409/error since artifact ids are
 * insert-only). This exists as a second, independent guarantee that the HTTP response is never sent while a relay
 * is still genuinely in flight — belt and suspenders with the handler-level await, not a replacement for it (see
 * this file's header comment for why the handler-level await is the one that actually closes the idempotency race).
 *
 * Returns `result` unchanged without even calling `flush` when the dispatch did not succeed in the first place —
 * relaying only matters for a result the caller is about to hand back as fact, and document.archive (which derives
 * nothing) never has anything for `flush` to do anyway.
 */
export async function settleRelayOrFail(result: ResultEnvelope, flush: () => Promise<void>, message: MessageEnvelope): Promise<ResultEnvelope> {
  if (result.status !== "SUCCEEDED") return result;
  try {
    await flush();
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[apf-document-host] relaying a derived artifact to the gateway failed for workflowId=${message.workflowId ?? "-"}: ${detail}`);
    return transportFailure(message, "DEPENDENCY_UNAVAILABLE", `apf-document-host: relaying a derived artifact to the gateway failed: ${detail}`);
  }
}
