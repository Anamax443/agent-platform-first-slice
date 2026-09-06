import type { Audit } from "./audit.js";
import type { Clock } from "./clock.js";
import { iso, plus } from "./clock.js";
import { newId } from "./ids.js";
import type { Instance, Journal, SideEffects, StepRecord } from "./journal.js";
import type { ReviewService, Decision } from "./review.js";
import type { DispatchTransport } from "./transport.js";
import type { Reconciler } from "./executor-host.js";
import type { ErrorClass, MessageEnvelope, ResultEnvelope } from "./types.js";

export type { Reconciler, ReconcileResult } from "./executor-host.js";

export type OnFailed = "retryQuality" | "review" | "fail";

export interface StepDef {
  id: string;
  capability: string;
  capabilityVersion: string;
  sideEffects: SideEffects;
  /** Payload template. Strings starting with "$" are refs ("$input.x", "$steps.<stepId>.payload.a.b", "$strategy"); objects nest; other values are literals. */
  inputs: Record<string, unknown>;
  /** Overrides the workflow deadline for this step (e.g. an executor with a shorter deadlinePolicy). */
  deadlineMs?: number;
  strategies?: string[];
  qualityBudget?: number;
  technicalRetries?: number;
  reconciliationBudget?: number;
  onFailed?: Partial<Record<ErrorClass, OnFailed>>;
  reviewRole?: string;
  reviewEscalateTo?: string;
  reviewExpiresInMs?: number;
}

export interface WorkflowDef {
  workflow: string;
  workflowVersion: string;
  conformanceTier: "exact" | "semantic" | "property" | "ai-eval";
  deadlineMs: number;
  /** Role for the operator review created when reconciliation of an UNKNOWN_OUTCOME runs out of budget (WF-UNK-002). */
  operatorRole: string;
  supervisorRole: string;
  steps: StepDef[];
}

export type RunOutcome = "SUCCEEDED" | "FAILED" | "WAITING";

/**
 * Deterministic orchestrator over a versioned workflow definition (FOUNDATION-core §2, §5).
 * Owns workflow state, not domain data. Every ending is explicit and journaled.
 */
export class Orchestrator {
  constructor(
    private readonly opts: {
      workflow: WorkflowDef;
      /** In-process or HTTP: the orchestrator does not know and must not care (F3). */
      transport: DispatchTransport;
      journal: Journal;
      review: ReviewService;
      audit: Audit;
      clock: Clock;
      actorId: string;
      reconcilers?: Record<string, Reconciler>;
    },
  ) {}

  get workflow(): WorkflowDef {
    return this.opts.workflow;
  }

  start(input: { tenantId: string } & Record<string, unknown>, correlationId?: string): Instance {
    const now = iso(this.opts.clock.now());
    const { tenantId, ...rest } = input;
    const inst: Instance = {
      workflowId: newId("wf"),
      workflow: this.opts.workflow.workflow,
      workflowVersion: this.opts.workflow.workflowVersion,
      correlationId: correlationId ?? newId("cor"),
      tenantId,
      actorId: this.opts.actorId,
      status: "RUNNING",
      currentStep: 0,
      input: rest,
      steps: [],
      published: { status: "RUNNING" },
      createdAt: now,
      updatedAt: now,
    };
    this.save(inst);
    return inst;
  }

  /** Runs until the instance is terminal or waits. Idempotent to call again after WAITING is resolved. */
  async run(workflowId: string): Promise<Instance> {
    let inst = this.load(workflowId);
    if (inst.workflow !== this.opts.workflow.workflow) {
      throw new Error(`instance ${workflowId} belongs to workflow ${inst.workflow}, this orchestrator runs ${this.opts.workflow.workflow}`);
    }
    if (inst.workflowVersion !== this.opts.workflow.workflowVersion) {
      throw new Error(
        `instance ${workflowId} is pinned to workflow v${inst.workflowVersion}, this orchestrator runs v${this.opts.workflow.workflowVersion} (WF-VER-001)`,
      );
    }
    while (inst.status === "RUNNING" && inst.currentStep < this.opts.workflow.steps.length) {
      const outcome = await this.runStep(inst, inst.currentStep);
      inst = this.load(workflowId);
      if (outcome !== "SUCCEEDED") break;
    }
    if (inst.status === "RUNNING" && inst.currentStep >= this.opts.workflow.steps.length) {
      inst.status = "SUCCEEDED";
      inst.published = { status: "SUCCEEDED" };
      this.save(inst);
      this.opts.audit.append({ kind: "state", workflowId: inst.workflowId, correlationId: inst.correlationId, tenantId: inst.tenantId, details: { status: "SUCCEEDED" } });
    }
    return inst;
  }

