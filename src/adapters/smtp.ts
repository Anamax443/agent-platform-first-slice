import { UnknownOutcomeError } from "../platform/errors.js";

/**
 * SMTP adapter: the external system email.send writes into. `clientRef` (= idempotency key) is the business identity of
 * the message: a real provider keeps it as Message-ID / idempotency header, so a resend with the same reference is not a
 * second delivery (IRREVERSIBLE capability, IDM-RET-002).
 */
export interface SmtpAdapter {
  send(input: { to: string; subject: string; body: string; clientRef: string }, credential: string): Promise<{ messageId: string }>;
  status(clientRef: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN">;
  read(clientRef: string): Promise<{ messageId: string; to: string } | undefined>;
}

export type SmtpMode = "ok" | "unknown-once" | "unknown-always" | "reject";
export type SmtpStatusMode = "ok" | "unknown";

export class FakeSmtpAdapter implements SmtpAdapter {
  /** Deliveries that actually happened. */
  sendCalls = 0;
  /** Resends with a known clientRef, suppressed by the provider (business identity). */
  duplicatesSuppressed = 0;
  readonly sent = new Map<string, { messageId: string; to: string; subject: string; body: string }>();
  private thrownOnce = false;
  constructor(
    public mode: SmtpMode = "ok",
    public statusMode: SmtpStatusMode = "ok",
    private readonly expectedCredential = "smtp-secret",
  ) {}

  async send(input: { to: string; subject: string; body: string; clientRef: string }, credential: string): Promise<{ messageId: string }> {
    if (credential !== this.expectedCredential) throw new Error("SMTP authentication failed");
    if (this.mode === "reject") throw new Error("550 mailbox unavailable");
    const existing = this.sent.get(input.clientRef);
    if (existing) {
      this.duplicatesSuppressed += 1;
      return { messageId: existing.messageId };
    }
    this.sendCalls += 1;
    const messageId = `smtp-${this.sendCalls}`;
    this.sent.set(input.clientRef, { messageId, to: input.to, subject: input.subject, body: input.body }); // the side effect happened
    if (this.mode === "unknown-once" && !this.thrownOnce) {
      this.thrownOnce = true;
      throw new UnknownOutcomeError(input.clientRef);
    }
    if (this.mode === "unknown-always") throw new UnknownOutcomeError(input.clientRef);
    return { messageId };
  }

  async status(clientRef: string): Promise<"DONE" | "NOT_FOUND" | "UNKNOWN"> {
    if (this.statusMode === "unknown") return "UNKNOWN";
    return this.sent.has(clientRef) ? "DONE" : "NOT_FOUND";
  }

  async read(clientRef: string): Promise<{ messageId: string; to: string } | undefined> {
    const s = this.sent.get(clientRef);
    return s ? { messageId: s.messageId, to: s.to } : undefined;
  }

  /** Every address that ever received a message: SEC-INJ-001 asserts it stays inside the allowlist. */
  recipients(): string[] {
    return [...this.sent.values()].map((s) => s.to);
  }
}
