// Which discovery-planned capability maps to which DiscoveryInputBuilder (src/platform/discovery-runner.ts) —
// its own small file for the same reason fact-catalog-bundle.ts is its own file rather than folded into
// platform-wiring.ts (that file's own doc comment): a fixed, bundled registry that is a property of THIS
// deployable's build, one clear concern per file. src/platform/* itself may never import src/components/*
// (ARCH-DEP-001, fact-catalog-bundle.ts's own header) — this file is deploy-layer composition, so it may.
import type { DiscoveryInputBuilder } from "../../../../src/platform/discovery-runner.js";
import { discoveryInput as intentResolveDiscoveryInput } from "../../../../src/components/intent-resolver/discovery.js";

export const DISCOVERY_INPUT_BUILDERS: Readonly<Record<string, DiscoveryInputBuilder>> = {
  "intent.resolve": intentResolveDiscoveryInput,
};
