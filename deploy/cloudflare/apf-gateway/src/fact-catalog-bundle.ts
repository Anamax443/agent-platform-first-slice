// Workers-safe FactCatalog build (M0-FACT-CONTRACT-V1.md část C, owner's Commit 1 follow-up, 18.9.2026):
// src/platform/attachment-fanout.ts needs a FactCatalog instance to call plan() against, but the only existing
// loader (tests/harness/facts.ts's realCatalog()) uses node:fs (readdirSync/existsSync) — its own comment says so
// on purpose ("tests only; the platform never reads files"). node:fs does not exist in the Cloudflare Workers
// runtime, so that loader cannot be reused by this live deployable's Durable Object (./index.ts's mailIntake()).
//
// Same fix as src/platform/workflow.ts already applies to WORKFLOW_DEFINITIONS: every JSON file this needs is
// known at build time, so each one is a static ESM JSON import (`with { type: "json" }`, an import assertion) —
// bundles fine for Workers, no fs call anywhere.
//
// Placement, not src/platform/ (unlike WORKFLOW_DEFINITIONS in workflow.ts): ARCH-DEP-001 (scripts/arch-dep.mjs,
// FOUNDATION-core F3) fails the build the moment anything under src/platform/ imports from src/components/ —
// attachment-fanout.ts's own header comment documents exactly this ("platform/* stays free of a
// src/components/* import"), and this file needs one facts.json import per component. Not inside
// platform-wiring.ts either, though that file already crosses this same boundary freely (it is deploy-layer
// composition, not src/platform/, so ARCH-DEP-001 does not apply to it) — kept as its own small file instead so
// platform-wiring.ts stays about Installation/SecretsSource/WorkersAiBinding composition, and this stays about
// "which JSON files make up this deployable's fact catalog", the same separation of concerns workflow.ts already
// keeps from platform-wiring.ts's own orchestrator construction. Lives beside platform-wiring.ts (not inside
// src/platform/) because a FactCatalog assembled from a fixed, bundled file list is a property of THIS
// deployable's build, exactly like GATEWAY_CAPABILITIES/WORKFLOW_DEFINITIONS wiring already is here — a future
// deployable that also needs fan-out (none does yet) would get its own copy, the same way it would get its own
// platform-wiring.ts.
import namespace from "../../../../contracts/facts.v1.json" with { type: "json" };
import czCompanyVerifyFacts from "../../../../src/components/cz-company-verify/facts.json" with { type: "json" };
import czVatVerifyFacts from "../../../../src/components/cz-vat-verify/facts.json" with { type: "json" };
import documentClassifierFacts from "../../../../src/components/document-classifier/facts.json" with { type: "json" };
import documentExecutorHostFacts from "../../../../src/components/document-executor-host/facts.json" with { type: "json" };
import documentValidatorFacts from "../../../../src/components/document-validator/facts.json" with { type: "json" };
import emailExecutorFacts from "../../../../src/components/email-executor/facts.json" with { type: "json" };
import invoiceExtractorFacts from "../../../../src/components/invoice-extractor/facts.json" with { type: "json" };
import mailIngestFacts from "../../../../src/components/mail-ingest/facts.json" with { type: "json" };
import { FactCatalog, type FactNamespace, type ModuleFacts } from "../../../../src/platform/fact-catalog.js";

// Every src/components/<module>/facts.json sidecar that exists today — confirmed by listing the directory at the
// time this file was written, not carried over from an old count (tests/facts.test.ts's own directory-scan
// assertions are the fs-based, tests-only backstop that would catch a components directory drifting from this
// list; FactCatalog.build()'s own DUPLICATE_MODULE/DUPLICATE_CAPABILITY checks are the fail-closed backstop here
// at build/import time — a module added without a line below throws immediately rather than silently omitting it).
const MODULES: readonly ModuleFacts[] = [
  czCompanyVerifyFacts,
  czVatVerifyFacts,
  documentClassifierFacts,
  documentExecutorHostFacts,
  documentValidatorFacts,
  emailExecutorFacts,
  invoiceExtractorFacts,
  mailIngestFacts,
] as unknown as ModuleFacts[];

/** Built once at import, fail-closed exactly like WORKFLOW_DEFINITIONS (src/platform/workflow.ts) — same "same
 * list under Node and in a Worker" guarantee, no runtime file access either place. */
export const FACT_CATALOG: FactCatalog = FactCatalog.build(namespace as unknown as FactNamespace, MODULES);
