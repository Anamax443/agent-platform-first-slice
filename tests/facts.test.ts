// FACT family (Posudek 17, 15. 9. 2026): contracts/facts.v1.json (what a key MEANS) and src/components/*/facts.json (which
// keys each capability consumes/produces) must be one consistent, value-free catalog. Negative cases build a small
// synthetic namespace so each rule is shown to actually bite, not just to pass on today's files.
import { describe, expect, it } from "vitest";
import { FactCatalog, FactCatalogError, type FactNamespace, type ModuleFacts } from "../src/platform/fact-catalog.js";
import { loadComponents, loadNamespace, realCatalog } from "./harness/facts.js";

const ns = (facts: FactNamespace["facts"]): FactNamespace => ({ schemaVersion: "1", facts });
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
