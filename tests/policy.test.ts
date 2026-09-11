// Policy Enforcement v2 (FOUNDATION-core §3.3 steps 5-6, SEC-SEM-001 runtime layer, docs/POSUDKY.md
// Posudek 7 MAJOR 3 / Posudek 8 P0-2 / Posudek 11 point 4): checkGrant() alone never enforced
// `effectFieldValidators`/`approval`/`isolation` even though Policy has carried them from the start.
// No real capability declares these today (every policy file has approval.required:false, empty
// effectFieldValidators — verified before this file was written), so this exercises the new
// ExecutorHost decision-chain steps through a self-contained synthetic fixture, the same pattern
// tests/dh.test.ts already uses for the real Gateway/Router/ExecutorHost boundary — no production
// capability invented.
import { describe, expect, it } from "vitest";
import { Audit } from "../src/platform/audit.js";
import { FakeClock, iso, plus, MINUTE } from "../src/platform/clock.js";
import { CredentialResolver } from "../src/platform/credentials.js";
import { ExecutorHost, type HostHandlerSpec, type HostMutants } from "../src/platform/executor-host.js";
import { Gateway, IdentityProvider } from "../src/platform/gateway.js";
import { newId } from "../src/platform/ids.js";
import { LifecycleRegistry } from "../src/platform/lifecycle.js";
import type { Policy } from "../src/platform/policy.js";
import { ReviewService } from "../src/platform/review.js";
import { Router, type RegisteredComponent } from "../src/platform/router.js";
import { generateKeyPair, KeyRegistry, Signer } from "../src/platform/signing.js";
import type { MessageEnvelope } from "../src/platform/types.js";

const START = "2026-09-11T08:00:00Z";
const CAP = "test.write";
const MODULE = "test-policy-module";
const HANDLER_ID = "test.write.handler";
const TENANT = "t1";
const ACTOR = "svc-test";

/** `isolationClass` parameterized: the isolation cross-check tests need to construct a deliberately
 * mismatched descriptor vs. policy. */
function descriptorFor(isolationClass: string): Record<string, unknown> & { module: string } {
  return {
    module: MODULE,
    componentVersion: "0.1.0",
    runtime: "in-process",
    deploymentModel: "CLOUD_SINGLE_TENANT",
    tenantMode: "SINGLE",
    owner: "test",
    verificationProfiles: ["WRITE_EXECUTOR", "PROVIDER", "EVIDENCE"],
    capabilities: [
      {
        name: CAP,
        versions: ["1"],
        preferredVersion: "1",
        inputSchema: "test.write.input.v1",
        outputSchema: "test.write.output.v1",
        conformanceSuiteVersion: "1.0",
        conformanceTier: "exact",
        executionMode: "sync",
        sideEffects: "external-write",
        trustClass: "executor",
        riskClass: "MEDIUM",
        isolationClass,
        requiredScopes: [CAP],
        usesLlm: false,
        idempotency: "not-applicable",
        idempotencyRetention: "business-identity",
        deadlinePolicy: "PT10M",
        reversibility: "IRREVERSIBLE",
        unknownOutcomeRecovery: "not-applicable",
        humanApproval: "policy",
        errorCodes: ["EFFECT_FIELD_VALIDATION_FAILED", "APPROVAL_REQUIRED", "APPROVAL_MISMATCH"],
      },
    ],
    endpoints: { health: "/health", version: "/version", capabilities: "/capabilities" },
  };
}

const inputSchema = { type: "object", additionalProperties: true };

function basePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    policyRef: `test.${CAP}`,
    capability: CAP,
    capabilityVersion: "1",
    owner: "test",
    grants: [{ actorId: ACTOR, scopes: [CAP], tenants: [TENANT] }],
    failClosed: true,
    ...overrides,
  };
}

type HostOptions = ConstructorParameters<typeof ExecutorHost>[0];

/** Builds a real Gateway + Router + ExecutorHost trio for `test.write`, same pattern as tests/dh.test.ts's
 * remoteHost() — a real signed dispatch runs the real decision chain, not a hand-built context. */
