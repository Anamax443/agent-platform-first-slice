// INST family: the installation profile and workflow definitions are loaded fail-closed; a wrong or missing
// piece stops the wiring before any router or orchestrator exists (installation-profile rule, M4b step 1).
import { describe, expect, it } from "vitest";
import { assembleInstallation, credentialTable } from "../src/installation.js";
import type { Policy } from "../src/platform/policy.js";
import { parseWorkflowDef } from "../src/platform/workflow.js";
import { createSlice, FAKE_SECRETS, LOCAL_FAKES, ORCHESTRATOR, TENANT_A, workflowDef } from "./harness/index.js";

const clone = <T>(x: T): T => structuredClone(x);
const profile = () => clone(LOCAL_FAKES.profile);
const policies = () => Object.values(clone(LOCAL_FAKES.policies));

describe("INST-001 installation profile is assembled fail-closed", () => {
  it("the local-fakes installation assembles and its constants come from the profile", () => {
    const inst = assembleInstallation(profile(), policies());
    expect(inst.profile.roles.orchestrator).toBe(ORCHESTRATOR);
    expect(inst.profile.identities.find((i) => i.actorId === ORCHESTRATOR)?.tenantId).toBe(TENANT_A);
    expect(Object.keys(inst.policies).sort()).toEqual([...inst.profile.policyRefs].sort());
  });

  it("a profile that violates its schema is rejected", () => {
    const p = profile() as unknown as Record<string, unknown>;
    delete p.retentionDays;
    expect(() => assembleInstallation(p, policies())).toThrow(/profile invalid/);
    const q = profile() as unknown as Record<string, unknown>;
    q.extra = 1;
    expect(() => assembleInstallation(q, policies())).toThrow(/profile invalid/);
  });

  it("a policyRef without a policy file is rejected", () => {
    expect(() => assembleInstallation(profile(), policies().filter((p) => p.capability !== "email.send"))).toThrow(/policy for email.send missing/);
  });

  it("a policy that is not failClosed, grants an unknown identity, a scope the identity lacks, or an unknown tenant is rejected", () => {
    const notClosed = policies().map((p) => (p.capability === "document.stamp" ? { ...p, failClosed: false } : p));
    expect(() => assembleInstallation(profile(), notClosed)).toThrow(/not failClosed/);

    const ghost = policies().map((p) => (p.capability === "document.stamp" ? { ...p, grants: [...p.grants, { actorId: "svc-ghost", scopes: ["document.stamp"], tenants: [TENANT_A] }] } : p));
    expect(() => assembleInstallation(profile(), ghost)).toThrow(/svc-ghost, which is not an identity/);

    const ai = profile().identities.find((i) => i.actorType === "ai-agent")?.actorId as string;
    const escalated = policies().map((p) => (p.capability === "document.stamp" ? { ...p, grants: [...p.grants, { actorId: ai, scopes: ["document.stamp"], tenants: [TENANT_A] }] } : p));
    expect(() => assembleInstallation(profile(), escalated)).toThrow(/whose identity does not hold it/);

    const foreign = policies().map((p) => (p.capability === "document.stamp" ? { ...p, grants: [{ ...(p.grants[0] as Policy["grants"][number]), tenants: ["tenant-x"] }] } : p));
    expect(() => assembleInstallation(profile(), foreign)).toThrow(/tenant tenant-x, unknown/);
  });

  it("the orchestrator role must be an identity and identities must belong to known tenants", () => {
    const p = profile();
    p.roles.orchestrator = "svc-nobody";
    expect(() => assembleInstallation(p, policies())).toThrow(/roles.orchestrator svc-nobody/);
    const q = profile();
    (q.identities[0] as { tenantId: string }).tenantId = "tenant-x";
    expect(() => assembleInstallation(q, policies())).toThrow(/tenant tenant-x, unknown/);
  });
});

describe("INST-002 credential table: code needs, profile grants, secrets source provides", () => {
  it("a handler without a profile entry, a reference the profile does not grant, or a missing secret value stops the wiring", () => {
    expect(() => credentialTable(LOCAL_FAKES, FAKE_SECRETS, { "unknown-handler": [] })).toThrow(/no credential entry for handler unknown-handler/);
    expect(() => credentialTable(LOCAL_FAKES, FAKE_SECRETS, { "email-send-handler": ["cred:dms-stamp"] })).toThrow(/needs cred:dms-stamp, which the profile does not grant/);
    expect(() => credentialTable(LOCAL_FAKES, () => undefined, { "email-send-handler": ["cred:smtp"] })).toThrow(/secret for cred:smtp .* not provided/);
    expect(() => createSlice()).not.toThrow();
  });

  it("the table holds exactly the references the profile lists for each handler", () => {
    const table = credentialTable(LOCAL_FAKES, FAKE_SECRETS, { "email-send-handler": ["cred:smtp"], "mail-ingest-handler": [] });
    expect(Object.keys(table["email-send-handler"] ?? {})).toEqual(LOCAL_FAKES.profile.credentials["email-send-handler"]);
    expect(table["mail-ingest-handler"]).toEqual({});
  });
});

describe("INST-003 workflow definitions are parsed fail-closed", () => {
  it("the bundled definitions parse; a schema violation, a duplicate step id or a forward $steps ref is rejected", () => {
    const def = clone(workflowDef("mail-intake"));
    expect(parseWorkflowDef(def).steps.map((s) => s.id)).toEqual(["ingest", "classify", "validate", "stamp", "notify"]);

    const badTier = { ...clone(def), conformanceTier: "loose" };
    expect(() => parseWorkflowDef(badTier)).toThrow(/workflow definition invalid/);

    const dup = clone(def);
    (dup.steps[1] as { id: string }).id = "ingest";
    expect(() => parseWorkflowDef(dup)).toThrow(/duplicate step id ingest/);

    const forward = clone(def);
    (forward.steps[0] as { inputs: Record<string, unknown> }).inputs.later = "$steps.notify.payload.x";
    expect(() => parseWorkflowDef(forward)).toThrow(/refers to \$steps.notify, which is not an earlier step/);
  });
});
