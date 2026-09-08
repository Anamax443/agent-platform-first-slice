import type { HandlerOutcome } from "./types.js";

export interface IdempotencyRecord {
  status: "RESERVED" | "DONE";
  fingerprint: string;
  outcome?: HandlerOutcome;
}

/**
 * Durable store behind ExecutorHost's dedup (found 2026-09-08, Posudek 5/6: on the farm
 * apf-document-host is a stateless Worker — ExecutorHost is rebuilt fresh on every request and
 * its old in-memory Map dedupped nothing in production). `reserveOrGet` is the atomic primitive
 * the design needs: a Cloudflare-backed implementation (one Durable Object per dedup key) gives
 * true single-threaded serialization, closing the check-then-act race a plain get/set store
 * (like a D1 table) cannot close on its own.
 */
export interface IdempotencyStore {
  /** Read-only; never reserves. Test/observability only (mirrors the old `remembered()`). */
  peek(dedupKey: string): Promise<IdempotencyRecord | undefined>;
  /** Atomically: unseen key -> reserved and returns undefined (caller proceeds); seen key -> the existing record. */
  reserveOrGet(dedupKey: string, fingerprint: string): Promise<IdempotencyRecord | undefined>;
  /** A reservation resolves to a durable, dedupable outcome (SUCCEEDED / UNKNOWN_OUTCOME). */
  resolve(dedupKey: string, outcome: HandlerOutcome): Promise<void>;
  /** A reservation is abandoned (outcome was FAILED before any side effect) — a later attempt may reserve again. */
  release(dedupKey: string): Promise<void>;
}

/** In-process default: a single JS thread makes this trivially atomic. Same role as InMemoryReviewTaskStore. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();

  async peek(dedupKey: string): Promise<IdempotencyRecord | undefined> {
    return this.map.get(dedupKey);
  }

  async reserveOrGet(dedupKey: string, fingerprint: string): Promise<IdempotencyRecord | undefined> {
    const existing = this.map.get(dedupKey);
    if (existing) return existing;
    this.map.set(dedupKey, { status: "RESERVED", fingerprint });
    return undefined;
  }

  async resolve(dedupKey: string, outcome: HandlerOutcome): Promise<void> {
    const existing = this.map.get(dedupKey);
    this.map.set(dedupKey, { status: "DONE", fingerprint: existing?.fingerprint ?? "", outcome });
  }

  async release(dedupKey: string): Promise<void> {
    this.map.delete(dedupKey);
  }
}
