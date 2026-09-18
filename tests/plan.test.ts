// PLAN family (Posudek 17, 15. 9. 2026): plan() derives the capability chain from goal + available keys over the
// FactCatalog, deterministically and without values. PLAN-001/002 are the hard gate of the idea: the derived chains
// must equal today's hand-written workflows/*.json — proof that the catalog encodes what the workflows already know,
// nothing more and nothing less.
import { describe, expect, it } from "vitest";
import { FactCatalog, type FactNamespace, type ModuleFacts } from "../src/platform/fact-catalog.js";
import { plan, type PlanResult } from "../src/platform/planner.js";
import { loadComponents, loadNamespace, realCatalog, workflowChain } from "./harness/facts.js";

const chain = (r: PlanResult): string[] | string => (r.status === "PLANNED" ? r.steps.map((s) => s.capability) : r.status);

describe("PLAN-001 document goal reproduces the document-intake capability chain", () => {
  it("document.stamped from document.original = classify → validate → stamp (v2 and v1)", () => {
    const r = plan({ goal: ["document.stamped"], available: ["document.original"] }, realCatalog());
    expect(chain(r)).toEqual(workflowChain("document-intake.v2.json"));
    expect(chain(r)).toEqual(workflowChain("document-intake.v1.json"));
  });
  it("the same request planned twice is byte-identical", () => {
    const c = realCatalog();
    const req = { goal: ["document.stamped"], available: ["document.original"] };
    expect(JSON.stringify(plan(req, c))).toBe(JSON.stringify(plan(req, c)));
  });
  it("the DMS effect as goal selects the same chain — stamp produces both the artifact and the effect", () => {
    expect(chain(plan({ goal: ["dms.document.stored"], available: ["document.original"] }, realCatalog()))).toEqual(workflowChain("document-intake.v2.json"));
  });
});

describe("PLAN-002 mail goal reproduces the mail-intake capability chain", () => {
  it("notification.sent from impulse.raw + notification.recipientRef = ingest → classify → validate → stamp → notify (v2 and v1)", () => {
    const r = plan({ goal: ["notification.sent"], available: ["impulse.raw", "notification.recipientRef"] }, realCatalog());
    expect(chain(r)).toEqual(workflowChain("mail-intake.v2.json"));
    expect(chain(r)).toEqual(workflowChain("mail-intake.v1.json"));
  });
  it("without the recipient reference the mail goal is a gap, not a chain that ends in a send with nobody to send to", () => {
    const r = plan({ goal: ["notification.sent"], available: ["impulse.raw"] }, realCatalog());
    expect(r.status).toBe("CAPABILITY_GAP");
    if (r.status === "CAPABILITY_GAP") expect(r.missing.map((m) => m.key)).toContain("notification.recipientRef");
  });
});

describe("PLAN-003 missing producer → CAPABILITY_GAP, never an approximate substitute", () => {
  it("vendor.bcNumber has no producer today (bc.vendors, SEVERKA ## Pořadí 7)", () => {
    const r = plan({ goal: ["vendor.bcNumber"], available: ["document.original"] }, realCatalog());
    expect(r.status).toBe("CAPABILITY_GAP");
    if (r.status === "CAPABILITY_GAP") expect(r.missing).toEqual([{ key: "vendor.bcNumber", reason: "NO_PRODUCER", tried: [] }]);
  });
  it("supplier.vatId.verified is unreachable from a document: invoice.extract v1 does not produce supplier.vatId", () => {
    const r = plan({ goal: ["supplier.vatId.verified"], available: ["document.original"] }, realCatalog());
    expect(r.status).toBe("CAPABILITY_GAP");
    if (r.status === "CAPABILITY_GAP") {
      expect(r.missing).toEqual([
        { key: "supplier.vatId", reason: "NO_PRODUCER", tried: [] },
        { key: "supplier.vatId.verified", reason: "UNSATISFIABLE", tried: ["cz.vat.verify"] },
      ]);
    }
  });
  it("the ARES chain needs invoice.extract, which itself now needs confirmed-INVOICE evidence (PLAN-007): unreachable from document.original alone", () => {
    expect(plan({ goal: ["supplier.companyId.verified"], available: ["document.original"] }, realCatalog()).status).toBe("CAPABILITY_GAP");
  });
  it("with the confirmed-INVOICE evidence already available, the ARES chain resolves: invoice.extract → cz.company.verify", () => {
    expect(chain(plan({ goal: ["supplier.companyId.verified"], available: ["document.original", "document.type.invoiceConfirmed"] }, realCatalog()))).toEqual(["invoice.extract", "cz.company.verify"]);
  });
  it("an unknown key in goal or available, or an empty goal, is INVALID — not silently ignored", () => {
    const c = realCatalog();
    expect(plan({ goal: ["document.stamped"], available: ["document.orginal"] }, c).status).toBe("INVALID");
    expect(plan({ goal: ["document.stampd"], available: ["document.original"] }, c).status).toBe("INVALID");
    expect(plan({ goal: [], available: ["document.original"] }, c).status).toBe("INVALID");
  });
});

