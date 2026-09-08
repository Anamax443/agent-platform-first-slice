import type { AuditTrail } from "./audit.js";
import { sha256 } from "./artifacts.js";
import { canonicalize } from "./canonical.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import type { CredentialResolver } from "./credentials.js";
import { platformError, UnknownOutcomeError } from "./errors.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import type { Instance, StepRecord } from "./journal.js";
import type { Handler, HandlerInput, HandlerOutcome } from "./types.js";

/**
 * Result of resolving who owns the resource a write command targets (Posudek 5/6, W: resourceTenant
 * fail-open). `undefined` used to double as both "genuinely new resource" and "couldn't tell" —
 * an easy trap for a future handler to fall into silently. The four cases are now explicit and
 * FOUND is the only one that can pass without an owning tenant matching the context.
 */
export type ResourceTenantResult =
  | { kind: "FOUND"; tenantId: string }
  | { kind: "GLOBAL_RESOURCE" } // a brand-new resource: its tenant IS the trusted context, never the payload
  | { kind: "NOT_FOUND" } // the referenced resource does not exist
  | { kind: "UNRESOLVED" }; // ownership could not be established for any other reason

/** Test-harness only. Each flag removes one guard so the matching BLOCK test must fail (VERIFICATION-CONTRACT §6). */
export interface HostMutants {
  skipAllowlist?: boolean; // MUT-PRIV-001
  skipContextMatch?: boolean; // MUT-CTX-001
  skipDeadline?: boolean; // MUT-IDM-001
  skipIdempotencyStore?: boolean; // MUT-IDM-002
}

export type ReconcileResult =
  | { status: "SUCCEEDED"; payload: Record<string, unknown> }
  | { status: "FAILED" }
  | { status: "UNKNOWN" };

/** Orchestrator-facing reconciliation entry point. Opaque to the orchestrator (F3). */
export type Reconciler = (ref: string, step: StepRecord, instance: Instance) => Promise<ReconcileResult>;

export interface HostHandlerSpec {
  capability: string;
  handlerId: string;
  /** Tenant that owns the resource the command targets; compared with the trusted context (SEC-CTX-002). */
  resourceTenant: (payload: Record<string, unknown>) => ResourceTenantResult;
  /** Must be explicitly true for `resourceTenant` to be allowed to return `GLOBAL_RESOURCE` (a handler cannot opt itself in by returning the kind alone). */
  allowsGlobalResource?: boolean;
  run: Handler;
  /**
   * Domain part of unknownOutcomeRecovery (descriptor statusQuery): given the original command payload and the
   * idempotency key used as client reference, find out whether the side effect happened. Runs under the handler identity.
   */
  reconcile?: (input: { idempotencyKey: string; payload: Record<string, unknown> }) => Promise<ReconcileResult>;
}

const DEADLINE_TOLERANCE_MS = 30_000;
const SKEW_LOG_MS = 5_000;

/**
 * Executor Host, LOGICAL isolation (FOUNDATION-core §3.2, §3.3). Wraps write handlers with the decision chain:
 * allowlist -> context match -> deadline -> idempotency -> audit -> side effect -> audit -> reconciliation hook.
 * Schema, binding, scope and policy checks already happened in the router.
 */
export class ExecutorHost {
  private readonly handlers = new Map<string, HostHandlerSpec>();
  private readonly idempotency: IdempotencyStore;
  readonly mutants: HostMutants = {};
  readonly skewLog: Array<{ messageId: string; skewMs: number }> = [];

  constructor(
    private readonly opts: { hostId: string; clock: Clock; audit: AuditTrail; credentials: CredentialResolver; idempotency?: IdempotencyStore },
  ) {
    this.idempotency = opts.idempotency ?? new InMemoryIdempotencyStore();
  }

  private dedupKey(tenantId: string, handlerId: string, idempotencyKey: string): string {
    return `${tenantId} ${handlerId} ${idempotencyKey}`;
  }

  register(spec: HostHandlerSpec): void {
    this.handlers.set(spec.capability, spec);
  }

  capabilities(): string[] {
    return [...this.handlers.keys()];
  }

  /** Handler to register in the router for a capability of this host. */
  handlerFor(capability: string): Handler {
    return (input) => this.execute(capability, input);
  }

  /** Reconciler to register in the orchestrator for a capability of this host (§3.3 step 10, §5.1). */
  reconcilerFor(capability: string): Reconciler {
    return async (ref, step, instance) => {
      const spec = this.handlers.get(capability);
      if (!spec?.reconcile) return { status: "UNKNOWN" };
      const payload = step.message?.payload ?? {};
      const key = step.idempotencyKey;
      const reconcile = spec.reconcile;
      const r = await this.opts.credentials.runAs(spec.handlerId, () => reconcile({ idempotencyKey: key, payload }));
      const dedupKey = this.dedupKey(instance.tenantId, spec.handlerId, key);
      // The dedup record follows the now-known truth: SUCCEEDED stays deduplicated, a proven non-effect reopens the intent.
      if (r.status === "SUCCEEDED") await this.idempotency.resolve(dedupKey, { status: "SUCCEEDED", payload: r.payload });
      if (r.status === "FAILED") await this.idempotency.release(dedupKey);
      this.opts.audit.append({
        kind: "reconciliation",
        correlationId: step.message?.correlationId,
        workflowId: step.message?.workflowId,
        capability,
        details: { ref, idempotencyKey: key, result: r.status },
      });
      return r;
    };
  }

  /** Test evidence: what the host remembers for a tenant + capability + key (IDM tests). Not used by production paths. */
  async remembered(tenantId: string, capability: string, idempotencyKey: string): Promise<HandlerOutcome | undefined> {
    const spec = this.handlers.get(capability);
    if (!spec) return undefined;
    const record = await this.idempotency.peek(this.dedupKey(tenantId, spec.handlerId, idempotencyKey));
    return record?.status === "DONE" ? record.outcome : undefined;
  }

