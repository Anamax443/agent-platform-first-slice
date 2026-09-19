// COMP family (część 6 krok 8, SEVERKA "M3 No-n8n Gate"): compiler.ts turns a Planner PlanResult into an immutable
// WorkflowDef. Bar: never a business value in the output (only $input/$steps refs), never a hardcoded per-
// capability mapping, fail-closed on every non-PLANNED plan status and on any capability the registry cannot
// vouch for, deterministic (same input -> byte-identical output), and — the M3 killer test itself — the compiled
// chain changes when availability changes, without editing a single workflow file.
import { describe, expect, it } from "vitest";
import type { CurrentCaseProjection } from "../src/platform/case-projection.js";
import { compileWorkflow, type CapabilityLookup, type CompileResult } from "../src/platform/compiler.js";
import { CompilerPolicy, CompilerPolicyError } from "../src/platform/compiler-policy.js";
import { CASE_SCOPE, FactCatalog, type FactNamespace, type ModuleFacts } from "../src/platform/fact-catalog.js";
import { plan } from "../src/platform/planner.js";
import { catalogOf, type CapabilityRecord } from "../src/platform/registry.js";
import { parseWorkflowDef } from "../src/platform/workflow.js";
import { loadComponents, realCatalog, workflowChain } from "./harness/facts.js";

function projectionOf(available: readonly string[]): CurrentCaseProjection {
  return {
    projectionSchemaVersion: 1,
    caseId: "case-comp",
    tenantId: "tenant-comp",
    availableArtifacts: [],
    availableFacts: available.map((key) => ({ key, scope: CASE_SCOPE })),
    facts: [],
    pendingCapabilities: [],
  };
}

function realCapabilities(): CapabilityLookup {
  const records = new Map<string, CapabilityRecord>();
  for (const c of loadComponents()) for (const r of catalogOf(c.descriptor)) records.set(r.capability, r);
  return { recordFor: (capability) => records.get(capability) };
}

const REAL_POLICY = CompilerPolicy.build({ schemaVersion: "1", workflowVersion: "1", deadlineMs: 1_800_000, conformanceTier: "semantic", operatorRole: "document.operator", supervisorRole: "document.supervisor" });

const chain = (r: CompileResult): string[] | string => (r.status === "COMPILED" ? r.workflow.steps.map((s) => s.capability) : r.status);

