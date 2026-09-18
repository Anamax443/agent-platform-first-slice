// Orchestration-layer fan-out driver for mail attachments (owner's Commit 1, M0-FACT-CONTRACT-V1.md část C,
// 18.9.2026) — the same architectural layer as deploy/cloudflare/apf-gateway/src/index.ts's startMailIntake():
// a decision about WHEN to start another workflow instance, never inside a capability handler. mail.ingest,
// document.classify and invoice.extract all stay exactly as narrow and single-purpose as before; none of them
// ever decides to start another workflow instance — that decision belongs here, one layer up.
//
// mail.ingest already returns attachmentArtifactIds[] (src/components/mail-ingest/handler.ts) alongside the
// existing combined-text artifact that the untouched top-level "classify" step of workflows/mail-intake.v3.json
// keeps reading and classifying exactly as it always has — this driver is purely additive. For each attachment
// artifact it:
//   1. runs a classify-only instance (workflows/attachment-classify.v1.json) on that ONE attachment,
//   2. asks planner.plan() — genuinely, by actually calling it and inspecting the result, never a hardcoded
//      "if classification result was INVOICE then run extract" shortcut — whether invoice.extract is reachable
//      from that specific artifact's own sealed evidence, and
//   3. only when plan() answers PLANNED with invoice.extract among its steps, runs an extract-only instance
//      (workflows/attachment-extract.v1.json) on that same artifact.
//
// orchestrator.ts is not touched for this: "run a small flow once per attachment" is achieved by calling
// Orchestrator.start() once per attachment from here, never by adding a loop/foreach construct to the
// orchestrator itself.
import type { Evidence, EvidenceLedger } from "./evidence.js";
import type { EntityId } from "./fact-address.js";
import type { FactCatalog } from "./fact-catalog.js";
import type { Instance } from "./journal.js";
import type { Orchestrator } from "./orchestrator.js";
import { plan, type PlanResult } from "./planner.js";

// Evidence identity document.classify seals under (src/components/document-classifier/handler.ts's own exported
// CLASSIFY_EVIDENCE_* constants) — re-declared here rather than imported: platform/* stays free of a
// src/components/* import (the same layering fact-catalog.ts and authorities.ts already keep for their own copies
// of shared literals, ARCH-DEP-001).
const CLASSIFY_PRODUCER_ID = "document.classify";
const CLASSIFY_INPUT_FIELD = "document.type";
const CLASSIFY_INVOICE_RESULT = "INVOICE";
/** The one namespace key this driver ever adds beyond the artifact itself. contracts/facts.v1.json's own entry
 * for this key documents why no module's facts.json declares producing it: a value-conditional gate must never
 * be something plan() can chain its way into on its own, from a bare document.original. */
const INVOICE_CONFIRMED_EVIDENCE_KEY = "document.type.invoiceConfirmed";
const DOCUMENT_ORIGINAL_KEY = "document.original";
/** The FactAddress scope document.type.invoiceConfirmed now carries (P0 fact-scope-multi-doc pass,
 * docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit — contracts/facts.v1.json's own entry for this
 * key explains why: a Case with more than one document, the ADR's own acceptance scenario C part 8, needs the
 * evidence's own scope to disambiguate by attachment, not by Evidence.workflowId, which classifiedAsInvoice() below
 * used to rely on). Re-declared here rather than imported: platform/* stays free of a src/components/* import,
 * same ARCH-DEP-001 reasoning as CLASSIFY_PRODUCER_ID/CLASSIFY_INPUT_FIELD/CLASSIFY_INVOICE_RESULT just above. */
const ATTACHMENT_ENTITY_SCOPE = "impulse.attachment";

