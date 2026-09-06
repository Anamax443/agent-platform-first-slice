// The installation a Worker is built for. There is no file by this name: scripts/farm-config.mjs generates
// .wrangler/generated/<installation>/installation.ts and the generated wrangler config aliases "apf:installation" to it.
// Worker code therefore never names an installation; the same source is bundled once per config/<installation>/.
declare module "apf:installation" {
  import type { Installation } from "../../../src/installation.js";
  /** Name of the installation directory the bundle was built from (config/<installation>/). */
  export const INSTALLATION: string;
  /** Profile + policies, assembled fail-closed at import. */
  export const installation: Installation;
}
