// ARCH-DEP-001: components import only platform/api, their own directory and adapter contracts; platform logic never reads
// the system clock; no installation value (config/<installation>/) and no e-mail address or public hostname is a literal in code.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TENANT_A, tmpDir } from "./harness/index.js";
import { projectRoot } from "./harness/paths.js";

const script = join(projectRoot, "scripts", "arch-dep.mjs");
const run = (dir?: string) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, dir ? [script, dir] : [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};

describe("ARCH-DEP-001", () => {
  it("the real source tree has no forbidden dependency and no direct system clock in platform or component logic", () => {
    const r = run();
    expect(r.out).toContain("ARCH-DEP-001 OK");
    expect(r.code).toBe(0);
  });

  it("the check can fail: a component importing the router, another component, node:fs, and a platform file reading Date.now()", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "components", "bad"), { recursive: true });
    mkdirSync(join(dir, "components", "other"), { recursive: true });
    mkdirSync(join(dir, "platform"), { recursive: true });
    writeFileSync(
      join(dir, "components", "bad", "handler.ts"),
      [
        'import { Router } from "../../platform/router.js";',
        'import { thing } from "../other/handler.js";',
        'import { readFileSync } from "node:fs";',
        'import { iso } from "../../platform/api.js";',
        "export const now = Date.now();",
      ].join("\n"),
    );
    writeFileSync(join(dir, "components", "other", "handler.ts"), "export const thing = 1;");
    writeFileSync(join(dir, "platform", "deadline.ts"), "export const t = new Date();");
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ARCH-DEP-001 FAILED (5)");
    expect(r.out).toContain("platform/router.js");
    expect(r.out).toContain("../other/handler.js");
    expect(r.out).toContain("node:fs");
    expect(r.out).toContain("direct system clock");
    expect(r.out).toContain("platform/deadline.ts:1");
  });

  it("the check can fail on installation values: a tenant from config/, an e-mail address or a public hostname as a literal in code", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "components", "leaky"), { recursive: true });
    mkdirSync(join(dir, "platform"), { recursive: true });
    writeFileSync(
      join(dir, "components", "leaky", "handler.ts"),
      [`export const tenant = "${TENANT_A}";`, 'export const ops = "ops@example.cz";', "// a comment may mention ops@example.cz, the lint reads literals only"].join("\n"),
    );
    writeFileSync(join(dir, "platform", "hosts.json"), JSON.stringify({ gateway: "apf.example.org" }));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ARCH-DEP-001 FAILED (3)");
    expect(r.out).toContain(`installation value "${TENANT_A}"`);
    expect(r.out).toContain("e-mail address");
    expect(r.out).toContain("public hostname");
  });
});