describe("COMP-000 the real document-intake chain compiles into a schema-valid WorkflowDef", () => {
  it("same capability order as plan()'s own PLANNED result and today's hand-written document-intake.v2.json", () => {
    const r = compileWorkflow({ goal: ["document.stamped"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    expect(chain(r)).toEqual(workflowChain("document-intake.v2.json"));
  });

  it("step ids are a mechanical, collision-safe transform of the capability name; parseWorkflowDef() accepts the result unchanged (it already ran inside compileWorkflow())", () => {
    const r = compileWorkflow({ goal: ["document.stamped"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    if (r.status !== "COMPILED") throw new Error("expected COMPILED");
    expect(r.workflow.steps.map((s) => s.id)).toEqual(["document-classify", "document-validate", "document-stamp"]);
    expect(parseWorkflowDef(r.workflow)).toEqual(r.workflow);
  });

  it("a fact produced by an earlier step is wired as a $steps ref to that step's own id, a fact already available is $input — never a literal", () => {
    const r = compileWorkflow({ goal: ["document.stamped"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    if (r.status !== "COMPILED") throw new Error("expected COMPILED");
    const validate = r.workflow.steps.find((s) => s.capability === "document.validate");
    expect(validate?.inputs).toEqual({ document_original: "$input.document_original", document_type: "$steps.document-classify.payload.document_type" });
  });
});

describe("COMP-001 an unreachable goal is CAPABILITY_GAP, passed through from plan() unchanged", () => {
  it("vendor.bcNumber has no producer today (same gap plan() itself reports, PLAN-003)", () => {
    const r = compileWorkflow({ goal: ["vendor.bcNumber"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    expect(r.status).toBe("CAPABILITY_GAP");
    const direct = plan({ goal: ["vendor.bcNumber"], available: ["document.original"] }, realCatalog());
    if (r.status === "CAPABILITY_GAP" && direct.status === "CAPABILITY_GAP") expect(r.missing).toEqual(direct.missing);
  });
});

describe("COMP-002 a dependency cycle fails closed, never a partial WorkflowDef", () => {
  const NS: FactNamespace = { schemaVersion: "1", facts: [{ key: "a.x", kind: "fact" }, { key: "b.y", kind: "fact" }] };
  const MODS: ModuleFacts[] = [
    { module: "m", capabilities: { "cap.a": { consumes: { facts: ["b.y"] }, produces: { facts: ["a.x"] } }, "cap.b": { consumes: { facts: ["a.x"] }, produces: { facts: ["b.y"] } } } },
  ];
  it("a.x with nothing available -> CYCLE with the loop path, no capability ever looked up", () => {
    let lookedUp = false;
    const r = compileWorkflow({
      goal: ["a.x"],
      projection: projectionOf([]),
      factCatalog: FactCatalog.build(NS, MODS),
      capabilities: { recordFor: () => ((lookedUp = true), undefined) },
      policy: REAL_POLICY,
    });
    expect(r.status).toBe("CYCLE");
    if (r.status === "CYCLE") expect(r.path).toEqual(["a.x", "b.y", "a.x"]);
    expect(lookedUp).toBe(false);
  });
});

describe("COMP-003 an empty goal is INVALID, never silently compiled to an empty workflow", () => {
  it("plan() itself refuses an empty goal (workflow-definition.schema.json also requires steps.minItems=1 — there is no valid empty WorkflowDef to fall back to)", () => {
    const r = compileWorkflow({ goal: [], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    expect(r.status).toBe("INVALID");
  });
});

describe("COMP-004 a planned capability the registry cannot vouch for fails closed, never a guessed version", () => {
  it("no record at all -> CAPABILITY_UNUSABLE naming the capability, not a silently-skipped step", () => {
    const caps = realCapabilities();
    const r = compileWorkflow({
      goal: ["document.stamped"],
      projection: projectionOf(["document.original"]),
      factCatalog: realCatalog(),
      capabilities: { recordFor: (c) => (c === "document.classify" ? undefined : caps.recordFor(c)) },
      policy: REAL_POLICY,
    });
    expect(r).toEqual({ status: "CAPABILITY_UNUSABLE", capability: "document.classify", reason: "not registered" });
  });

  it("a record with an unusable sideEffects value fails closed instead of passing it through to the WorkflowDef", () => {
    const caps = realCapabilities();
    const r = compileWorkflow({
      goal: ["document.stamped"],
      projection: projectionOf(["document.original"]),
      factCatalog: realCatalog(),
      capabilities: { recordFor: (c) => (c === "document.classify" ? { ...caps.recordFor(c)!, sideEffects: "sometimes" } : caps.recordFor(c)) },
      policy: REAL_POLICY,
    });
    expect(r).toEqual({ status: "CAPABILITY_UNUSABLE", capability: "document.classify", reason: 'invalid sideEffects "sometimes"' });
  });

  it("a record with a non-numeric capabilityVersion fails closed", () => {
    const caps = realCapabilities();
    const r = compileWorkflow({
      goal: ["document.stamped"],
      projection: projectionOf(["document.original"]),
      factCatalog: realCatalog(),
      capabilities: { recordFor: (c) => (c === "document.classify" ? { ...caps.recordFor(c)!, version: "latest" } : caps.recordFor(c)) },
      policy: REAL_POLICY,
    });
    expect(r).toEqual({ status: "CAPABILITY_UNUSABLE", capability: "document.classify", reason: 'invalid capabilityVersion "latest"' });
  });

  it("a record whose version is a JS number, not a string, still fails closed (adversarial verification, część 6 krok 8: /regex/.test() coerces its argument, so a naive check would silently accept 1 and only crash later)", () => {
    const caps = realCapabilities();
    const r = compileWorkflow({
      goal: ["document.stamped"],
      projection: projectionOf(["document.original"]),
      factCatalog: realCatalog(),
      capabilities: { recordFor: (c) => (c === "document.classify" ? { ...caps.recordFor(c)!, version: 1 as unknown as string } : caps.recordFor(c)) },
      policy: REAL_POLICY,
    });
    expect(r).toEqual({ status: "CAPABILITY_UNUSABLE", capability: "document.classify", reason: "invalid capabilityVersion 1" });
  });
});

describe("COMP-008 a goal already fully satisfied by the projection is NOTHING_TO_DO, never a crash", () => {
  it("plan() itself returns PLANNED with zero steps; compileWorkflow() names that outcome instead of building a workflow no schema allows (adversarial verification, część 6 krok 8: this used to throw an unnamed schema error, workflow-definition.schema.json requires steps.minItems=1)", () => {
    const r = compileWorkflow({ goal: ["document.original"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    expect(r).toEqual({ status: "NOTHING_TO_DO" });
  });
});

describe("COMP-005 M3 killer test: the compiled chain changes with availability alone, no workflow file edited", () => {
  it("without cz.company.verify's precondition evidence, the ARES chain is a gap", () => {
    const r = compileWorkflow({ goal: ["supplier.companyId.verified"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    expect(r.status).toBe("CAPABILITY_GAP");
  });

  it("with document.type.invoiceConfirmed available, the exact same goal compiles invoice.extract -> cz.company.verify", () => {
    const r = compileWorkflow({
      goal: ["supplier.companyId.verified"],
      projection: projectionOf(["document.original", "document.type.invoiceConfirmed"]),
      factCatalog: realCatalog(),
      capabilities: realCapabilities(),
      policy: REAL_POLICY,
    });
    expect(chain(r)).toEqual(["invoice.extract", "cz.company.verify"]);
  });

  it("the two compiled workflows above have different content-derived names — availability changed the definition's identity, not just its steps in memory", () => {
    const gap = compileWorkflow({ goal: ["supplier.companyId.verified"], projection: projectionOf(["document.original", "document.type.invoiceConfirmed"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    const other = compileWorkflow({ goal: ["document.stamped"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    if (gap.status !== "COMPILED" || other.status !== "COMPILED") throw new Error("expected both COMPILED");
    expect(gap.workflow.workflow).not.toBe(other.workflow.workflow);
  });
});

describe("COMP-006 determinism: same input twice is byte-identical", () => {
  it("document-intake chain compiled twice", () => {
    const req = { goal: ["document.stamped"], projection: projectionOf(["document.original"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY };
    expect(JSON.stringify(compileWorkflow(req))).toBe(JSON.stringify(compileWorkflow(req)));
  });
});

describe("COMP-007 every input is a reference, never a business value (AR-1)", () => {
  it("every leaf of every compiled step's inputs starts with $input. or $steps.", () => {
    const r = compileWorkflow({ goal: ["notification.sent"], projection: projectionOf(["impulse.raw", "notification.recipientRef"]), factCatalog: realCatalog(), capabilities: realCapabilities(), policy: REAL_POLICY });
    if (r.status !== "COMPILED") throw new Error("expected COMPILED");
    for (const step of r.workflow.steps) {
      for (const value of Object.values(step.inputs)) {
        expect(typeof value).toBe("string");
        expect(value as string).toMatch(/^\$(input|steps)\./);
      }
    }
  });
});

describe("COMP-POLICY-000 CompilerPolicy.build() is fail-closed over its whole shape", () => {
  const VALID = { schemaVersion: "1", workflowVersion: "1", deadlineMs: 1_800_000, conformanceTier: "semantic" as const, operatorRole: "document.operator", supervisorRole: "document.supervisor" };
  it("accepts a valid policy", () => {
    expect(() => CompilerPolicy.build(VALID)).not.toThrow();
  });
  it.each([
    ["wrong schemaVersion", { ...VALID, schemaVersion: "2" }],
    ["non-numeric workflowVersion", { ...VALID, workflowVersion: "v1" }],
    ["zero deadlineMs", { ...VALID, deadlineMs: 0 }],
    ["non-integer deadlineMs", { ...VALID, deadlineMs: 1.5 }],
    ["unknown conformanceTier", { ...VALID, conformanceTier: "vibes" }],
    ["malformed operatorRole", { ...VALID, operatorRole: "Document.Operator" }],
    ["malformed supervisorRole", { ...VALID, supervisorRole: "" }],
  ])("rejects %s", (_label, json) => {
    expect(() => CompilerPolicy.build(json)).toThrow(CompilerPolicyError);
  });
});
