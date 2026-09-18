// Reliability Gate RG2-A (2026-09-18): the ordering-safe half of apf-gateway's copyOut() (index.ts), extracted
// into its own file for the same reason fanout-retry.ts/alarm-scheduler.ts already are — index.ts imports
// "cloudflare:workers" and cannot be loaded under plain-Node vitest, and this batch of work's own rule requires
// tests to land in the same change as the fix (see fanout-retry.ts's file-level doc comment). `BlobStore` and
// `R2RefCounter` (r2-refcount.ts) below are the only two capabilities this loop needs, kept structural/narrow so
// this file never imports "@cloudflare/workers-types" or "cloudflare:workers" — index.ts's real `env.ARTIFACTS`
// (an R2Bucket) satisfies BlobStore as-is, no adapter needed.
//
// The bug this closes (confirmed independently against main@7333324 before writing this file): pre-RG2-A copyOut()
// did, in order, (1) R2 head/put per uncopied artifact, (2) markCopied(), (3) mirror audit, (4) mirror evidence,
// (5) registerR2Refs() LAST for every artifact, wrapped in one try/catch that only logs on a D1 failure. If step 5
// throws for an instance whose alarm rearmAlarm() later deletes (nothing else left pending), that instance's r2_ref
// claim is unregistered forever — a sibling Case's purge() sharing the same content-addressed key then sees zero
// refs and deletes a blob this instance still points at: unbounded, silent data loss, not a bounded leak.
//
// The fix, per artifact: claim the r2_ref FIRST. Only once that specific claim durably lands does this function
// treat the key as "in use" — ensuring the blob exists (head/put) and marking the artifact copied. An artifact
// whose claim throws is left exactly as it was (still `.uncopied()` if it was) for the NEXT copyOut() pass to
// retry; this function never swallows a failed claim and proceeds to put()/markCopied() for that same artifact the
// way the pre-RG2-A code effectively did (by registering refs only at the very end, after every put already ran).
// The governing invariant, verbatim (index.ts's copyOut() doc comment, durable-job.ts's own header):
//
//   "An orphaned reference-claim, or a blob nobody deletes because a stale claim says it's still used, is a
//   bounded, cosmetic leak. A live reference pointing at a blob some OTHER Case's purge() has already deleted is
//   unbounded, undetectable data loss. Every ordering decision in this file resolves in favor of the leak."
import type { Artifact } from "./artifacts.js";
import { registerR2Refs, type R2RefCounter } from "./r2-refcount.js";

/** Structural subset of Cloudflare's R2Bucket this loop needs (mirrors registerR2Refs's own narrow-adapter style
 * one file up) — `env.ARTIFACTS` satisfies this directly; a test passes an in-memory fake. */
export interface BlobStore {
  head(key: string): Promise<unknown>;
  put(key: string, bytes: string, opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface CopyOutArtifactsDeps {
  refCounter: R2RefCounter;
  blobs: BlobStore;
  /** Durable side effect for a successfully-claimed, previously-uncopied artifact (SqliteArtifacts.markCopied,
   * store.ts) — called only AFTER both the ref claim and the R2 write for that artifact have succeeded. */
  markCopied: (artifactId: string) => void;
  /** Observability only: called once per artifact whose ref claim threw this pass. Never rethrown — a failed
   * claim degrades that one artifact to "retried next pass", it must never abort the artifacts still to come in
   * this same loop (each artifact's ordering is independent of every other's). */
  onClaimFailed: (artifactId: string, err: unknown) => void;
}

export interface CopyOutArtifactsResult {
  /** True when at least one artifact's r2_ref claim failed this pass. The caller (index.ts's copyOut()) folds
   * this, together with whatever `.uncopied()` still reports afterward, into whether its durable copyout job
   * (durable-job.ts, store.ts's `durable_job` table) stays PENDING. */
  anyRefClaimFailed: boolean;
}

/** The R2 key formula, independently re-derived at copyOut(), purge(), startIntake() and
 * apf-document-host's relayDerivedArtifact() (r2-refcount.ts's own header has the full citation) — content-
 * addressed so two Cases receiving byte-identical content share one object by design. */
export const r2KeyOf = (a: Pick<Artifact, "location" | "derivedFrom" | "tenantId" | "sha256">): string => a.location ?? `${a.derivedFrom ? "derived" : "originals"}/${a.tenantId}/${a.sha256}`;

/**
 * Claims this instance's own r2_ref on every given artifact's key, in the claim-before-write order this file's
 * header explains, ensuring an R2 blob exists and marking it copied only for the subset `uncopiedIds` names (a
 * binary original already arrives copied — see store.ts's `artifact.copied` column and index.ts's copyOut() doc
 * comment for why it still needs a ref claim despite never reaching the put() branch here).
 */
export async function copyOutArtifacts(deps: CopyOutArtifactsDeps, input: { workflowId: string; artifacts: readonly Artifact[]; uncopiedIds: ReadonlySet<string> }): Promise<CopyOutArtifactsResult> {
  let anyRefClaimFailed = false;
  for (const a of input.artifacts) {
    const key = r2KeyOf(a);
    try {
      await registerR2Refs([{ r2Key: key, workflowId: input.workflowId, tenantId: a.tenantId }], deps.refCounter);
    } catch (e) {
      anyRefClaimFailed = true;
      deps.onClaimFailed(a.artifactId, e);
      continue; // ordering invariant: do not treat this key as "in use" (put/markCopied) until its claim durably lands
    }
    if (!input.uncopiedIds.has(a.artifactId)) continue; // already copied (binary original, or a prior pass)
    if (!(await deps.blobs.head(key))) {
      await deps.blobs.put(key, a.bytes, {
        httpMetadata: { contentType: a.contentType ?? "text/plain; charset=utf-8" },
        customMetadata: { artifactId: a.artifactId, receivedFrom: a.receivedFrom, receivedAt: a.receivedAt, ...(a.derivedFrom ? { derivedFrom: a.derivedFrom } : {}) },
      });
    }
    deps.markCopied(a.artifactId);
  }
  return { anyRefClaimFailed };
}
