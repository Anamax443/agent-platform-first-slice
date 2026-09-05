// INT family: dependency failure classes, end-to-end golden master, implementation replacement.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDmsAdapter, type DmsMode } from "../src/adapters/dms.js";
import { KeywordClassifierAdapter } from "../src/adapters/llm.js";
import { FakeRegistryAdapter } from "../src/adapters/registry.js";
import { expectGolden, runFixture } from "./harness/conformance.js";
import { createSlice, INVOICE_CZ, runIntake, subsetDiff, trace, type Trace } from "./harness/index.js";
import { CONFORMANCE_DIR, fixtureBytes, loadSuite } from "./harness/suite.js";

describe("INT-FAIL dependency failure per error class (validator -> registry)", () => {
  it("INT-FAIL-001 timeout -> DEPENDENCY_TIMEOUT retryable, bounded retries, never a silent continue", async () => {
    const registry = new FakeRegistryAdapter("timeout");
    const slice = createSlice({ registry, registryTimeoutMs: 20 });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    expect(instance.status).toBe("FAILED");
    const validate = instance.steps.find((s) => s.stepId === "validate");
    expect(validate?.result?.error).toMatchObject({ code: "DEPENDENCY_TIMEOUT", class: "DEPENDENCY", retryable: true });
    expect(validate?.attempt).toBe(3);
    expect(slice.dms.stampCalls).toBe(0);
  });

  it("INT-FAIL-002 5xx -> technical retries then DEPENDENCY_UNAVAILABLE", async () => {
    const registry = new FakeRegistryAdapter("unavailable");
    const slice = createSlice({ registry });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    expect(instance.steps.find((s) => s.stepId === "validate")?.result?.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(registry.calls).toBe(3);
    expect(instance.status).toBe("FAILED");
  });

  it("INT-FAIL-003 business 4xx -> no technical retry, review instead", async () => {
    const registry = new FakeRegistryAdapter("business");
    const slice = createSlice({ registry });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    expect(registry.calls).toBe(1);
    expect(instance.status).toBe("WAITING");
    expect(instance.waiting?.reason).toBe("REVIEW");
    expect(slice.review.get(instance.waiting?.reviewTaskId as string)?.reasonCode).toBe("REGISTRY_REJECTED");
    expect(slice.dms.stampCalls).toBe(0);
  });

  it("INT-FAIL-004 (a) schema-valid nonsense outside the business range -> VALIDATION, never SUCCEEDED", async () => {
    const slice = createSlice({ registry: new FakeRegistryAdapter("nonsense-range") });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    const validate = instance.steps.find((s) => s.stepId === "validate");
    expect(validate?.status).toBe("FAILED");
    expect(validate?.result?.error).toMatchObject({ code: "REGISTRY_RESPONSE_INVALID", class: "VALIDATION", retryable: false });
    expect(instance.status).toBe("FAILED");
    expect(slice.dms.stampCalls).toBe(0);
  });

  it("INT-FAIL-004 (b) formally fine, semantically impossible -> QUALITY and WAITING(REVIEW), never SUCCEEDED", async () => {
    const slice = createSlice({ registry: new FakeRegistryAdapter("nonsense-semantic") });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    const validate = instance.steps.find((s) => s.stepId === "validate");
    expect(validate?.status).toBe("WAITING");
    expect(validate?.result?.error).toMatchObject({ code: "REGISTRY_TYPE_CONFLICT", class: "QUALITY" });
    expect(instance.status).toBe("WAITING");
    expect(slice.dms.stampCalls).toBe(0);
  });
});

describe("INT-E2E-001 workflow golden master (semantic tier of document-intake.v1)", () => {
  const dir = join(CONFORMANCE_DIR, "workflows", "document-intake.v1");
  const scenarios = JSON.parse(readFileSync(join(dir, "scenarios.json"), "utf8")) as Array<{
    id: string;
    input: { fixture: string; stampText?: string };
    adapters?: { dms?: DmsMode };
  }>;
  const golden = JSON.parse(readFileSync(join(dir, "golden.json"), "utf8")) as Record<string, Partial<Trace>>;

  for (const sc of scenarios) {
    it(`INT-E2E-001 ${sc.id}`, async () => {
      const slice = createSlice({ dms: new FakeDmsAdapter(sc.adapters?.dms ?? "ok") });
      const { instance } = await runIntake(slice, { bytes: fixtureBytes("document.classify", sc.input.fixture), ...(sc.input.stampText ? { stampText: sc.input.stampText } : {}) });
      const actual = trace(slice, instance.workflowId);
      const diff = subsetDiff(actual, golden[sc.id]);
      expect(diff, `${sc.id}:\n${diff.join("\n")}\nactual: ${JSON.stringify(actual, null, 2)}`).toEqual([]);
      // property that holds for every scenario: every write has an audit record before and after it
      expect(slice.audit.byKind("write-intent")).toHaveLength(slice.audit.byKind("write-done").length);
      expect(slice.dms.stampCalls).toBeLessThanOrEqual(slice.audit.byKind("write-intent").length);
    });
  }
});

describe("INT-REPLACE-001 replacing the model behind document.classify", () => {
  const rules = () => ({ llm: new KeywordClassifierAdapter(), keyword: new KeywordClassifierAdapter() });

  it("the rules implementation passes the original conformance suite at the semantic tier", async () => {
    const suite = loadSuite("document.classify");
    for (const f of suite.fixtures) {
      const run = await runFixture("document.classify", f, { models: rules() });
      expectGolden(run.result, suite.golden[f.id], run.vars, `${f.id} (replaced implementation)`);
    }
  });

  it("the workflow, the validator and the executor do not change; only provenance says who classified", async () => {
    const slice = createSlice({ models: rules() });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    const classify = instance.steps.find((s) => s.stepId === "classify");
    expect(classify?.result?.provenance?.modelId).toBe("keyword-rules-1");
    expect(classify?.result?.provenance?.promptVersion).toBe("rules-1");
    expect(instance.steps.find((s) => s.stepId === "validate")?.result?.payload?.documentType).toMatchObject({ value: "INVOICE", trustLevel: "validated" });
    expect(slice.dms.stampCalls).toBe(1);
  });
});
