// Live self-test (owner's request 2026-09-08: "chci si to testovat sám v GUI"): runs the conformance fixtures of
// document.classify and document.validate — the two capabilities without side effects — against THIS deployment's
// real wiring (real model, real apf-fakes registry over HTTP), not the Node fake adapters tests/harness uses.
// "OK" on /farm today only proves the process answers /version; this proves the capability itself still produces
// the contracted result, right now, on this Worker. Fixtures that need an adapter-chaos mode (adapters/storage
// overrides) are skipped: those simulate Node-only fake failures and have no live equivalent to trigger on demand.
//
// substitute()/subsetDiff()/goldenDiff() mirror tests/harness/index.ts and tests/harness/conformance.ts exactly —
// duplicated, not imported, so the Worker bundle never pulls in test-only code (vitest, node:fs) across the
// deploy/cloudflare <-> tests boundary.
import classifyFixtures from "../../../../conformance/document.classify/fixtures/document.classify.fixtures.json" with { type: "json" };
import classifyGolden from "../../../../conformance/document.classify/golden/document.classify.golden.json" with { type: "json" };
import validateFixtures from "../../../../conformance/document.validate/fixtures/document.validate.fixtures.json" with { type: "json" };
import validateGolden from "../../../../conformance/document.validate/golden/document.validate.golden.json" with { type: "json" };
import stampFixtures from "../../../../conformance/document.stamp/fixtures/document.stamp.fixtures.json" with { type: "json" };
import stampGolden from "../../../../conformance/document.stamp/golden/document.stamp.golden.json" with { type: "json" };
import archiveFixtures from "../../../../conformance/document.archive/fixtures/document.archive.fixtures.json" with { type: "json" };
import archiveGolden from "../../../../conformance/document.archive/golden/document.archive.golden.json" with { type: "json" };
import { sha256 } from "../../../../src/platform/artifacts.js";
import type { ArtifactWriter } from "../../../../src/platform/artifacts.js";
import type { Clock } from "../../../../src/platform/clock.js";
import { iso } from "../../../../src/platform/clock.js";
import { newId } from "../../../../src/platform/ids.js";
import type { DispatchTransport } from "../../../../src/platform/transport.js";
import type { MessageEnvelope, ResultEnvelope } from "../../../../src/platform/types.js";

interface Fixture {
  id: string;
  kind: string;
  actor?: string;
  artifact?: { tenantId?: string; bytes: string };
  payload: Record<string, unknown>;
  adapters?: unknown;
  storage?: unknown;
  deadlineMs?: number;
  capabilityVersion?: string;
}

interface Golden {
  anyOf?: Golden[];
  [key: string]: unknown;
}

// document.stamp/document.archive are write capabilities (owner's request 2026-09-08: "chci testovat i samostatné
// kravičky" — apf-document-host, not just what runs in-process on the gateway). Safe to run live today because the
// DMS/archive they write to is still the apf-fakes twin, not a real production system (docs/NAVRHOVY-LIST-farma.md,
// celek D) — revisit this list once a real DMS is wired, the same way a real payment/ERP write never belongs here.
const SUITES: { capability: string; fixtures: Fixture[]; golden: Record<string, Golden> }[] = [
  { capability: "document.classify", fixtures: classifyFixtures as Fixture[], golden: classifyGolden as Record<string, Golden> },
  { capability: "document.validate", fixtures: validateFixtures as Fixture[], golden: validateGolden as Record<string, Golden> },
  { capability: "document.stamp", fixtures: stampFixtures as Fixture[], golden: stampGolden as Record<string, Golden> },
  { capability: "document.archive", fixtures: archiveFixtures as Fixture[], golden: archiveGolden as Record<string, Golden> },
];

export interface SelfTestRow {
  capability: string;
  id: string;
  kind: string;
  ok: boolean;
  skipped?: string;
  diff: string[];
}

function subsetDiff(actual: unknown, expected: unknown, path = "$"): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array`];
    if (actual.length !== expected.length) return [`${path}: length ${actual.length} != ${expected.length}`];
    return expected.flatMap((e, i) => subsetDiff((actual as unknown[])[i], e, `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected as Record<string, unknown>).flatMap(([k, v]) => subsetDiff((actual as Record<string, unknown>)[k], v, `${path}.${k}`));
  }
  return Object.is(actual, expected) ? [] : [`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`];
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value in vars ? vars[value] : value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

function goldenDiff(result: ResultEnvelope, golden: Golden, vars: Record<string, string>): string[] {
  if (golden.anyOf) {
    const diffs = golden.anyOf.map((g) => goldenDiff(result, g, vars));
    return diffs.some((d) => d.length === 0) ? [] : diffs.flatMap((d, i) => d.map((x) => `alternative ${i}: ${x}`));
  }
  return subsetDiff(result, substitute(golden, vars));
}

export async function runSelfTest(opts: { transport: DispatchTransport; artifacts: ArtifactWriter; clock: Clock; defaultActor: string; deadlineMs: number }): Promise<SelfTestRow[]> {
  const rows: SelfTestRow[] = [];
  for (const suite of SUITES) {
    for (const f of suite.fixtures) {
      if (f.adapters || f.storage) {
        rows.push({ capability: suite.capability, id: f.id, kind: f.kind, ok: true, skipped: "vyžaduje adapter chaos mode (jen Node testy)", diff: [] });
        continue;
      }
      // No installation-bound fallback here (ARCH-DEP-001): every conformance fixture that carries an artifact
      // already names its own tenantId, so a fixture missing one is a fixture bug, not something to paper over.
      if (f.artifact && !f.artifact.tenantId) {
        rows.push({ capability: suite.capability, id: f.id, kind: f.kind, ok: false, diff: [`fixture ${f.id}: artifact.tenantId chybí`] });
        continue;
      }
      const artifact = f.artifact ? opts.artifacts.put({ tenantId: f.artifact.tenantId as string, bytes: f.artifact.bytes, receivedFrom: "self-test" }) : undefined;
      const vars: Record<string, string> = {
        $artifactId: artifact?.artifactId ?? "art-missing",
        $sha256: artifact?.sha256 ?? "0".repeat(64),
        "$sha256:tampered": sha256(`${f.artifact?.bytes ?? ""} tampered`),
        $now: iso(opts.clock.now()),
      };
      const now = opts.clock.now();
      const message: MessageEnvelope = {
        messageId: newId("msg"),
        correlationId: newId("cor"),
        type: "command",
        capability: suite.capability,
        capabilityVersion: f.capabilityVersion ?? "1",
        schemaVersion: "1",
        createdAt: iso(now),
        idempotencyKey: newId("key"),
        notValidAfter: iso(new Date(now.getTime() + (f.deadlineMs ?? opts.deadlineMs))),
        payload: substitute(f.payload, vars) as Record<string, unknown>,
      };
      const result = await opts.transport.dispatch(message, f.actor ?? opts.defaultActor);
      const golden = suite.golden[f.id];
      const diff = golden ? goldenDiff(result, golden, vars) : [`chybí golden pro ${f.id}`];
      rows.push({ capability: suite.capability, id: f.id, kind: f.kind, ok: diff.length === 0, diff });
    }
  }
  return rows;
}
