// AUTH family (docs/M0-FACT-CONTRACT-V1.md část C, step C-1): authority is granted by the installation
// (config/<installation>/authorities.json) and enforced by the EvidenceWriter — the domain is stamped from the
// grant, a fact outside the grant's scope is refused with nothing written, and the grant caps how long evidence may
// be trusted. A cow never declares any of this. AUTH-004/005/007 (Dojička by domain, revocation, human review) are C-2.
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstallationFromDir } from "../src/installation-node.js";
import { AuthorityError, AuthorityRegistry, parseIsoDuration } from "../src/platform/authorities.js";
import { FakeClock, iso, plus } from "../src/platform/clock.js";
import { EvidenceLedger } from "../src/platform/evidence.js";
import { EvidenceWriter, type WriterAuthority } from "../src/platform/evidence-writer.js";
import { generateKeyPair } from "../src/platform/signing.js";
import type { HandlerInput, MessageEnvelope, TrustedContext } from "../src/platform/types.js";
import { loadComponents, realCatalog } from "./harness/facts.js";
import { tmpDir } from "./harness/index.js";
import { projectRoot } from "./harness/paths.js";

const START = "2026-09-16T08:00:00Z";
const DAY = 86_400_000;

function fixture() {
  const clock = new FakeClock(START);
  const k = generateKeyPair();
  return { clock, ledger: new EvidenceLedger(clock, { keyId: "platform-k1", privateKey: k.privateKey, publicKey: k.publicKey }) };
}

function input(): HandlerInput {
  const context: TrustedContext = {
    dispatchId: "dsp-1",
    tenantId: "tenant-a",
    actorId: "cz.company.verify-handler",
    actorType: "deterministic-module",
    scopes: ["cz.company.verify"],
    sourceComponent: "apf-gateway",
    authenticatedAt: START,
    expiresAt: iso(plus(new Date(START), 3_600_000)),
  };
  const message: MessageEnvelope = {
    messageId: "msg-1",
    correlationId: "cor-1",
    workflowId: "wf-1",
    type: "command",
    capability: "cz.company.verify",
    capabilityVersion: "1",
    schemaVersion: "1",
    idempotencyKey: "wf-1:verify:default:1",
    createdAt: START,
    notValidAfter: iso(plus(new Date(START), 600_000)),
    payload: {},
  };
  return { message, context };
}

const IDENTITY = { producerId: "cz.company.verify", capabilityVersion: "1", buildHash: "build-1" };
const GRANT: WriterAuthority = { domain: "cz.company.registry", facts: ["supplier.companyId", "supplier.officialName"], maxEvidenceTtlMs: 30 * DAY };
const CLAIM = { inputField: "supplier.companyId", inputValueHash: "sha256-of-ico", result: "ACTIVE" };
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuthorityError) return e.message;
    throw e;
  }
  return "OK";
};

describe("AUTH-001 a producer without a grant produces inferred evidence — never a self-declared authority", () => {
  it("no grant → no authorityDomain; a grant → the grant's domain, stamped by the writer", () => {
    const { ledger, clock } = fixture();
    const inferred = new EvidenceWriter(ledger, IDENTITY).write(input(), CLAIM);
    expect(inferred.authorityDomain).toBeUndefined();
    const granted = new EvidenceWriter(ledger, { ...IDENTITY, authority: GRANT }, clock).write(input(), CLAIM);
    expect(granted.authorityDomain).toBe("cz.company.registry");
    expect(ledger.verify(granted)).toEqual({ ok: true });
  });
});

