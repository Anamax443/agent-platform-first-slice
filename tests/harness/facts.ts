// Loaders for the fact namespace, the per-module facts.json sidecars and the workflow capability chains (tests only;
// the platform never reads files — FactCatalog.build() takes parsed JSON).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FactCatalog, type FactNamespace, type ModuleFacts } from "../../src/platform/fact-catalog.js";
import type { ModuleDescriptorLike } from "../../src/platform/registry.js";
import { loadJson, projectRoot } from "./paths.js";

export const componentsDir = join(projectRoot, "src", "components");

export const loadNamespace = (): FactNamespace => loadJson<FactNamespace>(join(projectRoot, "contracts", "facts.v1.json"));

export interface ComponentFacts {
  module: string;
  dir: string;
  facts?: ModuleFacts;
  descriptor: ModuleDescriptorLike;
}

/** Every directory under src/components, sorted; `facts` is absent when the sidecar is missing (FACT-004 asserts it is not). */
export function loadComponents(): ComponentFacts[] {
  return readdirSync(componentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((module) => {
      const dir = join(componentsDir, module);
      const factsPath = join(dir, "facts.json");
      return {
        module,
        dir,
        ...(existsSync(factsPath) ? { facts: loadJson<ModuleFacts>(factsPath) } : {}),
        descriptor: loadJson<ModuleDescriptorLike>(join(dir, "descriptor.json")),
      };
    });
}

export const realCatalog = (): FactCatalog => FactCatalog.build(loadNamespace(), loadComponents().flatMap((c) => (c.facts ? [c.facts] : [])));

/** The capability names of a workflows/*.json definition, in step order. */
export const workflowChain = (file: string): string[] =>
  loadJson<{ steps: { capability: string }[] }>(join(projectRoot, "workflows", file)).steps.map((s) => s.capability);