  /** Restart recovery (RES-CRASH-001): RUNNING steps either rerun (no side effects) or reconcile (writes). */
  async recover(): Promise<Instance[]> {
    const out: Instance[] = [];
    for (const inst of this.opts.journal.list()) {
      if (inst.status !== "RUNNING" || inst.workflow !== this.opts.workflow.workflow) continue;
      const step = inst.steps.find((s) => s.status === "RUNNING");
      if (step && step.sideEffects !== "none") {
        step.status = "UNKNOWN_OUTCOME";
        step.reconciliationRef = step.reconciliationRef ?? step.idempotencyKey;
        this.opts.audit.append({
          kind: "reconciliation",
          workflowId: inst.workflowId,
          correlationId: inst.correlationId,
          details: { stepId: step.stepId, reason: "recovered RUNNING write step as UNKNOWN_OUTCOME" },
        });
        this.save(inst);
      } else if (step) {
        step.status = "PENDING";
        this.save(inst);
      }
      out.push(await this.run(inst.workflowId));
    }
    return out;
  }

  /**
   * Apply review expiry policies to waiting instances (WF-REV-003). Escalation and a new review keep the instance waiting
   * on the new task; FAILED / CANCELLED end the instance explicitly. Never "nothing happens".
   */
  applyReviewExpiries(): Array<{ workflowId: string; transition: string }> {
    const out: Array<{ workflowId: string; transition: string }> = [];
    const transitions = this.opts.review.expire();
    for (const inst of this.opts.journal.list()) {
      if (inst.status !== "WAITING" || !inst.waiting?.reviewTaskId) continue;
      const t = transitions.find((x) => x.reviewTaskId === inst.waiting?.reviewTaskId);
      if (!t) continue;
      const step = inst.steps.find((s) => s.stepId === inst.waiting?.stepId && (s.status === "WAITING" || s.status === "UNKNOWN_OUTCOME"));
      if ((t.transition === "ESCALATED" || t.transition === "NEW_REVIEW") && t.newTaskId) {
        const task = this.opts.review.get(t.newTaskId);
        inst.waiting = { ...inst.waiting, reviewTaskId: t.newTaskId, deadline: task?.expiresAt ?? inst.waiting.deadline };
      } else {
        const terminal = t.transition === "CANCELLED" ? "CANCELLED" : "FAILED";
        if (step) step.status = terminal;
        inst.status = terminal;
        inst.published = { status: terminal };
        delete inst.waiting;
        this.opts.audit.append({ kind: "state", workflowId: inst.workflowId, correlationId: inst.correlationId, tenantId: inst.tenantId, details: { status: terminal, reason: t.transition, reviewTaskId: t.reviewTaskId } });
      }
      this.save(inst);
      out.push({ workflowId: inst.workflowId, transition: t.transition });
    }
    return out;
  }

