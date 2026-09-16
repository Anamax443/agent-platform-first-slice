// FACT family (Posudek 17, 15. 9. 2026): contracts/facts.v1.json (what a key MEANS) and src/components/*/facts.json (which
// keys each capability consumes/produces) must be one consistent, value-free catalog. Negative cases build a small
// synthetic namespace so each rule is shown to actually bite, not just to pass on today's files.
// FACT-005/006/007 (M0-FACT-CONTRACT-V1.md část A, krůček 1) add entities/scope to the same catalog and the
// canonical FactAddress form on top of it. A-adv-1/2/4 (a cow's own id ignored, reordering, a scope-less fact
// smuggling an entity) are intentionally NOT tested here yet — they need a real entity-issuing capability
// (platform assigns EntityId when a "many"-scope output is stored) that does not exist until M2's invoice.line;
// A-adv-3 (a malformed id, or an id on the wrong fact) is covered below since it's pure address validation.
import { describe, expect, it } from "vitest";
import { formatFactAddress, FactAddressError, newEntityId, parseFactAddress } from "../src/platform/fact-address.js";
import { CASE_SCOPE, FactCatalog, FactCatalogError, type EntityDecl, type FactNamespace, type ModuleFacts } from "../src/platform/fact-catalog.js";
import { loadComponents, loadNamespace, realCatalog } from "./harness/facts.js";

const ns = (facts: FactNamespace["facts"], entities?: readonly EntityDecl[]): FactNamespace => ({ schemaVersion: "1", facts, ...(entities ? { entities } : {}) });
const MINI = ns([
  { key: "doc.original", kind: "artifact" },
  { key: "doc.type", kind: "fact", type: "string", authority: "derived" },
  { key: "doc.type.validated", kind: "evidence", for: "doc.type" },
  { key: "doc.stored", kind: "effect" },
]);
const mod = (module: string, capabilities: ModuleFacts["capabilities"]): ModuleFacts => ({ module, capabilities });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FactCatalogError) return e.code;
    throw e;
  }
  return "OK";
};

describe("FACT-001 fact keys are unique, well-formed and carry no values", () => {
  it("the real namespace builds and is not empty", () => {
    expect(() => FactCatalog.build(loadNamespace(), [])).not.toThrow();
    expect(realCatalog().keys().length).toBeGreaterThan(0);
  });
  it("a duplicate key is refused", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact" }, { key: "a.b", kind: "fact" }]), []))).toBe("DUPLICATE_KEY");
  });
  it("a key that is not dotted lowerCamel is refused", () => {
    for (const bad of ["Supplier.id", "supplier", "supplier..id", "supplier.Id", "supplier_id.x", "supplier.id!"]) {
      expect(code(() => FactCatalog.build(ns([{ key: bad, kind: "fact" }]), [])), bad).toBe("INVALID_KEY");
    }
  });
  it("an entry field outside the contract (an example value, say) is refused", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact", value: "12345678" } as never]), []))).toBe("UNKNOWN_FIELD");
  });
  it("an unknown kind or authority is refused", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "thing" as never }]), []))).toBe("INVALID_KIND");
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact", authority: "guess" as never }]), []))).toBe("INVALID_KIND");
  });
  it("every real entry has a known kind and, for evidence, names the fact it attests", () => {
    const c = realCatalog();
    for (const key of c.keys()) {
      const e = c.entry(key);
      expect(e).toBeDefined();
      expect(["fact", "artifact", "evidence", "effect"]).toContain(e?.kind);
      if (e?.kind === "evidence") expect(c.entry(e.for ?? "")?.kind, `${key} for`).toBe("fact");
    }
  });
});

describe("FACT-002 every consumed key exists in the namespace", () => {
  it("real sidecars: every consumes key resolves", () => {
    const c = realCatalog();
    for (const cap of c.capabilities()) for (const k of c.flowOf(cap)?.consumes ?? []) expect(c.entry(k), `${cap} consumes ${k}`).toBeDefined();
  });
  it("an undeclared consumed key is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { facts: ["doc.missing"] }, produces: { facts: ["doc.type"] } } })]))).toBe("UNKNOWN_KEY");
  });
});

describe("FACT-003 every produced key exists in the namespace", () => {
  it("real sidecars: every produces key resolves", () => {
    const c = realCatalog();
    for (const cap of c.capabilities()) for (const k of c.flowOf(cap)?.produces ?? []) expect(c.entry(k), `${cap} produces ${k}`).toBeDefined();
  });
  it("an undeclared produced key is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { artifacts: ["doc.original"] }, produces: { facts: ["doc.invented"] } } })]))).toBe("UNKNOWN_KEY");
  });
  it("evidence that does not name the fact it attests is refused", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "a.b.verified", kind: "evidence" }]), []))).toBe("EVIDENCE_TARGET");
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "artifact" }, { key: "a.b.verified", kind: "evidence", for: "a.b" }]), []))).toBe("EVIDENCE_TARGET");
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact", resultVocabulary: ["PASS"] }]), []))).toBe("EVIDENCE_TARGET");
  });
});

