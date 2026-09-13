// Conformance runner: one fresh slice per fixture, placeholders substituted, golden compared as a subset (semantic tier).
import { expect } from "vitest";
import { FakeAresAdapter } from "../../src/adapters/ares.js";
import { FakeMojeDaneAdapter } from "../../src/adapters/moje-dane.js";
import { FakeDmsAdapter } from "../../src/adapters/dms.js";
import type { LlmAdapter } from "../../src/adapters/llm.js";
import { FakeRegistryAdapter } from "../../src/adapters/registry.js";
import { FakeSmtpAdapter } from "../../src/adapters/smtp.js";
import { sha256, type Artifact } from "../../src/platform/artifacts.js";
import { iso } from "../../src/platform/clock.js";
import type { ResultEnvelope } from "../../src/platform/types.js";
import { command, createSlice, dispatch, ORCHESTRATOR, putArtifact, subsetDiff, TENANT_A, type Slice, type SliceOptions } from "./index.js";
import type { AdapterModes, Fixture, Golden } from "./suite.js";

export type Vars = Record<string, string>;

export interface FixtureRun {
  slice: Slice;
  result: ResultEnvelope;
  artifact?: Artifact;
  vars: Vars;
}

/** Slice options derived from fixture / scenario adapter modes and storage limits. */
export function sliceOptionsFor(adapters: AdapterModes | undefined, storage: { capacityBytes: number } | undefined): SliceOptions {
  return {
    registry: new FakeRegistryAdapter(adapters?.registry ?? "ok"),
    ares: new FakeAresAdapter(adapters?.ares ?? "ok"),
    mojeDane: new FakeMojeDaneAdapter(adapters?.mojeDane ?? "ok"),
    dms: new FakeDmsAdapter(adapters?.dms ?? "ok", adapters?.dmsStatus ?? "ok"),
    smtp: new FakeSmtpAdapter(adapters?.smtp ?? "ok", adapters?.smtpStatus ?? "ok"),
    registryTimeoutMs: 30,
    aresTimeoutMs: 30,
    mojeDaneTimeoutMs: 30,
    modelTimeoutMs: 30,
    ...(storage ? { artifactCapacityBytes: storage.capacityBytes } : {}),
  };
}

export async function runFixture(capability: string, f: Fixture, opts: { models?: Record<string, LlmAdapter> } = {}): Promise<FixtureRun> {
  const slice = createSlice({ ...sliceOptionsFor(f.adapters, f.storage), ...(opts.models ? { models: opts.models } : {}) });
  const artifact = f.artifact ? putArtifact(slice, f.artifact.bytes, f.artifact.tenantId ?? TENANT_A) : undefined;
  const vars: Vars = {
    $artifactId: artifact?.artifactId ?? "art-missing",
    $sha256: artifact?.sha256 ?? "0".repeat(64),
    "$sha256:tampered": sha256((artifact?.bytes ?? "") + " tampered"),
    $now: iso(slice.clock.now()),
  };
  const msg = command(slice, {
    capability,
    payload: substitute(f.payload, vars) as Record<string, unknown>,
    ...(f.capabilityVersion ? { version: f.capabilityVersion } : {}),
    ...(f.deadlineMs !== undefined ? { deadlineMs: f.deadlineMs } : {}),
  });
  const result = await dispatch(slice, msg, f.actor ?? ORCHESTRATOR);
  return { slice, result, ...(artifact ? { artifact } : {}), vars };
}

/** Replace whole-string placeholders ($artifactId, $sha256, $sha256:tampered, $now) anywhere in a JSON value. */
export function substitute(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") return value in vars ? vars[value] : value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

/** Golden is a subset of the result (semantic tier). `anyOf` lists alternatives that all satisfy the contract. */
export function goldenDiff(result: ResultEnvelope, golden: Golden, vars: Vars): string[] {
  if (golden.anyOf) {
    const diffs = golden.anyOf.map((g) => goldenDiff(result, g, vars));
    return diffs.some((d) => d.length === 0) ? [] : diffs.flatMap((d, i) => d.map((x) => `alternative ${i}: ${x}`));
  }
  return subsetDiff(result, substitute(golden, vars));
}

export function expectGolden(result: ResultEnvelope, golden: Golden | undefined, vars: Vars, id: string): void {
  expect(golden, `golden missing for fixture ${id}`).toBeDefined();
  const diff = goldenDiff(result, golden as Golden, vars);
  expect(diff, `fixture ${id}:\n${diff.join("\n")}\nresult: ${JSON.stringify(result, null, 2)}`).toEqual([]);
}
