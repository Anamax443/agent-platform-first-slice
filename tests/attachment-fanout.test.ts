// FANOUT family (owner's Commit 1, M0-FACT-CONTRACT-V1.md část C, 18.9.2026): src/platform/attachment-fanout.ts
// fans out over mail.ingest's attachments[], classifying each attachment on its own and asking
// planner.plan() — genuinely, never a hardcoded conditional — whether invoice.extract is next. Acceptance
// scenario exactly as the owner specified: one e-mail, three attachments (CONTRACT, INVOICE, a photo/OTHER).
import { describe, expect, it } from "vitest";
import { fanOutAttachments, summarizeFanoutOutcomes, type AttachmentFanoutAttachment, type AttachmentFanoutOutcome, type MailIngestAttachmentOutcome } from "../src/platform/attachment-fanout.js";
import type { Instance } from "../src/platform/journal.js";
import { plan } from "../src/platform/planner.js";
import { command, CONTRACT_CZ, createSlice, dispatch, INVOICE_CZ, NEWSLETTER, TENANT_A, type Slice } from "./harness/index.js";
import { realCatalog } from "./harness/facts.js";

/** Same "throw on a missing key" discipline as tests/harness/index.ts's own runScenario() — these two
 * orchestrators are always present (src/slice.ts builds one per entry of WORKFLOW_DEFINITIONS). */
function orchestratorOf(slice: Slice, name: string) {
  const o = slice.orchestrators[name];
  if (!o) throw new Error(`no orchestrator for workflow ${name}`);
  return o;
}

const CASE_A = "case-fanout-a";

// P0 fact-scope-multi-doc pass (docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit): runFanout() now
// takes the real {artifactId, entityId} pairs AttachmentFanoutInput.attachments needs, threaded from mail.ingest's
// own newEntityId() mint (handler.ts) via ingestThreeAttachments() below — never a synthetic id, since the whole
// point of this pass is that classifiedAsInvoice() disambiguates by THIS specific entityId, not by workflowId.
async function runFanout(slice: Slice, attachments: readonly AttachmentFanoutAttachment[]): Promise<AttachmentFanoutOutcome[]> {
  return fanOutAttachments(
    { classifyOrchestrator: orchestratorOf(slice, "attachment-classify"), extractOrchestrator: orchestratorOf(slice, "attachment-extract"), catalog: realCatalog(), evidence: slice.evidence },
    { tenantId: TENANT_A, caseId: CASE_A, attachments },
  );
}

const CRLF = "\r\n";

/** Same helper shape as tests/mime.test.ts's own multipart(): a top-level multipart/mixed message with a plain
 * body and N attachment parts, each `Content-Disposition: attachment` so mail-ingest's isTextish() fast path
 * decodes it directly (no extractor mock needed — the attachment text is exactly the fixture bytes). */
function multipart(boundary: string, parts: string[], topHeaders: string[] = []): string {
  const headers = [`Content-Type: multipart/mixed; boundary="${boundary}"`, ...topHeaders].join(CRLF);
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
  return `${headers}${CRLF}${CRLF}${body}`;
}

function attachmentPart(name: string, text: string): string {
  return `Content-Type: text/plain; name="${name}"${CRLF}Content-Disposition: attachment; filename="${name}"${CRLF}${CRLF}${text}`;
}

/** One e-mail, three attachments, in this exact order: a contract-like PDF stand-in, an invoice-like one, a
 * photo/newsletter stand-in with neither invoice nor contract markers. */
const THREE_ATTACHMENT_MAIL = multipart(
  "B-FANOUT",
  [
    `Content-Type: text/plain${CRLF}${CRLF}Viz přílohy, prosím zpracujte.`,
    attachmentPart("contract.txt", CONTRACT_CZ),
    attachmentPart("invoice.txt", INVOICE_CZ),
    attachmentPart("photo-caption.txt", NEWSLETTER),
  ],
  [`From: sender@example.com`, `Subject: Tři přílohy`],
);

async function ingestThreeAttachments() {
  const slice = createSlice();
  const result = await dispatch(slice, command(slice, { capability: "mail.ingest", payload: { rawMail: THREE_ATTACHMENT_MAIL, receivedFrom: "test-harness" } }));
  expect(result.status).toBe("SUCCEEDED");
  const attachmentArtifactIds = (result.payload as { attachmentArtifactIds: string[] }).attachmentArtifactIds;
  expect(attachmentArtifactIds).toHaveLength(3);
  // P0 fact-scope-multi-doc pass: the richer per-attachment view mail.ingest now carries (entityId alongside
  // artifactId, real — minted by handler.ts's newEntityId() — not a test-synthesized id), so callers build the
  // {artifactId, entityId} pairs fanOutAttachments() needs from live ingest output rather than a fresh id per test.
  const attachments = (result.payload as { attachments: AttachmentFanoutAttachment[] }).attachments;
  expect(attachments).toHaveLength(3);
  return { slice, attachmentArtifactIds, attachments };
}

