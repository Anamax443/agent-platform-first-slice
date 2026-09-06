// INT family: dependency failure classes, end-to-end golden masters of every workflow, implementation replacement.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeywordClassifierAdapter } from "../src/adapters/llm.js";
import { FakeRegistryAdapter } from "../src/adapters/registry.js";
import { expectGolden, runFixture, sliceOptionsFor } from "./harness/conformance.js";
import { createSlice, INVOICE_CZ, runIntake, runScenario, subsetDiff, trace, type Trace } from "./harness/index.js";
import { CONFORMANCE_DIR, loadSuite, type AdapterModes } from "./harness/suite.js";

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

interface Scenario {
  id: string;
  description?: string;
  input: Record<string, unknown>;
  adapters?: AdapterModes;
  storage?: { capacityBytes: number };
}

const WORKFLOW_DIRS = readdirSync(join(CONFORMANCE_DIR, "workflows"));

for (const dir of WORKFLOW_DIRS) {
  // conformance/workflows/<name>.v<version> pins the definition version the golden master describes (WF-VER-001).
  const workflow = dir.replace(/\.v(\d+)$/, "@$1");
  const scenarios = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "workflows", dir, "scenarios.json"), "utf8")) as Scenario[];
  const golden = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "workflows", dir, "golden.json"), "utf8")) as Record<string, Partial<Trace>>;

  describe(`INT-E2E-001 golden master of ${dir} (semantic tier)`, () => {
    it("every scenario has a golden and every golden a scenario", () => {
      expect(scenarios.map((s) => s.id).sort()).toEqual(Object.keys(golden).sort());
    });
    for (const sc of scenarios) {
      it(`INT-E2E-001 ${dir} ${sc.id}`, async () => {
        const slice = createSlice(sliceOptionsFor(sc.adapters, sc.storage));
        const instance = await runScenario(slice, workflow, sc.input);
        const actual = trace(slice, instance.workflowId);
        const diff = subsetDiff(actual, golden[sc.id]);
        expect(diff, `${sc.id}:\n${diff.join("\n")}\nactual: ${JSON.stringify(actual, null, 2)}`).toEqual([]);
        // properties that hold for every scenario: every write has an audit record before and after; no address outside the allowlist
        expect(slice.audit.byKind("write-intent")).toHaveLength(slice.audit.byKind("write-done").length);
        expect(slice.dms.stampCalls + slice.smtp.sendCalls).toBeLessThanOrEqual(slice.audit.byKind("write-intent").length);
        for (const to of slice.smtp.recipients()) expect(to.endsWith("@maxferit.example") || to.endsWith("@tenant7.example"), to).toBe(true);
      });
    }
  });
}

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
