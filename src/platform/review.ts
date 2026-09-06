import type { AuditTrail } from "./audit.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";

export type Decision = "APPROVE" | "CORRECT" | "REJECT" | "RECLASSIFY";
export type ExpiryPolicy = "EXPIRE_TO_FAILED" | "EXPIRE_TO_CANCELLED" | "ESCALATE" | "CREATE_NEW_REVIEW";

export interface ReviewTask {
  reviewTaskId: string;
  workflowId: string;
  correlationId?: string;
  stepId: string;
  tenantId: string;
  reasonCode: string;
  requiredRole: string;
  allowedDecisions: Decision[];
  currentValue?: unknown;
  alternatives?: unknown[];
  createdAt: string;
  expiresAt: string;
  expiryPolicy: ExpiryPolicy;
  escalateTo?: string;
  escalationDepth: number;
  maxEscalationDepth: number;
  status: "OPEN" | "DECIDED" | "EXPIRED" | "ESCALATED";
  decision?: { actorId: string; role: string; decision: Decision; correction?: Record<string, unknown>; at: string };
}

export interface CreateTask {
  workflowId: string;
  correlationId?: string;
  stepId: string;
  tenantId: string;
  reasonCode: string;
  requiredRole: string;
  allowedDecisions: Decision[];
  expiresInMs: number;
  expiryPolicy: ExpiryPolicy;
  escalateTo?: string;
  maxEscalationDepth?: number;
  currentValue?: unknown;
  alternatives?: unknown[];
}

export type DecisionResult =
  | { ok: true; task: ReviewTask }
  | { ok: false; code: "APPROVAL_MISMATCH" | "TENANT_SCOPE_MISMATCH" | "REVIEW_EXPIRED" };

export interface ExpiryTransition {
  reviewTaskId: string;
  transition: "FAILED" | "CANCELLED" | "ESCALATED" | "NEW_REVIEW" | "FAILED_MAX_ESCALATION";
  newTaskId?: string;
}

/** Review Service (FOUNDATION-core §5.8, F7): decisions are authorized, audited state transitions. */
export class ReviewService {
  private readonly tasks = new Map<string, ReviewTask>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {}

