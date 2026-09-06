import { createHash } from "node:crypto";
import { utf8ByteLength } from "./bytes.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface Artifact {
  artifactId: string;
  tenantId: string;
  sha256: string;
  bytes: string;
  receivedAt: string;
  receivedFrom: string;
  derivedFrom?: string;
  producer?: string;
}

/** The store cannot accept another original (RES-STOR-001): the caller must fail explicitly, never pretend acceptance. */
export class StorageFull extends Error {
  constructor(public readonly capacityBytes: number) {
    super(`artifact store full (capacity ${capacityBytes} bytes)`);
    this.name = "StorageFull";
  }
}

/** Read-only view given to components through platform/api. */
export interface ArtifactReader {
  get(artifactId: string): Artifact | undefined;
}

/** Write side for executors: new originals (ingest) and derivations; never overwrite. */
export interface ArtifactWriter extends ArtifactReader {
  put(input: { tenantId: string; bytes: string; receivedFrom: string }): Artifact;
  derive(originalId: string, bytes: string, producer: string): Artifact;
}

/** Immutable original artifacts + derived artifacts with provenance (FOUNDATION-core §7, EVD-001). */
export class ArtifactStore implements ArtifactWriter {
  private readonly items = new Map<string, Artifact>();
  private usedBytes = 0;

  constructor(
    private readonly clock: Clock,
    private readonly opts: { capacityBytes?: number } = {},
  ) {}

  put(input: { tenantId: string; bytes: string; receivedFrom: string }): Artifact {
    this.ensureCapacity(input.bytes);
    const a: Artifact = {
      artifactId: newId("art"),
      tenantId: input.tenantId,
      sha256: sha256(input.bytes),
      bytes: input.bytes,
      receivedAt: iso(this.clock.now()),
      receivedFrom: input.receivedFrom,
    };
    this.store(a);
    return { ...a };
  }

  derive(originalId: string, bytes: string, producer: string): Artifact {
    const orig = this.items.get(originalId);
    if (!orig) throw new Error(`original ${originalId} not found`);
    this.ensureCapacity(bytes);
    const a: Artifact = {
      artifactId: newId("art"),
      tenantId: orig.tenantId,
      sha256: sha256(bytes),
      bytes,
      receivedAt: iso(this.clock.now()),
      receivedFrom: producer,
      derivedFrom: originalId,
      producer,
    };
    this.store(a);
    return { ...a };
  }

  get(artifactId: string): Artifact | undefined {
    const a = this.items.get(artifactId);
    return a ? { ...a } : undefined;
  }

  count(): number {
    return this.items.size;
  }

  private ensureCapacity(bytes: string): void {
    const cap = this.opts.capacityBytes;
    if (cap !== undefined && this.usedBytes + utf8ByteLength(bytes) > cap) throw new StorageFull(cap);
  }

  /** The only write path; a second write to an existing id is a programming error, not an update. */
  private store(a: Artifact): void {
    if (this.items.has(a.artifactId)) throw new Error(`artifact ${a.artifactId} already exists: artifacts are immutable`);
    this.items.set(a.artifactId, Object.freeze({ ...a }));
    this.usedBytes += utf8ByteLength(a.bytes);
  }
}
