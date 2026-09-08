// Agent Registry (SEVERKA.md item 4): a deterministic capability catalog derived from module descriptors already
// validated by Router.register(). Read-only introspection over what's already true, never a second source of
// authorization — Router.route() alone decides what may execute (FOUNDATION-core §3.3), this only describes it.
export interface CapabilityDescriptorLike {
  readonly name: string;
  readonly riskClass?: string;
  readonly sideEffects?: string;
  readonly isolationClass?: string;
  readonly trustClass?: string;
  readonly requiredScopes?: readonly string[];
  readonly usesLlm?: boolean;
  readonly conformanceTier?: string;
}

export interface ModuleDescriptorLike {
  readonly module: string;
  readonly componentVersion?: string;
  readonly capabilities: readonly CapabilityDescriptorLike[];
}

export interface CapabilityRecord {
  capability: string;
  version: string;
  module: string;
  componentVersion?: string;
  riskClass?: string;
  sideEffects?: string;
  isolationClass?: string;
  trustClass?: string;
  requiredScopes?: readonly string[];
  usesLlm?: boolean;
  conformanceTier?: string;
}

/**
 * The capability names a descriptor declares. Used to derive cross-Worker dispatch tables from the descriptor
 * itself instead of hand-duplicating them as a separate literal (the drift risk: a capability added to a
 * descriptor without also updating a hand-typed list elsewhere would silently misroute or fall to notWired).
 */
export function capabilityNamesOf(descriptor: ModuleDescriptorLike): string[] {
  return descriptor.capabilities.map((c) => c.name);
}

/** One catalog row for a capability actually registered on a Router, carrying the risk/isolation metadata Router.providers() discards. */
export function catalogEntry(descriptor: ModuleDescriptorLike, capability: string, version: string): CapabilityRecord {
  const c = descriptor.capabilities.find((x) => x.name === capability);
  return {
    capability,
    version,
    module: descriptor.module,
    ...(descriptor.componentVersion ? { componentVersion: descriptor.componentVersion } : {}),
    ...(c?.riskClass ? { riskClass: c.riskClass } : {}),
    ...(c?.sideEffects ? { sideEffects: c.sideEffects } : {}),
    ...(c?.isolationClass ? { isolationClass: c.isolationClass } : {}),
    ...(c?.trustClass ? { trustClass: c.trustClass } : {}),
    ...(c?.requiredScopes ? { requiredScopes: c.requiredScopes } : {}),
    ...(c?.usesLlm !== undefined ? { usesLlm: c.usesLlm } : {}),
    ...(c?.conformanceTier ? { conformanceTier: c.conformanceTier } : {}),
  };
}
