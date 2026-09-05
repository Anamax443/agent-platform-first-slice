import type { Audit } from "./audit.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import type { CredentialResolver } from "./credentials.js";
import { platformError, UnknownOutcomeError } from "./errors.js";
import type { Handler, HandlerInput, HandlerOutcome } from "./types.js";

/** Test-harness only. Each flag removes one guard so the matching BLOCK test must fail (VERIFICATION-CONTRACT §6). */
export interface HostMutants {
  skipAllowlist?: boolean; // MUT-PRIV-001
  skipContextMatch?: boolean; // MUT-CTX-001
  skipDeadline?: boolean; // MUT-IDM-001
  skipIdempotencyStore?: boolean; // MUT-IDM-002
}

export interface HostHandlerSpec {
  capability: string;
  handlerId: string;
  /** Tenant that owns the resource the command targets; compared with the trusted context (SEC-CTX-002). */
  resourceTenant: (payload: Record<string, unknown>) => string | undefined;
  run: Handler;
}

const DEADLINE_TOLERANCE_MS = 30_000;
const SKEW_LOG_MS = 5_000;

/**
 * Executor Host, LOGICAL isolation (FOUNDATION-core §3.2, §3.3). Wraps write handlers with the decision chain:
 * allowlist -> context match -> deadline -> idempotency -> audit -> side effect -> audit.
 * Schema, binding, scope and policy checks already happened in the router.
 */
export class ExecutorHost {
  private readonly handlers = new Map<string, HostHandlerSpec>();
  private readonly idempotency = new Map<string, HandlerOutcome>();
  readonly mutants: HostMutants = {};
  readonly skewLog: Array<{ messageId: string; skewMs: number }> = [];

  constructor(private readonly opts: { clock: Clock; audit: Audit; credentials: CredentialResolver }) {}

  register(spec: HostHandlerSpec): void {
    this.handlers.set(spec.capability, spec);
  }

  /** Handler to register in the router for a capability of this host. */
  handlerFor(capability: string): Handler {
    return (input) => this.execute(capability, input);
  }

  private async execute(capability: string, input: HandlerInput): Promise<HandlerOutcome> {
    const { message, context } = input;
    const spec = this.handlers.get(capability);

    // §3.3 step 4: allowlist of the host
    if (!this.mutants.skipAllowlist && (!spec || message.capability !== capability)) {
      return { status: "FAILED", error: platformError("CAPABILITY_NOT_ALLOWED", `host does not serve ${message.capability}`) };
    }
    if (!spec) return { status: "FAILED", error: platformError("CAPABILITY_NOT_ALLOWED", `host does not serve ${message.capability}`) };

    // §3.3 step 3: trusted context matches the targeted resource
    if (!this.mutants.skipContextMatch) {
      const owner = spec.resourceTenant(message.payload);
      if (owner !== undefined && owner !== context.tenantId) {
        this.opts.audit.append({ kind: "security", correlationId: message.correlationId, actorId: context.actorId, capability, details: { code: "TENANT_SCOPE_MISMATCH", resourceTenant: owner, contextTenant: context.tenantId } });
        return { status: "FAILED", error: platformError("TENANT_SCOPE_MISMATCH", `resource belongs to ${owner}, context is ${context.tenantId}`) };
      }
    }

    // §3.3 step 7: deadline, checked immediately before the side effect, with clock tolerance (§5.4)
    if (!this.mutants.skipDeadline) {
      if (!message.notValidAfter) {
        return { status: "FAILED", error: platformError("SCHEMA_VALIDATION_FAILED", "write command without notValidAfter") };
      }
      const nowMs = this.opts.clock.now().getTime();
      const overMs = nowMs - Date.parse(message.notValidAfter);
      if (overMs > DEADLINE_TOLERANCE_MS) {
        this.opts.audit.append({ kind: "deny", correlationId: message.correlationId, capability, details: { code: "COMMAND_EXPIRED", notValidAfter: message.notValidAfter, now: iso(this.opts.clock.now()) } });
        return { status: "FAILED", error: platformError("COMMAND_EXPIRED", `command expired at ${message.notValidAfter}`) };
      }
      if (overMs > SKEW_LOG_MS) this.skewLog.push({ messageId: message.messageId, skewMs: overMs });
    }

    // §3.3 step 8: idempotency (one logical write intent)
    const key = message.idempotencyKey;
    if (key && this.idempotency.has(key)) {
      this.opts.audit.append({ kind: "duplicate", correlationId: message.correlationId, capability, details: { idempotencyKey: key } });
      return this.idempotency.get(key) as HandlerOutcome;
    }

    // §3.3 step 9–10: side effect with audit before and after, under the handler's own credential identity
    this.opts.audit.append({ kind: "write-intent", correlationId: message.correlationId, workflowId: message.workflowId, tenantId: context.tenantId, actorId: context.actorId, capability, details: { idempotencyKey: key, messageId: message.messageId } });
    let outcome: HandlerOutcome;
    try {
      outcome = await this.opts.credentials.runAs(spec.handlerId, () => spec.run(input));
    } catch (e) {
      if (e instanceof UnknownOutcomeError) {
        outcome = { status: "UNKNOWN_OUTCOME", reconciliationRef: e.reconciliationRef };
      } else if ((e as Error).name === "ProcessCrash") {
        throw e;
      } else if ((e as Error).name === "CredentialDenied") {
        outcome = { status: "FAILED", error: platformError("CREDENTIAL_DENIED", (e as Error).message) };
      } else {
        outcome = { status: "FAILED", error: platformError("HANDLER_CRASHED", (e as Error).message) };
      }
    }
    // Only outcomes that may have produced a side effect are deduplicated. A FAILED before the side effect
    // must remain retryable under the same key (technical retry). Finding for MEASUREMENT.md.
    if (key && !this.mutants.skipIdempotencyStore && (outcome.status === "SUCCEEDED" || outcome.status === "UNKNOWN_OUTCOME")) {
      this.idempotency.set(key, outcome);
    }
    this.opts.audit.append({ kind: "write-done", correlationId: message.correlationId, workflowId: message.workflowId, tenantId: context.tenantId, actorId: context.actorId, capability, details: { idempotencyKey: key, status: outcome.status } });
    return outcome;
  }
}