function fixture(opts: { policy: Policy; reviewTasks?: HostOptions["reviewTasks"]; mutants?: HostMutants; isolationClass?: string }) {
  const clock = new FakeClock(START);
  const audit = new Audit(clock);
  const credentials = new CredentialResolver({}, audit);
  const executor = new ExecutorHost({
    hostId: MODULE,
    clock,
    audit,
    credentials,
    policyFor: () => opts.policy,
    reviewTasks: opts.reviewTasks,
  });
  if (opts.mutants) Object.assign(executor.mutants, opts.mutants);
  const spec: HostHandlerSpec = {
    capability: CAP,
    handlerId: HANDLER_ID,
    resourceTenant: () => ({ kind: "GLOBAL_RESOURCE" }),
    allowsGlobalResource: true,
    run: async () => ({ status: "SUCCEEDED", payload: { ok: true } }),
  };
  executor.register(spec);

  const keyPair = generateKeyPair();
  const registry = new KeyRegistry();
  registry.add({ keyId: "k1", publicKey: keyPair.publicKey, validFrom: iso(new Date(0)) });
  const identities = new IdentityProvider([{ actorId: ACTOR, actorType: "service", tenantId: TENANT, scopes: [CAP], authStrength: "client-credentials" }]);
  const gateway = new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock });
  const router = new Router({ registry, clock, audit, lifecycle: new LifecycleRegistry({ [MODULE]: "ACTIVE" }) });
  const component: RegisteredComponent = {
    descriptor: descriptorFor(opts.isolationClass ?? "PRINCIPAL") as never,
    policies: { [CAP]: opts.policy },
    capabilities: [{ name: CAP, version: "1", inputSchema, handler: executor.handlerFor(CAP) }],
  };
  router.register(component);

  const msg = (payload: Record<string, unknown>): MessageEnvelope => ({
    messageId: newId("msg"),
    correlationId: newId("cor"),
    type: "command",
    capability: CAP,
    capabilityVersion: "1",
    schemaVersion: "1",
    createdAt: iso(clock.now()),
    notValidAfter: iso(plus(clock.now(), 30 * MINUTE)),
    payload,
  });

  return { clock, audit, router, gateway, dispatch: (payload: Record<string, unknown>) => router.route(gateway.dispatch(msg(payload), ACTOR)) };
}

describe("SEC-SEM-001 runtime layer — effect-field validators (FOUNDATION-core §3.3 step 5)", () => {
  const policy = basePolicy({ effectFieldValidators: { bankAccount: { validator: "cz.vat.verify", mustPass: true } } });

  it("a field carrying validation.status:passed from the named validator succeeds", async () => {
    const f = fixture({ policy });
    const r = await f.dispatch({ bankAccount: { value: "CZ0000000000000000000000", validation: { status: "passed", provider: "cz.vat.verify", at: iso(f.clock.now()) } } });
    console.log("DEBUG result:", JSON.stringify(r, null, 2));
    expect(r.status).toBe("SUCCEEDED");
  });

  it("a field missing validation entirely is rejected, never silently accepted (INT-FAIL-004 shape)", async () => {
    const f = fixture({ policy });
    const r = await f.dispatch({ bankAccount: { value: "CZ0000000000000000000000" } });
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("EFFECT_FIELD_VALIDATION_FAILED");
    expect(r.error?.class).toBe("SECURITY");
  });

  it("a field whose validation.status is failed is rejected", async () => {
    const f = fixture({ policy });
    const r = await f.dispatch({ bankAccount: { value: "CZ0000000000000000000000", validation: { status: "failed", provider: "cz.vat.verify", at: iso(f.clock.now()) } } });
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("EFFECT_FIELD_VALIDATION_FAILED");
  });

  it("a field validated by a different provider than the policy names is rejected (no laundering another field's validation)", async () => {
    const f = fixture({ policy });
    const r = await f.dispatch({ bankAccount: { value: "CZ0000000000000000000000", validation: { status: "passed", provider: "some.other.validator", at: iso(f.clock.now()) } } });
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("EFFECT_FIELD_VALIDATION_FAILED");
  });

  it("MUT-SEM-001 host with skipEffectFieldValidation accepts the unvalidated field (this test proves the guard can fail)", async () => {
    const f = fixture({ policy, mutants: { skipEffectFieldValidation: true } });
    const r = await f.dispatch({ bankAccount: { value: "CZ0000000000000000000000" } });
    expect(r.status).toBe("SUCCEEDED");
  });

  it("a capability whose policy declares no effectFieldValidators is unaffected (every real policy today)", async () => {
    const f = fixture({ policy: basePolicy() });
    const r = await f.dispatch({ anything: "goes" });
    expect(r.status).toBe("SUCCEEDED");
  });
});

