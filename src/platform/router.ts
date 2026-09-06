import type { AuditTrail } from "./audit.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";
import { platformError } from "./errors.js";
import { checkGrant, type Policy } from "./policy.js";
import { compileSchema, validateContract, type Validation } from "./schemas.js";
import { verifyBinding, type KeyRegistry } from "./signing.js";
import type { DispatchEnvelope, ErrorObject, Handler, HandlerOutcome, ResultEnvelope } from "./types.js";

export interface ProvidedCapability {
  name: string;
  version: string;
  inputSchema: object;
  handler: Handler;
}

export interface RegisteredComponent {
  descriptor: Record<string, unknown> & { module: string };
  policies: Record<string, Policy>;
  capabilities: ProvidedCapability[];
}

interface Resolved {
  component: RegisteredComponent;
  capability: ProvidedCapability;
  validateInput: (data: unknown) => Validation;
}

/**
 * Capability Router (FOUNDATION-core §2, §3.3 steps 1–5): schema -> binding -> context expiry ->
 * scope -> tenant/policy -> input schema -> handler. Any DENY ends before the handler and is audited.
 */
export class Router {
  private readonly resolved: Resolved[] = [];
  /** Every message that reached the router, for tests such as SEC-INJ-001 ("no email.send was ever dispatched"). */
  readonly seen: DispatchEnvelope[] = [];

  /** Binding mechanisms this receiver accepts. "in-process" only when message and context provably never left the process (SEC-CTX-005). */
  private readonly acceptedMechanisms: string[];

  constructor(private readonly opts: { registry: KeyRegistry; clock: Clock; audit: AuditTrail; acceptedMechanisms?: string[] }) {
    this.acceptedMechanisms = opts.acceptedMechanisms ?? ["signed-envelope"];
  }

  register(component: RegisteredComponent): void {
    const v = validateContract("module-descriptor", component.descriptor);
    if (!v.ok) throw new Error(`descriptor of ${component.descriptor.module} invalid: ${v.errors}`);
    for (const cap of component.capabilities) {
      if (!component.policies[cap.name]) throw new Error(`no policy registered for ${cap.name} (fail-closed)`);
      this.resolved.push({ component, capability: cap, validateInput: compileSchema(cap.inputSchema) });
    }
  }

  providers(): string[] {
    return this.resolved.map((r) => `${r.capability.name}/v${r.capability.version}@${r.component.descriptor.module}`);
  }

  async route(env: DispatchEnvelope): Promise<ResultEnvelope> {
    this.seen.push(env);
    const { message, context } = env;
    const now = iso(this.opts.clock.now());

    const schema = validateContract("dispatch-envelope", env);
    if (!schema.ok) return this.deny(env, platformError("SCHEMA_VALIDATION_FAILED", "dispatch envelope invalid", { errors: schema.errors }));

    if (!this.acceptedMechanisms.includes(env.binding.mechanism)) {
      return this.deny(env, platformError("CONTEXT_BINDING_INVALID", `binding mechanism ${env.binding.mechanism} not accepted by this receiver`));
    }
    const binding = verifyBinding(env, this.opts.registry, now);
    if (!binding.ok) return this.deny(env, platformError("CONTEXT_BINDING_INVALID", binding.reason));

    if (context.expiresAt < now) return this.deny(env, platformError("CONTEXT_EXPIRED", `context expired at ${context.expiresAt}`));

    if (!scopeAllows(context.scopes, message.capability)) {
      return this.deny(env, platformError("CAPABILITY_NOT_ALLOWED", `actor ${context.actorId} has no scope ${message.capability}`));
    }

    const byName = this.resolved.filter((r) => r.capability.name === message.capability);
    if (byName.length === 0) return this.deny(env, platformError("CAPABILITY_NOT_ALLOWED", `no provider for ${message.capability}`));
    const target = byName.find((r) => r.capability.version === message.capabilityVersion);
    if (!target) {
      return this.deny(env, platformError("INCOMPATIBLE_VERSION", `no provider for ${message.capability}/v${message.capabilityVersion}`, {
        available: byName.map((r) => r.capability.version),
      }));
    }

    const policy = target.component.policies[message.capability] as Policy;
    const grant = checkGrant(policy, context, message.capability);
    if (!grant.ok) return this.deny(env, platformError(grant.code, `policy ${policy.policyRef} denies ${context.actorId} for tenant ${context.tenantId}`));

    const input = target.validateInput(message.payload);
    if (!input.ok) return this.deny(env, platformError("SCHEMA_VALIDATION_FAILED", `payload does not match ${message.capability} input schema`, { errors: input.errors }));

    const routedContext = { ...context, targetComponent: target.component.descriptor.module };
    const executionId = newId("exe");
    this.opts.audit.append({
      kind: "dispatch",
      correlationId: message.correlationId,
      workflowId: message.workflowId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      capability: message.capability,
      details: { messageId: message.messageId, executionId, target: routedContext.targetComponent },
    });

    let outcome: HandlerOutcome;
    try {
      outcome = await target.capability.handler({ message, context: routedContext });
    } catch (e) {
      if ((e as Error).name === "ProcessCrash") throw e; // the process is gone; nothing gets recorded (RES-CRASH-001)
      outcome = { status: "FAILED", error: platformError("HANDLER_CRASHED", (e as Error).message) };
    }
    return this.finish(env, outcome, executionId);
  }

  private deny(env: DispatchEnvelope, error: ErrorObject): ResultEnvelope {
    this.opts.audit.append({
      kind: "deny",
      correlationId: env.message.correlationId,
      workflowId: env.message.workflowId,
      tenantId: env.context.tenantId,
      actorId: env.context.actorId,
      capability: env.message.capability,
      details: { code: error.code, message: error.message },
    });
    if (error.class === "SECURITY") {
      this.opts.audit.append({ kind: "security", correlationId: env.message.correlationId, actorId: env.context.actorId, details: { code: error.code } });
    }
    return this.finish(env, { status: "FAILED", error }, undefined);
  }

  private finish(env: DispatchEnvelope, outcome: HandlerOutcome, executionId: string | undefined): ResultEnvelope {
    const m = env.message;
    const res: ResultEnvelope = {
      messageId: newId("res"),
      inReplyTo: m.messageId,
      correlationId: m.correlationId,
      status: outcome.status,
      capability: m.capability,
      capabilityVersion: m.capabilityVersion,
      schemaVersion: m.schemaVersion,
      completedAt: iso(this.opts.clock.now()),
    };
    if (m.workflowId) res.workflowId = m.workflowId;
    if (m.stepId) res.stepId = m.stepId;
    if (executionId) res.executionId = executionId;
    switch (outcome.status) {
      case "SUCCEEDED":
        res.payload = outcome.payload;
        if (outcome.provenance) res.provenance = outcome.provenance;
        break;
      case "FAILED":
        res.error = outcome.error;
        break;
      case "WAITING":
        res.waitReason = outcome.waitReason;
        res.deadline = outcome.deadline;
        if (outcome.reviewTaskId) res.reviewTaskId = outcome.reviewTaskId;
        if (outcome.payload) res.payload = outcome.payload;
        break;
      case "UNKNOWN_OUTCOME":
        res.reconciliationRef = outcome.reconciliationRef;
        break;
    }
    const v = validateContract("result-envelope", res);
    if (!v.ok) throw new Error(`router produced an invalid result envelope: ${v.errors}`);
    return res;
  }
}

export function scopeAllows(scopes: string[], capability: string): boolean {
  return scopes.some((s) => s === capability || (s.endsWith(".*") && capability.startsWith(s.slice(0, -1))));
}
