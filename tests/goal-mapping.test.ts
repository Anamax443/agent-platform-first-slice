// CGM family: goal-mapping.ts's resolveCaseGoal() — reads a Case's resolved impulse.intent through
// CurrentCaseProjection's own AVAILABLE recordId (never re-deriving trust/ambiguity, case-projection.ts already
// decided that) and maps it via GoalMapRegistry. Bar: NOT_RESOLVED/NO_MAPPING/MAPPED are never conflated, the
// intent VALUE only ever comes from EvidenceLedger.get(recordId) — never from Projection/Planner directly (AR-1).
import { describe, expect, it } from "vitest";
import type { LlmAdapter, TokenUsage } from "../src/adapters/llm.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { Audit } from "../src/platform/audit.js";
import { newCase, type Case, type NormalizedImpulse } from "../src/platform/case.js";
import { projectCurrentCase } from "../src/platform/case-projection.js";
import { FakeClock } from "../src/platform/clock.js";
import { discoveryInput } from "../src/components/intent-resolver/discovery.js";
import { runDiscovery } from "../src/platform/discovery-runner.js";
import { EvidenceLedger, type EvidenceCandidate } from "../src/platform/evidence.js";
import { CASE_SCOPE } from "../src/platform/fact-catalog.js";
import { GoalMapRegistry } from "../src/platform/goal-map.js";
import { resolveCaseGoal } from "../src/platform/goal-mapping.js";
import { generateKeyPair } from "../src/platform/signing.js";
import { createSlice, ORCHESTRATOR, TENANT_A, putArtifact, type Slice } from "./harness/index.js";
import { realCatalog } from "./harness/facts.js";

const START = "2026-09-19T11:00:00Z";
const TENANT = "tenant-42";
const CASE_A = "case-goal-a";

function fixture(now = START) {
  const clock = new FakeClock(now);
  const keyPair = generateKeyPair();
  const ledger = new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
  const artifacts = new ArtifactStore(clock);
  const audit = new Audit(clock);
  return { clock, ledger, artifacts, audit };
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

function intentCandidate(result: string, overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    tenantId: TENANT,
    originCaseId: CASE_A,
    producerId: "intent.resolve",
    capabilityVersion: "1",
    buildHash: "test",
    subject: { key: "impulse.intent", scope: CASE_SCOPE },
    inputValueHash: "hash-of-content",
    result,
    parentRefs: [],
    parentHashes: [],
    ...overrides,
  };
}

describe("CGM-000 a Case with no resolved intent yet", () => {
  it("NOT_RESOLVED — nothing to map, and nothing audited (that's discovery's own job to report)", () => {
    const { ledger, artifacts, audit } = fixture();
    const c = caseOf();
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const before = audit.byKind("state").length;
    const result = resolveCaseGoal({ ledger, goalMap: GoalMapRegistry.empty(), audit }, projection);
    expect(result).toEqual({ status: "NOT_RESOLVED" });
    expect(audit.byKind("state").length).toBe(before);
  });
});

describe("CGM-001 a resolved intent with no configured mapping", () => {
  it("NO_MAPPING, carries the intent value, and is audited", () => {
    const { ledger, artifacts, audit } = fixture();
    const c = caseOf();
    ledger.append(intentCandidate("INVOICE_RECEIVED"));
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const result = resolveCaseGoal({ ledger, goalMap: GoalMapRegistry.empty(), audit }, projection);
    expect(result).toEqual({ status: "NO_MAPPING", intent: "INVOICE_RECEIVED" });
    const entry = audit.byKind("state").find((r) => r.capability === "case-goal-mapping");
    expect(entry?.details).toMatchObject({ caseId: CASE_A, intent: "INVOICE_RECEIVED", status: "NO_MAPPING" });
  });
});

describe("CGM-002 a resolved intent with a real configured mapping", () => {
  it("MAPPED, carries the goal, and is audited with the goal", () => {
    const { ledger, artifacts, audit } = fixture();
    const c = caseOf();
    ledger.append(intentCandidate("UNKNOWN"));
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const goalMap = GoalMapRegistry.build({ schemaVersion: "1", entries: { UNKNOWN: [] } });
    const result = resolveCaseGoal({ ledger, goalMap, audit }, projection);
    expect(result).toEqual({ status: "MAPPED", intent: "UNKNOWN", goal: [] });
    const entry = audit.byKind("state").find((r) => r.capability === "case-goal-mapping");
    expect(entry?.details).toMatchObject({ caseId: CASE_A, intent: "UNKNOWN", status: "MAPPED", goal: [] });
  });

  it("a non-empty mapped goal round-trips exactly", () => {
    const { ledger, artifacts, audit } = fixture();
    const c = caseOf();
    ledger.append(intentCandidate("INVOICE_RECEIVED"));
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    const goalMap = GoalMapRegistry.build({ schemaVersion: "1", entries: { INVOICE_RECEIVED: ["document.type"] } });
    const result = resolveCaseGoal({ ledger, goalMap, audit }, projection);
    expect(result).toEqual({ status: "MAPPED", intent: "INVOICE_RECEIVED", goal: ["document.type"] });
  });
});

