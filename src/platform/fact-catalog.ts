// Fact catalog (SEVERKA "Slovník faktů", Posudek 17): the semantic namespace (contracts/facts.v1.json) joined with each
// module's fact-flow sidecar (src/components/<module>/facts.json) — which capability consumes and produces which key.
// Pure validation and lookup over keys and kinds. Structurally it cannot hold a business value: an entry field outside
// the contract is refused at build time, so the one thing a planner is allowed to read is also the one thing that can
// never carry data (SEVERKA "Hlavní invariant: farmář nesmí nosit hodnoty"). Loading files is the caller's job (tests,
// build scripts) — same rule as registry.ts: no node:fs here, the platform never knows where the repo is.

export type FactKind = "fact" | "artifact" | "evidence" | "effect";
export type FactAuthority = "source" | "derived";

export interface FactEntry {
  readonly key: string;
  readonly kind: FactKind;
  readonly type?: string;
  readonly authority?: FactAuthority;
  /** Evidence only: the fact whose value this evidence attests (Evidence.inputField semantics). */
  readonly for?: string;
  /** Evidence only: the closed set of Evidence.result values the producer seals. */
  readonly resultVocabulary?: readonly string[];
  readonly description?: string;
}

export interface FactNamespace {
  readonly $comment?: string;
  readonly schemaVersion: string;
  readonly facts: readonly FactEntry[];
}

export interface FactFlowSide {
  readonly artifacts?: readonly string[];
  readonly facts?: readonly string[];
  readonly evidence?: readonly string[];
  /** produces only — an effect is a result in the outside world, never an input. */
  readonly effects?: readonly string[];
}

export interface FactFlow {
  readonly consumes?: FactFlowSide;
  readonly produces?: FactFlowSide;
}

/** One module's sidecar: `capabilities` is keyed by capability name and must equal the descriptor's set (FACT-004). */
export interface ModuleFacts {
  readonly $comment?: string;
  readonly module: string;
  readonly capabilities: Readonly<Record<string, FactFlow>>;
}

export interface CapabilityFlow {
  readonly capability: string;
  readonly module: string;
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
}

export type FactCatalogErrorCode =
  | "NAMESPACE_VERSION"
  | "INVALID_KEY"
  | "DUPLICATE_KEY"
  | "INVALID_KIND"
  | "UNKNOWN_FIELD"
  | "EVIDENCE_TARGET"
  | "DUPLICATE_MODULE"
  | "DUPLICATE_CAPABILITY"
  | "UNKNOWN_GROUP"
  | "UNKNOWN_KEY"
  | "KIND_MISMATCH"
  | "SELF_PRODUCE"
  | "EMPTY_PRODUCES";

export class FactCatalogError extends Error {
  constructor(
    readonly code: FactCatalogErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FactCatalogError";
  }
}

// Explicit annotation on purpose: TypeScript narrows after a `never`-returning call only when the callee's
// declaration itself carries the type (otherwise `if (!e) fail(...)` leaves `e` possibly undefined below).
const fail: (code: FactCatalogErrorCode, message: string) => never = (code, message) => {
  throw new FactCatalogError(code, message);
};

/** Dotted lowerCamel segments, at least two: supplier.companyId, document.type.validated. */
const KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const KINDS: readonly FactKind[] = ["fact", "artifact", "evidence", "effect"];
const AUTHORITIES: readonly FactAuthority[] = ["source", "derived"];
const ENTRY_FIELDS: ReadonlySet<string> = new Set(["key", "kind", "type", "authority", "for", "resultVocabulary", "description"]);
const CONSUME_GROUPS: Readonly<Record<string, FactKind>> = { artifacts: "artifact", facts: "fact", evidence: "evidence" };
const PRODUCE_GROUPS: Readonly<Record<string, FactKind>> = { ...CONSUME_GROUPS, effects: "effect" };
const byName = (a: { capability: string }, b: { capability: string }): number => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0);

export class FactCatalog {
  private constructor(
    private readonly entries: ReadonlyMap<string, FactEntry>,
    private readonly flows: ReadonlyMap<string, CapabilityFlow>,
    private readonly producers: ReadonlyMap<string, readonly CapabilityFlow[]>,
  ) {}

