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
  trustedProvidersCheck,
  type ProbeResult,
  type ProbeSpec,
} from "../deploy/cloudflare/apf-gateway/src/readiness.js";
import { FAKE_SECRETS, LOCAL_FAKES } from "./harness/index.js";

const ok = (name: string, required = true): ProbeResult => ({ name, ok: true, required, ms: 1, timeoutMs: 100 });
const failed = (name: string, reason: string, required = true): ProbeResult => ({ name, ok: false, required, reason, ms: 1, timeoutMs: 100 });
const IDS = { gitSha: "abc1234", installation: "test-install" };
/** The four REQUIRED probes index.ts's readinessProbes() defines, by name. The fifth required check a reader of
 * /ready sees, KILL_SWITCH, is not a probe: assessReadiness() folds it in itself (readiness.ts). */
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

  // The two timing assertions below run against the REAL clock (withTimeout() schedules a real setTimeout, so a
  // fake `now` could not prove anything about the hang being cut off). Budgets are chosen so the assertion's
  // slack is far wider than timer jitter on a loaded runner: a 60 ms budget measured as >= 40 ms (20 ms slack), and
  // two concurrent 100 ms hangs finishing under 180 ms where a sequential run could not finish before 200 ms.
  it("a thunk that hangs past its budget -> ok:false, reason exactly \"timeout\", and the call itself resolves", async () => {
    const r = await runProbe(spec(() => new Promise<never>(() => {}), 60));
    expect(r).toMatchObject({ ok: false, reason: "timeout", timeoutMs: 60 });
    expect(r.ms).toBeGreaterThanOrEqual(40);
  });

  it("runProbes() runs every spec concurrently: two 100 ms hangs finish in one budget, not two", async () => {
    const t0 = Date.now();
    const rs = await runProbes([spec(() => new Promise<never>(() => {}), 100), spec(() => new Promise<never>(() => {}), 100)]);
    expect(rs.map((r) => r.reason)).toEqual(["timeout", "timeout"]);
    expect(Date.now() - t0).toBeLessThan(180);
  });

  it("a timed-out probe's ms is measured through the injected clock (the value the report shows is `now` based)", async () => {
    let t = 1_000;
    const now = () => (t += 7);
    const r = await runProbe(spec(() => new Promise<never>(() => {}), 10), now);
    expect(r).toMatchObject({ ok: false, reason: "timeout", ms: 7 });
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

  it("a row whose JSON parsed but has no fixtures array (corrupted/hand-edited) is reported, never thrown", () => {
    // The only path the RG2-E review found that could 500 /health/details: the route has no try/catch around
    // summarizeSelfTest(), and boundedRead() only guards the D1 read + JSON.parse inside the thunk.
    const malformed = { updatedAt: "2026-09-18T10:00:00.000Z" } as unknown as { updatedAt: string; fixtures: [] };
    expect(() => summarizeSelfTest({ ok: true, value: malformed, ms: 1 })).not.toThrow();
    expect(summarizeSelfTest({ ok: true, value: malformed, ms: 1 })).toMatchObject({ at: null, reason: expect.stringContaining("malformed") });
    const wrongType = { updatedAt: "x", fixtures: "not an array" } as unknown as { updatedAt: string; fixtures: [] };
    expect(summarizeSelfTest({ ok: true, value: wrongType, ms: 1 })).toMatchObject({ at: null, reason: expect.stringContaining("malformed") });
  });
});

