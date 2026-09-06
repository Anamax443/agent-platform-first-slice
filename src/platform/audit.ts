import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { newId } from "./ids.js";

export type AuditKind =
  | "dispatch"
  | "deny"
  | "write-intent"
  | "write-done"
  | "duplicate"
  | "review-created"
  | "review-decision"
  | "review-expired"
  | "security"
  | "reconciliation"
  | "state";

export interface AuditRecord {
  auditId: string;
  at: string;
  kind: AuditKind;
  correlationId?: string;
  workflowId?: string;
  tenantId?: string;
  actorId?: string;
  capability?: string;
  details?: Record<string, unknown>;
}

/** What the platform needs from an audit trail: append and read, nothing else (FOUNDATION-core §7). */
export interface AuditTrail {
  append(record: Omit<AuditRecord, "auditId" | "at">): AuditRecord;
  all(): readonly AuditRecord[];
  byKind(kind: AuditKind): AuditRecord[];
  byCorrelation(correlationId: string): AuditRecord[];
}

/**
 * Append-only audit trail for Node (memory + optional JSONL file). There is deliberately no update or delete API:
 * EVD-004 asserts that by reflection on this class. A Worker uses Durable Object SQLite + D1 behind the same interface.
 */
export class Audit implements AuditTrail {
  private readonly records: AuditRecord[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly file?: string,
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        this.records.push(JSON.parse(line) as AuditRecord);
      }
    }
  }

  append(record: Omit<AuditRecord, "auditId" | "at">): AuditRecord {
    const full: AuditRecord = { auditId: newId("aud"), at: iso(this.clock.now()), ...record };
    this.records.push(Object.freeze(full));
    if (this.file) appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }

  /** Deep copies: a caller can never reach the stored record, not even its details (EVD-004). */
  all(): readonly AuditRecord[] {
    return this.records.map((r) => structuredClone(r));
  }

  byKind(kind: AuditKind): AuditRecord[] {
    return this.all().filter((r) => r.kind === kind);
  }

  byCorrelation(correlationId: string): AuditRecord[] {
    return this.all().filter((r) => r.correlationId === correlationId);
  }
}
