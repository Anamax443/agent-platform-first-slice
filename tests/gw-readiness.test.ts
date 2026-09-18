// RG2-E (Reliability Gate 2, last item, 18.9.2026): /live, /ready, /health/details. Every decision those routes
// make lives in deploy/cloudflare/apf-gateway/src/readiness.ts as a pure function (same reason alarm-scheduler.ts/
// fanout-retry.ts do: index.ts imports "cloudflare:workers" and cannot load under plain-Node vitest) — this file
// drives the REAL readiness.ts with fake thunks, the REAL platform-wiring.ts checkWiringPreconditions() over the
// real LOCAL_FAKES installation, and pins index.ts to actually routing through them with a source-level trap
// (the same honestly-labelled pattern tests/gw-platform-wiring-fanout.test.ts uses for orchestratorFor()).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Installation } from "../src/installation.js";
import type { IncidentRecord } from "../deploy/cloudflare/apf-gateway/src/page.js";
import { checkWiringPreconditions } from "../deploy/cloudflare/apf-gateway/src/platform-wiring.js";
import {
  assessReadiness,
  boundedRead,
  buildHealthDetails,
  KILL_SWITCH_PROBE,
  missingBindings,
  NOT_OBSERVABLE_GLOBALLY,
  runProbe,
  runProbes,
  summarizeSelfTest,
  summarizeWatchdog,
  type ProbeResult,
  type ProbeSpec,
} from "../deploy/cloudflare/apf-gateway/src/readiness.js";
import { FAKE_SECRETS, LOCAL_FAKES } from "./harness/index.js";

const ok = (name: string, required = true): ProbeResult => ({ name, ok: true, required, ms: 1, timeoutMs: 100 });
const failed = (name: string, reason: string, required = true): ProbeResult => ({ name, ok: false, required, reason, ms: 1, timeoutMs: 100 });
const IDS = { gitSha: "abc1234", installation: "test-install" };
/** The five REQUIRED probes index.ts's readinessProbes() defines, by name, plus the kill switch assessReadiness() folds in. */
const REQUIRED = ["bindings", "d1-audit", "r2-artifacts", "wiring-config"];

describe("runProbe(): a thunk's throw, rejection or hang becomes a ProbeResult — never a rejection", () => {
  const spec = (run: ProbeSpec["run"], timeoutMs = 20): ProbeSpec => ({ name: "p", required: true, timeoutMs, run });

  it("a resolving thunk -> ok:true with a measured duration and its budget", async () => {
    const r = await runProbe(spec(async () => "fine"));
    expect(r).toMatchObject({ name: "p", ok: true, required: true, timeoutMs: 20 });
    expect(r.reason).toBeUndefined();
    expect(typeof r.ms).toBe("number");
  });

  it("a synchronously throwing thunk -> ok:false with the error message", async () => {
    const r = await runProbe(
      spec(() => {
        throw new Error("D1_ERROR: no such table");
      }),
    );
    expect(r).toMatchObject({ ok: false, reason: "D1_ERROR: no such table" });
  });

  it("a rejecting thunk -> ok:false with the error message", async () => {
    const r = await runProbe(spec(async () => Promise.reject(new Error("bucket unreachable"))));
    expect(r).toMatchObject({ ok: false, reason: "bucket unreachable" });
  });

  it("a thunk that hangs past its budget -> ok:false, reason exactly \"timeout\", and the call itself resolves", async () => {
    const r = await runProbe(spec(() => new Promise<never>(() => {}), 20));
    expect(r).toMatchObject({ ok: false, reason: "timeout", timeoutMs: 20 });
    expect(r.ms).toBeGreaterThanOrEqual(15);
  });

  it("runProbes() runs every spec concurrently: two 30 ms hangs finish in one budget, not two", async () => {
    const t0 = Date.now();
    const rs = await runProbes([spec(() => new Promise<never>(() => {}), 30), spec(() => new Promise<never>(() => {}), 30)]);
    expect(rs.map((r) => r.reason)).toEqual(["timeout", "timeout"]);
    expect(Date.now() - t0).toBeLessThan(55);
  });

  it("boundedRead() keeps the value on success and reports a non-Error throw as its string form", async () => {
    expect(await boundedRead(() => 42, 20)).toMatchObject({ ok: true, value: 42 });
    expect(
      await boundedRead(() => {
        throw "plain string";
      }, 20),
    ).toMatchObject({ ok: false, reason: "plain string" });
  });
});

