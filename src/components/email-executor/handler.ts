// email.send/1: single-purpose write executor (MEDIUM, PRINCIPAL). Accepts a recipient reference from the platform
// allowlist and a template id; never an address, never free text (FOUNDATION-core §3.4, example 6.3).
import type { SmtpAdapter } from "../../adapters/smtp.js";
import { capabilityError, UnknownOutcomeError } from "../../platform/api.js";
import type { ArtifactReader, Clock, CredentialAccess, HandlerOutcome, HostHandlerSpec, ReconcileResult } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };

export { descriptor, inputSchema };

export const SMTP_CREDENTIAL = "cred:smtp";
export const SEND_HANDLER_ID = "email-send-handler";

/** Authority: the recipient allowlist of the platform policy (ADR-016), resolved per tenant. */
export type RecipientDirectory = (tenantId: string, recipientRef: string) => string | undefined;

export interface EmailDeps {
  artifacts: ArtifactReader;
  smtp: SmtpAdapter;
  credentials: CredentialAccess;
  recipients: RecipientDirectory;
  clock: Clock;
}

interface Input {
  recipientRef: string;
  templateId: "document-stamped" | "document-rejected";
  params: { documentType: string; artifactId: string };
}

/** Templates are fixed text with enum/id slots; untrusted document content never reaches an outgoing mail. */
const TEMPLATES: Record<Input["templateId"], (p: Input["params"]) => { subject: string; body: string }> = {
  "document-stamped": (p) => ({ subject: `Document stamped: ${p.documentType}`, body: `Artifact ${p.artifactId} was validated as ${p.documentType} and stamped.` }),
  "document-rejected": (p) => ({ subject: `Document needs review: ${p.documentType}`, body: `Artifact ${p.artifactId} (${p.documentType}) was not stamped and waits for review.` }),
};

export function createEmailSendHandler(deps: EmailDeps): HostHandlerSpec {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  const payloadFor = (p: Input, smtpMessageId: string) => ({ recipientRef: p.recipientRef, templateId: p.templateId, smtpMessageId });

  return {
    capability: "email.send",
    handlerId: SEND_HANDLER_ID,
    resourceTenant: (payload) => deps.artifacts.get(String((payload.params as { artifactId?: string } | undefined)?.artifactId ?? ""))?.tenantId,

    run: async ({ message, context }) => {
      const p = message.payload as unknown as Input;
      const art = deps.artifacts.get(p.params.artifactId);
      if (!art) return failed(capabilityError("ARTIFACT_NOT_FOUND", "BUSINESS", false, "referenced artifact not found", { artifactId: p.params.artifactId }));
      const to = deps.recipients(context.tenantId, p.recipientRef);
      if (!to) return failed(capabilityError("RECIPIENT_NOT_ALLOWED", "POLICY", false, "recipient reference is not in the tenant allowlist", { recipientRef: p.recipientRef }));
      const rendered = TEMPLATES[p.templateId](p.params);
      const credential = deps.credentials.resolve(SMTP_CREDENTIAL);
      let out: { messageId: string };
      try {
        out = await deps.smtp.send({ to, subject: rendered.subject, body: rendered.body, clientRef: message.idempotencyKey as string }, credential);
      } catch (e) {
        if (e instanceof UnknownOutcomeError || (e as Error).name === "ProcessCrash") throw e;
        return failed(capabilityError("SMTP_REJECTED", "DEPENDENCY", true, "mail provider rejected the message"));
      }
      return {
        status: "SUCCEEDED",
        payload: payloadFor(p, out.messageId),
        provenance: { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion, derivedFrom: [art.artifactId] },
      };
    },

    /** unknownOutcomeRecovery = query-external-status by client reference; never send again. */
    reconcile: async ({ idempotencyKey, payload }): Promise<ReconcileResult> => {
      const p = payload as unknown as Input;
      const status = await deps.smtp.status(idempotencyKey);
      if (status === "UNKNOWN") return { status: "UNKNOWN" };
      if (status === "NOT_FOUND") return { status: "FAILED" };
      const sent = await deps.smtp.read(idempotencyKey);
      return sent ? { status: "SUCCEEDED", payload: payloadFor(p, sent.messageId) } : { status: "UNKNOWN" };
    },
  };
}
