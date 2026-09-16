// EW family: EvidenceWriter, the trusted-context-bound write path onto the Žlab (docs/POSUDKY.md
// Posudek 15 P1-2). EvidenceLedger.append() is a storage primitive, not a trust boundary by its
// own admission — these tests prove EvidenceWriter is the boundary a real capability handler would
// actually be handed, and that it structurally cannot be tricked into claiming a false identity.
import { describe, expect, it } from "vitest";
import { FakeClock, iso } from "../src/platform/clock.js";
import { EvidenceLedger } from "../src/platform/evidence.js";
import { EvidenceWriter } from "../src/platform/evidence-writer.js";
import { generateKeyPair } from "../src/platform/signing.js";
import type { HandlerInput, MessageEnvelope, TrustedContext } from "../src/platform/types.js";

const START = "2026-09-13T08:00:00Z";

function fixture() {
  const clock = new FakeClock(START);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  return { clock, ledger };
}

function context(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    dispatchId: "dsp-1",
    tenantId: "tenant-a",
    actorId: "cz.vat.verify-handler",
    actorType: "deterministic-module",
    scopes: ["cz.vat.verify"],
    sourceComponent: "apf-gateway",
    authenticatedAt: START,
    expiresAt: iso(new Date(Date.parse(START) + 3_600_000)),
    ...overrides,
  };
}

function message(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    messageId: "msg-1",
    correlationId: "cor-1",
    workflowId: "wf-1",
    type: "command",
    capability: "cz.vat.verify",
    capabilityVersion: "1",
    schemaVersion: "1",
    idempotencyKey: "wf-1:vat:default:1",
    createdAt: START,
    notValidAfter: iso(new Date(Date.parse(START) + 600_000)),
    payload: {},
    ...overrides,
  };
}

function input(overrides: { message?: Partial<MessageEnvelope>; context?: Partial<TrustedContext> } = {}): HandlerInput {
  return { message: message(overrides.message), context: context(overrides.context) };
}

const IDENTITY = { producerId: "cz.vat.verify", capabilityVersion: "1", buildHash: "build-vat-123" };
const CLAIM = { inputField: "bankAccount", inputValueHash: "hash-account", result: "PASS" };

describe("EW-001 write() binds tenantId/workflowId/operationId from the trusted HandlerInput, not from the claim", () => {
  it("evidence carries exactly the context's tenantId and the message's workflowId/messageId", () => {
    const { ledger } = fixture();
    const writer = new EvidenceWriter(ledger, IDENTITY);
    const evidence = writer.write(input(), CLAIM);
    expect(evidence.tenantId).toBe("tenant-a");
    expect(evidence.workflowId).toBe("wf-1");
    expect(evidence.operationId).toBe("msg-1");
  });

  it("a different context tenant produces evidence for that tenant, proving tenantId is genuinely per-call, not baked into the writer", () => {
    const { ledger } = fixture();
    const writer = new EvidenceWriter(ledger, IDENTITY);
    const evidence = writer.write(input({ context: { tenantId: "tenant-b" } }), CLAIM);
    expect(evidence.tenantId).toBe("tenant-b");
  });
});

describe("EW-002 producer identity is bound once at construction, never per call", () => {
  it("two writers built for different capabilities always stamp their own identity, regardless of the HandlerInput they're given", () => {
    const { ledger } = fixture();
    const vatWriter = new EvidenceWriter(ledger, { producerId: "cz.vat.verify", capabilityVersion: "1", buildHash: "build-vat" });
    const companyWriter = new EvidenceWriter(ledger, { producerId: "cz.company.verify", capabilityVersion: "1", buildHash: "build-company" });

    const sameInput = input();
    const vatEvidence = vatWriter.write(sameInput, CLAIM);
    const companyEvidence = companyWriter.write(sameInput, CLAIM);

    expect(vatEvidence.producerId).toBe("cz.vat.verify");
    expect(vatEvidence.buildHash).toBe("build-vat");
    expect(companyEvidence.producerId).toBe("cz.company.verify");
    expect(companyEvidence.buildHash).toBe("build-company");
  });

  it("EvidenceClaim has no field a handler could use to override producerId/capabilityVersion/buildHash even by casting", () => {
    const { ledger } = fixture();
    const writer = new EvidenceWriter(ledger, IDENTITY);
    // A handler that somehow got a malicious object past the type system still can't smuggle an
    // identity through: write() reads exactly the six named EvidenceClaim properties, never spreads.
    const malicious = { ...CLAIM, producerId: "cz.company.verify", buildHash: "attacker-build", tenantId: "tenant-evil" } as typeof CLAIM;
    const evidence = writer.write(input(), malicious);
    expect(evidence.producerId).toBe("cz.vat.verify");
    expect(evidence.buildHash).toBe("build-vat-123");
    expect(evidence.tenantId).toBe("tenant-a");
  });
});

describe("EW-003 the written evidence is real, sealed Žlab evidence, not a separate side-channel", () => {
  it("the ledger holds it and verify()/get() see exactly what write() returned", () => {
    const { ledger } = fixture();
    const writer = new EvidenceWriter(ledger, IDENTITY);
    const evidence = writer.write(input(), CLAIM);
    expect(ledger.get(evidence.recordId)).toEqual(evidence);
    expect(ledger.verify(evidence)).toEqual({ ok: true });
  });
});

describe("EW-004 EvidenceWriter exposes only write(), no read/update/delete surface", () => {
  it("the class has exactly one method", () => {
    const methods = Object.getOwnPropertyNames(EvidenceWriter.prototype).filter((m) => m !== "constructor");
    expect(methods).toEqual(["write"]);
  });
});

// M0 část C (docs/M0-FACT-CONTRACT-V1.md): authority is granted by the installation and bound into the writer at
// construction — a cow can never raise its own trust through the claim.
describe("EW-005 authorityDomain comes from the writer's platform-bound identity, never from the claim", () => {
  it("a writer constructed with a domain stamps it; a claim carrying authorityDomain (even via cast) is ignored", () => {
    const { ledger } = fixture();
    const granted = new EvidenceWriter(ledger, { ...IDENTITY, authority: { domain: "cz.vat.registry", facts: "*", maxEvidenceTtlMs: null } });
    expect(granted.write(input(), CLAIM).authorityDomain).toBe("cz.vat.registry");
    const ungranted = new EvidenceWriter(ledger, IDENTITY);
    const smuggled = ungranted.write(input(), { ...CLAIM, authorityDomain: "tenant.human-review" } as never);
    expect(smuggled.authorityDomain).toBeUndefined();
    expect(ledger.verify(smuggled)).toEqual({ ok: true });
  });
});