describe("trustedProvidersCheck(): Reliability Gate R4's config gap, reported by /health/details, never a blocker", () => {
  it("opted into the fakes (local-fakes) -> ok; real adapters wired -> ok regardless of the flag", () => {
    expect(trustedProvidersCheck({ allowUnconfiguredTrustedProviders: true, realAdaptersWired: false })).toMatchObject({ name: "trusted-providers", ok: true, required: false });
    expect(trustedProvidersCheck({ allowUnconfiguredTrustedProviders: false, realAdaptersWired: true })).toMatchObject({ ok: true, required: false });
    expect(trustedProvidersCheck({ allowUnconfiguredTrustedProviders: undefined, realAdaptersWired: true })).toMatchObject({ ok: true, required: false });
  });

  it("neither -> ok:false, non-required, naming the two capabilities and the FAILED code they will produce", () => {
    for (const flag of [false, undefined]) {
      const r = trustedProvidersCheck({ allowUnconfiguredTrustedProviders: flag, realAdaptersWired: false });
      expect(r).toMatchObject({ name: "trusted-providers", ok: false, required: false });
      expect(r.reason).toContain("cz.company.verify");
      expect(r.reason).toContain("cz.vat.verify");
      expect(r.reason).toContain("TRUSTED_PROVIDER_NOT_CONFIGURED");
      expect(r.reason).toContain("allowUnconfiguredTrustedProviders");
    }
  });

  it("the REAL local-fakes installation passes (it exists to BE the fakes), and never affects readiness", () => {
    const check = trustedProvidersCheck({ allowUnconfiguredTrustedProviders: LOCAL_FAKES.profile.allowUnconfiguredTrustedProviders, realAdaptersWired: false });
    expect(check.ok).toBe(true);
    const failing = trustedProvidersCheck({ allowUnconfiguredTrustedProviders: false, realAdaptersWired: false });
    const r = assessReadiness([...REQUIRED.map((n) => ok(n)), failing], { killSwitch: false, ...IDS });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
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

  it("effectiveLevel ignores acknowledged incidents (page.ts effectiveWatchdogLevel, what /farm shows) while level does not", () => {
    const warn = incident("ohrada-backlog", "WARN");
    const ackedIncident = incident("worker:apf-fakes", "INCIDENT", { acknowledgedAt: "2026-09-18T09:30:00.000Z", acknowledgedBy: "someone" });
    const ackedWarn = incident("selftest-degraded:x", "WARN", { acknowledgedAt: "2026-09-18T09:30:00.000Z" });
    // Raw INCIDENT, human-facing DEGRADED: the acknowledged INCIDENT no longer demands attention, the open WARN does.
    expect(summarizeWatchdog({ ok: true, value: [warn, ackedIncident], ms: 1 })).toMatchObject({ level: "INCIDENT", effectiveLevel: "DEGRADED" });
    // Everything open is acknowledged: raw INCIDENT, human-facing HEALTHY — exactly the /farm vs /health/details gap the review named.
    expect(summarizeWatchdog({ ok: true, value: [ackedIncident, ackedWarn], ms: 1 })).toMatchObject({ level: "INCIDENT", effectiveLevel: "HEALTHY" });
    // Nothing acknowledged: the two agree.
    expect(summarizeWatchdog({ ok: true, value: [warn], ms: 1 })).toMatchObject({ level: "DEGRADED", effectiveLevel: "DEGRADED" });
    // UNKNOWN is UNKNOWN on both.
    expect(summarizeWatchdog({ ok: true, value: [], ms: 1 })).toMatchObject({ level: "UNKNOWN", effectiveLevel: "UNKNOWN" });
    expect(summarizeWatchdog({ ok: true, value: [warn], ms: 1 }).source).toContain("effectiveLevel");
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
      trustedProviders: trustedProvidersCheck({ allowUnconfiguredTrustedProviders: false, realAdaptersWired: false }),
    });
    expect(details).toMatchObject({ ready: false, blockers: ["d1-audit: timeout"], gitSha: "abc1234", installation: "test-install" });
    expect(details.checks).toBe(readiness.checks);
    expect(details.watchdog.level).toBe("UNKNOWN");
    expect(details.lastSelfTest.at).toBeNull();
    expect(details.remoteHosts.map((h) => [h.name, h.ok])).toEqual([
      ["apf-document-host", true],
      ["apf-fakes", false],
    ]);
    // R4's gap is visible here and only here — it did not become a blocker above.
    expect(details.trustedProviders).toMatchObject({ name: "trusted-providers", ok: false, required: false });
    expect(details.blockers).not.toContainEqual(expect.stringContaining("trusted-providers"));
    expect(details.notObservableGlobally).toBe(NOT_OBSERVABLE_GLOBALLY);
    // The three the task names explicitly, each with a one-line reason a reader can act on.
    const facts = details.notObservableGlobally.map((n) => n.fact);
    expect(facts).toContain("pending durable_job / fanout_job rows");
    expect(facts).toContain("stale RESERVED idempotency rows");
    expect(facts).toContain("oldest RUNNING step");
    // Plus the one deliberate probe gap: the d1-audit probe is read-only, so D1 refusing writes is named, not hidden.
    expect(facts).toContainEqual(expect.stringContaining("D1 refusing writes"));
    for (const n of details.notObservableGlobally) expect(n.reason).toMatch(/Durable Object|own journal|own object/);
  });
});