export interface AttachmentFanoutDeps {
  /** Orchestrator built over workflows/attachment-classify.v1.json — src/slice.ts's generic per-WorkflowDef loop
   * already provides one keyed "attachment-classify" in `slice.orchestrators`. */
  classifyOrchestrator: Orchestrator;
  /** Orchestrator built over workflows/attachment-extract.v1.json (`slice.orchestrators["attachment-extract"]`). */
  extractOrchestrator: Orchestrator;
  /** FactCatalog built from contracts/facts.v1.json + every module's facts.json sidecar — loaded once by the
   * caller (tests/harness/facts.ts's realCatalog(), or the equivalent bundled at a future deploy call site),
   * never by this file (fact-catalog.ts's own rule: "the platform never reads files"). */
  catalog: FactCatalog;
  /** The Žlab this installation's document.classify writes into (`slice.evidence`) — read-only here. */
  evidence: EvidenceLedger;
}

export interface AttachmentFanoutInput {
  tenantId: string;
  /**
   * The Case every attachment-classify/attachment-extract instance this call starts belongs to
   * (docs/AUTONOMOUS-RUNTIME-V1.md část 2) — required, not optional: by the time a caller can legitimately invoke
   * this driver at all (index.ts's fanOutAttachmentsIfAny(), which runs strictly after createCaseForMailIntake()
   * already built the Case for this same mail-intake instance), the Case always already exists. Threaded through to
   * the classify orchestrator's own start() input (flows to document.classify's handler via
   * attachment-classify.v1.json's "caseId" step input) so document.classify's own sealed evidence carries
   * originCaseId, and used directly by classifiedAsInvoice() below to read through EvidenceLedger.forCase() instead
   * of an unfiltered tenant-wide scan.
   */
  caseId: string;
  /**
   * One {artifactId, entityId} pair per successfully-ingested attachment (P0 fact-scope-multi-doc pass,
   * docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit) — replaces the old flat `attachmentArtifactIds:
   * readonly string[]`. `entityId` is mail.ingest's own freshly-minted impulse.attachment entity id (handler.ts's
   * `newEntityId()` call, one per parsed attachment) threaded through so classifiedAsInvoice() below can look up
   * THIS attachment's own sealed evidence by FactAddress (subject.scope + subject.entityId), not by
   * Evidence.workflowId (the old, coincidental "one classify sub-instance per attachment" keying this rescoping
   * replaces — see classifiedAsInvoice()'s own doc comment).
   */
  attachments: readonly AttachmentFanoutAttachment[];
  correlationId?: string;
}

/** One attachment this driver fans out over — artifactId to classify/extract, entityId to scope its evidence to
 * (see AttachmentFanoutInput.attachments's own doc comment for why both are needed, P0 fact-scope-multi-doc pass). */
export interface AttachmentFanoutAttachment {
  artifactId: string;
  entityId: EntityId;
}

/** Structural shape of mail.ingest's own `attachments[]` payload entries (src/components/mail-ingest/handler.ts's
 * exported `AttachmentOutcome`) — re-declared here rather than imported: platform/* stays free of a
 * src/components/* import (ARCH-DEP-001), the same discipline this file's own CLASSIFY_* constants above already
 * follow for their shared literals. Only the fields summarizeFanoutOutcomes() and index.ts's own
 * fanOutAttachmentsIfAny() actually read are kept — `entityId` added by the P0 fact-scope-multi-doc pass
 * (docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit) alongside `artifactId`, present under the same
 * "iff status is SUCCEEDED" condition, since index.ts now reads both off this exact structural type to build the
 * `attachments` input above. */
export interface MailIngestAttachmentOutcome {
  index: number;
  filename: string;
  contentType: string;
  status: "SUCCEEDED" | "FAILED";
  artifactId?: string;
  entityId?: string;
  errorCode?: string;
}

/** Aggregate status this driver's own audit record (index.ts's fanOutAttachmentsIfAny) reports for one mail's
 * whole attachment fan-out — owner, 18.9.2026, after live external review: the audit line was always an
 * unqualified "SUCCEEDED" once fanOutAttachments() itself didn't throw, regardless of whether individual
 * attachments' ingest or classify steps actually succeeded (2-of-3-classified mail read exactly like 3-of-3). */
export type FanoutStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

