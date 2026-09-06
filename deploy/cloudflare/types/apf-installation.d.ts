// The installation a Worker is built for. There is no file by this name: scripts/farm-config.mjs generates
// .wrangler/generated/<installation>/installation.ts and the generated wrangler config aliases "apf:installation" to it.
// Worker code therefore never names an installation; the same source is bundled once per config/<installation>/.
// (Inline import types: an ambient module declaration may not use a relative import statement, and skipLibCheck would hide that.)
declare module "apf:installation" {
  /** Name of the installation directory the bundle was built from (config/<installation>/). */
  export const INSTALLATION: string;
  /** Profile + policies, assembled fail-closed at import. */
  export const installation: import("../../../src/installation.js").Installation;
}
