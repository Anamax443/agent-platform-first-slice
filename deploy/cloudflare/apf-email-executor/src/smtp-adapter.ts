// Live SmtpAdapter over Cloudflare's native Email Sending binding (SEND_MODE=live). Workers-specific (the
// `SendEmail` binding type), so it stays here rather than src/adapters/smtp.ts — the root tsconfig has no
// @cloudflare/workers-types, only deploy/cloudflare/tsconfig.json does.
import type { SmtpAdapter } from "../../../../src/adapters/smtp.js";

/**
 * Cloudflare's native Email Sending API has no query-by-reference call (confirmed against the current API surface,
 * not assumed) — there is no way to ask "did clientRef X already send". status()/read() are therefore always
 * UNKNOWN/undefined: a crash between "send succeeded" and the local idempotency ledger recording it cannot be
 * resolved by asking the real provider, unlike HttpDmsAdapter.status() against apf-fakes. Documented limitation,
 * not hidden — the risk is a duplicate low-stakes notification email, never a duplicate financial/document write.
 * SEND_MODE stays "sandbox" (FakeSmtpAdapter) until this is explicitly accepted for a live installation.
 */
export class CloudflareSmtpAdapter implements SmtpAdapter {
  constructor(
    private readonly email: SendEmail,
    private readonly fromAddress: string,
    private readonly fromName: string,
  ) {}

  // credential is unused by design: the send_email binding itself is the authorization (PRINCIPAL, "Secrets: none"
  // in wrangler.jsonc) — there is no separate secret value to check the way FakeSmtpAdapter checks one in tests.
  async send(input: { to: string; subject: string; body: string; clientRef: string }, _credential: string): Promise<{ messageId: string }> {
    const response = await this.email.send({
      to: input.to,
      from: { email: this.fromAddress, name: this.fromName },
      subject: input.subject,
      text: input.body,
    });
    return { messageId: response.messageId };
  }

  async status(): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN"> {
    return "UNKNOWN";
  }

  async read(): Promise<{ messageId: string; to: string } | undefined> {
    return undefined;
  }
}