describe("FANOUT-001 acceptance scenario: one e-mail, three attachments (CONTRACT, INVOICE, OTHER)", () => {
  it("the CONTRACT attachment classifies CONTRACT and invoice.extract never runs for it (hard regression, not a soft check)", async () => {
    const { slice, attachmentArtifactIds, attachments } = await ingestThreeAttachments();
    const [contractId] = attachmentArtifactIds;
    const outcomes = await runFanout(slice, attachments);
    const contract = outcomes.find((o) => o.artifactId === contractId);
    expect(contract?.classify.status).toBe("SUCCEEDED");
    const documentType = contract?.classify.steps.find((s) => s.stepId === "classify")?.result?.payload?.documentType as { value: string } | undefined;
    expect(documentType?.value).toBe("CONTRACT");
    expect(contract?.plan?.status).toBe("CAPABILITY_GAP");
    expect(contract?.extract).toBeUndefined();
    // System-state proof, not just the driver's own report: no attachment-extract instance was ever started for
    // this artifactId, and no evidence of a confirmed INVOICE was ever sealed for it.
    expect(slice.journal.list().filter((i) => i.workflow === "attachment-extract" && i.input.artifactId === contractId)).toHaveLength(0);
    expect(slice.evidence.forTenant(TENANT_A).some((e) => e.workflowId === contract?.classify.workflowId && e.result === "INVOICE")).toBe(false);
  });

  it("the OTHER (photo) attachment classifies OTHER and invoice.extract never runs for it either", async () => {
    const { slice, attachmentArtifactIds, attachments } = await ingestThreeAttachments();
    const [, , otherId] = attachmentArtifactIds;
    const outcomes = await runFanout(slice, attachments);
    const other = outcomes.find((o) => o.artifactId === otherId);
    expect(other?.classify.status).toBe("SUCCEEDED");
    const documentType = other?.classify.steps.find((s) => s.stepId === "classify")?.result?.payload?.documentType as { value: string } | undefined;
    expect(documentType?.value).toBe("OTHER");
    expect(other?.plan?.status).toBe("CAPABILITY_GAP");
    expect(other?.extract).toBeUndefined();
    expect(slice.journal.list().filter((i) => i.workflow === "attachment-extract" && i.input.artifactId === otherId)).toHaveLength(0);
  });

  it("the INVOICE attachment classifies INVOICE, seals confirmed-INVOICE evidence scoped to its own impulse.attachment entity, plan() actually selects invoice.extract, and it runs producing a derived artifact", async () => {
    const { slice, attachmentArtifactIds, attachments } = await ingestThreeAttachments();
    const [, invoiceId] = attachmentArtifactIds;
    const invoiceEntityId = attachments.find((a) => a.artifactId === invoiceId)?.entityId;
    expect(invoiceEntityId).toBeTruthy();
    const outcomes = await runFanout(slice, attachments);
    const invoice = outcomes.find((o) => o.artifactId === invoiceId);
    expect(invoice?.classify.status).toBe("SUCCEEDED");
    const documentType = invoice?.classify.steps.find((s) => s.stepId === "classify")?.result?.payload?.documentType as { value: string } | undefined;
    expect(documentType?.value).toBe("INVOICE");

    // Evidence actually sealed, tied to THIS artifact's own classify instance AND now — P0 fact-scope-multi-doc pass
    // — to a FactAddress scoped to its own impulse.attachment entity id, not the reserved case scope: this is the
    // primitive classifiedAsInvoice() reads to disambiguate, so pin its exact shape, not just the result string.
    const sealed = slice.evidence.forTenant(TENANT_A).find((e) => e.workflowId === invoice?.classify.workflowId && e.producerId === "document.classify");
    expect(sealed).toMatchObject({ inputField: `document.type@${invoiceEntityId}`, result: "INVOICE" });
    expect(sealed?.subject).toEqual({ key: "document.type", scope: "impulse.attachment", entityId: invoiceEntityId });

    // plan() genuinely returned PLANNED with invoice.extract among its steps — not assumed.
    expect(invoice?.plan?.status).toBe("PLANNED");
    if (invoice?.plan?.status === "PLANNED") expect(invoice.plan.steps.map((s) => s.capability)).toContain("invoice.extract");

    expect(invoice?.extract?.status).toBe("SUCCEEDED");
    const extractPayload = invoice?.extract?.steps.find((s) => s.stepId === "extract")?.result?.payload as
      | { extractedArtifactId: string; extractedSha256: string; companyId?: { value: string } }
      | undefined;
    expect(extractPayload?.extractedArtifactId).toBeTruthy();
    expect(extractPayload?.companyId?.value).toBe("12345678");
    const derived = slice.artifacts.get(extractPayload?.extractedArtifactId as string);
    expect(derived).toMatchObject({ derivedFrom: invoiceId, producer: "invoice-extractor", sha256: extractPayload?.extractedSha256 });
  });
});

