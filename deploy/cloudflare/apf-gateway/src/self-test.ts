// Live self-test (owner's request 2026-09-08: "chci si to testovat sám v GUI"; "chci otestovat samostatnou
// kravičku"): runs the conformance fixtures of document.classify/document.validate (in-process on apf-gateway) and
// document.stamp/document.archive (apf-document-host, over the network) against THIS deployment's real wiring —
// real model, real apf-fakes registry/DMS/archive over HTTP — not the Node fake adapters tests/harness uses. "OK" on
// /farm today only proves the process answers /version; this proves each capability itself still produces the
// contracted result, right now, on the Worker that actually serves it. Fixtures that need an adapter-chaos mode
// (adapters/storage overrides) are skipped: those simulate Node-only fake failures and have no live equivalent to
// trigger on demand.
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
import ingestFixtures from "../../../../conformance/mail.ingest/fixtures/mail.ingest.fixtures.json" with { type: "json" };
import ingestGolden from "../../../../conformance/mail.ingest/golden/mail.ingest.golden.json" with { type: "json" };
import emailFixtures from "../../../../conformance/email.send/fixtures/email.send.fixtures.json" with { type: "json" };
import emailGolden from "../../../../conformance/email.send/golden/email.send.golden.json" with { type: "json" };
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

// Fixed, reserved workflowId for every self-test dispatch — never a randomly generated one. Two things depend on it
// being exactly this constant, in exactly this shape:
//  1. apf-document-host fetches an artifact's bytes back from the gateway via GET /workflow/<wf-...>/artifact/<id>
//     (apf-document-host/src/index.ts fetchArtifact(), matched against index.ts's `wf-[A-Za-z0-9]+` artifact route) —
//     document.stamp/document.archive run on that separate Worker and need this to resolve to the SAME Durable
//     Object this file's caller is already running in (selfTest() puts the fixture artifact into `this.artifacts`
//     of that exact instance).
//  2. recentInstances() in index.ts excludes this exact id from "Poslední instance" — a self-test run must never
//     show up there as a fake document (found live 2026-09-08: an earlier attempt did exactly that).
export const SELF_TEST_WORKFLOW_ID = "wf-selftest";

// document.stamp/document.archive run on apf-document-host (a different Worker), reached through the same
// wiring.transport.dispatch() as document.classify/document.validate — the routing itself (platform-wiring.ts)
// doesn't care which Worker actually serves a capability. Safe to exercise live today: the DMS/archive they write
// to is still the apf-fakes twin, not a real production system (docs/NAVRHOVY-LIST-farma.md, celek D) — revisit
// once a real DMS is wired, the same way a real payment/ERP write would never belong in an on-demand self-test.
const SUITES: { capability: string; worker: string; fixtures: Fixture[]; golden: Record<string, Golden> }[] = [
  { capability: "document.classify", worker: "apf-gateway", fixtures: classifyFixtures as Fixture[], golden: classifyGolden as Record<string, Golden> },
  { capability: "document.validate", worker: "apf-gateway", fixtures: validateFixtures as Fixture[], golden: validateGolden as Record<string, Golden> },
  { capability: "document.stamp", worker: "apf-document-host", fixtures: stampFixtures as Fixture[], golden: stampGolden as Record<string, Golden> },
  { capability: "document.archive", worker: "apf-document-host", fixtures: archiveFixtures as Fixture[], golden: archiveGolden as Record<string, Golden> },
  // SEVERKA.md item 3, second real write-type: mail.ingest runs in-process on the gateway (no credential to
  // isolate), email.send is a genuine remote dispatch to apf-email-executor (PRINCIPAL, SEND_MODE=sandbox here —
  // self-test never flips that, so this never sends a real email). Both fixture suites individually verified
  // correct (HANDOFF 60); running the full SUITES list end to end can hit Cloudflare's subrequest depth limit
  // by the time it reaches these last two suites — a self-test tooling limitation, not a capability bug.
  { capability: "mail.ingest", worker: "apf-gateway", fixtures: ingestFixtures as Fixture[], golden: ingestGolden as Record<string, Golden> },
  { capability: "email.send", worker: "apf-email-executor", fixtures: emailFixtures as Fixture[], golden: emailGolden as Record<string, Golden> },
];

export interface SelfTestRow {
  capability: string;
  worker: string;
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

export async function runSelfTest(opts: {
  transport: DispatchTransport;
  artifacts: ArtifactWriter;
  clock: Clock;
  defaultActor: string;
  deadlineMs: number;
  /** Owner's request 2026-09-09: "chci vidět kontroly a i si je být schopen individuálně vyvolat" — run just
   * one capability's suite (or one worker's suites) instead of always all 72 fixtures. Absent = everything. */
  only?: { capability?: string; worker?: string };
}): Promise<SelfTestRow[]> {
  const suitesToRun = SUITES.filter((s) => (!opts.only?.capability || s.capability === opts.only.capability) && (!opts.only?.worker || s.worker === opts.only.worker));
  const rows: SelfTestRow[] = [];
  for (const suite of suitesToRun) {
    for (const f of suite.fixtures) {
      if (f.adapters || f.storage) {
        rows.push({ capability: suite.capability, worker: suite.worker, id: f.id, kind: f.kind, ok: true, skipped: "vyžaduje adapter chaos mode (jen Node testy)", diff: [] });
        continue;
      }
      // No installation-bound fallback here (ARCH-DEP-001): every conformance fixture that carries an artifact
      // already names its own tenantId, so a fixture missing one is a fixture bug, not something to paper over.
      if (f.artifact && !f.artifact.tenantId) {
        rows.push({ capability: suite.capability, worker: suite.worker, id: f.id, kind: f.kind, ok: false, diff: [`fixture ${f.id}: artifact.tenantId chybí`] });
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
      // workflowId fixed to SELF_TEST_WORKFLOW_ID (not a fresh newId("wf")): document.stamp/document.archive run on
      // apf-document-host, which fetches the artifact back from the gateway by this exact id — it must resolve to
      // the same Durable Object instance whose `artifacts` store just received the put() above.
      const message: MessageEnvelope = {
        messageId: newId("msg"),
        correlationId: newId("cor"),
        workflowId: SELF_TEST_WORKFLOW_ID,
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
      rows.push({ capability: suite.capability, worker: suite.worker, id: f.id, kind: f.kind, ok: diff.length === 0, diff });
    }
  }
  return rows;
}
