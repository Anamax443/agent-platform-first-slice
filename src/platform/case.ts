// Case (M0-FACT-CONTRACT-V1.md část 0 "Impuls a Case", krůček 5 UZAVŘENO 16. 9. 2026; implementation část E):
// a container over one NormalizedImpulse — one impulse, one Žlab, N workflow instances over time (discovery,
// then processing, possibly re-processing). Replaces today's WorkflowInstance-is-the-object simplification
// (src/platform/journal.ts's Instance = exactly one workflow) — but only the type and its append-only instance
// list, additive, alongside the existing Instance/Journal, exactly as this project has built every other M0
// part today (mechanism first, live wiring once a real producer exists).
//
// Commit 3 (18.9.2026, owner's "Case wiring"): apf-gateway's mail intake path (index.ts's mailIntake()/
// fanOutAttachmentsIfAny()) now DOES build a NormalizedImpulse and grow a Case for every inbound e-mail — see
// deploy/cloudflare/apf-gateway/src/store.ts's SqliteCaseStore and index.ts's createCaseForMailIntake()/
// growCaseWithFanout(). intake()'s own (Podatelna/form) path still creates a bare Instance directly — that
// channel's own Case wiring is its own future step, not part of this commit either.
import type { Instance, InstanceStatus } from "./journal.js";

/** A minimal pointer to an already-stored Artifact (artifacts.ts) — one impulse may carry several (attachments). */
export interface ArtifactRef {
  readonly artifactId: string;
}

/**
 * The single shape every ingress channel normalizes into (part 0's hard invariant: the channel carries the
 * impulse, it never determines intent/goal/workflow). Structurally has no workflow/goal/intent field — an
 * ingress adapter cannot smuggle a routing decision through it even by mistake (same defense as EvidenceClaim
 * having no tenantId field for a cow to fill in).
 *
 * `content`, when a channel populates it, is that channel's own single normalized full-text representation of
 * this impulse's readable content, when the channel needs to derive one — distinct from `artifacts` (the
 * discrete things the sender actually sent) and from `text` (short inline content the sender typed directly,
 * e.g. a chat message body). A channel that derives a combined/joined document from several inputs (mail: body
 * + every attachment's extracted text, one artifact) points `content` at that artifact instead of duplicating
 * it into `text` or smuggling it into `artifacts`. Added 18.9.2026 (Commit 4, in response to a live external
 * audit's finding that the mail channel's own combined-body-and-attachments artifact — mail.ingest's
 * payload.artifactId, handler.ts's `combinedText` — was reachable only via the mail-intake instance's own
 * journal entry, not from the Case/NormalizedImpulse itself, forcing any future channel-agnostic consumer such
 * as intent.resolve or CurrentCaseProjection back into per-instance journal parsing that case.ts/index.ts's own
 * design explicitly tries to keep out of the channel-agnostic layer).
 */