describe("Human approval — FOUNDATION-core §3.3 step 6", () => {
  function withApproval(review: ReviewService): Policy {
    return basePolicy({ approval: { required: true, reviewerRole: "test.approver", approvalBoundTo: ["workflowId"] } });
  }

  it("a command carrying an approvalId that resolves to a DECIDED APPROVE task for this tenant/role succeeds", async () => {
    const clockRef = new FakeClock(START);
    const audit = new Audit(clockRef);
    const review = new ReviewService(clockRef, audit);
    const task = review.create({ workflowId: "wf-1", stepId: "write", tenantId: TENANT, reasonCode: "TEST", requiredRole: "test.approver", allowedDecisions: ["APPROVE"], expiresInMs: 60_000, expiryPolicy: "EXPIRE_TO_FAILED" });
    review.decide(task.reviewTaskId, { actorId: "human-1", role: "test.approver", tenantId: TENANT, decision: "APPROVE" });
    const f = fixture({ policy: withApproval(review), reviewTasks: review });
    const r = await f.dispatch({ approvalId: task.reviewTaskId, workflowId: "wf-1" });
    expect(r.status).toBe("SUCCEEDED");
  });

  it("a command with no approvalId is rejected APPROVAL_REQUIRED, not silently allowed", async () => {
    const clockRef = new FakeClock(START);
    const audit = new Audit(clockRef);
    const review = new ReviewService(clockRef, audit);
    const f = fixture({ policy: withApproval(review), reviewTasks: review });
    const r = await f.dispatch({});
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.error?.class).toBe("POLICY");
  });

  it("a command whose approvalId points at a REJECTed task is rejected APPROVAL_MISMATCH, never treated as approved", async () => {
    const clockRef = new FakeClock(START);
    const audit = new Audit(clockRef);
    const review = new ReviewService(clockRef, audit);
    const task = review.create({ workflowId: "wf-1", stepId: "write", tenantId: TENANT, reasonCode: "TEST", requiredRole: "test.approver", allowedDecisions: ["APPROVE", "REJECT"], expiresInMs: 60_000, expiryPolicy: "EXPIRE_TO_FAILED" });
    review.decide(task.reviewTaskId, { actorId: "human-1", role: "test.approver", tenantId: TENANT, decision: "REJECT" });
    const f = fixture({ policy: withApproval(review), reviewTasks: review });
    const r = await f.dispatch({ approvalId: task.reviewTaskId, workflowId: "wf-1" });
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("APPROVAL_MISMATCH");
  });

  it("a command bound to a different workflowId than the one the approval was decided for is rejected APPROVAL_MISMATCH", async () => {
    const clockRef = new FakeClock(START);
    const audit = new Audit(clockRef);
    const review = new ReviewService(clockRef, audit);
    const task = review.create({ workflowId: "wf-1", stepId: "write", tenantId: TENANT, reasonCode: "TEST", requiredRole: "test.approver", allowedDecisions: ["APPROVE"], expiresInMs: 60_000, expiryPolicy: "EXPIRE_TO_FAILED" });
    review.decide(task.reviewTaskId, { actorId: "human-1", role: "test.approver", tenantId: TENANT, decision: "APPROVE" });
    const f = fixture({ policy: withApproval(review), reviewTasks: review });
    const r = await f.dispatch({ approvalId: task.reviewTaskId, workflowId: "wf-2" });
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("APPROVAL_MISMATCH");
  });

  it("MUT-SEM-002 host with skipApproval accepts a command with no approvalId (this test proves the guard can fail)", async () => {
    const clockRef = new FakeClock(START);
    const audit = new Audit(clockRef);
    const review = new ReviewService(clockRef, audit);
    const f = fixture({ policy: withApproval(review), reviewTasks: review, mutants: { skipApproval: true } });
    const r = await f.dispatch({});
    expect(r.status).toBe("SUCCEEDED");
  });

  it("a capability whose policy has approval.required:false is unaffected (every real policy today)", async () => {
    const f = fixture({ policy: basePolicy({ approval: { required: false } }) });
    const r = await f.dispatch({});
    expect(r.status).toBe("SUCCEEDED");
  });
});

describe("Isolation cross-check — Router.register() (SEC-SEM-001 layer b, Posudek 11 point 4)", () => {
  it("registration succeeds when policy.isolation.acceptedIsolationClass matches the descriptor's declared isolationClass", () => {
    const f = fixture({ policy: basePolicy({ isolation: { acceptedIsolationClass: "PRINCIPAL" } }), isolationClass: "PRINCIPAL" });
    expect(f.router.providers()).toContain(`${CAP}/v1@${MODULE}`);
  });

  it("registration fails closed when policy and descriptor disagree on isolationClass (a drift that was silent before this change)", () => {
    expect(() => fixture({ policy: basePolicy({ isolation: { acceptedIsolationClass: "PRINCIPAL" } }), isolationClass: "LOGICAL" })).toThrow(/isolation/i);
  });

  it("registration is unaffected when neither side declares isolation (most capabilities today)", () => {
    const f = fixture({ policy: basePolicy() });
    expect(f.router.providers()).toContain(`${CAP}/v1@${MODULE}`);
  });
});
