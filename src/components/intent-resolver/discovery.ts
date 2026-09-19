// This capability's own DiscoveryInputBuilder (src/platform/discovery-runner.ts) — kept beside descriptor.json/
// input.schema.json/handler.ts, the same place every other piece of this capability's own shape lives, not in a
// central switch inside the driver. Each composition root assembles its own {capability -> builder} registry
// from pieces like this one (deploy/cloudflare/apf-gateway/src/discovery-wiring.ts for the live gateway).
import type { DiscoveryInputBuilder } from "../../platform/api.js";

/**
 * artifactId: input.schema.json's own description names both valid sources — "NormalizedImpulse.content, or a
 * channel's own text artifact" — so prefer the impulse's own content artifact, else its first attachment.
 * caseId: input.schema.json's own doc comment anticipated exactly this caller ("no Case-level loop calls this
 * yet") — now that one exists, thread it through (EvidenceWriter.write()'s originCaseId option).
 */
export const discoveryInput: DiscoveryInputBuilder = ({ case: c }) => {
  const artifactId = c.impulse.content?.artifactId ?? c.impulse.artifacts[0]?.artifactId;
  return artifactId ? { artifactId, caseId: c.caseId } : undefined;
};
