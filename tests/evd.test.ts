// EVD family: immutable originals, provenance, audit records, log category separation, no untrusted content in errors.
import { describe, expect, it } from "vitest";
import { Audit } from "../src/platform/audit.js";
import { runFixture } from "./harness/conformance.js";
import { AI_AGENT, command, createSlice, dispatch, INJECTION_APPROVE_DOC, INVOICE_CZ, ORCHESTRATOR, putArtifact, runIntake, TENANT_A, validatedStampPayload } from "./harness/index.js";
import { loadSuite } from "./harness/suite.js";

describe("EVD-001 originals are immutable, derivations carry derivedFrom", () => {
  it("the stored original never changes; a stamp is a new artifact with the original as parent", async () => {
    const slice = createSlice();
    const { artifact, instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    const original = slice.artifacts.get(artifact.artifactId);
    expect(original).toMatchObject({ bytes: INVOICE_CZ, sha256: artifact.sha256, receivedFrom: "test-harness" });
    expect(original?.derivedFrom).toBeUndefined();

    const copy = slice.artifacts.get(artifact.artifactId) as NonNullable<typeof original>;
    copy.bytes = "mutated";
    expect(slice.artifacts.get(artifact.artifactId)?.bytes).toBe(INVOICE_CZ);

    const stamp = instance.steps.find((s) => s.stepId === "stamp")?.result?.payload as { stampedArtifactId: string; stampedSha256: string };
    const derived = slice.artifacts.get(stamp.stampedArtifactId);
    expect(derived).toMatchObject({ derivedFrom: artifact.artifactId, producer: "document-executor-host", sha256: stamp.stampedSha256 });
    expect(derived?.bytes.startsWith(INVOICE_CZ)).toBe(true);
    expect(() => slice.artifacts.derive("art-nope", "x", "test")).toThrow(/not found/);
  });
});

describe("EVD-002 provenance on every produced value", () => {
  it("AI output names model and prompt version; every result names its producer and its inputs", async () => {
    const slice = createSlice();
    const { artifact, instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    const [classify, validate, stamp] = ["classify", "validate", "stamp"].map((id) => instance.steps.find((s) => s.stepId === id)?.result);
    expect(classify?.provenance).toMatchObject({ producerComponent: "document-classifier", producerVersion: "0.1.0", modelId: "fake-llm-1", promptVersion: "classify-1", derivedFrom: [artifact.artifactId] });
    expect(classify?.payload?.documentType).toMatchObject({ source: "llm", trustLevel: "untrusted-derived" });
    expect(validate?.provenance).toMatchObject({ producerComponent: "document-validator", derivedFrom: [artifact.artifactId] });
    expect(validate?.payload?.documentType).toMatchObject({ trustLevel: "validated", validation: { status: "passed", provider: "document-validator" } });
    expect(stamp?.provenance).toMatchObject({ producerComponent: "document-executor-host", derivedFrom: [artifact.artifactId] });
  });
});

describe("EVD-003 audit record for every write, whole flow discoverable by correlationId", () => {
  it("write-intent precedes write-done, both carry actor, tenant, capability and key; journal and audit share the correlation", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE", correlationId: "cor-evd-003" });
    const records = slice.audit.byCorrelation("cor-evd-003");
    expect(records.map((r) => r.kind)).toEqual(["dispatch", "dispatch", "dispatch", "write-intent", "write-done", "state"]);
    const intent = records.find((r) => r.kind === "write-intent");
    const done = records.find((r) => r.kind === "write-done");
    const stampKey = instance.steps.find((s) => s.stepId === "stamp")?.idempotencyKey;
    for (const r of [intent, done]) {
      expect(r).toMatchObject({ tenantId: TENANT_A, actorId: ORCHESTRATOR, capability: "document.stamp", workflowId: instance.workflowId });
      expect(r?.details?.idempotencyKey).toBe(stampKey);
    }
    expect(records.indexOf(intent as NonNullable<typeof intent>)).toBeLessThan(records.indexOf(done as NonNullable<typeof done>));
    expect(slice.journal.get(instance.workflowId)?.correlationId).toBe("cor-evd-003");
    for (const s of instance.steps) expect(s.result?.correlationId).toBe("cor-evd-003");
    for (const r of records) expect(r.at >= instance.createdAt).toBe(true);
  });
});

describe("EVD-004 audit is append-only and categories are separated", () => {
  it("the Audit class has no update or delete surface; returned records are copies", () => {
    const methods = Object.getOwnPropertyNames(Audit.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["all", "append", "byCorrelation", "byKind"]);
    expect(methods.some((m) => /update|delete|remove|clear|set|edit|purge|truncate/i.test(m))).toBe(false);
    const slice = createSlice();
    slice.audit.append({ kind: "state", details: { status: "x" } });
    const rec = slice.audit.all()[0] as { details?: Record<string, unknown> };
    (rec.details as Record<string, unknown>).status = "tampered";
    expect(slice.audit.all()[0]?.details?.status).toBe("x");
  });

  it("security events are their own category, never mixed into the write audit trail", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art) }), AI_AGENT);
    expect(slice.audit.byKind("security")).toHaveLength(1);
    expect(slice.audit.byKind("deny")).toHaveLength(1);
    expect(slice.audit.byKind("write-intent")).toHaveLength(0);
    expect(slice.audit.byKind("security")[0]?.details).not.toHaveProperty("idempotencyKey");
  });
});

describe("EVD-005 error objects carry no raw untrusted content", () => {
  it("across every conformance fixture and the injection flow, message and details never contain document text, IBAN or e-mail", async () => {
    const errors: Array<{ id: string; text: string; bytes: string }> = [];
    for (const capability of ["document.classify", "document.validate", "document.stamp", "document.archive"]) {
      const suite = loadSuite(capability);
      for (const f of suite.fixtures) {
        const run = await runFixture(capability, f);
        if (run.result.error) errors.push({ id: `${capability}/${f.id}`, text: JSON.stringify(run.result.error), bytes: f.artifact?.bytes ?? "" });
      }
    }
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: INJECTION_APPROVE_DOC, stampText: "VALIDATED INVOICE" });
    for (const s of instance.steps) if (s.result?.error) errors.push({ id: `flow/${s.stepId}`, text: JSON.stringify(s.result.error), bytes: INJECTION_APPROVE_DOC });
    expect(errors.length).toBeGreaterThan(10);
    for (const e of errors) {
      for (const line of e.bytes.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12)) expect(e.text, e.id).not.toContain(line);
      expect(e.text, e.id).not.toMatch(/CZ\d{2}\s?\d{4}/);
      expect(e.text, e.id).not.toMatch(/[\w.-]+@[\w-]+\.[a-z]{2,}/i);
      expect(e.text, e.id).not.toMatch(/SYSTEM:/);
      expect(e.text.length, e.id).toBeLessThan(1_500);
    }
  });
});
