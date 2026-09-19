// GM family: goal-map.ts's GoalMapRegistry — the config/data half of Intent -> Goal mapping (docs/
// AUTONOMOUS-RUNTIME-V1.md część 6 krok 7). Bar: fail-closed validation mirroring authorities.ts's own bar
// (tests/auth.test.ts), and a real distinction between "no mapping configured" (undefined) and "deliberately
// mapped to no further action" ([]) — never collapsed into one outcome.
import { describe, expect, it } from "vitest";
import { loadInstallationFromDir } from "../src/installation-node.js";
import { GoalMapError, GoalMapRegistry } from "../src/platform/goal-map.js";
import { projectRoot } from "./harness/paths.js";
import { join } from "node:path";

describe("GM-000 empty registry: every intent is unmapped", () => {
  it("goalFor() is undefined for anything, including a deliberately-mapped-elsewhere value", () => {
    const registry = GoalMapRegistry.empty();
    expect(registry.goalFor("UNKNOWN")).toBeUndefined();
    expect(registry.goalFor("INVOICE_RECEIVED")).toBeUndefined();
  });
});

describe("GM-001 build() from valid JSON", () => {
  it("an intent mapped to [] is a real entry, distinct from one never mentioned", () => {
    const registry = GoalMapRegistry.build({ schemaVersion: "1", entries: { UNKNOWN: [] } });
    expect(registry.goalFor("UNKNOWN")).toEqual([]);
    expect(registry.goalFor("CALENDAR_QUERY")).toBeUndefined();
  });

  it("an intent mapped to real fact-catalog-shaped keys round-trips exactly", () => {
    const registry = GoalMapRegistry.build({ schemaVersion: "1", entries: { INVOICE_RECEIVED: ["invoice.readyForReview", "document.type"] } });
    expect(registry.goalFor("INVOICE_RECEIVED")).toEqual(["invoice.readyForReview", "document.type"]);
  });
});

describe("GM-002 fail-closed validation, same bar as AuthorityRegistry.build()", () => {
  it("rejects a wrong schemaVersion", () => {
    expect(() => GoalMapRegistry.build({ schemaVersion: "2", entries: {} })).toThrow(GoalMapError);
  });
  it("rejects a missing entries object", () => {
    expect(() => GoalMapRegistry.build({ schemaVersion: "1" })).toThrow(GoalMapError);
  });
  it("rejects a lower-case intent value (not SCREAMING_SNAKE_CASE)", () => {
    expect(() => GoalMapRegistry.build({ schemaVersion: "1", entries: { invoice_received: [] } })).toThrow(GoalMapError);
  });
  it("rejects a goal key that isn't a fact-catalog-shaped key", () => {
    expect(() => GoalMapRegistry.build({ schemaVersion: "1", entries: { UNKNOWN: ["not a key!"] } })).toThrow(GoalMapError);
  });
  it("rejects a goal that isn't an array", () => {
    expect(() => GoalMapRegistry.build({ schemaVersion: "1", entries: { UNKNOWN: "not-an-array" } })).toThrow(GoalMapError);
  });
  it("rejects not-an-object", () => {
    expect(() => GoalMapRegistry.build(null)).toThrow(GoalMapError);
    expect(() => GoalMapRegistry.build("nope")).toThrow(GoalMapError);
  });
});

describe("GM-003 the real config/local-fakes/goal-map.json loads through loadInstallationFromDir() exactly as shipped", () => {
  it("UNKNOWN maps to [] (deliberate no-op), every other real intent value has no mapping configured yet", () => {
    const installation = loadInstallationFromDir(join(projectRoot, "config", "local-fakes"));
    expect(installation.goalMap.goalFor("UNKNOWN")).toEqual([]);
    expect(installation.goalMap.goalFor("INVOICE_RECEIVED")).toBeUndefined();
    expect(installation.goalMap.goalFor("CALENDAR_QUERY")).toBeUndefined();
    expect(installation.goalMap.goalFor("DOCUMENT_BUNDLE")).toBeUndefined();
    expect(installation.goalMap.goalFor("GENERAL_QUESTION")).toBeUndefined();
  });
});

describe("GM-004 the real config/farm-bass443/goal-map.json loads and matches local-fakes", () => {
  it("same shape as local-fakes (test installation intentionally mirrors the live one)", () => {
    const installation = loadInstallationFromDir(join(projectRoot, "config", "farm-bass443"));
    expect(installation.goalMap.goalFor("UNKNOWN")).toEqual([]);
    expect(installation.goalMap.goalFor("INVOICE_RECEIVED")).toBeUndefined();
  });
});