describe("FACT-004 no component invents a fact, a capability or a kind", () => {
  it("every component has facts.json whose module and capability set equal its descriptor", () => {
    const components = loadComponents();
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) {
      expect(c.facts, `${c.module}/facts.json missing`).toBeDefined();
      expect(c.facts?.module).toBe(c.module);
      expect(c.descriptor.module).toBe(c.module);
      expect(Object.keys(c.facts?.capabilities ?? {}).sort()).toEqual(c.descriptor.capabilities.map((x) => x.name).sort());
    }
  });
  it("a key listed under the wrong group (evidence declared as a fact) is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { artifacts: ["doc.original"] }, produces: { facts: ["doc.type.validated"] } } })]))).toBe("KIND_MISMATCH");
  });
  it("an effect cannot be consumed and an unknown group is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { effects: ["doc.stored"] } as never, produces: { facts: ["doc.type"] } } })]))).toBe("UNKNOWN_GROUP");
  });
  it("a capability that produces nothing is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { artifacts: ["doc.original"] } } })]))).toBe("EMPTY_PRODUCES");
  });
  it("a capability that both consumes and produces the same key is refused", () => {
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": { consumes: { facts: ["doc.type"] }, produces: { facts: ["doc.type"] } } })]))).toBe("SELF_PRODUCE");
  });
  it("the same capability declared by two modules, or the same module twice, is refused", () => {
    const flow = { consumes: { artifacts: ["doc.original"] }, produces: { facts: ["doc.type"] } };
    expect(code(() => FactCatalog.build(MINI, [mod("m1", { "x.do": flow }), mod("m2", { "x.do": flow })]))).toBe("DUPLICATE_CAPABILITY");
    expect(code(() => FactCatalog.build(MINI, [mod("m", { "x.do": flow }), mod("m", { "y.do": flow })]))).toBe("DUPLICATE_MODULE");
  });
  it("producers of a key come back in name order regardless of sidecar order", () => {
    const flow = { consumes: { artifacts: ["doc.original"] }, produces: { facts: ["doc.type"] } };
    const a = FactCatalog.build(MINI, [mod("m1", { "z.do": flow }), mod("m2", { "a.do": flow })]).producersOf("doc.type").map((p) => p.capability);
    const b = FactCatalog.build(MINI, [mod("m2", { "a.do": flow }), mod("m1", { "z.do": flow })]).producersOf("doc.type").map((p) => p.capability);
    expect(a).toEqual(["a.do", "z.do"]);
    expect(b).toEqual(a);
  });
});

const LINE_ENTITY: EntityDecl = { type: "invoice.line", multiplicity: "many", identityFields: ["invoice.line.description"] };
const ENTITY_NS = ns(
  [
    { key: "invoice.line.description", kind: "fact", authority: "source", scope: "invoice.line" },
    { key: "invoice.line.accountCode", kind: "fact", authority: "derived", scope: "invoice.line" },
    { key: "supplier.companyId", kind: "fact", authority: "source" },
  ],
  [LINE_ENTITY],
);
const addressCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FactAddressError) return e.code;
    throw e;
  }
  return "OK";
};

describe("FACT-005 a fact's scope must name a declared entity, or the reserved case scope", () => {
  it("the real namespace builds with its first real entity, impulse.attachment (krůček 5)", () => {
    const catalog = realCatalog();
    const decl = catalog.entityOf("impulse.attachment");
    expect(decl).toEqual({ type: "impulse.attachment", of: "impulse.raw", multiplicity: "many", identityFields: ["impulse.attachment.sha256", "impulse.attachment.name"] });
    expect(catalog.scopeOf("impulse.attachment.sha256")).toBe("impulse.attachment");
    expect(catalog.scopeOf("impulse.channel")).toBe(CASE_SCOPE);
  });
  it("a fact scoped to a declared entity builds; the reserved case scope needs no declaration at all", () => {
    expect(() => FactCatalog.build(ENTITY_NS, [])).not.toThrow();
    expect(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact", authority: "source", scope: CASE_SCOPE }]), [])).not.toThrow();
  });
  it("a fact scoped to an undeclared name is refused", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "a.b", kind: "fact", scope: "invoice.line" }]), []))).toBe("UNKNOWN_SCOPE");
  });
  it("declaring the reserved case scope as an entity is refused", () => {
    expect(code(() => FactCatalog.build(ns([], [{ type: CASE_SCOPE, multiplicity: "one", identityFields: ["a.b"] }]), []))).toBe("RESERVED_ENTITY_TYPE");
  });
  it("a duplicate entity type, a bad multiplicity and empty identityFields are all refused", () => {
    expect(code(() => FactCatalog.build(ns([], [LINE_ENTITY, LINE_ENTITY]), []))).toBe("DUPLICATE_ENTITY");
    expect(code(() => FactCatalog.build(ns([], [{ ...LINE_ENTITY, multiplicity: "few" as never }]), []))).toBe("INVALID_MULTIPLICITY");
    expect(code(() => FactCatalog.build(ns([], [{ ...LINE_ENTITY, identityFields: [] }]), []))).toBe("EMPTY_IDENTITY_FIELDS");
  });
});