export interface NormalizedImpulse {
  readonly impulseId: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly sender?: string;
  readonly receivedAt: string;
  readonly text?: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly content?: ArtifactRef;
  readonly thread?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * One impulse, one Žlab, N workflow instances in time. `instances` holds workflowIds only (journal.ts's
 * Journal is still the source of truth for each Instance's own state) — append-only, oldest first, exactly the
 * "discovery, then processing, possibly re-processing" shape part 0 describes.
 *
 * Deliberately NOT included here: a `ledger` field. Today's EvidenceLedger is tenant-scoped
 * (evidence.ts/evidence-sqlite.ts), not case-scoped — part 0's sketch of "one Žlab per Case" is a future
 * durable-store partitioning decision, not something this type should pretend already exists by embedding a
 * runtime object reference in what is otherwise a plain, journal-serializable record.
 *
 * `status` is the Case-level AGGREGATE over every one of `instances`' own current InstanceStatus (see
 * `aggregateCaseStatus()` below) — not just the most-recently-touched instance's status. E-1 shipped this field
 * holding exactly that simplification ("status = last-added instance's status", case.test.ts CASE-002) because
 * only one instance existed yet; Commit 3 closes the gap the E-1 doc comment flagged here ("not decided yet, out
 * of scope for E-1") now that a Case genuinely does outlive one instance (mail-intake + its fanned-out
 * attachment-classify/attachment-extract instances). `newCase()`/`addInstance()` below still only ever see ONE
 * instance's own status (the one just added/created) — pure functions, no journal access — so they still set
 * `status` to that single instance's status; the real, multi-instance aggregate is computed by whoever DOES have
 * journal access (index.ts's growCaseWithFanout()) via `aggregateCaseStatus()` and stored back through
 * CaseStore.put() as the authoritative value. A single-instance Case's aggregate and its "last instance" status
 * coincide, so this is not a behaviour change for the E-1 shape, only an addition for N>1.
 */
export interface Case {
  readonly caseId: string;
  readonly tenantId: string;
  readonly impulse: NormalizedImpulse;
  readonly instances: readonly string[];
  readonly status: CaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Case-level generalization of InstanceStatus across N instances (Commit 3 — case.ts's own E-1 doc comment left
 * this "not decided yet, out of scope"). Deliberately reuses InstanceStatus's own vocabulary for every value that
 * already has a single-instance meaning (RUNNING/WAITING/SUCCEEDED/FAILED/CANCELLED — see aggregateCaseStatus()
 * for exactly which combination of member statuses maps to which) and adds exactly one genuinely new value,
 * PARTIAL, for the one aggregate outcome no single Instance can ever be in: some of a Case's instances reached a
 * terminal SUCCEEDED while others reached a terminal FAILED/CANCELLED — "2 of 3 attachments extracted fine, one
 * genuinely failed" (the owner's own example for the sibling fan-out-level aggregate, summarizeFanoutOutcomes()'s
 * PARTIAL, in attachment-fanout.ts) — not a brand-new unrelated enum.
 *
 * UNSTARTED (this change, 18.9.2026, fixing the gap a rigorous external audit performed after commit 7971ede
 * named — "Case can exist with 0 instances"): means no member instance exists yet — the Case was built from an
 * impulse before any workflow started. Before this change, `newCase()` always REQUIRED an `instance` argument, so
 * a Case could not structurally represent the pre-planning state that AUTONOMOUS-RUNTIME-V1.md's own part 2
 * (originCaseId-optional reasoning) and part 6 step 8 (the eventual Case-level replanning loop) assume will exist
 * — and the ADR's own acceptance scenario C (part 8: one mail containing a contract, an invoice, and an ordinary
 * photo, three different document.type values arriving under one impulse before any of them is individually
 * planned) needs exactly this "Case exists, nothing has run yet" state to be representable, well before
 * CurrentCaseProjection (part 6 step 3) is built on top of it. Deliberately does NOT reuse the ADR's future
 * goalStatus vocabulary (docs/AUTONOMOUS-RUNTIME-V1.md part 7, line ~293-294:
 * UNRESOLVED/PLANNABLE/SATISFIED/CAPABILITY_GAP/NEEDS_INPUT/NEEDS_APPROVAL) — CaseStatus stays pure
 * execution-health per this file's own existing doc comment above and the ADR's own executionStatus/goalStatus
 * split; conflating the two is reserved for part 6 step 6 (intent->goal mapping), out of scope here.
 */
export type CaseStatus = InstanceStatus | "PARTIAL" | "UNSTARTED";

/**
 * Pure aggregate over every member instance's own CURRENT InstanceStatus (journal.ts stays the source of truth
 * for each instance's own state — Case never duplicates it structurally, only this derived summary). No I/O: the
 * caller (index.ts's growCaseWithFanout(), which has journal access) gathers each instance's live status and
 * passes them in; same discipline/testability as attachment-fanout.ts's summarizeFanoutOutcomes().
 *
 * Priority, most urgent/informative first (mirrors how a live dashboard should read a Case while it is still
 * growing, not just once it is done):
 *  - RUNNING  — at least one instance is still actively running. Takes priority over everything else, including
 *    an already-FAILED sibling: the Case is still in flight and its outcome can still change (e.g. one attachment
 *    already failed classification while another is still being classified) — the terminal PARTIAL/FAILED
 *    verdict below only applies once nothing is left running.
 *  - WAITING  — nothing running, but at least one instance is blocked on human review (WAITING). A distinct
 *    "needs a person, not more compute" state from RUNNING.
 *  - SUCCEEDED — every instance reached a terminal SUCCEEDED. The Case is genuinely done, cleanly.
 *  - PARTIAL  — every instance is terminal (SUCCEEDED/FAILED/CANCELLED) and at least one SUCCEEDED and at least
 *    one did not — needs-attention: the Case finished but not cleanly (owner's "2 of 3 classified fine, one
 *    genuinely failed" case, one level up from summarizeFanoutOutcomes()'s own PARTIAL).
 *  - FAILED   — every instance is terminal and NONE ever reached SUCCEEDED (at least one FAILED) — the whole
 *    Case never got anywhere.
 *  - CANCELLED — every instance is terminal and every single one is CANCELLED (no FAILED, no SUCCEEDED) — a
 *    deliberate stop, not a failure. Narrow, but keeps CaseStatus a coherent covering of InstanceStatus rather
 *    than silently folding CANCELLED into FAILED.
 *
 * A Case with only its first instance so far (before any fan-out has run — the common case right after
 * newCase()) is just the N=1 case of the same rules: single RUNNING -> RUNNING, single SUCCEEDED -> SUCCEEDED,
 * single FAILED -> FAILED, etc. — always coherent, never a special case. As of this change (18.9.2026), N=0 is
 * covered too: an empty `statuses` list (a Case built from an impulse before any instance ever started) returns
 * UNSTARTED, logically first in the priority order above — nothing can be running, waiting, or terminal if
 * nothing has started. This is the one case `newCase()` no longer rules out as of this change: previously
 * `newCase()` always required exactly one instance, and this function threw on an empty list as an invariant
 * check on that guarantee; that invariant is gone now that `newCase()`'s `instance` argument is optional (see
 * `newCase()` below) and a Case can be opened directly from an impulse before any workflow exists.
 * AUTONOMOUS-RUNTIME-V1.md part 6 step 8's eventual /impulse path (out of scope for this task — see this file's
 * own top-of-file comment and case.ts's newCase() doc comment below) will be the first LIVE producer of such a
 * Case; this change only makes the primitive able to represent and aggregate it, it does not wire that path.
 */
export function aggregateCaseStatus(statuses: readonly InstanceStatus[]): CaseStatus {
  if (statuses.length === 0) return "UNSTARTED";
  if (statuses.some((s) => s === "RUNNING")) return "RUNNING";
  if (statuses.some((s) => s === "WAITING")) return "WAITING";
  // Everything left is terminal: SUCCEEDED, FAILED or CANCELLED.
  const succeeded = statuses.filter((s) => s === "SUCCEEDED").length;
  if (succeeded === statuses.length) return "SUCCEEDED";
  if (succeeded > 0) return "PARTIAL";
  return statuses.every((s) => s === "CANCELLED") ? "CANCELLED" : "FAILED";
}

export class CaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseError";
  }
}

