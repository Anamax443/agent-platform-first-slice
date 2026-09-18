// Reliability Gate RG2-A (2026-09-18): src/platform/copyout-artifacts.ts's own tests — the ordering-safe half of
// apf-gateway's copyOut() (index.ts cannot be loaded under plain-Node vitest, see that file's own header). Same
// real-SQL-via-node:sqlite pattern tests/artifact-refcount.test.ts already uses for r2-refcount.ts's own table —
// against the real R2_REF_DDL schema, not a mock, so "the ref claim is still there afterward" is a genuine SQL
// read, not an assumption about in-memory state.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/platform/artifacts.js";
import { copyOutArtifacts, r2KeyOf, type BlobStore } from "../src/platform/copyout-artifacts.js";
import { R2_REF_DDL, SqliteR2RefCounter, type R2RefCounter } from "../src/platform/r2-refcount.js";
import { tmpDir } from "./harness/index.js";
import { openAsyncSql } from "./harness/sqlite.js";

async function realRefCounter() {
  const d1 = openAsyncSql(join(tmpDir(), "d1.sqlite"));
  await d1.sql.run(R2_REF_DDL);
  return { counter: new SqliteR2RefCounter(d1.sql), close: () => d1.close() };
}

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  artifactId: "art-1",
  tenantId: "tenant-a",
  sha256: "deadbeef",
  bytes: "hello",
  receivedAt: "2026-09-18T12:00:00.000Z",
  receivedFrom: "test",
  ...overrides,
});

/** In-memory BlobStore fake — `putThrows` stands in for a real R2 outage mid-write; `exists` stands in for a
 * key another Case already wrote (head() finds it, so put() is correctly skipped either way). */
function fakeBlobs(opts: { putThrows?: boolean; exists?: boolean } = {}) {
  const putCalls: string[] = [];
  const headCalls: string[] = [];
  const blobs: BlobStore & { putCalls: string[]; headCalls: string[] } = {
    putCalls,
    headCalls,
    head: async (key: string) => {
      headCalls.push(key);
      return opts.exists ?? false;
    },
    put: async (key: string) => {
      putCalls.push(key);
      if (opts.putThrows) throw new Error("blob put failed (simulated R2 outage)");
    },
  };
  return blobs;
}

describe("copyOutArtifacts — ordering invariant: claim the r2_ref BEFORE treating a key as in use", () => {
  it("ref-claim succeeds, the subsequent blob-write throws -> the ref claim is still durably present afterward (a sibling instance's hasAny()/purge() correctly refuses to delete)", async () => {
    const f = await realRefCounter();
    const blobs = fakeBlobs({ putThrows: true });
    const a = artifact();
    const markCopiedCalls: string[] = [];

    await expect(
      copyOutArtifacts(
        { refCounter: f.counter, blobs, markCopied: (id) => markCopiedCalls.push(id), onClaimFailed: () => { throw new Error("must not be called: the claim itself must succeed in this scenario"); } },
        { workflowId: "wf-A", artifacts: [a], uncopiedIds: new Set([a.artifactId]) },
      ),
    ).rejects.toThrow("blob put failed");

    // The invariant this test exists to prove, verbatim from copyout-artifacts.ts's own header: even though the
    // OVERALL call rejected (the blob write threw), the ref claim that ran BEFORE it already committed to D1 — a
    // sibling Case releasing its own claim on the same key must still see this workflow's row and refuse to
    // delete the shared blob (releaseR2Ref()'s safeToDelete would be false, not true).
    expect(await f.counter.hasAny(r2KeyOf(a))).toBe(true);
    // And precisely because the write never finished, this artifact is correctly NOT marked copied — the next
    // copyOut() pass must still see it as uncopied and retry the blob write.
    expect(markCopiedCalls).toEqual([]);
    f.close();
  });

  it("the ref-claim itself fails -> the blob write is never attempted at all, and the artifact is left for the next pass", async () => {
    const throwingCounter: R2RefCounter = {
      addRef: async () => {
        throw new Error("D1 unavailable");
      },
      release: async () => {},
      hasAny: async () => false,
    };
    const blobs = fakeBlobs();
    const a = artifact();
    const markCopiedCalls: string[] = [];
    const claimFailures: string[] = [];

    const result = await copyOutArtifacts(
      { refCounter: throwingCounter, blobs, markCopied: (id) => markCopiedCalls.push(id), onClaimFailed: (id) => claimFailures.push(id) },
      { workflowId: "wf-A", artifacts: [a], uncopiedIds: new Set([a.artifactId]) },
    );

    expect(result.anyRefClaimFailed).toBe(true);
    expect(claimFailures).toEqual([a.artifactId]);
    // Ordering invariant, the other direction: a claim that never lands must never let this artifact be treated
    // as "in use" — put()/head() are never even reached.
    expect(blobs.putCalls).toEqual([]);
    expect(blobs.headCalls).toEqual([]);
    expect(markCopiedCalls).toEqual([]);
  });

  it("happy path: claim lands, the blob is written, the artifact is marked copied, and the result reports no claim failure", async () => {
    const f = await realRefCounter();
    const blobs = fakeBlobs();
    const a = artifact();
    const markCopiedCalls: string[] = [];

    const result = await copyOutArtifacts(
      { refCounter: f.counter, blobs, markCopied: (id) => markCopiedCalls.push(id), onClaimFailed: () => { throw new Error("must not be called"); } },
      { workflowId: "wf-A", artifacts: [a], uncopiedIds: new Set([a.artifactId]) },
    );

    expect(result.anyRefClaimFailed).toBe(false);
    expect(await f.counter.hasAny(r2KeyOf(a))).toBe(true);
    expect(blobs.putCalls).toEqual([r2KeyOf(a)]);
    expect(markCopiedCalls).toEqual([a.artifactId]);
    f.close();
  });

  it("an already-copied artifact (not in uncopiedIds — a binary original, arrives with `location` already set) still gets its ref claimed, but head()/put()/markCopied() never run", async () => {
    const f = await realRefCounter();
    const blobs = fakeBlobs();
    const a = artifact({ artifactId: "art-binary", location: "originals/tenant-a/deadbeef" });
    const markCopiedCalls: string[] = [];

    const result = await copyOutArtifacts(
      { refCounter: f.counter, blobs, markCopied: (id) => markCopiedCalls.push(id), onClaimFailed: () => { throw new Error("must not be called"); } },
      { workflowId: "wf-A", artifacts: [a], uncopiedIds: new Set() }, // deliberately NOT in uncopiedIds
    );

    expect(result.anyRefClaimFailed).toBe(false);
    // Still claimed — this is R0's whole point for a binary original: it never appears in `.uncopied()` (it
    // arrives already `copied = 1`), so if this loop skipped ref-claiming it too, it would look permanently
    // unreferenced to a sibling Case's purge() from the very first moment.
    expect(await f.counter.hasAny(r2KeyOf(a))).toBe(true);
    expect(blobs.putCalls).toEqual([]);
    expect(blobs.headCalls).toEqual([]);
    expect(markCopiedCalls).toEqual([]);
    f.close();
  });
});