describe("PLAN-004 a dependency cycle fails closed", () => {
  const NS: FactNamespace = { schemaVersion: "1", facts: [{ key: "a.x", kind: "fact" }, { key: "b.y", kind: "fact" }] };
  const MODS: ModuleFacts[] = [
    { module: "m", capabilities: { "cap.a": { consumes: { facts: ["b.y"] }, produces: { facts: ["a.x"] } }, "cap.b": { consumes: { facts: ["a.x"] }, produces: { facts: ["b.y"] } } } },
  ];
  it("a.x with nothing available → CYCLE with the loop path", () => {
    const r = plan({ goal: ["a.x"], available: [] }, FactCatalog.build(NS, MODS));
    expect(r.status).toBe("CYCLE");
    if (r.status === "CYCLE") expect(r.path).toEqual(["a.x", "b.y", "a.x"]);
  });
  it("the same catalog with b.y available plans cap.a alone — the loop only matters when it is actually needed", () => {
    expect(chain(plan({ goal: ["a.x"], available: ["b.y"] }, FactCatalog.build(NS, MODS)))).toEqual(["cap.a"]);
  });
});

describe("PLAN-005 planner output carries no business values", () => {
  const leaves = (v: unknown, path: string, out: { path: string; value: unknown }[]): void => {
    if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
    else out.push({ path, value: v });
  };
  it("every leaf of a PLANNED and of a CAPABILITY_GAP result is a namespace key, a capability/module name or a status token", () => {
    const c = realCatalog();
    const allowed = new Set([
      ...c.keys(),
      ...c.capabilities(),
      ...loadComponents().map((x) => x.module),
      "PLANNED",
      "CAPABILITY_GAP",
      "CYCLE",
      "INVALID",
      "NO_PRODUCER",
      "UNSATISFIABLE",
    ]);
    const results = [
      plan({ goal: ["notification.sent"], available: ["impulse.raw", "notification.recipientRef"] }, c),
      plan({ goal: ["supplier.vatId.verified"], available: ["document.original"] }, c),
    ];
    for (const r of results) {
      const out: { path: string; value: unknown }[] = [];
      leaves(r, "$", out);
      expect(out.length).toBeGreaterThan(0);
      for (const leaf of out) {
        expect(typeof leaf.value, leaf.path).toBe("string");
        expect(allowed.has(leaf.value as string), `${leaf.path} = ${String(leaf.value)}`).toBe(true);
      }
      expect(JSON.stringify(r)).not.toMatch(/"(value|payload|inputs|params)"/);
    }
  });
  it("the request itself is keys only: a value passed as 'available' is an unknown key, not data", () => {
    expect(plan({ goal: ["document.stamped"], available: ["12345678"] }, realCatalog()).status).toBe("INVALID");
  });
});

describe("PLAN-006 a write path cannot be selected without its required evidence", () => {
  it("document.stamp declares the evidence it needs, not just the fact", () => {
    expect(realCatalog().flowOf("document.stamp")?.consumes).toContain("document.type.validated");
  });
  it("without a validator in the catalog, document.stamped is a CAPABILITY_GAP — stamp is never planned over an unvalidated type", () => {
    const mods = loadComponents().flatMap((c) => (c.facts && c.module !== "document-validator" ? [c.facts] : []));
    const r = plan({ goal: ["document.stamped"], available: ["document.original"] }, FactCatalog.build(loadNamespace(), mods));
    expect(r.status).toBe("CAPABILITY_GAP");
    if (r.status === "CAPABILITY_GAP") {
      expect(r.missing).toEqual([
        { key: "document.type.validated", reason: "NO_PRODUCER", tried: [] },
        { key: "document.stamped", reason: "UNSATISFIABLE", tried: ["document.stamp"] },
      ]);
    }
  });
  it("document.type being available does not skip validation: the evidence, not the fact, gates the write", () => {
    expect(chain(plan({ goal: ["document.stamped"], available: ["document.original", "document.type"] }, realCatalog()))).toEqual(["document.validate", "document.stamp"]);
  });
});

describe("PLAN-007 invoice.extract cannot be selected without confirmed-INVOICE evidence (owner's Commit 1, 18.9.2026)", () => {
  it("invoice.extract declares the evidence it needs, not just the artifact", () => {
    expect(realCatalog().flowOf("invoice.extract")?.consumes).toContain("document.type.invoiceConfirmed");
  });
  it("document.type.invoiceConfirmed has no producer in the real catalog on purpose — a value-conditional gate must never be something plan() can chain its way into producing", () => {
    expect(realCatalog().producersOf("document.type.invoiceConfirmed")).toEqual([]);
  });
  it("the cheapest, most direct proof of the gate: invoice.extract's own goal is CAPABILITY_GAP from document.original alone — a CONTRACT or a photo can never reach it via the catalog", () => {
    const goal = realCatalog().flowOf("invoice.extract")?.produces as string[];
    const r = plan({ goal, available: ["document.original"] }, realCatalog());
    expect(r.status).toBe("CAPABILITY_GAP");
    if (r.status === "CAPABILITY_GAP") {
      expect(r.missing.map((m) => m.key)).toContain("document.type.invoiceConfirmed");
      expect(r.missing.every((m) => m.reason === "NO_PRODUCER" || m.reason === "UNSATISFIABLE")).toBe(true);
    }
  });
  it("with the confirmed-INVOICE evidence already available (as a driver that actually checked the Žlab would supply it), invoice.extract plans cleanly", () => {
    const goal = realCatalog().flowOf("invoice.extract")?.produces as string[];
    expect(chain(plan({ goal, available: ["document.original", "document.type.invoiceConfirmed"] }, realCatalog()))).toEqual(["invoice.extract"]);
  });
});