export interface FanoutSummary {
  status: FanoutStatus;
  /** Every attachment mail.ingest saw, SUCCEEDED and FAILED alike — attachments.length. */
  total: number;
  /** Failed at the mail.ingest stage itself (extraction failed or threw) — these never got an artifactId, so they
   * never even reach fanOutAttachments()/outcomes below. A real, distinct failure mode from a classify failure. */
  ingestFailed: number;
  /** Attachments whose classify step reached SUCCEEDED. */
  classified: number;
  /** Attachments that were ingested (have an artifactId) but whose classify step did NOT reach SUCCEEDED. */
  classificationFailed: number;
  /** Attachments for which invoice.extract actually ran and reached SUCCEEDED. */
  invoiceExtracted: number;
}

/**
 * Pure aggregate over mail.ingest's own `attachments[]` (every parsed attachment, ingest outcome included) and
 * this driver's own `outcomes` (one per successfully-ingested attachment, from fanOutAttachments() above) — no
 * I/O, so it is unit-testable under plain Node vitest even though the caller (deploy/cloudflare/apf-gateway/src/
 * index.ts's fanOutAttachmentsIfAny(), inside a Durable Object class importing "cloudflare:workers") is not.
 * `status` is SUCCEEDED only when every attachment ingested AND every classify step succeeded (ingestFailed===0
 * && classificationFailed===0 — equivalently classified===total); FAILED when literally everything failed
 * (classified===0 && total>0 — a caller whose own fanOutAttachments() call threw should treat that the same way,
 * that decision stays index.ts's job, not this function's); PARTIAL otherwise, the common real-world case.
 */
export function summarizeFanoutOutcomes(attachments: readonly MailIngestAttachmentOutcome[], outcomes: readonly AttachmentFanoutOutcome[]): FanoutSummary {
  const total = attachments.length;
  const ingestFailed = attachments.filter((a) => a.status === "FAILED").length;
  const classified = outcomes.filter((o) => o.classify.status === "SUCCEEDED").length;
  const classificationFailed = outcomes.length - classified;
  const invoiceExtracted = outcomes.filter((o) => o.extract?.status === "SUCCEEDED").length;

  const failed = ingestFailed + classificationFailed;
  const status: FanoutStatus = failed === 0 ? "SUCCEEDED" : total > 0 && failed === total ? "FAILED" : "PARTIAL";

  return { status, total, ingestFailed, classified, classificationFailed, invoiceExtracted };
}

export interface AttachmentFanoutOutcome {
  artifactId: string;
  classify: Instance;
  /** plan()'s own result over invoice.extract's produced keys for this one artifact. Absent only when classify
   * itself never reached SUCCEEDED — there is nothing meaningful to plan for an artifact with no classification. */
  plan?: PlanResult;
  /** Present only when plan() actually selected invoice.extract and this driver went on to start it. */
  extract?: Instance;
}

/**
 * True iff THIS attachment's own classify instance actually sealed the confirmed-INVOICE evidence — inspects
 * only whether the Žlab record exists (a key/producer/result-vocabulary check), never the classification VALUE
 * itself (documentType.value): the same key-level, never-value discipline planner.ts's own output is held to
 * (PLAN-005 — no business value ever crosses this boundary).
 *
 * Reads through EvidenceLedger.forCase() (docs/AUTONOMOUS-RUNTIME-V1.md część 2), not a plain forTenant() scan —
 * fixed 18.9.2026: this function used to scan every evidence record of the whole tenant, so a confirmed-INVOICE
 * record sealed for a DIFFERENT Case's attachment (same tenant, coincidentally the same workflowId scheme) could in
 * principle satisfy this check. forCase() only ever returns records whose originCaseId is this exact caseId (or
 * that are explicitly reusePolicy TENANT_WIDE, which document.classify's own evidence never is) — no defensive
 * guard is needed against a pre-migration (v2, no `subject`) record reaching the `.subject.key`/`.scope`/`.entityId`
 * access below either: EvidenceLedger.forCase()'s own filter (`r.originCaseId === caseId || r.reusePolicy ===
 * "TENANT_WIDE"`) can never admit such a record (both fields are `undefined` on a v2 row, and `undefined` can never
 * equal a real caseId or the literal string "TENANT_WIDE") — verified against evidence.ts's own append()/verify(),
 * fail-closed the same way the v1→v2 bump already was.
 *
 * P0 fact-scope-multi-doc pass (docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit — closes the "NESMÍ
 * se replikovat" gap part 7 of that document names): the match below is now entity-scoped
 * (`e.subject.scope === ATTACHMENT_ENTITY_SCOPE && e.subject.entityId === attachmentEntityId`), replacing the old
 * `e.workflowId === classifyWorkflowId` keying entirely. That old keying was a coincidence of "exactly one classify
 * sub-instance per attachment, no other producer of this evidence exists yet" holding true today — it would have
 * silently stopped disambiguating the moment ADR acceptance scenario C's shape (part 8: more than one document in
 * one Case, more than one classify-shaped producer eventually) needed a second, non-workflow-keyed way to seal this
 * same evidence key. A FactAddress (key+scope+entityId) is the primitive this was always supposed to be, per
 * contracts/facts.v1.json's own entities[0] declaration of impulse.attachment (M0-FACT-CONTRACT-V1.md część A,
 * krůček 1) — this fix is what finally uses it here instead of a side-channel identifier.
 */
