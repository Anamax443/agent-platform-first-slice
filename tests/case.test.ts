// CASE family (M0-FACT-CONTRACT-V1.md część 0 "Impuls a Case", krůček 5 UZAVŘENO 16. 9. 2026 — implementation
// część E): Case = one impulse, one Žlab, N workflow instances in time. Today's model still creates a bare
// Instance straight from a channel (apf-gateway index.ts) — this is the additive type + append-only instance
// list only, not yet wired into the live intake path (same "mechanism first" pattern as A-1/B-1 today).
import { describe, expect, it } from "vitest";
import { addInstance, CaseError, newCase, type NormalizedImpulse } from "../src/platform/case.js";
import type { Instance } from "../src/platform/journal.js";

const TENANT = "tenant-42";
const START = "2026-09-16T16:00:00Z";

const impulse = (overrides: Partial<NormalizedImpulse> = {}): NormalizedImpulse => ({
  impulseId: "imp-1",
  tenantId: TENANT,
  channel: "mail",
  receivedAt: START,
  artifacts: [],
  metadata: {},
  ...overrides,
});

const instance = (overrides: Partial<Pick<Instance, "workflowId" | "tenantId" | "status" | "createdAt" | "updatedAt">> = {}) => ({
  workflowId: "wf-1",
  tenantId: TENANT,
  status: "RUNNING" as const,
  createdAt: START,
  updatedAt: START,
  ...overrides,
});

describe("CASE-001 a fresh Case wraps one impulse and its first instance", () => {
  it("caseId/tenantId/status/instances[] are set from the impulse and instance given", () => {
    const c = newCase({ caseId: "case-1", impulse: impulse(), instance: instance() });
    expect(c).toEqual({
      caseId: "case-1",
      tenantId: TENANT,
      impulse: impulse(),
      instances: ["wf-1"],
      status: "RUNNING",
      createdAt: START,
      updatedAt: START,
    });
  });
  it("a Case can never span tenants — a mismatched impulse/instance tenantId is refused", () => {
    expect(() => newCase({ caseId: "case-1", impulse: impulse({ tenantId: "tenant-7" }), instance: instance() })).toThrow(CaseError);
  });
});

describe("CASE-002 addInstance is append-only", () => {
  it("a second instance is appended, oldest first, status follows the newest instance", () => {
    const c1 = newCase({ caseId: "case-1", impulse: impulse(), instance: instance() });
    const c2 = addInstance(c1, { workflowId: "wf-2", tenantId: TENANT, status: "SUCCEEDED", updatedAt: "2026-09-16T16:05:00Z" });
    expect(c2.instances).toEqual(["wf-1", "wf-2"]);
    expect(c2.status).toBe("SUCCEEDED");
    expect(c2.updatedAt).toBe("2026-09-16T16:05:00Z");
    // c1 itself is untouched (Case values are immutable snapshots, same discipline as Instance/Evidence).
    expect(c1.instances).toEqual(["wf-1"]);
  });
  it("re-adding the same workflowId is refused, never silently duplicated", () => {
    const c1 = newCase({ caseId: "case-1", impulse: impulse(), instance: instance() });
    expect(() => addInstance(c1, { workflowId: "wf-1", tenantId: TENANT, status: "RUNNING", updatedAt: START })).toThrow(CaseError);
  });
  it("an instance from a different tenant is refused", () => {
    const c1 = newCase({ caseId: "case-1", impulse: impulse(), instance: instance() });
    expect(() => addInstance(c1, { workflowId: "wf-2", tenantId: "tenant-7", status: "RUNNING", updatedAt: START })).toThrow(CaseError);
  });
});

describe("CASE-003 NormalizedImpulse structurally carries no workflow/goal/intent field", () => {
  it("the only fields on an impulse are the ones part 0 named — no route/workflow/goal key exists to smuggle a decision through", () => {
    const i = impulse({ sender: "a@b.cz", text: "hello", thread: "t-1", metadata: { foo: "bar" }, content: { artifactId: "art-1" } });
    expect(Object.keys(i).sort()).toEqual(["artifacts", "channel", "content", "impulseId", "metadata", "receivedAt", "sender", "tenantId", "text", "thread"].sort());
  });
});

// Commit 4 (18.9.2026, live external audit finding — see case.ts's NormalizedImpulse.content doc comment and
// index.ts's createCaseForMailIntake()/mailIngestPayload() for the full "why"): `content` is the one new field
// this commit adds, a single optional ArtifactRef distinct from `artifacts` (the discrete things the sender
// actually sent) — these two tests close the exact test-surface gap the audit's own evidence chain flagged (no
// existing test exercised impulse.content construction end-to-end): that it is genuinely optional, and that it
// round-trips through newCase() unchanged, mirroring how CASE-001 already asserts the impulse round-trips.
describe("CASE-004 content, when present, is a plain ArtifactRef distinct from artifacts", () => {
  it("an impulse built with no override has content undefined — the field is optional, not silently defaulted", () => {
    const i = impulse();
    expect(i.content).toBeUndefined();
  });

  it("when supplied, content round-trips through newCase() unchanged, alongside an unrelated non-empty artifacts[]", () => {
    const withContent = impulse({ artifacts: [{ artifactId: "art-attachment-1" }], content: { artifactId: "art-combined-1" } });
    const c = newCase({ caseId: "case-1", impulse: withContent, instance: instance() });
    expect(c.impulse.content).toEqual({ artifactId: "art-combined-1" });
    expect(c.impulse.artifacts).toEqual([{ artifactId: "art-attachment-1" }]);
    expect(c.impulse).toEqual(withContent);
  });
});

// CASE-004 (this change, 18.9.2026 — fixing the gap a rigorous external audit performed after commit 7971ede
// named, "Case can exist with 0 instances"): newCase() no longer requires an `instance` argument. Before this
// change a Case could not structurally represent "opened from an impulse, nothing has run yet" — the state
// AUTONOMOUS-RUNTIME-V1.md's own acceptance scenario C (part 8) needs for a mail with three different
// document.type attachments arriving before any of them is individually planned. See case.ts's CaseStatus
// (UNSTARTED) and newCase()/addInstance() doc comments for the full reasoning.
describe("CASE-004 newCase() with no instance yet — Case can exist with 0 instances (this change)", () => {
  it("instances/status/tenantId/timestamps are sourced from the impulse alone when no instance is given", () => {
    const c = newCase({ caseId: "case-1", impulse: impulse() });
    expect(c).toEqual({
      caseId: "case-1",
      tenantId: TENANT,
      impulse: impulse(),
      instances: [],
      status: "UNSTARTED",
      createdAt: START,
      updatedAt: START,
    });
  });

  it("addInstance() appends the first instance onto an UNSTARTED case exactly like appending a second instance onto a started one (CASE-002 above) — no code-path change needed for the empty starting array", () => {
    const c0 = newCase({ caseId: "case-1", impulse: impulse() });
    const c1 = addInstance(c0, instance());
    expect(c1.instances).toEqual(["wf-1"]);
    expect(c1.status).toBe("RUNNING");
  });
});
