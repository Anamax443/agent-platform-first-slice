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

/**
 * Append-only audit trail (FOUNDATION-core §7). There is deliberately no update or delete API:
 * EVD-004 asserts that by reflection on this class.
 */
export class Audit {
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

  all(): readonly AuditRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  byKind(kind: AuditKind): AuditRecord[] {
    return this.all().filter((r) => r.kind === kind);
  }

  byCorrelation(correlationId: string): AuditRecord[] {
    return this.all().filter((r) => r.correlationId === correlationId);
  }
}
