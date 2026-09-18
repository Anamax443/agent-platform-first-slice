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
  /** mail.ingest's own attachmentArtifactIds[] payload field — unchanged by this commit. */
  attachmentArtifactIds: readonly string[];
  correlationId?: string;
}

/** Structural shape of mail.ingest's own `attachments[]` payload entries (src/components/mail-ingest/handler.ts's
 * exported `AttachmentOutcome`) — re-declared here rather than imported: platform/* stays free of a
 * src/components/* import (ARCH-DEP-001), the same discipline this file's own CLASSIFY_* constants above already
 * follow for their shared literals. Only the fields summarizeFanoutOutcomes() actually reads are kept. */
export interface MailIngestAttachmentOutcome {
  index: number;
  filename: string;
  contentType: string;
  status: "SUCCEEDED" | "FAILED";
  artifactId?: string;
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
 * True iff THIS classify instance actually sealed the confirmed-INVOICE evidence for this artifact — inspects
 * only whether the Žlab record exists (a key/producer/result-vocabulary check), never the classification VALUE
 * itself (documentType.value): the same key-level, never-value discipline planner.ts's own output is held to
 * (PLAN-005 — no business value ever crosses this boundary).
 */
function classifiedAsInvoice(evidence: EvidenceLedger, tenantId: string, classifyWorkflowId: string): boolean {
  return evidence
    .forTenant(tenantId)
    .some((e: Evidence) => e.workflowId === classifyWorkflowId && e.producerId === CLASSIFY_PRODUCER_ID && e.inputField === CLASSIFY_INPUT_FIELD && e.result === CLASSIFY_INVOICE_RESULT);
}

/**
 * Runs the classify → (plan →) extract sequence for every attachment, one pair of orchestrator instances per
 * artifact. One attachment's own failure never stops the others — same "best-effort per attachment" principle
 * mail-ingest's own handler already documents for attachment extraction.
 */
export async function fanOutAttachments(deps: AttachmentFanoutDeps, input: AttachmentFanoutInput): Promise<AttachmentFanoutOutcome[]> {
  const goal = [...(deps.catalog.flowOf("invoice.extract")?.produces ?? [])];
  const out: AttachmentFanoutOutcome[] = [];

  for (const artifactId of input.attachmentArtifactIds) {
    const classifyStart = deps.classifyOrchestrator.start({ tenantId: input.tenantId, artifactId }, input.correlationId);
    const classify = await deps.classifyOrchestrator.run(classifyStart.workflowId);

    if (classify.status !== "SUCCEEDED") {
      out.push({ artifactId, classify });
      continue;
    }

    const available = [DOCUMENT_ORIGINAL_KEY];
    if (classifiedAsInvoice(deps.evidence, input.tenantId, classify.workflowId)) available.push(INVOICE_CONFIRMED_EVIDENCE_KEY);

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