  private async execute(capability: string, input: HandlerInput): Promise<HandlerOutcome> {
    const { message, context } = input;
    const spec = this.handlers.get(capability);

    // §3.3 step 4: allowlist of the host
    if (!this.mutants.skipAllowlist && (!spec || message.capability !== capability)) {
      this.opts.audit.append({
        kind: "security",
        correlationId: message.correlationId,
        actorId: context.actorId,
        capability: message.capability,
        details: { code: "CAPABILITY_NOT_ALLOWED", host: this.opts.hostId },
      });
      return { status: "FAILED", error: platformError("CAPABILITY_NOT_ALLOWED", `host does not serve ${message.capability}`) };
    }
    if (!spec) return { status: "FAILED", error: platformError("CAPABILITY_NOT_ALLOWED", `host does not serve ${message.capability}`) };

    // §3.3 step 3: trusted context matches the targeted resource (Posudek 5/6: resourceTenant() used to
    // return bare `string | undefined`, where `undefined` meant both "genuinely new resource" and "couldn't
    // tell" — an easy trap for a future handler. The four cases below are explicit; only FOUND-with-match
    // and an explicitly opted-in GLOBAL_RESOURCE pass.
    if (!this.mutants.skipContextMatch) {
      const result = spec.resourceTenant(message.payload);
      if (result.kind === "FOUND" && result.tenantId !== context.tenantId) {
        this.opts.audit.append({
          kind: "security",
          correlationId: message.correlationId,
          actorId: context.actorId,
          capability,
          details: { code: "TENANT_SCOPE_MISMATCH", resourceTenant: result.tenantId, contextTenant: context.tenantId },
        });
        return { status: "FAILED", error: platformError("TENANT_SCOPE_MISMATCH", `resource belongs to ${result.tenantId}, context is ${context.tenantId}`) };
      }
      if (result.kind === "NOT_FOUND" || result.kind === "UNRESOLVED" || (result.kind === "GLOBAL_RESOURCE" && !spec.allowsGlobalResource)) {
        this.opts.audit.append({
          kind: "security",
          correlationId: message.correlationId,
          actorId: context.actorId,
          capability,
          details: { code: "RESOURCE_TENANT_UNRESOLVED", reason: result.kind, contextTenant: context.tenantId, artifactId: String((message.payload as { artifactId?: unknown } | undefined)?.artifactId ?? ""), messageId: message.messageId },
        });
        return { status: "FAILED", error: platformError("RESOURCE_TENANT_UNRESOLVED", `resource ownership could not be established (${result.kind})`) };
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
        this.opts.audit.append({
          kind: "deny",
          correlationId: message.correlationId,
          capability,
          details: { code: "COMMAND_EXPIRED", notValidAfter: message.notValidAfter, now: iso(this.opts.clock.now()) },
        });
        return { status: "FAILED", error: platformError("COMMAND_EXPIRED", `command expired at ${message.notValidAfter}`) };
      }
      if (overMs >= SKEW_LOG_MS) this.skewLog.push({ messageId: message.messageId, skewMs: overMs });
    }

    // §3.3 step 8: idempotency (one logical write intent), keyed by tenant + handler + client key (Posudek
    // 5/6, W19/W20): a host may serve more than one capability (document.stamp/archive share a host, each
    // with its own handlerId), and the same key reused with a different payload is a conflict, not a replay.
    const key = message.idempotencyKey;
    let dedupKey: string | undefined;
    if (key && !this.mutants.skipIdempotencyStore) {
      dedupKey = this.dedupKey(context.tenantId, spec.handlerId, key);
      const fingerprint = sha256(canonicalize(message.payload));
      const record = await this.idempotency.reserveOrGet(dedupKey, fingerprint);
      if (record) {
        if (record.status === "RESERVED") {
          this.opts.audit.append({ kind: "duplicate", correlationId: message.correlationId, capability, details: { idempotencyKey: key, code: "IDEMPOTENCY_IN_FLIGHT" } });
          return { status: "FAILED", error: platformError("IDEMPOTENCY_IN_FLIGHT", `another attempt for ${key} is still in flight`) };
        }
        if (record.fingerprint !== fingerprint) {
          this.opts.audit.append({ kind: "security", correlationId: message.correlationId, actorId: context.actorId, capability, details: { code: "IDEMPOTENCY_CONFLICT", idempotencyKey: key } });
          return { status: "FAILED", error: platformError("IDEMPOTENCY_CONFLICT", `idempotency key ${key} was already used with a different payload`) };
        }
        this.opts.audit.append({ kind: "duplicate", correlationId: message.correlationId, capability, details: { idempotencyKey: key } });
        return record.outcome as HandlerOutcome;
      }
    }

    // §3.3 step 9–10: side effect with audit before and after, under the handler's own credential identity
    this.opts.audit.append({
      kind: "write-intent",
      correlationId: message.correlationId,
      workflowId: message.workflowId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      capability,
      details: { idempotencyKey: key, messageId: message.messageId },
    });
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
    // releases the reservation so it remains retryable under the same key (technical retry). Finding for MEASUREMENT.md.
    if (dedupKey) {
      if (outcome.status === "SUCCEEDED" || outcome.status === "UNKNOWN_OUTCOME") await this.idempotency.resolve(dedupKey, outcome);
      else await this.idempotency.release(dedupKey);
    }
    this.opts.audit.append({
      kind: "write-done",
      correlationId: message.correlationId,
      workflowId: message.workflowId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      capability,
      details: { idempotencyKey: key, status: outcome.status },
    });
    return outcome;
  }
}
