// REG family: Agent Registry (SEVERKA.md item 4) — Router.catalog() and capabilityNamesOf() are pure, read-only
// introspection over what Router.register() already validated; they must never disagree with Router.providers()
// or with what a descriptor actually declares.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityNamesOf, catalogEntry, catalogOf, type ModuleDescriptorLike } from "../src/platform/registry.js";
import { createSlice } from "./harness/index.js";
import { loadJson, projectRoot } from "./harness/paths.js";

const descriptorOf = (module: string) => loadJson<ModuleDescriptorLike>(join(projectRoot, "src", "components", module, "descriptor.json"));

describe("REG-001 catalog() agrees with providers()", () => {
  it("same capability/version/module triples, just structured", () => {
    const router = createSlice().router;
    const providers = router.providers();
    const catalog = router.catalog();
    expect(catalog).toHaveLength(providers.length);
    for (const entry of catalog) {
      expect(providers).toContain(`${entry.capability}/v${entry.version}@${entry.module}`);
    }
  });
});

describe("REG-002 catalog() carries the descriptor's risk/isolation metadata", () => {
  it("email.send: MEDIUM risk, PRINCIPAL isolation, external-write", () => {
    const entry = createSlice().router.catalog().find((e) => e.capability === "email.send");
    expect(entry).toMatchObject({ riskClass: "MEDIUM", isolationClass: "PRINCIPAL", sideEffects: "external-write", module: "email-executor" });
  });
  it("document.classify: LOW risk, uses an LLM, no side effects", () => {
    const entry = createSlice().router.catalog().find((e) => e.capability === "document.classify");
    expect(entry).toMatchObject({ riskClass: "LOW", usesLlm: true, sideEffects: "none", module: "document-classifier" });
  });
  it("document.stamp and document.archive share one module (one deployable, two capabilities)", () => {
    const catalog = createSlice().router.catalog();
    const stamp = catalog.find((e) => e.capability === "document.stamp");
    const archive = catalog.find((e) => e.capability === "document.archive");
    expect(stamp?.module).toBe("document-executor-host");
    expect(archive?.module).toBe("document-executor-host");
  });
});

describe("REG-003 capabilityNamesOf() is the single source for cross-Worker dispatch tables", () => {
  it("document-executor-host descriptor names exactly document.stamp + document.archive", () => {
    expect(capabilityNamesOf(descriptorOf("document-executor-host"))).toEqual(["document.stamp", "document.archive"]);
  });
  it("email-executor descriptor names exactly email.send", () => {
    expect(capabilityNamesOf(descriptorOf("email-executor"))).toEqual(["email.send"]);
  });
  it("mail-ingest descriptor names exactly mail.ingest", () => {
    expect(capabilityNamesOf(descriptorOf("mail-ingest"))).toEqual(["mail.ingest"]);
  });
});

describe("REG-005 catalogOf() — a deployable's own /capabilities endpoint, no live Router needed", () => {
  it("one row per capability the descriptor declares, at its preferredVersion", () => {
    const descriptor = descriptorOf("document-executor-host");
    const catalog = catalogOf(descriptor);
    expect(catalog).toHaveLength(2);
    expect(catalog).toEqual(
      expect.arrayContaining([
        catalogEntry(descriptor, "document.stamp", "1"),
        catalogEntry(descriptor, "document.archive", "1"),
      ]),
    );
  });
});

describe("REG-004 catalogEntry() falls back cleanly when the descriptor doesn't recognize the capability", () => {
  it("returns just capability/version/module, no risk fields invented", () => {
    const entry = catalogEntry(descriptorOf("email-executor"), "email.send", "9");
    expect(entry).toMatchObject({ capability: "email.send", version: "9", module: "email-executor" });
    const unknown = catalogEntry(descriptorOf("email-executor"), "nonexistent.capability", "1");
    expect(unknown).toEqual({ capability: "nonexistent.capability", version: "1", module: "email-executor", componentVersion: "0.1.0" });
  });
});