  /** Apply a review decision and continue (F7: the decision itself was authorized in ReviewService). */
  async resumeAfterReview(workflowId: string, reviewTaskId: string): Promise<Instance> {
    const inst = this.load(workflowId);
    const task = this.opts.review.get(reviewTaskId);
    if (!task || task.status !== "DECIDED" || !task.decision) throw new Error(`review ${reviewTaskId} not decided`);
    if (task.workflowId !== workflowId || inst.waiting?.reviewTaskId !== reviewTaskId) {
      throw new Error("review task is not bound to this instance (APPROVAL_MISMATCH)");
    }
    const step = inst.steps.find((s) => s.stepId === inst.waiting?.stepId && (s.status === "WAITING" || s.status === "UNKNOWN_OUTCOME"));
    if (!step) throw new Error("no waiting step");
    const d: Decision = task.decision.decision;
    if (d === "REJECT") {
      step.status = "FAILED";
      inst.status = "FAILED";
      inst.published = { status: "FAILED" };
      delete inst.waiting;
      this.save(inst);
      this.opts.audit.append({ kind: "state", workflowId: inst.workflowId, correlationId: inst.correlationId, tenantId: inst.tenantId, details: { status: "FAILED", step: step.stepId, reason: "REJECT" } });
      return inst;
    }
    if (task.reasonCode === "UNKNOWN_OUTCOME_UNRESOLVED") {
      // APPROVE = human confirmed the side effect happened (with evidence in correction)
      step.status = "SUCCEEDED";
      step.finishedAt = iso(this.opts.clock.now());
      step.result = { ...(step.result as ResultEnvelope), status: "SUCCEEDED", payload: { ...(task.decision.correction ?? {}), confirmedBy: task.decision.actorId } };
      delete step.result.reconciliationRef;
      inst.currentStep += 1;
    } else if (d === "CORRECT" || d === "RECLASSIFY") {
      inst.input = { ...inst.input, ...(task.decision.correction ?? {}) };
      step.status = "PENDING";
      step.strategy = "human-corrected";
      step.strategyIndex = -1;
      step.attempt = 1;
      step.logicalAttempt += 1;
      delete step.result;
      delete step.finishedAt;
    } else {
      // APPROVE on a business failure: accept the last payload as is
      step.status = "SUCCEEDED";
      step.finishedAt = iso(this.opts.clock.now());
      const prev = step.result as ResultEnvelope;
      step.result = { ...prev, status: "SUCCEEDED", payload: { ...(prev.payload ?? {}), approvedBy: task.decision.actorId } };
      delete step.result.error;
      inst.currentStep += 1;
    }
    inst.status = "RUNNING";
    inst.published = { status: "RUNNING" };
    delete inst.waiting;
    this.save(inst);
    return this.run(workflowId);
  }

