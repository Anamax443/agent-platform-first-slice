import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { MessageEnvelope, ResultEnvelope, WaitReason } from "./types.js";

export type StepStatus = "PENDING" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN_OUTCOME";
export type SideEffects = "none" | "internal-write" | "external-write";

export interface StepRecord {
  stepId: string;
  capability: string;
  capabilityVersion: string;
  sideEffects: SideEffects;
  executionId: string;
  attempt: number;
  strategyIndex: number;
  strategy: string;
  idempotencyKey: string;
  status: StepStatus;
  startedAt: string;
  finishedAt?: string;
  message?: MessageEnvelope;
  result?: ResultEnvelope;
  reconciliationRef?: string;
  reconciliationAttempts?: number;
}

export type InstanceStatus = "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface Instance {
  workflowId: string;
  workflow: string;
  workflowVersion: string;
  correlationId: string;
  tenantId: string;
  actorId: string;
  status: InstanceStatus;
  currentStep: number;
  input: Record<string, unknown>;
  steps: StepRecord[];
  waiting?: { reason: WaitReason; stepId: string; reviewTaskId?: string; deadline: string };
  /** What clients see while the true outcome is not yet known (WF-UNK-003). */
  published: { status: string; reconciliation?: "IN_PROGRESS" | "AWAITING_REVIEW" };
  createdAt: string;
  updatedAt: string;
}

/** Durable journal: JSON file, rewritten on every transition (RES-CRASH-001). */
export class Journal {
  private readonly instances = new Map<string, Instance>();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as Instance[];
      for (const i of data) this.instances.set(i.workflowId, i);
    }
  }

  get(workflowId: string): Instance | undefined {
    const i = this.instances.get(workflowId);
    return i ? structuredClone(i) : undefined;
  }

  put(instance: Instance): void {
    this.instances.set(instance.workflowId, structuredClone(instance));
    if (this.file) writeFileSync(this.file, JSON.stringify([...this.instances.values()], null, 2));
  }

  list(): Instance[] {
    return [...this.instances.values()].map((i) => structuredClone(i));
  }
}
