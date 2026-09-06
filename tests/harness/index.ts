// Test harness: builds the slice, dispatches like the orchestrator would, and reads evidence back.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlice as composeSlice, command, type Slice, type SliceOptions } from "../../src/slice.js";
import type { Artifact } from "../../src/platform/artifacts.js";
import type { Instance } from "../../src/platform/journal.js";
import type { MessageEnvelope, ResultEnvelope } from "../../src/platform/types.js";
import { FAKE_SECRETS, LOCAL_FAKES, ORCHESTRATOR, TENANT_A } from "./installation.js";
import { fixtureBytes, fixtureText } from "./suite.js";

export { command, type Slice, type SliceOptions };
export { DEFAULT_CLOCK_START, WORKFLOW_DEFINITIONS, workflowDef } from "../../src/slice.js";
export { AI_AGENT, FAKE_SECRETS, LOCAL_FAKES, ORCHESTRATOR, ORCHESTRATOR_B, TENANT_A, TENANT_B } from "./installation.js";

/** The slice as the tests see it: the local-fakes installation with fake secret values. */
export function createSlice(o: SliceOptions = {}): Slice {
  return composeSlice(LOCAL_FAKES, FAKE_SECRETS, o);
}

/** Reference texts come from the conformance fixtures; nothing is duplicated here. */
export const INVOICE_CZ = fixtureBytes("document.classify", "canonical-invoice-cz");
export const CONTRACT_CZ = fixtureBytes("document.classify", "canonical-contract-cz");
export const NEWSLETTER = fixtureBytes("document.classify", "canonical-other-newsletter");
export const INJECTION_APPROVE_DOC = fixtureBytes("document.classify", "injection-approve");
export const INJECTION_IN_ALLOWLIST_DOC = fixtureBytes("document.classify", "injection-in-allowlist");
export const INVOICE_MAIL = fixtureText("mail.ingest/canonical-invoice-mail");
export const INJECTION_MAIL = fixtureText("mail.ingest/injection-headers");

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "first-slice-"));
}

export function putArtifact(slice: Slice, bytes: string, tenantId = TENANT_A): Artifact {
  return slice.artifacts.put({ tenantId, bytes, receivedFrom: "test-harness" });
}

/** Deliver as the given actor through the slice transport. This is exactly what the orchestrator does per step. */
export async function dispatch(slice: Slice, message: MessageEnvelope, actorId = ORCHESTRATOR): Promise<ResultEnvelope> {
  return slice.transport.dispatch(message, actorId);
}

/** Payload a validator would hand to the stamp executor, for direct executor tests. */
export function validatedStampPayload(slice: Slice, artifact: Artifact, value = "INVOICE", stampText = "VALIDATED INVOICE"): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    documentType: { value, source: "llm", confidence: 0.9, trustLevel: "validated", validation: { status: "passed", provider: "document-validator", at: slice.clock.now().toISOString() } },
    stampText,
  };
}

/** Payload the workflow hands to email.send, for direct executor tests. */
export function emailPayload(artifactId: string, recipientRef = "ops-mailbox", documentType = "INVOICE"): Record<string, unknown> {
  return { recipientRef, templateId: "document-stamped", params: { documentType, artifactId } };
}

export async function runIntake(slice: Slice, input: { bytes: string; tenantId?: string; stampText?: string; correlationId?: string }) {
  const artifact = putArtifact(slice, input.bytes, input.tenantId);
  const inst = slice.orchestrator.start(
    { tenantId: input.tenantId ?? TENANT_A, artifactId: artifact.artifactId, ...(input.stampText ? { stampText: input.stampText } : {}) },
    input.correlationId,
  );
  const instance = await slice.orchestrator.run(inst.workflowId);
  return { artifact, instance };
}

export async function runMailIntake(slice: Slice, input: { rawMail: string; notifyRef?: string; stampText?: string; receivedFrom?: string; correlationId?: string }) {
  const inst = slice.mailOrchestrator.start(
    {
      tenantId: TENANT_A,
      rawMail: input.rawMail,
      receivedFrom: input.receivedFrom ?? "smtp:relay.example",
      notifyRef: input.notifyRef ?? "ops-mailbox",
      ...(input.stampText ? { stampText: input.stampText } : {}),
    },
    input.correlationId,
  );
  return slice.mailOrchestrator.run(inst.workflowId);
}

/** Generic scenario runner for INT-E2E-001: resolves `$artifact` / `$fixtureText` inputs and runs the named workflow. */
export async function runScenario(slice: Slice, workflow: string, input: Record<string, unknown>): Promise<Instance> {
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === "object" && "$artifact" in v) resolved[k] = putArtifact(slice, fixtureText(String((v as { $artifact: string }).$artifact))).artifactId;
    else if (v && typeof v === "object" && "$fixtureText" in v) resolved[k] = fixtureText(String((v as { $fixtureText: string }).$fixtureText));
    else resolved[k] = v;
  }
  const orchestrator = slice.orchestrators[workflow];
  if (!orchestrator) throw new Error(`no orchestrator for workflow ${workflow}`);
  const inst = orchestrator.start({ tenantId: TENANT_A, ...resolved });
  return orchestrator.run(inst.workflowId);
}

export interface Trace {
  instance: string;
  published: Instance["published"];
  steps: Array<{ stepId: string; status: string; strategy: string; sideEffects: string; attempt: number; logicalAttempt: number; code?: string; reconciliationAttempts?: number }>;
  audit: string[];
  reviews: Array<{ reasonCode: string; requiredRole: string; status: string }>;
  writes: number;
  sends: number;
  recipients: string[];
}

/** Everything INT-E2E-001 compares against the golden master (conformanceTier of the workflow definition). */
export function trace(slice: Slice, workflowId: string): Trace {
  const inst = slice.journal.get(workflowId);
  if (!inst) throw new Error(`no instance ${workflowId}`);
  const taskIds = slice.audit
    .byKind("review-created")
    .filter((r) => r.workflowId === workflowId)
    .map((r) => String(r.details?.reviewTaskId));
  return {
    instance: inst.status,
    published: inst.published,
    steps: inst.steps.map((s) => ({
      stepId: s.stepId,
      status: s.status,
      strategy: s.strategy,
      sideEffects: s.sideEffects,
      attempt: s.attempt,
      logicalAttempt: s.logicalAttempt,
      ...(s.result?.error ? { code: s.result.error.code } : {}),
      ...(s.reconciliationAttempts ? { reconciliationAttempts: s.reconciliationAttempts } : {}),
    })),
    audit: slice.audit.byCorrelation(inst.correlationId).map((r) => r.kind),
    reviews: taskIds
      .map((id) => slice.review.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({ reasonCode: t.reasonCode, requiredRole: t.requiredRole, status: t.status })),
    writes: slice.dms.stampCalls,
    sends: slice.smtp.sendCalls,
    recipients: slice.smtp.recipients(),
  };
}

/** Deep subset: every key in `expected` must exist in `actual` with an equal (recursively subset) value. Arrays compare by index and length. */
export function subsetDiff(actual: unknown, expected: unknown, path = "$"): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array`];
    if (actual.length !== expected.length) return [`${path}: length ${actual.length} != ${expected.length}`];
    return expected.flatMap((e, i) => subsetDiff(actual[i], e, `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected as Record<string, unknown>).flatMap(([k, v]) => subsetDiff((actual as Record<string, unknown>)[k], v, `${path}.${k}`));
  }
  return Object.is(actual, expected) ? [] : [`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`];
}