  /** Fail-closed: any inconsistency between the namespace and a sidecar throws with a FactCatalogErrorCode. */
  static build(namespace: FactNamespace, modules: readonly ModuleFacts[]): FactCatalog {
    if (namespace.schemaVersion !== "1") fail("NAMESPACE_VERSION", `expected schemaVersion "1", got ${JSON.stringify(namespace.schemaVersion)}`);
    const entries = new Map<string, FactEntry>();
    for (const e of namespace.facts) {
      for (const f of Object.keys(e)) {
        if (!ENTRY_FIELDS.has(f)) fail("UNKNOWN_FIELD", `${String(e.key)}: "${f}" is not a fact-entry field (the namespace names facts, it never carries values)`);
      }
      if (typeof e.key !== "string" || !KEY.test(e.key)) fail("INVALID_KEY", `${JSON.stringify(e.key)} (expected dotted lowerCamel segments, e.g. supplier.companyId)`);
      if (entries.has(e.key)) fail("DUPLICATE_KEY", e.key);
      if (!KINDS.includes(e.kind)) fail("INVALID_KIND", `${e.key}: kind ${JSON.stringify(e.kind)}`);
      if (e.authority !== undefined && !AUTHORITIES.includes(e.authority)) fail("INVALID_KIND", `${e.key}: authority ${JSON.stringify(e.authority)}`);
      entries.set(e.key, e);
    }
    for (const e of entries.values()) {
      if (e.kind === "evidence") {
        const target = e.for === undefined ? undefined : entries.get(e.for);
        if (!target || target.kind !== "fact") fail("EVIDENCE_TARGET", `${e.key}: evidence must name the fact it attests via "for" (got ${JSON.stringify(e.for)})`);
      } else if (e.for !== undefined || e.resultVocabulary !== undefined) {
        fail("EVIDENCE_TARGET", `${e.key}: "for"/"resultVocabulary" belong to evidence only`);
      }
    }

    const flows = new Map<string, CapabilityFlow>();
    const seenModules = new Set<string>();
    for (const m of modules) {
      if (seenModules.has(m.module)) fail("DUPLICATE_MODULE", m.module);
      seenModules.add(m.module);
      for (const [capability, flow] of Object.entries(m.capabilities)) {
        const other = flows.get(capability);
        if (other) fail("DUPLICATE_CAPABILITY", `${capability} declared by ${other.module} and ${m.module}`);
        const consumes = collect(entries, `${capability} consumes`, flow.consumes ?? {}, CONSUME_GROUPS);
        const produces = collect(entries, `${capability} produces`, flow.produces ?? {}, PRODUCE_GROUPS);
        if (produces.length === 0) fail("EMPTY_PRODUCES", `${capability}: a capability that produces no key can never be planned`);
        for (const k of produces) if (consumes.includes(k)) fail("SELF_PRODUCE", `${capability}: ${k} both consumed and produced`);
        flows.set(capability, { capability, module: m.module, consumes, produces });
      }
    }

    // Producers of a key in a fixed (name) order: the planner's choice among them must not depend on file order.
    const producers = new Map<string, CapabilityFlow[]>();
    for (const f of [...flows.values()].sort(byName)) {
      for (const k of f.produces) {
        const list = producers.get(k) ?? [];
        list.push(f);
        producers.set(k, list);
      }
    }
    return new FactCatalog(entries, flows, producers);
  }

  entry(key: string): FactEntry | undefined {
    return this.entries.get(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  capabilities(): string[] {
    return [...this.flows.keys()].sort();
  }

  flowOf(capability: string): CapabilityFlow | undefined {
    return this.flows.get(capability);
  }

  producersOf(key: string): readonly CapabilityFlow[] {
    return this.producers.get(key) ?? [];
  }
}

function collect(entries: ReadonlyMap<string, FactEntry>, where: string, side: FactFlowSide, groups: Readonly<Record<string, FactKind>>): string[] {
  const out: string[] = [];
  for (const [group, keys] of Object.entries(side)) {
    const kind = groups[group];
    if (!kind) fail("UNKNOWN_GROUP", `${where}: group "${group}" (allowed: ${Object.keys(groups).join(", ")})`);
    for (const key of keys ?? []) {
      const e = entries.get(key);
      if (!e) fail("UNKNOWN_KEY", `${where}.${group}: ${key} is not in the fact namespace`);
      if (e.kind !== kind) fail("KIND_MISMATCH", `${where}.${group}: ${key} is ${e.kind === "evidence" ? "" : "an "}${e.kind}, not ${kind === "evidence" ? "" : "an "}${kind}`);
      if (out.includes(key)) fail("DUPLICATE_KEY", `${where}: ${key} listed twice`);
      out.push(key);
    }
  }
  return out;
}
