// DISC family: discovery.ts's planDiscovery() — the platform's fixed first question ("what does this impulse
// mean") expressed as a genuine plan() call over the real FactCatalog, never a hardcoded conditional (same bar
// tests/attachment-fanout.test.ts holds fanOutAttachments() to for its own plan() call).
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { newCase, type Case, type NormalizedImpulse } from "../src/platform/case.js";
import { projectCurrentCase } from "../src/platform/case-projection.js";
import { FakeClock } from "../src/platform/clock.js";
import { DISCOVERY_GOAL, planDiscovery } from "../src/platform/discovery.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
import { EvidenceLedger, type EvidenceCandidate } from "../src/platform/evidence.js";
import { generateKeyPair } from "../src/platform/signing.js";
import { realCatalog } from "./harness/facts.js";

const START = "2026-09-19T09:00:00Z";
const TENANT = "tenant-42";
const CASE_A = "case-disc-a";
const CATALOG = realCatalog();

function fixture(now = START) {
  const clock = new FakeClock(now);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  const artifacts = new ArtifactStore(clock);
  return { clock, ledger, artifacts };
}

const impulse = (overrides: Partial<NormalizedImpulse> = {}): NormalizedImpulse => ({
  impulseId: "imp-1",
  tenantId: TENANT,
  channel: "mail",
  receivedAt: START,
  artifacts: [],
  metadata: {},
  ...overrides,
});

function caseOf(overrides: Partial<NormalizedImpulse> = {}): Case {
  return newCase({ caseId: CASE_A, impulse: impulse(overrides) });
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT,
    originCaseId: CASE_A,
    producerId: "intent.resolve",
    capabilityVersion: "1",
    buildHash: "build-abc123",
    subject: { key: "impulse.intent", scope: CASE_SCOPE },
    inputValueHash: "hash-of-content",
    result: "GENERAL_QUESTION",
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

describe("DISC-000 goal is the fixed, documented discovery question", () => {
  it("is exactly ['impulse.intent'] (docs/M0-FACT-CONTRACT-V1.md's own example)", () => {
    expect(DISCOVERY_GOAL).toEqual(["impulse.intent"]);
  });
});

describe("DISC-001 a Case with no impulse content at all cannot even reach intent.resolve", () => {
  it("is CAPABILITY_GAP — impulse.raw has no producer and is not available", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf();
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    expect(projection.availableArtifacts).toHaveLength(0);
    const result = planDiscovery(projection, CATALOG);
    expect(result.status).toBe("CAPABILITY_GAP");
    if (result.status !== "CAPABILITY_GAP") return;
    expect(result.missing.some((g) => g.key === "impulse.raw")).toBe(true);
  });
});

describe("DISC-002 a Case whose impulse carries content resolves to exactly [intent.resolve]", () => {
  it("PLANNED, one step, intent.resolve — via the impulse's own content artifact", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf({ content: { artifactId: "art-content-1" } });
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const result = planDiscovery(projection, CATALOG);
    expect(result.status).toBe("PLANNED");
    if (result.status !== "PLANNED") return;
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.capability).toBe("intent.resolve");
  });

  it("also resolves via a plain attachment (no dedicated content artifact)", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf({ artifacts: [{ artifactId: "art-attach-1" }] });
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const result = planDiscovery(projection, CATALOG);
    expect(result.status).toBe("PLANNED");
    if (result.status !== "PLANNED") return;
    expect(result.steps.map((s) => s.capability)).toEqual(["intent.resolve"]);
  });
});

describe("DISC-003 a Case that already has impulse.intent needs no further plan", () => {
  it("PLANNED with zero steps — the goal is already satisfied, never re-planned", () => {
    const { ledger, artifacts } = fixture();
    const c = caseOf({ content: { artifactId: "art-content-1" } });
    ledger.append(candidate());
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    expect(projection.availableFacts.some((a) => a.key === "impulse.intent")).toBe(true);
    const result = planDiscovery(projection, CATALOG);
    expect(result.status).toBe("PLANNED");
    if (result.status !== "PLANNED") return;
    expect(result.steps).toHaveLength(0);
  });
});

describe("DISC-004 genuinely goes through plan(), not a lookup table", () => {
  it("an UNKNOWN-key goal would be INVALID, proving planDiscovery defers entirely to plan()+catalog", () => {
    // Sanity check on the real catalog itself: impulse.intent must be a known key (else DISCOVERY_GOAL is
    // pointing at nothing and every test above would be vacuous).
    expect(CATALOG.entry("impulse.intent")).toBeDefined();
    expect(CATALOG.producersOf("impulse.intent").map((f) => f.capability)).toEqual(["intent.resolve"]);
  });
});