  private async runStep(instIn: Instance, idx: number): Promise<RunOutcome> {
    const def = this.opts.workflow.steps[idx] as StepDef;
    const inst = instIn;
    let step = inst.steps.find((s) => s.stepId === def.id && s.status !== "SUCCEEDED" && s.status !== "FAILED" && s.status !== "CANCELLED");
    const technicalRetries = def.technicalRetries ?? 2;
    const strategies = def.strategies ?? ["default"];
    const qualityBudget = def.qualityBudget ?? strategies.length;

    if (step && step.status === "UNKNOWN_OUTCOME") {
      const r = await this.reconcile(inst, step, def);
      if (r !== "RETRY") return r;
      step.attempt += 1;
      step.status = "PENDING";
    }

    for (;;) {
      if (!step || step.status === "PENDING") {
        const strategyIndex = step ? step.strategyIndex : 0;
        const strategy = step?.strategy === "human-corrected" ? "human-corrected" : (strategies[Math.max(strategyIndex, 0)] as string);
        const logicalAttempt = step ? step.logicalAttempt : 1;
        // One logical write intent = one key. Technical retries reuse it; a new strategy or a human correction gets a new one (§5.2).
        const key = `${inst.workflowId}:${def.id}:${strategy}:${logicalAttempt}`;
        step = step ?? {
          stepId: def.id,
          capability: def.capability,
          capabilityVersion: def.capabilityVersion,
          sideEffects: def.sideEffects,
          executionId: "",
          attempt: 1,
          logicalAttempt,
          strategyIndex,
          strategy,
          idempotencyKey: key,
          status: "PENDING",
          startedAt: iso(this.opts.clock.now()),
        };
        step.executionId = newId("exe");
        step.idempotencyKey = key;
        step.status = "RUNNING";
        step.message = this.buildMessage(inst, def, step);
        if (!inst.steps.includes(step)) inst.steps.push(step);
        this.save(inst);
      }

      const message = step.message as MessageEnvelope;
      const res = await this.opts.transport.dispatch(message, inst.actorId);
      step.result = res;
      step.finishedAt = iso(this.opts.clock.now());

      if (res.status === "SUCCEEDED") {
        step.status = "SUCCEEDED";
        inst.currentStep = idx + 1;
        this.save(inst);
        return "SUCCEEDED";
      }
      if (res.status === "WAITING") {
        step.status = "WAITING";
        inst.status = "WAITING";
        inst.waiting = { reason: res.waitReason ?? "EXTERNAL", stepId: def.id, deadline: res.deadline ?? iso(this.opts.clock.now()) };
        if (res.reviewTaskId) inst.waiting.reviewTaskId = res.reviewTaskId;
        inst.published = { status: "WAITING" };
        this.save(inst);
        return "WAITING";
      }
      if (res.status === "UNKNOWN_OUTCOME") {
        step.status = "UNKNOWN_OUTCOME";
        step.reconciliationRef = res.reconciliationRef;
        this.save(inst);
        const r = await this.reconcile(inst, step, def);
        if (r !== "RETRY") return r;
        step.attempt += 1;
        step.status = "PENDING";
        continue;
      }
      // FAILED
      const err = res.error;
      const cls = err?.class ?? "UNKNOWN";
      if (err?.retryable && (cls === "TECHNICAL" || cls === "DEPENDENCY") && step.attempt < technicalRetries + 1) {
        step.attempt += 1;
        step.status = "PENDING";
        this.save(inst);
        continue;
      }
      const usedLogical = inst.steps.filter((s) => s.stepId === def.id).length;
      if (err?.retryable && cls === "QUALITY" && step.strategyIndex + 1 < strategies.length && usedLogical < qualityBudget) {
        step.status = "FAILED";
        const next: StepRecord = {
          ...step,
          executionId: "",
          attempt: 1,
          logicalAttempt: step.logicalAttempt + 1,
          strategyIndex: step.strategyIndex + 1,
          strategy: strategies[step.strategyIndex + 1] as string,
          status: "PENDING",
          startedAt: iso(this.opts.clock.now()),
        };
        delete next.finishedAt;
        delete next.result;
        delete next.message;
        delete next.reconciliationRef;
        delete next.reconciliationAttempts;
        step = next;
        this.save(inst);
        continue;
      }
      const policy = def.onFailed?.[cls] ?? "fail";
      if (policy === "review") {
        const task = this.opts.review.create({
          workflowId: inst.workflowId,
          correlationId: inst.correlationId,
          stepId: def.id,
          tenantId: inst.tenantId,
          reasonCode: err?.code ?? "STEP_FAILED",
          requiredRole: def.reviewRole ?? "document.reviewer",
          allowedDecisions: ["APPROVE", "CORRECT", "REJECT", "RECLASSIFY"],
          expiresInMs: def.reviewExpiresInMs ?? 3 * 24 * 3_600_000,
          expiryPolicy: "ESCALATE",
          escalateTo: def.reviewEscalateTo ?? this.opts.workflow.supervisorRole,
          currentValue: err?.details ?? null,
        });
        step.status = "WAITING";
        inst.status = "WAITING";
        inst.waiting = { reason: "REVIEW", stepId: def.id, reviewTaskId: task.reviewTaskId, deadline: task.expiresAt };
        inst.published = { status: "WAITING" };
        this.save(inst);
        return "WAITING";
      }
      step.status = "FAILED";
      inst.status = "FAILED";
      inst.published = { status: "FAILED" };
      this.save(inst);
      this.opts.audit.append({ kind: "state", workflowId: inst.workflowId, correlationId: inst.correlationId, tenantId: inst.tenantId, details: { status: "FAILED", step: def.id, code: err?.code } });
      return "FAILED";
    }
  }