describe("assessReadiness(): ready iff every REQUIRED probe passed and the kill switch is off", () => {
  it("all ok -> ready:true, no blockers, KILL_SWITCH listed as a passing check", () => {
    const r = assessReadiness(REQUIRED.map((n) => ok(n)), { killSwitch: false, ...IDS });
    expect(r).toMatchObject({ ready: true, blockers: [], gitSha: "abc1234", installation: "test-install" });
    expect(r.checks.map((c) => c.name)).toEqual([KILL_SWITCH_PROBE, ...REQUIRED]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  for (const name of REQUIRED) {
    it(`required probe "${name}" failing -> ready:false with that probe named in blockers`, () => {
      const r = assessReadiness(
        REQUIRED.map((n) => (n === name ? failed(n, "boom") : ok(n))),
        { killSwitch: false, ...IDS },
      );
      expect(r.ready).toBe(false);
      expect(r.blockers).toEqual([`${name}: boom`]);
    });
  }

  it("a timed-out required probe is a blocker naming the timeout", () => {
    const r = assessReadiness([ok("bindings"), failed("d1-audit", "timeout"), ok("r2-artifacts"), ok("wiring-config")], { killSwitch: false, ...IDS });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["d1-audit: timeout"]);
  });

  it("kill switch on -> ready:false naming KILL_SWITCH even when every probe passed", () => {
    const r = assessReadiness(REQUIRED.map((n) => ok(n)), { killSwitch: true, ...IDS });
    expect(r.ready).toBe(false);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toMatch(/^KILL_SWITCH: /);
    expect(r.checks[0]).toMatchObject({ name: KILL_SWITCH_PROBE, ok: false, required: true });
  });

  it("a failing NON-required check (a remote host) never flips ready, but stays visible in checks", () => {
    const r = assessReadiness([...REQUIRED.map((n) => ok(n)), failed("apf-document-host", "HTTP 503", false)], { killSwitch: false, ...IDS });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.checks.find((c) => c.name === "apf-document-host")).toMatchObject({ ok: false, required: false });
  });
});

describe("missingBindings(): presence only, no call on any binding", () => {
  it("names exactly the absent ones, in the required order", () => {
    const env = { AUDIT: {}, ARTIFACTS: null, WORKFLOW: undefined, AI: {} };
    expect(missingBindings(env, ["AUDIT", "ARTIFACTS", "WORKFLOW", "AI", "FAKES"])).toEqual(["ARTIFACTS", "WORKFLOW", "FAKES"]);
    expect(missingBindings(env, ["AUDIT", "AI"])).toEqual([]);
  });
});

describe("summarizeSelfTest(): the last persisted self-test-state row, never a fresh run", () => {
  it("counts passed/failed with skipped fixtures toward neither (same rule as index.ts selfTestAggregates)", () => {
    const summary = { updatedAt: "2026-09-18T10:00:00.000Z", fixtures: [{ ok: true }, { ok: false }, { ok: true }, { ok: false, skipped: "no host" }] };
    expect(summarizeSelfTest({ ok: true, value: summary, ms: 1 })).toEqual({ at: "2026-09-18T10:00:00.000Z", passed: 2, failed: 1, skipped: 1 });
  });

  it("no row yet -> at:null with a reason; unreadable row -> at:null naming the read failure", () => {
    expect(summarizeSelfTest({ ok: true, value: undefined, ms: 1 })).toMatchObject({ at: null, reason: expect.stringContaining("never ran") });
    expect(summarizeSelfTest({ ok: false, reason: "timeout", ms: 1 })).toMatchObject({ at: null, reason: expect.stringContaining("timeout") });
  });
});

describe("summarizeWatchdog(): Argos's last persisted verdict, same level rule as computeWatchdog()", () => {
  const incident = (key: string, level: "WARN" | "INCIDENT", extra: Partial<IncidentRecord> = {}): IncidentRecord => ({
    key,
    level,
    text: `${key} text`,
    firstSeenAt: "2026-09-18T08:00:00.000Z",
    lastSeenAt: "2026-09-18T09:00:00.000Z",
    occurrences: 3,
    ...extra,
  });

  it("zero rows of any kind is UNKNOWN (reconcile never ran), not HEALTHY", () => {
    expect(summarizeWatchdog({ ok: true, value: [], ms: 1 })).toMatchObject({ level: "UNKNOWN", openIncidents: [], asOf: null, reason: expect.stringContaining("never run") });
  });

  it("an unreadable D1 is UNKNOWN naming the read failure", () => {
    expect(summarizeWatchdog({ ok: false, reason: "timeout", ms: 1 })).toMatchObject({ level: "UNKNOWN", reason: expect.stringContaining("timeout") });
  });

  it("any open INCIDENT -> INCIDENT; only open WARNs -> DEGRADED; everything resolved -> HEALTHY with asOf = newest timestamp", () => {
    const warn = incident("ohrada-backlog", "WARN");
    const inc = incident("worker:apf-fakes", "INCIDENT", { acknowledgedAt: "2026-09-18T09:30:00.000Z", acknowledgedBy: "someone" });
    const resolved = incident("selftest-stale", "INCIDENT", { resolvedAt: "2026-09-18T11:00:00.000Z" });

    const withIncident = summarizeWatchdog({ ok: true, value: [warn, inc, resolved], ms: 1 });
    expect(withIncident.level).toBe("INCIDENT");
    expect(withIncident.openIncidents.map((i) => i.key)).toEqual(["ohrada-backlog", "worker:apf-fakes"]);
    // The acknowledgment survives (a human said "known"), the acknowledger's identity is not re-published.
    expect(withIncident.openIncidents[1]).toMatchObject({ acknowledgedAt: "2026-09-18T09:30:00.000Z" });
    expect(withIncident.openIncidents[1]).not.toHaveProperty("acknowledgedBy");

    expect(summarizeWatchdog({ ok: true, value: [warn, resolved], ms: 1 })).toMatchObject({ level: "DEGRADED", asOf: "2026-09-18T11:00:00.000Z" });
    expect(summarizeWatchdog({ ok: true, value: [resolved], ms: 1 })).toMatchObject({ level: "HEALTHY", openIncidents: [], asOf: "2026-09-18T11:00:00.000Z" });
    expect(summarizeWatchdog({ ok: true, value: [warn], ms: 1 })).toMatchObject({ level: "DEGRADED", asOf: "2026-09-18T09:00:00.000Z" });
  });
});

describe("buildHealthDetails(): one plain report that always names its blind spots", () => {
  it("carries readiness, watchdog, last self-test, remote hosts, and every NOT_OBSERVABLE_GLOBALLY entry", () => {
    const readiness = assessReadiness([ok("bindings"), failed("d1-audit", "timeout"), ok("r2-artifacts"), ok("wiring-config")], { killSwitch: false, ...IDS });
    const details = buildHealthDetails({
      readiness,
      watchdog: summarizeWatchdog({ ok: true, value: [], ms: 1 }),
      lastSelfTest: summarizeSelfTest({ ok: true, value: undefined, ms: 1 }),
      remoteHosts: [ok("apf-document-host", false), failed("apf-fakes", "timeout", false)],
    });
    expect(details).toMatchObject({ ready: false, blockers: ["d1-audit: timeout"], gitSha: "abc1234", installation: "test-install" });
    expect(details.checks).toBe(readiness.checks);
    expect(details.watchdog.level).toBe("UNKNOWN");
    expect(details.lastSelfTest.at).toBeNull();
    expect(details.remoteHosts.map((h) => [h.name, h.ok])).toEqual([
      ["apf-document-host", true],
      ["apf-fakes", false],
    ]);
    expect(details.notObservableGlobally).toBe(NOT_OBSERVABLE_GLOBALLY);
    // The three the task names explicitly, each with a one-line reason a reader can act on.
    const facts = details.notObservableGlobally.map((n) => n.fact);
    expect(facts).toContain("pending durable_job / fanout_job rows");
    expect(facts).toContain("stale RESERVED idempotency rows");
    expect(facts).toContain("oldest RUNNING step");
    for (const n of details.notObservableGlobally) expect(n.reason).toMatch(/Durable Object|own journal|own object/);
  });
});

describe("checkWiringPreconditions(): the DO-independent construction-time throw points of the REAL wirePlatform()", () => {
  it("LOCAL_FAKES with its fake secrets and no signing key constructs (ephemeral key, apiHost null) and names the default models", () => {
    const r = checkWiringPreconditions({ installation: LOCAL_FAKES, secrets: FAKE_SECRETS, signingKeyPem: undefined });
    expect(r.signing).toBe("ephemeral");
    expect(r.models).toEqual({ "document.classify": "fake-llm", "invoice.extract": "fake-llm" });
  });

  it("an installation WITH an API host and no signing key fails closed with wirePlatform()'s own message", () => {
    const withApiHost: Installation = { ...LOCAL_FAKES, profile: { ...LOCAL_FAKES.profile, channels: { ...LOCAL_FAKES.profile.channels, apiHost: "gateway.example.test" } } };
    expect(() => checkWiringPreconditions({ installation: withApiHost, secrets: FAKE_SECRETS, signingKeyPem: undefined })).toThrow(/GATEWAY_SIGNING_KEY is missing/);
  });

  it("an unparsable signing key PEM throws (createPrivateKey), never silently degrades to ephemeral", () => {
    expect(() => checkWiringPreconditions({ installation: LOCAL_FAKES, secrets: FAKE_SECRETS, signingKeyPem: "not a pem" })).toThrow();
  });

  it("a default model whose credential has no secret value fails closed (modelTable's own message)", () => {
    const models = LOCAL_FAKES.profile.models ?? {};
    const needsSecret: Installation = {
      ...LOCAL_FAKES,
      profile: {
        ...LOCAL_FAKES.profile,
        models: { ...models, "document.classify": { default: "claude", options: { claude: { provider: "anthropic", model: "claude-x", credential: "cred:anthropic", label: "x", processor: "x" } } } },
      },
    };
    expect(() => checkWiringPreconditions({ installation: needsSecret, secrets: FAKE_SECRETS, signingKeyPem: undefined })).toThrow(/default model claude of document\.classify is unavailable/);
  });
});

describe("index.ts routes /live, /ready and /health/details through readiness.ts — source-level wiring trap", () => {
  // index.ts cannot be imported under plain-Node vitest (imports "cloudflare:workers"), so — exactly like
  // tests/gw-platform-wiring-fanout.test.ts's orchestratorFor() trap — this pins the wiring at source level and
  // says so, rather than dressing up as a runtime test it cannot be.
  const src = readFileSync(join(__dirname, "..", "deploy", "cloudflare", "apf-gateway", "src", "index.ts"), "utf8");

  it("the three routes exist and the pre-existing /health and /version routes are untouched", () => {
    expect(src).toContain('if (url.pathname === "/live") return Response.json({ ok: true, gitSha: env.GIT_SHA, installation: INSTALLATION });');
    expect(src).toContain('if (url.pathname === "/ready") {');
    expect(src).toContain('if (url.pathname === "/health/details") {');
    // Byte-for-byte the line that existed before RG2-E — something may already poll it.
    expect(src).toContain('if (url.pathname === "/health") return Response.json({ ok: true, wired: wiredOf(env) });');
    expect(src).toContain('if (url.pathname === "/version") {');
    expect(src).toContain('killSwitch: env.KILL_SWITCH === "true",');
  });

  it("/ready delegates to readinessReport(), which goes through readiness.ts's assessReadiness() over runProbes()", () => {
    const ready = src.indexOf('if (url.pathname === "/ready") {');
    const readyBody = src.slice(ready, src.indexOf("\n    }\n", ready));
    expect(readyBody).toContain("await readinessReport(env)");
    expect(readyBody).toContain("report.ready ? 200 : 503");

    const fn = src.indexOf("async function readinessReport(env: Env)");
    expect(fn, "readinessReport() not found in index.ts").toBeGreaterThan(-1);
    const fnBody = src.slice(fn, src.indexOf("\n}\n", fn));
    expect(fnBody).toContain("assessReadiness(await runProbes(readinessProbes(env)), { killSwitch: env.KILL_SWITCH === \"true\"");
    expect(src).toMatch(/import \{[^}]*\bassessReadiness\b[^}]*\} from "\.\/readiness\.js";/);
  });

  it("/ready's probes are the four required ones and never touch a WorkflowInstance or run a self-test", () => {
    const start = src.indexOf("function readinessProbes(env: Env): ProbeSpec[] {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    for (const name of REQUIRED) expect(body).toContain(`name: "${name}"`);
    expect(body).toContain("required: true");
    expect(body).not.toContain("required: false");
    expect(body).toContain("checkWiringPreconditions({ installation, secrets: secretsOf(env), signingKeyPem: env.GATEWAY_SIGNING_KEY })");
    expect(body).toContain("INSERT OR REPLACE INTO audit");
    expect(body).toContain("READINESS_PROBE_AUDIT_ID");
    expect(body).toContain("env.ARTIFACTS.head(READINESS_PROBE_R2_KEY)");
    // `wirePlatform({` = the call shape (the doc comment above the probe legitimately names wirePlatform() in prose).
    for (const forbidden of ["WORKFLOW.get(", "selfTest(", "runSelfTest(", "buildFarmModel(", "wirePlatform({"]) expect(body).not.toContain(forbidden);
  });

  it("remote hosts are non-required probes reported by /health/details only", () => {
    const start = src.indexOf("function remoteHostProbes(env: Env): ProbeSpec[] {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("required: false");
    expect(body).not.toContain("required: true");
    const details = src.indexOf('if (url.pathname === "/health/details") {');
    const detailsBody = src.slice(details, src.indexOf("\n    }\n", details));
    expect(detailsBody).toContain("runProbes(remoteHostProbes(env))");
    expect(detailsBody).toContain("latestSelfTestSummary(env)");
    expect(detailsBody).toContain("allIncidents(env)");
    expect(detailsBody).toContain("buildHealthDetails(");
    for (const forbidden of ["WORKFLOW.get(", "selfTest(", "buildFarmModel(", "computeWatchdog("]) expect(detailsBody).not.toContain(forbidden);
    const ready = src.indexOf('if (url.pathname === "/ready") {');
    expect(src.slice(ready, src.indexOf("\n    }\n", ready))).not.toContain("remoteHostProbes");
  });
});