// FANOUT-003 (P0 fact-scope-multi-doc pass, docs/AUTONOMOUS-RUNTIME-V1.md część 2, 18.9.2026 external audit): the
// concrete proof the audit itself asked for (Q3) — TWO invoice-like attachments in the SAME Case must each
// independently classify INVOICE, seal TWO DISTINCT evidence records (one per attachment's own entityId, never
// merged or confused), and each independently reach plan() PLANNED -> extract SUCCEEDED. Before this pass, both
// attachments' classify sub-instances would have had different workflowIds too (so the OLD keying happened to also
// disambiguate them) — this test's real job is pinning that disambiguation now comes from FactAddress/entityId, per
// contracts/facts.v1.json's own document.type.invoiceConfirmed scope, not from the coincidence of distinct
// workflowIds, which is what the ADR's own "NESMÍ se replikovat" line (część 7) is about.
const TWO_INVOICE_MAIL = multipart(
  "B-FANOUT-2",
  [`Content-Type: text/plain${CRLF}${CRLF}Dvě faktury, prosím zpracujte obě.`, attachmentPart("invoice-1.txt", INVOICE_CZ), attachmentPart("invoice-2.txt", INVOICE_CZ)],
  [`From: sender@example.com`, `Subject: Dvě faktury`],
);

describe("FANOUT-003 two INVOICE attachments in one Case classify and extract independently, each under its own entity id", () => {
  it("both seal their own distinct evidence record and both reach PLANNED -> extract SUCCEEDED", async () => {
    const slice = createSlice();
    const result = await dispatch(slice, command(slice, { capability: "mail.ingest", payload: { rawMail: TWO_INVOICE_MAIL, receivedFrom: "test-harness" } }));
    expect(result.status).toBe("SUCCEEDED");
    const attachments = (result.payload as { attachments: AttachmentFanoutAttachment[] }).attachments;
    expect(attachments).toHaveLength(2);
    const [invoiceOneId, invoiceTwoId] = attachments;
    // Two genuinely distinct entity ids — the whole disambiguation this pass adds is worthless if these collide.
    expect(invoiceOneId?.entityId).not.toBe(invoiceTwoId?.entityId);

    const outcomes = await runFanout(slice, attachments);
    expect(outcomes).toHaveLength(2);
    for (const own of [invoiceOneId, invoiceTwoId]) {
      const outcome = outcomes.find((o) => o.artifactId === own?.artifactId);
      expect(outcome?.classify.status).toBe("SUCCEEDED");
      const documentType = outcome?.classify.steps.find((s) => s.stepId === "classify")?.result?.payload?.documentType as { value: string } | undefined;
      expect(documentType?.value).toBe("INVOICE");
      expect(outcome?.plan?.status).toBe("PLANNED");
      expect(outcome?.extract?.status).toBe("SUCCEEDED");
    }

    // Two distinct sealed records, each carrying its own attachment's own entityId — never one record shared or
    // one attachment's evidence accidentally satisfying the other's classifiedAsInvoice() lookup.
    const sealedForInvoice1 = slice.evidence.forTenant(TENANT_A).find((e) => e.producerId === "document.classify" && e.subject.entityId === invoiceOneId?.entityId);
    const sealedForInvoice2 = slice.evidence.forTenant(TENANT_A).find((e) => e.producerId === "document.classify" && e.subject.entityId === invoiceTwoId?.entityId);
    expect(sealedForInvoice1?.recordId).toBeTruthy();
    expect(sealedForInvoice2?.recordId).toBeTruthy();
    expect(sealedForInvoice1?.recordId).not.toBe(sealedForInvoice2?.recordId);
    expect(sealedForInvoice1?.subject).toEqual({ key: "document.type", scope: "impulse.attachment", entityId: invoiceOneId?.entityId });
    expect(sealedForInvoice2?.subject).toEqual({ key: "document.type", scope: "impulse.attachment", entityId: invoiceTwoId?.entityId });
  });
});

