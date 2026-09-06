// CTR family: provider conformance (schema + fixtures + golden), error contract, UTC times.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/platform/artifacts.js";
import { PLATFORM_CODES } from "../src/platform/errors.js";
import { compileSchema, validateContract } from "../src/platform/schemas.js";
import { expectGolden, runFixture, type FixtureRun } from "./harness/conformance.js";
import { command, createSlice, dispatch, INVOICE_CZ, LOCAL_FAKES, putArtifact, TENANT_A, TENANT_B } from "./harness/index.js";
import { loadJson, projectRoot } from "./harness/paths.js";
import { loadSuite } from "./harness/suite.js";

interface Descriptor {
  module: string;
  capabilities: Array<{ name: string; errorCodes?: string[]; conformanceTier?: string; conformanceSuiteVersion?: string }>;
}

const COMPONENTS: Record<string, { caps: string[]; output: Record<string, string> }> = {
  "document-classifier": { caps: ["document.classify"], output: { "document.classify": "output.schema.json" } },
  "document-validator": { caps: ["document.validate"], output: { "document.validate": "output.schema.json" } },
  "document-executor-host": {
    caps: ["document.stamp", "document.archive"],
    output: { "document.stamp": "stamp.output.schema.json", "document.archive": "archive.output.schema.json" },
  },
  "mail-ingest": { caps: ["mail.ingest"], output: { "mail.ingest": "output.schema.json" } },
  "email-executor": { caps: ["email.send"], output: { "email.send": "output.schema.json" } },
};
const MINIMUM: Record<string, number> = { canonical: 5, damaged: 1, injection: 1, boundary: 1 };
const FULL_MINIMUM_CAPS = ["document.classify", "document.validate", "document.stamp", "mail.ingest", "email.send"];
const runs = new Map<string, FixtureRun>();

const descriptorOf = (module: string) => loadJson<Descriptor>(join(projectRoot, "src", "components", module, "descriptor.json"));
const emailPolicy = LOCAL_FAKES.policies["email.send"];
const ALLOWLISTED_ADDRESSES = new Set(Object.values(emailPolicy?.recipientAllowlist ?? {}).flatMap((t) => Object.values(t)));

describe("CTR-001 descriptors", () => {
  for (const [module, { caps }] of Object.entries(COMPONENTS)) {
    it(`CTR-001 ${module}: descriptor valid against module-descriptor.v1 and every capability routable`, () => {
      const d = descriptorOf(module);
      expect(validateContract("module-descriptor", d)).toEqual({ ok: true });
      const providers = createSlice().router.providers();
      for (const c of caps) expect(providers).toContain(`${c}/v1@${module}`);
    });
  }
});