function classifiedAsInvoice(evidence: EvidenceLedger, tenantId: string, caseId: string, attachmentEntityId: string): boolean {
  return evidence
    .forCase(tenantId, caseId)
    .some(
      (e: Evidence) =>
        e.producerId === CLASSIFY_PRODUCER_ID &&
        e.subject.key === CLASSIFY_INPUT_FIELD &&
        e.subject.scope === ATTACHMENT_ENTITY_SCOPE &&
        e.subject.entityId === attachmentEntityId &&
        e.result === CLASSIFY_INVOICE_RESULT,
    );
}

/**
 * Runs the classify → (plan →) extract sequence for every attachment, one pair of orchestrator instances per
 * artifact. One attachment's own failure never stops the others — same "best-effort per attachment" principle
 * mail-ingest's own handler already documents for attachment extraction.
 */
export async function fanOutAttachments(deps: AttachmentFanoutDeps, input: AttachmentFanoutInput): Promise<AttachmentFanoutOutcome[]> {
  const goal = [...(deps.catalog.flowOf("invoice.extract")?.produces ?? [])];
  const out: AttachmentFanoutOutcome[] = [];

  for (const { artifactId, entityId } of input.attachments) {
    const classifyStart = deps.classifyOrchestrator.start({ tenantId: input.tenantId, artifactId, caseId: input.caseId, attachmentEntityId: entityId }, input.correlationId);
    const classify = await deps.classifyOrchestrator.run(classifyStart.workflowId);

    if (classify.status !== "SUCCEEDED") {
      out.push({ artifactId, classify });
      continue;
    }

    const available = [DOCUMENT_ORIGINAL_KEY];
    if (classifiedAsInvoice(deps.evidence, input.tenantId, input.caseId, entityId)) available.push(INVOICE_CONFIRMED_EVIDENCE_KEY);

    // The single most important line in this file: whether invoice.extract runs next comes from actually calling
    // plan() and inspecting its returned status/steps — never from a shortcut such as
    // `if (classifiedAsInvoice(...)) startExtract()` that would bypass the FactCatalog entirely. Swapping in a
    // richer catalog later (more capabilities, more gates) changes this driver's behaviour with no code change
    // here (owner's explicit constraint, M0-FACT-CONTRACT-V1.md část C).
    const planResult: PlanResult = plan({ goal, available }, deps.catalog);
    const shouldExtract = planResult.status === "PLANNED" && planResult.steps.some((s) => s.capability === "invoice.extract");

    if (!shouldExtract) {
      out.push({ artifactId, classify, plan: planResult });
      continue;
    }

    const extractStart = deps.extractOrchestrator.start({ tenantId: input.tenantId, artifactId }, input.correlationId);
    const extract = await deps.extractOrchestrator.run(extractStart.workflowId);
    out.push({ artifactId, classify, plan: planResult, extract });
  }

  return out;
}