  create(input: CreateTask): ReviewTask {
    if (input.expiryPolicy === "ESCALATE" && !input.escalateTo) throw new Error("expiryPolicy ESCALATE requires escalateTo");
    const now = this.clock.now();
    const task: ReviewTask = {
      reviewTaskId: newId("rev"),
      workflowId: input.workflowId,
      stepId: input.stepId,
      tenantId: input.tenantId,
      reasonCode: input.reasonCode,
      requiredRole: input.requiredRole,
      allowedDecisions: [...input.allowedDecisions],
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + input.expiresInMs)),
      expiryPolicy: input.expiryPolicy,
      escalationDepth: 0,
      maxEscalationDepth: input.maxEscalationDepth ?? 2,
      status: "OPEN",
    };
    if (input.correlationId) task.correlationId = input.correlationId;
    if (input.escalateTo) task.escalateTo = input.escalateTo;
    if (input.currentValue !== undefined) task.currentValue = input.currentValue;
    if (input.alternatives) task.alternatives = [...input.alternatives];
    this.tasks.set(task.reviewTaskId, task);
    this.audit.append({
      kind: "review-created",
      workflowId: task.workflowId,
      correlationId: task.correlationId,
      tenantId: task.tenantId,
      details: { reviewTaskId: task.reviewTaskId, reasonCode: task.reasonCode, requiredRole: task.requiredRole, expiresAt: task.expiresAt },
    });
    return { ...task };
  }

  get(id: string): ReviewTask | undefined {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : undefined;
  }

  open(): ReviewTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "OPEN").map((t) => structuredClone(t));
  }

  decide(id: string, by: { actorId: string; role: string; tenantId: string; decision: Decision; correction?: Record<string, unknown> }): DecisionResult {
    const task = this.tasks.get(id);
    if (!task) return { ok: false, code: "APPROVAL_MISMATCH" };
    if (task.tenantId !== by.tenantId) {
      this.audit.append({ kind: "security", tenantId: by.tenantId, actorId: by.actorId, correlationId: task.correlationId, details: { code: "TENANT_SCOPE_MISMATCH", reviewTaskId: id, taskTenant: task.tenantId } });
      return { ok: false, code: "TENANT_SCOPE_MISMATCH" };
    }
    if (task.status !== "OPEN") return { ok: false, code: "REVIEW_EXPIRED" };
    if (task.requiredRole !== by.role || !task.allowedDecisions.includes(by.decision)) {
      this.audit.append({ kind: "security", tenantId: by.tenantId, actorId: by.actorId, correlationId: task.correlationId, details: { code: "APPROVAL_MISMATCH", reviewTaskId: id, role: by.role, decision: by.decision } });
      return { ok: false, code: "APPROVAL_MISMATCH" };
    }
    task.status = "DECIDED";
    task.decision = { actorId: by.actorId, role: by.role, decision: by.decision, at: iso(this.clock.now()) };
    if (by.correction) task.decision.correction = { ...by.correction };
    this.audit.append({
      kind: "review-decision",
      workflowId: task.workflowId,
      correlationId: task.correlationId,
      tenantId: task.tenantId,
      actorId: by.actorId,
      details: { reviewTaskId: id, role: by.role, decision: by.decision, originalValue: task.currentValue ?? null, correction: by.correction ?? null },
    });
    return { ok: true, task: structuredClone(task) };
  }

  /** Apply expiry policies to every open task whose deadline passed (WF-REV-003). Never "nothing happens". */
  expire(): ExpiryTransition[] {
    const now = iso(this.clock.now());
    const out: ExpiryTransition[] = [];
    for (const task of [...this.tasks.values()]) {
      if (task.status !== "OPEN" || task.expiresAt > now) continue;
      switch (task.expiryPolicy) {
        case "EXPIRE_TO_FAILED":
          task.status = "EXPIRED";
          out.push({ reviewTaskId: task.reviewTaskId, transition: "FAILED" });
          break;
        case "EXPIRE_TO_CANCELLED":
          task.status = "EXPIRED";
          out.push({ reviewTaskId: task.reviewTaskId, transition: "CANCELLED" });
          break;
        case "CREATE_NEW_REVIEW": {
          task.status = "EXPIRED";
          const n = this.create({ ...this.asCreate(task), expiryPolicy: "CREATE_NEW_REVIEW" });
          out.push({ reviewTaskId: task.reviewTaskId, transition: "NEW_REVIEW", newTaskId: n.reviewTaskId });
          break;
        }
        case "ESCALATE": {
          task.status = "ESCALATED";
          if (task.escalationDepth >= task.maxEscalationDepth) {
            task.status = "EXPIRED";
            out.push({ reviewTaskId: task.reviewTaskId, transition: "FAILED_MAX_ESCALATION" });
            break;
          }
          const n = this.create({ ...this.asCreate(task), requiredRole: task.escalateTo as string });
          const created = this.tasks.get(n.reviewTaskId) as ReviewTask;
          created.escalationDepth = task.escalationDepth + 1;
          out.push({ reviewTaskId: task.reviewTaskId, transition: "ESCALATED", newTaskId: n.reviewTaskId });
          break;
        }
      }
      this.audit.append({
        kind: "review-expired",
        workflowId: task.workflowId,
        correlationId: task.correlationId,
        tenantId: task.tenantId,
        details: { reviewTaskId: task.reviewTaskId, policy: task.expiryPolicy, transition: out[out.length - 1]?.transition, escalationDepth: task.escalationDepth },
      });
    }
    return out;
  }

  private asCreate(t: ReviewTask): CreateTask {
    const c: CreateTask = {
      workflowId: t.workflowId,
      stepId: t.stepId,
      tenantId: t.tenantId,
      reasonCode: t.reasonCode,
      requiredRole: t.requiredRole,
      allowedDecisions: [...t.allowedDecisions],
      expiresInMs: Date.parse(t.expiresAt) - Date.parse(t.createdAt),
      expiryPolicy: t.expiryPolicy,
      maxEscalationDepth: t.maxEscalationDepth,
    };
    if (t.correlationId) c.correlationId = t.correlationId;
    if (t.escalateTo) c.escalateTo = t.escalateTo;
    if (t.currentValue !== undefined) c.currentValue = t.currentValue;
    if (t.alternatives) c.alternatives = [...t.alternatives];
    return c;
  }
}