/**
 * A fresh Case around one impulse, and OPTIONALLY its first workflow instance (this change, 18.9.2026 —
 * previously `instance` was required; see CaseStatus's UNSTARTED and aggregateCaseStatus()'s doc comment above
 * for why). tenantId must agree with the instance when one is given — a Case can never span tenants (same
 * boundary as every other tenant-scoped record); with no instance, tenantId is taken directly from the impulse
 * instead, since there is nothing yet to cross-check it against.
 *
 * No new timestamp field was added to `input` for the no-instance branch: `createdAt`/`updatedAt` are sourced
 * from `input.impulse.receivedAt` — the moment the impulse itself arrived is the correct "Case opened at" instant
 * when nothing has started yet, and reusing it keeps this function pure (no I/O, no clock dependency) and keeps
 * the required->optional diff to exactly the one `instance` field, not two.
 */
export function newCase(input: { caseId: string; impulse: NormalizedImpulse; instance?: Pick<Instance, "workflowId" | "tenantId" | "status" | "createdAt" | "updatedAt"> }): Case {
  if (!input.instance) {
    return {
      caseId: input.caseId,
      tenantId: input.impulse.tenantId,
      impulse: input.impulse,
      instances: [],
      status: "UNSTARTED",
      createdAt: input.impulse.receivedAt,
      updatedAt: input.impulse.receivedAt,
    };
  }
  if (input.impulse.tenantId !== input.instance.tenantId) {
    throw new CaseError(`impulse tenantId ${input.impulse.tenantId} does not match instance tenantId ${input.instance.tenantId} — a Case cannot span tenants`);
  }
  return {
    caseId: input.caseId,
    tenantId: input.instance.tenantId,
    impulse: input.impulse,
    instances: [input.instance.workflowId],
    status: input.instance.status,
    createdAt: input.instance.createdAt,
    updatedAt: input.instance.updatedAt,
  };
}

