export type LifecycleStatus = "ACTIVE" | "QUARANTINED";

/**
 * Operational status of a registered module — independent of what its (frozen) module-descriptor CLAIMS to
 * be. The descriptor says what a module IS (FOUNDATION-core §8); this says whether the platform currently
 * trusts it to run at all. Lives in installation config (config/<installation>/lifecycle.json, optional),
 * the same authority layer as Policy — never in the frozen contracts/module-descriptor.v1.schema.json
 * (docs/POSUDKY.md Posudek 7, Admission Gate discussion 2026-09-09).
 *
 * A block-list, not a mandatory allow-list: an unlisted module defaults to ACTIVE, so adding this onto
 * already-running components changes nothing until someone explicitly quarantines one. Healing a quarantined
 * module never flips the same entry back — a new build/version is admitted as its own, separately-tracked
 * identity (same reasoning as immutable workflow definitions: fix forward, never rewrite history).
 */
export class LifecycleRegistry {
  private readonly byModule = new Map<string, LifecycleStatus>();

  constructor(statuses: Record<string, LifecycleStatus> = {}) {
    for (const [module, status] of Object.entries(statuses)) this.byModule.set(module, status);
  }

  statusOf(module: string): LifecycleStatus {
    return this.byModule.get(module) ?? "ACTIVE";
  }
}