describe("AUTH-002 the grant caps evidence TTL — a cow can only shorten it", () => {
  it("no claim → cap; a claim beyond the cap → cap; a shorter claim → kept; a null cap → the claim as is", () => {
    const { ledger, clock } = fixture();
    const writer = new EvidenceWriter(ledger, { ...IDENTITY, authority: GRANT }, clock);
    const cap = iso(plus(new Date(START), 30 * DAY));
    expect(writer.write(input(), CLAIM).expiresAt).toBe(cap);
    expect(writer.write(input(), { ...CLAIM, expiresAt: "2099-01-01T00:00:00.000Z" }).expiresAt).toBe(cap);
    const shorter = iso(plus(new Date(START), DAY));
    expect(writer.write(input(), { ...CLAIM, expiresAt: shorter }).expiresAt).toBe(shorter);
    const uncapped = new EvidenceWriter(ledger, { ...IDENTITY, authority: { ...GRANT, maxEvidenceTtlMs: null } }, clock);
    expect(uncapped.write(input(), { ...CLAIM, expiresAt: "2099-01-01T00:00:00.000Z" }).expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("a TTL-capping grant without a clock is refused at construction, not silently uncapped", () => {
    const { ledger } = fixture();
    expect(() => new EvidenceWriter(ledger, { ...IDENTITY, authority: GRANT })).toThrow(/needs a clock/);
  });
});

describe("AUTH-003 a fact outside the grant's scope is refused and nothing is written", () => {
  it("cz.company.registry may not attest supplier.vatId", () => {
    const { ledger, clock } = fixture();
    const writer = new EvidenceWriter(ledger, { ...IDENTITY, authority: GRANT }, clock);
    expect(() => writer.write(input(), { ...CLAIM, inputField: "supplier.vatId" })).toThrow(/AUTHORITY_SCOPE/);
    expect(ledger.forTenant("tenant-a")).toEqual([]);
  });

  it("a platform-level grant (facts: \"*\") attests any fact", () => {
    const { ledger, clock } = fixture();
    const platform = new EvidenceWriter(ledger, { ...IDENTITY, producerId: "platform.entity", authority: { domain: "platform", facts: "*", maxEvidenceTtlMs: null } }, clock);
    expect(platform.write(input(), { inputField: "invoice.line@ent-1", inputValueHash: "entity-hash", result: "OBSERVED" }).authorityDomain).toBe("platform");
  });
});

describe("AUTH-REG authorities.json is validated fail-closed", () => {
  const base = () => ({
    schemaVersion: "1",
    domains: { "cz.company.registry": { producers: ["cz.company.verify"], facts: ["supplier.companyId"], maxEvidenceTtl: "P30D" } },
    tenants: {},
  });
  it("durations parse (P30D, PT12H, P1DT6H) and garbage does not", () => {
    expect(parseIsoDuration("P30D")).toBe(30 * DAY);
    expect(parseIsoDuration("PT12H")).toBe(12 * 3_600_000);
    expect(parseIsoDuration("P1DT6H")).toBe(30 * 3_600_000);
    for (const bad of ["30D", "P", "PT", "P0D", "1 month", "P1DT"]) expect(code(() => parseIsoDuration(bad)), bad).not.toBe("OK");
  });
  it("wrong schemaVersion, a producer in two domains, a bad duration, empty facts, a mixed wildcard and tenant overrides are all refused", () => {
    expect(code(() => AuthorityRegistry.build({ ...base(), schemaVersion: "2" }))).toMatch(/schemaVersion/);
    const twice = base();
    (twice.domains as Record<string, unknown>)["cz.vat.registry"] = { producers: ["cz.company.verify"], facts: ["supplier.vatId"], maxEvidenceTtl: "P1D" };
    expect(code(() => AuthorityRegistry.build(twice))).toMatch(/two domains/);
    const badTtl = base();
    badTtl.domains["cz.company.registry"]!.maxEvidenceTtl = "30 days";
    expect(code(() => AuthorityRegistry.build(badTtl))).toMatch(/duration/);
    const noFacts = base();
    noFacts.domains["cz.company.registry"]!.facts = [];
    expect(code(() => AuthorityRegistry.build(noFacts))).toMatch(/facts/);
    const mixed = base();
    mixed.domains["cz.company.registry"]!.facts = ["*", "supplier.companyId"];
    expect(code(() => AuthorityRegistry.build(mixed))).toMatch(/not a namespace key/);
    expect(code(() => AuthorityRegistry.build({ ...base(), tenants: { "tenant-7": {} } }))).toMatch(/tenants/);
    expect(AuthorityRegistry.build(base()).forProducer("cz.company.verify")?.maxEvidenceTtlMs).toBe(30 * DAY);
    expect(AuthorityRegistry.build(base()).forProducer("nobody")).toBeUndefined();
  });
  it("an installation granting a domain to a name that is neither a capability with a policy nor platform.* is refused", () => {
    const dir = join(tmpDir(), "local-fakes-bad");
    cpSync(join(projectRoot, "config", "local-fakes"), dir, { recursive: true });
    const bad = base();
    bad.domains["cz.company.registry"]!.producers = ["cz.company.verify.typo"];
    writeFileSync(join(dir, "authorities.json"), JSON.stringify(bad));
    expect(() => loadInstallationFromDir(dir)).toThrow(/neither a capability with a policy nor platform/);
  });
});

describe("AUTH-006 both installations' authorities.json agree with the fact namespace and the deployed capabilities", () => {
  it("every granted fact is a namespace key (or *), every non-platform producer is a real capability, both installations grant the same domains", () => {
    const catalog = realCatalog();
    const capabilities = new Set(loadComponents().flatMap((c) => c.descriptor.capabilities.map((x) => x.name)));
    const domainSets: string[][] = [];
    for (const name of ["farm-bass443", "local-fakes"]) {
      const inst = loadInstallationFromDir(join(projectRoot, "config", name));
      const grants = inst.authorities.grants();
      expect(grants.length, name).toBeGreaterThan(0);
      for (const g of grants) {
        if (g.facts !== "*") for (const f of g.facts) expect(catalog.entry(f), `${name} ${g.domain} → ${f}`).toBeDefined();
        for (const p of g.producers) if (!p.startsWith("platform.")) expect(capabilities.has(p), `${name} ${g.domain} ← ${p}`).toBe(true);
      }
      domainSets.push(grants.map((g) => g.domain).sort());
      expect(inst.authorities.forProducer("cz.company.verify")?.domain, name).toBe("cz.company.registry");
      expect(inst.authorities.forProducer("cz.vat.verify")?.domain, name).toBe("cz.vat.registry");
    }
    expect(domainSets[0]).toEqual(domainSets[1]);
  });
});