describe("CGM-003 never reads the value except through a Projection-vouched recordId", () => {
  it("a BLOCKED (ambiguous) impulse.intent is NOT_RESOLVED, even though the ledger holds a record with a real .result", () => {
    const { ledger, artifacts, audit } = fixture();
    const c = caseOf();
    // Two disagreeing AVAILABLE-otherwise records at the same address: case-projection.ts's own rule (PROJ family)
    // demotes both to BLOCKED, never "latest wins" — resolveCaseGoal() must inherit that, not re-derive its own answer.
    ledger.append(intentCandidate("INVOICE_RECEIVED", { inputValueHash: "hash-a" }));
    ledger.append(intentCandidate("GENERAL_QUESTION", { inputValueHash: "hash-b" }));
    const projection = projectCurrentCase({ case: c, ledger, artifacts, now: START });
    expect(projection.facts.every((f) => f.availability === "BLOCKED")).toBe(true);
    const result = resolveCaseGoal({ ledger, goalMap: GoalMapRegistry.build({ schemaVersion: "1", entries: { INVOICE_RECEIVED: [], GENERAL_QUESTION: [] } }), audit }, projection);
    expect(result).toEqual({ status: "NOT_RESOLVED" });
  });
});

describe("CGM-004 end-to-end: real discovery dispatch, then goal mapping reads what it actually resolved", () => {
  class FakeIntentModel implements LlmAdapter {
    readonly modelId = "fake-intent-model-1";
    readonly promptVersion = "test-1";
    constructor(private readonly answer: string) {}
    async complete(_prompt: string, onUsage?: (u: TokenUsage) => void): Promise<string> {
      onUsage?.({ inputTokens: 10, outputTokens: 1 });
      return this.answer;
    }
  }

  function caseWithContent(slice: Slice, text: string, caseId: string): Case {
    const artifact = putArtifact(slice, text, TENANT_A);
    const impulseVal: NormalizedImpulse = { impulseId: "imp-1", tenantId: TENANT_A, channel: "mail", receivedAt: slice.clock.now().toISOString(), artifacts: [], content: { artifactId: artifact.artifactId }, metadata: {} };
    return newCase({ caseId, impulse: impulseVal });
  }

  it("intent.resolve really runs, then resolveCaseGoal() reads back the SAME value it just sealed — MAPPED via a real config entry", async () => {
    const slice = createSlice({ models: { llm: new FakeIntentModel("UNKNOWN") } });
    const c = caseWithContent(slice, "asdf qwer zxcv — nothing recognizable", "case-e2e-a");
    const discovery = await runDiscovery(
      { catalog: realCatalog(), ledger: slice.evidence, artifacts: slice.artifacts, authorities: slice.installation.authorities, lifecycle: slice.installation.lifecycle, transport: slice.transport, actorId: ORCHESTRATOR, clock: slice.clock, deadlineMs: 60_000, audit: slice.audit, inputBuilders: { "intent.resolve": discoveryInput } },
      c,
    );
    expect(discovery.status).toBe("EXECUTED");
    const fresh = projectCurrentCase({ case: c, ledger: slice.evidence, artifacts: slice.artifacts, now: slice.clock.now().toISOString(), authorities: slice.installation.authorities, lifecycle: slice.installation.lifecycle });
    const goalMap = GoalMapRegistry.build({ schemaVersion: "1", entries: { UNKNOWN: [] } });
    const result = resolveCaseGoal({ ledger: slice.evidence, goalMap, audit: slice.audit }, fresh);
    expect(result).toEqual({ status: "MAPPED", intent: "UNKNOWN", goal: [] });
  });

  it("a different real resolution (INVOICE_RECEIVED) with an empty goal-map is NO_MAPPING, not guessed", async () => {
    const slice = createSlice({ models: { llm: new FakeIntentModel("INVOICE_RECEIVED") } });
    const c = caseWithContent(slice, "faktura c. 2024/001, splatnost 30 dni", "case-e2e-b");
    await runDiscovery(
      { catalog: realCatalog(), ledger: slice.evidence, artifacts: slice.artifacts, authorities: slice.installation.authorities, lifecycle: slice.installation.lifecycle, transport: slice.transport, actorId: ORCHESTRATOR, clock: slice.clock, deadlineMs: 60_000, audit: slice.audit, inputBuilders: { "intent.resolve": discoveryInput } },
      c,
    );
    const fresh = projectCurrentCase({ case: c, ledger: slice.evidence, artifacts: slice.artifacts, now: slice.clock.now().toISOString(), authorities: slice.installation.authorities, lifecycle: slice.installation.lifecycle });
    const result = resolveCaseGoal({ ledger: slice.evidence, goalMap: GoalMapRegistry.empty(), audit: slice.audit }, fresh);
    expect(result).toEqual({ status: "NO_MAPPING", intent: "INVOICE_RECEIVED" });
  });
});
