export type LifecycleStatus = "ACTIVE" | "QUARANTINED";

/**
 * Operational status of a registered module — independent of what its (frozen) module-descriptor CLAIMS to
 * be. The descriptor says what a module IS (FOUNDATION-core §8); this says whether the platform currently
 * trusts it to run at all. Lives in installation config (config/<installation>/lifecycle.json), the same
 * authority layer as Policy — never in the frozen contracts/module-descriptor.v1.schema.json
 * (docs/POSUDKY.md Posudek 7, Admission Gate discussion 2026-09-09).
 *
 * A mandatory allow-list, not a block-list (changed 2026-09-10, external review + docs/SEVERKA.md Admission
 * Gate row: "unknown module -> ACTIVE" was the biggest gap between today's code and the Admission Gate vision
 * — a module the platform has never heard of must never be silently trusted). Every module a Router actually
 * dispatches to must have an explicit entry; a module missing from lifecycle.json entirely is refused exactly
 * like one explicitly QUARANTINED (MODULE_QUARANTINED) — fail-closed by omission, not by mistake. This is why
 * every real installation (config/farm-bass443, config/local-fakes) now ships its own lifecycle.json instead
 * of leaving it optional. Healing a quarantined module never flips the same entry back — a new build/version
 * is admitted as its own, separately-tracked identity (same reasoning as immutable workflow definitions: fix
 * forward, never rewrite history). NEW/TESTING/DEGRADED states and an automatic verification runner remain
 * future work (docs/SEVERKA.md) — today's registry is still just two states, ACTIVE and QUARANTINED.
 */
export class LifecycleRegistry {
  private readonly byModule = new Map<string, LifecycleStatus>();

  constructor(statuses: Record<string, LifecycleStatus> = {}) {
    for (const [module, status] of Object.entries(statuses)) this.byModule.set(module, status);
  }

  statusOf(module: string): LifecycleStatus {
    return this.byModule.get(module) ?? "QUARANTINED";
  }
}
