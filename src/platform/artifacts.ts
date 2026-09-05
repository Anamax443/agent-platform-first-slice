import { createHash } from "node:crypto";
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

/** Read-only view given to components through platform/api. */
export interface ArtifactReader {
  get(artifactId: string): Artifact | undefined;
}

/** Write side for executors: derive only, never overwrite. */
export interface ArtifactWriter extends ArtifactReader {
  derive(originalId: string, bytes: string, producer: string): Artifact;
}

/** Immutable original artifacts + derived artifacts with provenance (FOUNDATION-core §7, EVD-001). */
export class ArtifactStore implements ArtifactWriter {
  private readonly items = new Map<string, Artifact>();
  constructor(private readonly clock: Clock) {}

  put(input: { tenantId: string; bytes: string; receivedFrom: string }): Artifact {
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

  /** The only write path; a second write to an existing id is a programming error, not an update. */
  private store(a: Artifact): void {
    if (this.items.has(a.artifactId)) throw new Error(`artifact ${a.artifactId} already exists: artifacts are immutable`);
    this.items.set(a.artifactId, Object.freeze({ ...a }));
  }
}