/**
 * Appends a new workflow instance to an existing Case (re-processing after a correction, or a second explicit
 * goal derived from the same impulse) — never removes or reorders `instances` (append-only, same discipline as
 * the Žlab and Audit). Refuses a workflowId already present (idempotency: adding the same instance twice would
 * silently duplicate history) and a tenantId mismatch.
 *
 * Also correctly appends the FIRST instance onto an UNSTARTED, zero-instance Case built by `newCase()` without an
 * `instance` argument (this change, 18.9.2026 — see CaseStatus's UNSTARTED and newCase()'s doc comment above):
 * `c.instances.includes(...)` is simply false on an empty array and the spread below already handles an empty
 * starting array with no modification needed — this function's own logic never assumed a non-empty starting list.
 */
export function addInstance(c: Case, instance: Pick<Instance, "workflowId" | "tenantId" | "status" | "updatedAt">): Case {
  if (instance.tenantId !== c.tenantId) throw new CaseError(`instance tenantId ${instance.tenantId} does not match case tenantId ${c.tenantId}`);
  if (c.instances.includes(instance.workflowId)) throw new CaseError(`workflowId ${instance.workflowId} is already part of case ${c.caseId} — instances is append-only, never re-added`);
  return { ...c, instances: [...c.instances, instance.workflowId], status: instance.status, updatedAt: instance.updatedAt };
}

/**
 * What the live intake path needs from a Case store (Commit 3) — same shape/discipline as journal.ts's
 * JournalStore (get/put/list, synchronous: every transition durable before the next call, RES-CRASH-001) plus one
 * addition: `byWorkflowId()`. fanOutAttachmentsIfAny() only ever knows the mail-intake instance's OWN workflowId
 * (it does not carry the Case's own caseId around) and needs "the Case this instance belongs to" to grow it with
 * each fanned-out attachment-classify/attachment-extract instance; GET /case/:id.json needs the same lookup from
 * the outside. Implemented as an index kept in sync by put() (every one of `instances` -> caseId), not a scan —
 * see MemoryCaseStore below and store.ts's SqliteCaseStore for the durable equivalent.
 */
export interface CaseStore {
  get(caseId: string): Case | undefined;
  put(c: Case): void;
  list(): Case[];
  /** The Case that currently lists `workflowId` among its `instances`, if any. */
  byWorkflowId(workflowId: string): Case | undefined;
}

/** Default store: process memory. Tests and the in-process slice; a deployed farm uses SqliteCaseStore (store.ts). */
export class MemoryCaseStore implements CaseStore {
  private readonly byId = new Map<string, Case>();
  private readonly byWorkflow = new Map<string, string>();

  get(caseId: string): Case | undefined {
    return this.byId.get(caseId);
  }

  put(c: Case): void {
    this.byId.set(c.caseId, c);
    for (const workflowId of c.instances) this.byWorkflow.set(workflowId, c.caseId);
  }

  list(): Case[] {
    return [...this.byId.values()];
  }

  byWorkflowId(workflowId: string): Case | undefined {
    const caseId = this.byWorkflow.get(workflowId);
    return caseId ? this.byId.get(caseId) : undefined;
  }
}