  /** UNKNOWN_OUTCOME handling (§5.1): bounded reconciliation, never blind resend; then WAITING(REVIEW). */
  private async reconcile(inst: Instance, step: StepRecord, def: StepDef): Promise<RunOutcome | "RETRY"> {
    const budget = def.reconciliationBudget ?? 3;
    const reconciler = this.opts.reconcilers?.[def.capability];
    inst.published = { status: "UNKNOWN_OUTCOME", reconciliation: "IN_PROGRESS" };
    this.save(inst);
    step.reconciliationAttempts = step.reconciliationAttempts ?? 0;
    while (reconciler && step.reconciliationAttempts < budget) {
      step.reconciliationAttempts += 1;
      const r = await reconciler(step.reconciliationRef as string, step, inst);
      this.opts.audit.append({
        kind: "reconciliation",
        workflowId: inst.workflowId,
        correlationId: inst.correlationId,
        details: { stepId: step.stepId, attempt: step.reconciliationAttempts, result: r.status },
      });
      if (r.status === "SUCCEEDED") {
        step.status = "SUCCEEDED";
        step.finishedAt = iso(this.opts.clock.now());
        step.result = { ...(step.result as ResultEnvelope), status: "SUCCEEDED", payload: r.payload };
        delete (step.result as ResultEnvelope).reconciliationRef;
        inst.currentStep += 1;
        inst.published = { status: "RUNNING" };
        this.save(inst);
        return "SUCCEEDED";
      }
      if (r.status === "FAILED") {
        // side effect provably did not happen: same intent, same key, technical re-issue
        this.save(inst);
        return "RETRY";
      }
      this.save(inst);
    }
    const task = this.opts.review.create({
      workflowId: inst.workflowId,
      correlationId: inst.correlationId,
      stepId: def.id,
      tenantId: inst.tenantId,
      reasonCode: "UNKNOWN_OUTCOME_UNRESOLVED",
      requiredRole: this.opts.workflow.operatorRole,
      allowedDecisions: ["APPROVE", "REJECT"],
      expiresInMs: 4 * 3_600_000,
      expiryPolicy: "ESCALATE",
      escalateTo: this.opts.workflow.supervisorRole,
      currentValue: step.reconciliationRef,
    });
    inst.status = "WAITING";
    inst.waiting = { reason: "REVIEW", stepId: def.id, reviewTaskId: task.reviewTaskId, deadline: task.expiresAt };
    inst.published = { status: "UNKNOWN_OUTCOME", reconciliation: "AWAITING_REVIEW" };
    this.save(inst);
    return "WAITING";
  }

  private buildMessage(inst: Instance, def: StepDef, step: StepRecord): MessageEnvelope {
    const now = this.opts.clock.now();
    const payload = this.resolveInputs(inst, step, def.inputs);
    const prev = inst.steps.filter((s) => s.status === "SUCCEEDED").at(-1);
    const m: MessageEnvelope = {
      messageId: newId("msg"),
      correlationId: inst.correlationId,
      workflowId: inst.workflowId,
      stepId: def.id,
      type: "command",
      capability: def.capability,
      capabilityVersion: def.capabilityVersion,
      schemaVersion: "1",
      idempotencyKey: step.idempotencyKey,
      createdAt: iso(now),
      notValidAfter: iso(plus(now, def.deadlineMs ?? this.opts.workflow.deadlineMs)),
      payload,
    };
    if (prev?.result) m.causationId = prev.result.messageId;
    return m;
  }

  private resolveInputs(inst: Instance, step: StepRecord, inputs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputs)) {
      const r = this.resolveValue(inst, step, v);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }

  private resolveValue(inst: Instance, step: StepRecord, v: unknown): unknown {
    if (typeof v === "string") return v.startsWith("$") ? this.resolveRef(inst, step, v) : v;
    if (v && typeof v === "object" && !Array.isArray(v)) return this.resolveInputs(inst, step, v as Record<string, unknown>);
    return v;
  }

  private resolveRef(inst: Instance, step: StepRecord, ref: string): unknown {
    if (ref === "$strategy") return step.strategy;
    if (ref.startsWith("$input.")) return inst.input[ref.slice(7)];
    if (ref.startsWith("$steps.")) {
      const [stepId, ...path] = ref.slice(7).split(".");
      const s = inst.steps.filter((x) => x.stepId === stepId && x.status === "SUCCEEDED").at(-1);
      let cur: unknown = s?.result;
      for (const p of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
      return cur;
    }
    return ref;
  }

  private load(id: string): Instance {
    const i = this.opts.journal.get(id);
    if (!i) throw new Error(`unknown workflow instance ${id}`);
    return i;
  }

  private save(inst: Instance): void {
    inst.updatedAt = iso(this.opts.clock.now());
    this.opts.journal.put(inst);
  }
}