for (const [module, { caps, output }] of Object.entries(COMPONENTS)) {
  const descriptor = descriptorOf(module);
  for (const capability of caps) {
    const suite = loadSuite(capability);
    const cap = descriptor.capabilities.find((c) => c.name === capability);
    const validateOutput = compileSchema(loadJson(join(projectRoot, "src", "components", module, output[capability] as string)));

    describe(`CTR-001 ${capability} conformance suite ${suite.version}`, () => {
      it("suite version matches the descriptor claim", () => {
        expect(cap?.conformanceSuiteVersion).toBe(suite.version);
      });
      if (FULL_MINIMUM_CAPS.includes(capability)) {
        it("has at least the minimum fixture set for a first capability (VC §5)", () => {
          for (const [kind, min] of Object.entries(MINIMUM)) {
            expect(suite.fixtures.filter((f) => f.kind === kind).length, kind).toBeGreaterThanOrEqual(min);
          }
        });
      }
      for (const f of suite.fixtures) {
        it(`CTR-001 ${capability} [${f.kind}] ${f.id}`, async () => {
          const run = await runFixture(capability, f);
          runs.set(`${capability}/${f.id}`, run);
          expectGolden(run.result, suite.golden[f.id], run.vars, f.id);
          expect(validateContract("result-envelope", run.result)).toEqual({ ok: true });
          if (run.result.status !== "SUCCEEDED") return;
          expect(validateOutput(run.result.payload)).toEqual({ ok: true });

          if (capability === "document.stamp") {
            const p = run.result.payload as { stampedArtifactId: string; stampedSha256: string; originalArtifactId: string };
            const derived = run.slice.artifacts.get(p.stampedArtifactId);
            expect(derived?.derivedFrom).toBe(p.originalArtifactId);
            expect(derived && sha256(derived.bytes)).toBe(p.stampedSha256);
          }
          if (capability === "mail.ingest") {
            // EVD-001 for ingest: the stored original is the raw mail, owned by the tenant of the trusted context
            const p = run.result.payload as { artifactId: string; sha256: string };
            const stored = run.slice.artifacts.get(p.artifactId);
            expect(stored?.bytes).toBe(f.payload.rawMail);
            expect(stored?.tenantId).toBe(f.actor === "svc-orchestrator-t7" ? TENANT_B : TENANT_A);
            expect(stored?.receivedFrom).toBe(f.payload.receivedFrom);
            expect(p.sha256).toBe(sha256(String(f.payload.rawMail)));
          }
          if (capability === "email.send") {
            // effect field recipientRef: every delivery went to an allowlisted address, never to anything from a payload
            for (const to of run.slice.smtp.recipients()) expect(ALLOWLISTED_ADDRESSES.has(to), to).toBe(true);
            expect(run.slice.smtp.recipients()).toHaveLength(1);
          }
        });
      }
    });

    describe(`CTR-ERR-001 ${capability}`, () => {
      it("every FAILED golden is a row of errors.md with the same class and retryable", () => {
        for (const f of suite.fixtures) {
          const golden = suite.golden[f.id];
          for (const g of golden?.anyOf ?? [golden]) {
            if (!g?.error) continue;
            const row = suite.errors.find((r) => r.code === g.error?.code);
            expect(row, `${f.id}: ${String(g.error.code)} missing in errors.md`).toBeDefined();
            expect([row?.class, row?.retryable]).toEqual([g.error.class, g.error.retryable]);
          }
        }
      });
      it("actual error objects match errors.md (code -> class, retryable, reissuable)", () => {
        let checked = 0;
        for (const f of suite.fixtures) {
          const err = runs.get(`${capability}/${f.id}`)?.result.error;
          if (!err) continue;
          const row = suite.errors.find((r) => r.code === err.code);
          expect(row, `${f.id}: ${err.code} missing in errors.md`).toBeDefined();
          expect({ class: err.class, retryable: err.retryable, reissuable: err.reissuable ?? false }).toEqual({
            class: row?.class,
            retryable: row?.retryable,
            reissuable: row?.reissuable,
          });
          checked += 1;
        }
        expect(checked).toBeGreaterThan(0);
      });
      it("every declared errorCode is documented and every documented code is a platform or declared code", () => {
        const documented = new Set(suite.errors.map((r) => r.code));
        for (const code of cap?.errorCodes ?? []) expect(documented.has(code), `${code} not in errors.md`).toBe(true);
        const known = new Set([...Object.keys(PLATFORM_CODES), ...(cap?.errorCodes ?? [])]);
        for (const code of documented) expect(known.has(code), `${code} documented but neither platform nor declared`).toBe(true);
      });
    });
  }
}

describe("CTR-TIME-001 times are UTC with Z", () => {
  it("rejects createdAt with a zone offset before any handler runs", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const m = command(slice, { capability: "document.classify", payload: { artifactId: art.artifactId } });
    m.createdAt = "2026-09-06T10:00:00+02:00";
    const r = await dispatch(slice, m);
    expect(r.status).toBe("FAILED");
    expect(r.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(String(r.error?.details?.errors)).toContain("createdAt");
    expect(slice.audit.byKind("dispatch")).toHaveLength(0);
  });
  it("rejects notValidAfter without Z on a write command", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const m = command(slice, { capability: "document.stamp", payload: { artifactId: art.artifactId, sha256: art.sha256 } });
    m.notValidAfter = "2026-09-06T08:30:00";
    const r = await dispatch(slice, m);
    expect(r.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(String(r.error?.details?.errors)).toContain("notValidAfter");
    expect(slice.dms.stampCalls).toBe(0);
  });
});
