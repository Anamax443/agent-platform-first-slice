// Scheduled self-test rotation (HANDOFF 88): which capability a cron tick picks, given its own timestamp — pure,
// no Cloudflare runtime needed, unlike the scheduled() handler that calls it (deploy/cloudflare/apf-gateway/src/index.ts).
import { describe, expect, it } from "vitest";
import { SELF_TEST_CAPABILITIES, requiredTestsFor, selfTestCapabilityForTick } from "../deploy/cloudflare/apf-gateway/src/self-test.js";

describe("selfTestCapabilityForTick() — one capability per scheduled tick, no stored 'next' state", () => {
  it("two ticks in the same interval pick the same capability", () => {
    const a = selfTestCapabilityForTick(1_000_000_000_000, 1000);
    const b = selfTestCapabilityForTick(1_000_000_000_500, 1000);
    expect(a).toBe(b);
  });

  it("consecutive intervals step through SELF_TEST_CAPABILITIES in order", () => {
    const picks = Array.from({ length: SELF_TEST_CAPABILITIES.length }, (_, i) => selfTestCapabilityForTick(i * 1000, 1000));
    expect(picks).toEqual([...SELF_TEST_CAPABILITIES]);
  });

  it("wraps back to the first capability once every entry has had a turn", () => {
    const n = SELF_TEST_CAPABILITIES.length;
    const picks = Array.from({ length: n + 1 }, (_, i) => selfTestCapabilityForTick(i * 1000, 1000));
    expect(picks[n]).toBe(picks[0]);
    expect(picks[n]).toBe(SELF_TEST_CAPABILITIES[0]);
  });

  it("every entry of SELF_TEST_CAPABILITIES gets picked exactly once per full cycle — none skipped, none doubled", () => {
    const picks = Array.from({ length: SELF_TEST_CAPABILITIES.length }, (_, i) => selfTestCapabilityForTick(i * 1000, 1000));
    expect(new Set(picks)).toEqual(new Set(SELF_TEST_CAPABILITIES));
    expect(picks).toHaveLength(SELF_TEST_CAPABILITIES.length);
  });
});

describe("requiredTestsFor() — the platform's own admission requirement, not a caller-supplied list (Posudek 16 P1-9)", () => {
  it("every known capability has at least one required test — none can vacuously certify PASS with []", () => {
    for (const capability of SELF_TEST_CAPABILITIES) expect(requiredTestsFor(capability).length).toBeGreaterThan(0);
  });

  it("an unknown capability yields an empty list, not every fixture in the suite", () => {
    expect(requiredTestsFor("no.such.capability")).toEqual([]);
  });

  it("the same capability always yields the same set (deterministic, not run-dependent)", () => {
    const capability = SELF_TEST_CAPABILITIES[0] as string;
    expect(requiredTestsFor(capability)).toEqual(requiredTestsFor(capability));
  });
});
