// The repo-root diagram pages, bundled at build time. There is no file by this name: scripts/farm-config.mjs generates
// .wrangler/generated/docs.ts from VYVOJOVY-DIAGRAM.html / .en.html, and the generated wrangler config for apf-gateway
// aliases "apf:docs" to it. Not installation-bound (same content everywhere) — just too big for a template literal
// in a source file, and generated fresh from the repo root each time so the served copy can't drift.
declare module "apf:docs" {
  export const VYVOJOVY_DIAGRAM_HTML: string;
  export const VYVOJOVY_DIAGRAM_EN_HTML: string;
}