describe("FACT-006 canonical FactAddress form round-trips and rejects a malformed or misplaced entity id", () => {
  it("a case-scope address and a many-scope address both round-trip through format/parse", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    const plain = parseFactAddress("supplier.companyId", catalog);
    expect(plain).toEqual({ key: "supplier.companyId", scope: CASE_SCOPE });
    expect(parseFactAddress(formatFactAddress(plain), catalog)).toEqual(plain);

    const entityId = "ent-mu3o0000abc";
    const row = parseFactAddress(`invoice.line.description@${entityId}`, catalog);
    expect(row).toEqual({ key: "invoice.line.description", scope: "invoice.line", entityId });
    expect(formatFactAddress(row)).toBe(`invoice.line.description@${entityId}`);
    expect(parseFactAddress(formatFactAddress(row), catalog)).toEqual(row);
  });
  it("the real impulse.attachment entity round-trips a fact address (first real use of part A)", () => {
    const catalog = realCatalog();
    const entityId = newEntityId();
    const addr = parseFactAddress(`impulse.attachment.sha256@${entityId}`, catalog);
    expect(addr).toEqual({ key: "impulse.attachment.sha256", scope: "impulse.attachment", entityId });
    expect(parseFactAddress(formatFactAddress(addr), catalog)).toEqual(addr);
  });
  it("more than one '@', or an empty key before it, is malformed", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    expect(addressCode(() => parseFactAddress("a@b@c", catalog))).toBe("MALFORMED");
    expect(addressCode(() => parseFactAddress("@ent-1", catalog))).toBe("MALFORMED");
  });
  it("a fact without a 'many' scope may never carry an entity id (fakt bez scope s entitou)", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    expect(addressCode(() => parseFactAddress("supplier.companyId@ent-1", catalog))).toBe("ENTITY_ID_FORBIDDEN");
  });
  it("a 'many' scope address without an entity id is ambiguous", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    expect(addressCode(() => parseFactAddress("invoice.line.description", catalog))).toBe("ENTITY_ID_REQUIRED");
  });
  it("an entity id that is not the platform's own id shape is refused, even on a 'many' scope fact (A-adv-3)", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    expect(addressCode(() => parseFactAddress("invoice.line.description@L-12345678", catalog))).toBe("INVALID_ENTITY_ID");
  });
  it("an unknown key is refused", () => {
    const catalog = FactCatalog.build(ENTITY_NS, []);
    expect(addressCode(() => parseFactAddress("nobody.knows.this", catalog))).toBe("UNKNOWN_KEY");
  });
});

describe("FACT-007 identityFields are source-authority facts of the entity's own scope, nothing else", () => {
  it("a derived fact, a fact of a different scope, and an unknown key are all refused as identityFields", () => {
    expect(code(() => FactCatalog.build(ns([{ key: "invoice.line.accountCode", kind: "fact", authority: "derived", scope: "invoice.line" }], [{ ...LINE_ENTITY, identityFields: ["invoice.line.accountCode"] }]), []))).toBe(
      "INVALID_IDENTITY_FIELD",
    );
    expect(
      code(() =>
        FactCatalog.build(
          ns(
            [
              { key: "invoice.line.description", kind: "fact", authority: "source", scope: "invoice.line" },
              { key: "supplier.companyId", kind: "fact", authority: "source" },
            ],
            [{ ...LINE_ENTITY, identityFields: ["supplier.companyId"] }],
          ),
          [],
        ),
      ),
    ).toBe("INVALID_IDENTITY_FIELD");
    expect(code(() => FactCatalog.build(ns([], [{ ...LINE_ENTITY, identityFields: ["invoice.line.missing"] }]), []))).toBe("INVALID_IDENTITY_FIELD");
  });
  it("source-authority facts of the entity's own scope are accepted", () => {
    expect(() => FactCatalog.build(ENTITY_NS, [])).not.toThrow();
  });
});
