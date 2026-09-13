// CERT family: build-bound CertificationRecord (docs/SEVERKA.md `### Admission Gate`, Posudek 12
// point 6 / Posudek 14 priority list item 1). Not yet wired into LifecycleRegistry/Router — these
// tests exercise the primitive itself, same pattern as tests/zlab.test.ts for EvidenceLedger.
import { describe, expect, it } from "vitest";
import { CertificationRegistry, deriveLifecycleStatus, type CertificationInput } from "../src/platform/certification.js";
import { FakeClock } from "../src/platform/clock.js";

const START = "2026-09-13T08:00:00Z";

function input(overrides: Partial<CertificationInput> = {}): CertificationInput {
  return {
    module: "cz-company-verify",
    capability: "cz.company.verify",
    buildHash: "build-v1",
    riskProfile: "R1",
    requiredTests: ["CTR-001", "SEC-001"],
    actualResults: { "CTR-001": "PASS", "SEC-001": "PASS" },
    ...overrides,
  };
}

describe("CERT-001 every required test passing certifies PASS", () => {
  it("certify() returns decision:PASS and canActivate() succeeds for that exact build", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    const record = registry.certify(input());
    expect(record.decision).toBe("PASS");
    expect(registry.canActivate("cz-company-verify", "build-v1")).toEqual({ ok: true, record });
  });
});

describe("CERT-002 a missing required test result is not silently treated as passed", () => {
  it("requiredTests lists a test with no entry in actualResults -> FAIL, not PASS", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    const record = registry.certify(input({ requiredTests: ["CTR-001", "SEC-001", "SEC-002"], actualResults: { "CTR-001": "PASS", "SEC-001": "PASS" } }));
    expect(record.decision).toBe("FAIL");
    expect(registry.canActivate("cz-company-verify", "build-v1").ok).toBe(false);
  });
});

describe("CERT-003 a module cannot certify itself PASS by simply failing a required test", () => {
  it("an explicit FAIL result for a required test fails the whole certification", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    const record = registry.certify(input({ actualResults: { "CTR-001": "PASS", "SEC-001": "FAIL" } }));
    expect(record.decision).toBe("FAIL");
    const check = registry.canActivate("cz-company-verify", "build-v1");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/FAIL, not PASS/);
  });
});

describe("CERT-004 certification never carries forward to a different build of the same module", () => {
  it("v1.7 PASS does not certify v1.8 — a new build starts uncertified", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    registry.certify(input({ buildHash: "build-v1.7" }));
    expect(registry.canActivate("cz-company-verify", "build-v1.7").ok).toBe(true);
    const stillUncertified = registry.canActivate("cz-company-verify", "build-v1.8");
    expect(stillUncertified.ok).toBe(false);
    if (stillUncertified.ok) return;
    expect(stillUncertified.reason).toMatch(/no certification record/);
  });
});

describe("CERT-005 records are immutable, reads return independent copies", () => {
  it("mutating a returned record never changes what the registry holds", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    const record = registry.certify(input());
    (record as { decision: string }).decision = "FAIL";
    expect(registry.get("cz-company-verify", "build-v1")?.decision).toBe("PASS");
  });
});

describe("CERT-006 deriveLifecycleStatus: quarantine always wins, fail-closed", () => {
  it("quarantined overrides even a clean PASS certification", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    const record = registry.certify(input());
    expect(deriveLifecycleStatus({ certification: record, admitted: true, degraded: false, quarantined: true })).toBe("QUARANTINED");
  });
});

describe("CERT-007 deriveLifecycleStatus: the full state progression", () => {
  it("no record -> NEW; FAIL -> QUARANTINED; PASS+not admitted -> CERTIFIED; PASS+admitted -> ACTIVE or DEGRADED", () => {
    const registry = new CertificationRegistry(new FakeClock(START));
    expect(deriveLifecycleStatus({ certification: undefined, admitted: false, degraded: false, quarantined: false })).toBe("NEW");

    const failed = registry.certify(input({ buildHash: "build-bad", actualResults: { "CTR-001": "FAIL", "SEC-001": "PASS" } }));
    expect(deriveLifecycleStatus({ certification: failed, admitted: true, degraded: false, quarantined: false })).toBe("QUARANTINED");

    const passed = registry.certify(input({ buildHash: "build-good" }));
    expect(deriveLifecycleStatus({ certification: passed, admitted: false, degraded: false, quarantined: false })).toBe("CERTIFIED");
    expect(deriveLifecycleStatus({ certification: passed, admitted: true, degraded: false, quarantined: false })).toBe("ACTIVE");
    expect(deriveLifecycleStatus({ certification: passed, admitted: true, degraded: true, quarantined: false })).toBe("DEGRADED");
  });
});

describe("CERT-008 the registry has no update/delete surface beyond certify() itself", () => {
  it("CertificationRegistry exposes only certify/get/canActivate (plus the private key() helper)", () => {
    const methods = Object.getOwnPropertyNames(CertificationRegistry.prototype).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual(["canActivate", "certify", "get", "key"]);
    expect(methods.some((m) => /update|delete|remove|clear|edit|purge|truncate|overwrite/i.test(m))).toBe(false);
  });
});