describe("FANOUT-002 the driver's decision genuinely comes from plan(), not a hardcoded classify-then-extract pair", () => {
  it("plan() itself, called exactly as the driver calls it, refuses invoice.extract without the confirmed-INVOICE evidence", () => {
    const catalog = realCatalog();
    const goal = [...(catalog.flowOf("invoice.extract")?.produces ?? [])];
    expect(plan({ goal, available: ["document.original"] }, catalog).status).toBe("CAPABILITY_GAP");
  });
  it("and plans invoice.extract once that evidence is present — the same call, the same catalog, only `available` differs", () => {
    const catalog = realCatalog();
    const goal = [...(catalog.flowOf("invoice.extract")?.produces ?? [])];
    const r = plan({ goal, available: ["document.original", "document.type.invoiceConfirmed"] }, catalog);
    expect(r.status).toBe("PLANNED");
    if (r.status === "PLANNED") expect(r.steps.map((s) => s.capability)).toEqual(["invoice.extract"]);
  });
});

// FANOUT-SUMMARY (Commit 2B, 18.9.2026): summarizeFanoutOutcomes() is the pure aggregate the audit line at
// deploy/cloudflare/apf-gateway/src/index.ts's fanOutAttachmentsIfAny() now writes instead of a hardcoded
// unqualified "SUCCEEDED" — plain vitest, no Workers pool needed, because it takes data in and returns data out.
function ingested(index: number, artifactId: string): MailIngestAttachmentOutcome {
  return { index, filename: `a${index}`, contentType: "text/plain", status: "SUCCEEDED", artifactId };
}
function ingestFailure(index: number): MailIngestAttachmentOutcome {
  return { index, filename: `a${index}`, contentType: "application/pdf", status: "FAILED", errorCode: "EXTRACTION_FAILED" };
}
function classifyOutcome(artifactId: string, classifyStatus: Instance["status"], extractStatus?: Instance["status"]): AttachmentFanoutOutcome {
  const classify = { status: classifyStatus } as unknown as Instance;
  const extract = extractStatus === undefined ? undefined : ({ status: extractStatus } as unknown as Instance);
  return { artifactId, classify, extract };
}

describe("FANOUT-SUMMARY summarizeFanoutOutcomes() (Commit 2B)", () => {
  it("every attachment ingested and every classify succeeded -> SUCCEEDED", () => {
    const attachments = [ingested(0, "a0"), ingested(1, "a1")];
    const outcomes = [classifyOutcome("a0", "SUCCEEDED"), classifyOutcome("a1", "SUCCEEDED", "SUCCEEDED")];
    const summary = summarizeFanoutOutcomes(attachments, outcomes);
    expect(summary).toEqual({ status: "SUCCEEDED", total: 2, ingestFailed: 0, classified: 2, classificationFailed: 0, invoiceExtracted: 1 });
  });

  it("one ingest failure among three -> PARTIAL, ingestFailed counted, never reaches an outcome", () => {
    const attachments = [ingestFailure(0), ingested(1, "a1"), ingested(2, "a2")];
    const outcomes = [classifyOutcome("a1", "SUCCEEDED"), classifyOutcome("a2", "SUCCEEDED")];
    const summary = summarizeFanoutOutcomes(attachments, outcomes);
    expect(summary).toEqual({ status: "PARTIAL", total: 3, ingestFailed: 1, classified: 2, classificationFailed: 0, invoiceExtracted: 0 });
  });

  it("one classify failure among otherwise-successful ingests -> PARTIAL", () => {
    const attachments = [ingested(0, "a0"), ingested(1, "a1")];
    const outcomes = [classifyOutcome("a0", "SUCCEEDED"), classifyOutcome("a1", "FAILED")];
    const summary = summarizeFanoutOutcomes(attachments, outcomes);
    expect(summary).toEqual({ status: "PARTIAL", total: 2, ingestFailed: 0, classified: 1, classificationFailed: 1, invoiceExtracted: 0 });
  });

  it("everything failing (ingest and classify alike) -> FAILED", () => {
    const attachments = [ingestFailure(0), ingested(1, "a1")];
    const outcomes = [classifyOutcome("a1", "FAILED")];
    const summary = summarizeFanoutOutcomes(attachments, outcomes);
    expect(summary).toEqual({ status: "FAILED", total: 2, ingestFailed: 1, classified: 0, classificationFailed: 1, invoiceExtracted: 0 });
  });

  it("no attachments at all -> vacuously SUCCEEDED, zero everywhere", () => {
    expect(summarizeFanoutOutcomes([], [])).toEqual({ status: "SUCCEEDED", total: 0, ingestFailed: 0, classified: 0, classificationFailed: 0, invoiceExtracted: 0 });
  });
});
