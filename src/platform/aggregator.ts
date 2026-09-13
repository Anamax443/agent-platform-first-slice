import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import type { Evidence, EvidenceLedger } from "./evidence.js";

export type AggregateDecision = "READY" | "REVIEW" | "REJECT";

export type FindingKind =
  | "missing" // no valid evidence at all for a required field/producer
  | "expired" // evidence found but past its expiresAt
  | "tenant_mismatch" // evidence belongs to a different tenant than the object being certified
  | "integrity_failed" // Evidence.verify() rejected the record (tampered or forged)
  | "lineage_broken" // Evidence.verifyLineage() found a changed ancestor
  | "conflict"; // two valid pieces of evidence for the same field disagree

export interface AggregateFinding {
  field: string;
  kind: FindingKind;
  reason: string;
}

export interface AggregateResult {
  decision: AggregateDecision;
  findings: AggregateFinding[];
  /** recordIds actually accepted into the decision (excludes anything that failed a check). */
  evidenceRefs: string[];
}

export interface RequiredEvidence {
  field: string;
  producerId: string;
}

const HARD_FAILURE: ReadonlySet<FindingKind> = new Set(["tenant_mismatch", "integrity_failed", "lineage_broken", "conflict"]);

/**
 * Dojička (SEVERKA.md `### Tři role, ne dvě`): deterministic evidence aggregator, first concrete
 * instance of docs/POSUDKY.md Posudek 11 point 7 / Posudek 12 point 9's `invoice.verification.
 * aggregate`, generalized to any named set of required (field, producer) pairs rather than being
 * invoice-specific — same generality as EvidenceLedger itself. By construction this class:
 *   - carries no LLM adapter and no external credential (constructor takes only a ledger + clock);
 *   - never writes to the ledger (no `evidence.append` reference anywhere below) — it can decide
 *     READY/REVIEW/REJECT, but can never manufacture, edit or "helpfully fix" a missing value;
 *   - only reads Evidence already sealed by the platform (`EvidenceLedger.verify`/`verifyLineage`),
 *     never accepts a claim structure of its own that could be substituted for real evidence.
 */
export class EvidenceAggregator {
  constructor(
    private readonly ledger: EvidenceLedger,
    private readonly clock: Clock,
  ) {}

  aggregate(input: { tenantId: string; required: RequiredEvidence[]; evidenceRefs: string[] }): AggregateResult {
    const now = iso(this.clock.now());
    const findings: AggregateFinding[] = [];
    const byField = new Map<string, Evidence[]>();

    for (const recordId of input.evidenceRefs) {
      const record = this.ledger.get(recordId);
      if (!record) {
        findings.push({ field: "(unknown)", kind: "missing", reason: `evidenceRefs named ${recordId}, which does not exist in the ledger` });
        continue;
      }
      const integrity = this.ledger.verify(record);
      if (!integrity.ok) {
        findings.push({ field: record.inputField, kind: "integrity_failed", reason: `${recordId}: ${integrity.reason}` });
        continue;
      }
      const lineage = this.ledger.verifyLineage(recordId);
      if (!lineage.ok) {
        findings.push({ field: record.inputField, kind: "lineage_broken", reason: `${recordId} lineage broken at ${lineage.brokenAt}: ${lineage.reason}` });
        continue;
      }
      if (record.tenantId !== input.tenantId) {
        findings.push({ field: record.inputField, kind: "tenant_mismatch", reason: `${recordId} belongs to tenant ${record.tenantId}, expected ${input.tenantId}` });
        continue;
      }
      if (record.expiresAt && record.expiresAt < now) {
        findings.push({ field: record.inputField, kind: "expired", reason: `${recordId} expired at ${record.expiresAt} (now ${now})` });
        continue;
      }
      const list = byField.get(record.inputField) ?? [];
      list.push(record);
      byField.set(record.inputField, list);
    }

    for (const req of input.required) {
      const satisfied = (byField.get(req.field) ?? []).some((r) => r.producerId === req.producerId);
      if (!satisfied) findings.push({ field: req.field, kind: "missing", reason: `no valid, unexpired, same-tenant evidence from ${req.producerId} for field ${req.field}` });
    }

    for (const [field, records] of byField) {
      // SEVERKA `### Kontrola musí být svázaná s konkrétní hodnotou`: evidence for the same field must
      // agree on which value it verified. A hash mismatch here means the field changed between two
      // verifications — VALUE_CHANGED_AFTER_VERIFICATION, not a legitimate second opinion.
      const distinctValueHashes = new Set(records.map((r) => r.inputValueHash));
      if (distinctValueHashes.size > 1) {
        findings.push({ field, kind: "conflict", reason: `evidence for ${field} verified different values (inputValueHash mismatch) — value changed after verification` });
        continue;
      }
      const distinctResults = new Set(records.map((r) => r.result));
      if (distinctResults.size > 1) {
        findings.push({ field, kind: "conflict", reason: `conflicting results for ${field}: ${[...distinctResults].join(" vs ")}` });
      }
    }

    const evidenceRefs = [...byField.values()].flat().map((r) => r.recordId);
    if (findings.length === 0) return { decision: "READY", findings, evidenceRefs };
    const decision: AggregateDecision = findings.some((f) => HARD_FAILURE.has(f.kind)) ? "REJECT" : "REVIEW";
    return { decision, findings, evidenceRefs };
  }
}