describe("checkWiringPreconditions(): the DO-independent construction-time throw points of the REAL wirePlatform()", () => {
  it("LOCAL_FAKES with its fake secrets and no signing key constructs (ephemeral key, apiHost null) and names the default models", () => {
    const r = checkWiringPreconditions({ installation: LOCAL_FAKES, secrets: FAKE_SECRETS, signingKeyPem: undefined });
    expect(r.signing).toBe("ephemeral");
    expect(r.models).toEqual({ "document.classify": "fake-llm", "invoice.extract": "fake-llm", "intent.resolve": "fake-llm" });
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
    expect(body).toContain('prepare("SELECT 1")');
    expect(body).toContain("env.ARTIFACTS.head(READINESS_PROBE_R2_KEY)");
    // `wirePlatform({` = the call shape (the doc comment above the probe legitimately names wirePlatform() in prose).
    for (const forbidden of ["WORKFLOW.get(", "selfTest(", "runSelfTest(", "buildFarmModel(", "wirePlatform({"]) expect(body).not.toContain(forbidden);
  });

  it("/ready's probes are READ-ONLY: no D1 write, no audit row, no R2 put (RG2-E review: a write per LB poll pinned a probe row to the Deník and burned D1 quota)", () => {
    const start = src.indexOf("function readinessProbes(env: Env): ProbeSpec[] {");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    // Code only: strip // comment lines, which legitimately narrate the rejected write in prose.
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const forbidden of ["INSERT", "REPLACE", "UPDATE ", "DELETE", ".run()", ".put(", "readiness-probe", "READINESS_PROBE_AUDIT_ID"]) expect(code, `readinessProbes() must not contain ${forbidden}`).not.toContain(forbidden);
    expect(src).not.toContain("const READINESS_PROBE_AUDIT_ID");
    // And the blind spot that leaves is named in the report, not swallowed.
    expect(NOT_OBSERVABLE_GLOBALLY.some((n) => n.fact.includes("D1 refusing writes"))).toBe(true);
  });

  it("R4's trusted-provider gap: wiring() passes no real adapter, index.ts says so in one constant, and /health/details reports it", () => {
    const wiring = src.indexOf("private wiring(): Wiring {");
    expect(wiring).toBeGreaterThan(-1);
    const wiringBody = src.slice(wiring, src.indexOf("\n  }\n", wiring));
    expect(wiringBody).toContain("wirePlatform({");
    // The trap this constant's doc comment promises: while it says `false`, wiring() must not pass a real adapter.
    expect(src).toContain("const GATEWAY_WIRES_REAL_TRUSTED_PROVIDERS = false;");
    expect(wiringBody).not.toMatch(/\bares:/);
    expect(wiringBody).not.toMatch(/\bmojeDane:/);
    const details = src.indexOf('if (url.pathname === "/health/details") {');
    const detailsBody = src.slice(details, src.indexOf("\n    }\n", details));
    expect(detailsBody).toContain("trustedProvidersCheck({ allowUnconfiguredTrustedProviders: installation.profile.allowUnconfiguredTrustedProviders, realAdaptersWired: GATEWAY_WIRES_REAL_TRUSTED_PROVIDERS })");
    expect(detailsBody).toContain("trustedProviders,");
    // /ready never sees it.
    const ready = src.indexOf('if (url.pathname === "/ready") {');
    expect(src.slice(ready, src.indexOf("\n    }\n", ready))).not.toContain("trustedProvidersCheck");
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
