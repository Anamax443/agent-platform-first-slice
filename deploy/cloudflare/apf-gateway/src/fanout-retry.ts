// Reliability Gate, item R3 (owner's second, "can this run for months with near-zero human attention" audit,
// 18.9.2026 — the same day as the P0 fact-scope pass docs/AUTONOMOUS-RUNTIME-V1.md część 11 landed, but a
// separate, later finding): "background attachment fan-out relies on bare ctx.waitUntil(), not durable tracking".
//
// index.ts's fanOutAttachmentsIfAny() (called from mailIntake() via `this.ctx.waitUntil(...)`, never awaited by
// the request that triggered it) starts one attachment-classify + maybe attachment-extract Orchestrator instance
// PER ATTACHMENT, each of which calls a real Workers AI model. If this Durable Object is evicted mid-fan-out —
// the whole reason ctx.waitUntil() exists is to let a response return before background work finishes, and
// Workers' own docs are explicit that waitUntil() survives eviction only until it settles, not indefinitely — that
// work is simply gone: nothing durable recorded that it was ever started, so nothing on a later wake-up (this
// object's own alarm(), the only other code path that ever runs again for an evicted-then-reactivated instance)
// knows to retry it. Verified independently against live main@1d465dd before writing this: orchestrator.start()
// (src/platform/orchestrator.ts:71) is never given a workflowId by attachment-fanout.ts's fanOutAttachments()
// (src/platform/attachment-fanout.ts:218/242 — the two `deps.classifyOrchestrator.start(...)` /
// `deps.extractOrchestrator.start(...)` calls only ever pass two arguments), so a naive "just call
// fanOutAttachmentsIfAny() again" retry would mint a FRESH random workflowId (ids.ts's newId(): time + counter +
// crypto.getRandomValues, never content-derived) and re-run the real AI calls rather than resuming — there is no
// idempotency key to naturally protect a retry here, unlike copyOut()'s R2 head-check / D1 "INSERT OR IGNORE".
//
// The owner's own words for why this whole Reliability Gate (R0-R4) exists, verbatim, are the reason this file is
// scoped as small as it is: "Než dáme Farmě větší autonomii, musí se nejdřív sama umět bezpečně probudit,
// zopakovat, usmířit neznámý výsledek, odhalit stagnaci a uklidit po sobě" — this module is the "zopakovat"
// (repeat) and "odhalit stagnaci" (detect stagnation) half of that sentence for exactly this one background task.
//
// Why a separate file rather than private methods on index.ts's WorkflowInstance class: index.ts imports
// "cloudflare:workers" (line 11: `import { DurableObject } from "cloudflare:workers";`), so it cannot be loaded
// under plain-Node vitest — confirmed live before writing this file. The STYLE rule for this batch of work
// requires tests to land in the SAME change as the fix, so the two genuinely pure decisions this item needs
// (which attachments a Case is still missing; what an alarm tick should do about a given job row) are extracted
// here instead — the exact same workaround src/platform/attachment-fanout.ts's own summarizeFanoutOutcomes()
// already uses for the same reason, and the precedent tests/gw-platform-wiring-fanout.test.ts already set by
// importing plain deploy/cloudflare/apf-gateway/src/*.ts files directly under vitest, as long as they (like this
// file) avoid "cloudflare:workers"/"apf:*" imports. This file therefore imports only *type* declarations from
// src/platform/*, nothing that would drag in a Workers-only runtime dependency.
import type { AttachmentFanoutAttachment } from "../../../../src/platform/attachment-fanout.js";

/**
 * One row of the durable outbox (store.ts's `fanout_job` table, DDL comment there), one row per WorkflowInstance
 * object — deliberately keyed by `workflowId` (this object's own mail-intake instance id), not a generated jobId:
 * today there is exactly one fan-out job per object, and `workflowId` is already that object's own identity
 * (SqliteJournal/SqliteCaseStore's own keying discipline, store.ts). A generic, independently-keyed job table
 * (Approach A in the judged patch plan for this item) was deliberately NOT built — see attachment-fanout.ts's own
 * doc comment and docs/AUTONOMOUS-RUNTIME-V1.md część 7 ("Nesmí se replikovat"): attachment-fanout.ts is this
 * codebase's own documented example of code that is intentionally transitional, soon superseded by the część 3-6
 * CurrentCaseProjection/goal-mapping loop (część 6, krok 4 — landing this Reliability Gate first is exactly the
 * owner's own explicit ordering decision, część 11's same "fix primitives before building on them" logic applied
 * one level up: replanning without idempotency first just "automatizuje chyby rychleji"). Investing in reusable,
 * multi-kind job-engine machinery underneath a driver already slated for replacement would be scope this item does
 * not need to close its actual gap.
 *
 * Only two states exist on purpose (PENDING/DONE, no RUNNING/RETRY/DEAD state machine): the in-memory
 * `fanoutRetryInFlight` boolean on WorkflowInstance (index.ts) is the only same-isolate "is a pass running right
 * now" signal this needs — the durable row's job is purely "is there still unfinished work, and how many times
 * have we tried", which two states answer completely. The one gap a 2-state schema would otherwise leave open —
 * a permanently-stuck job (attempts >= cap) being silently invisible forever, exactly the residual risk the prior
 * P0 pass itself flagged for a hypothetical future retry mechanism — is closed without a third status value: see
 * `fanoutRetryDecision`'s "give-up" outcome below and index.ts's `maybeRetryFanoutJob()`, which writes ONE audited
 * FAILED record and moves the row to DONE with `lastError` set, so a permanently-stuck job stays discoverable via
 * the audit trail and this row's own `lastError` text — not via a distinct, separately-queryable status value.
 */
export interface FanoutJobRecord {
  workflowId: string;
  caseId: string;
  status: "PENDING" | "DONE";
  /** How many fan-out passes (the initial attempt from mailIntake(), plus every alarm()-driven retry) have been
   * made for this job. Only ever read/compared by fanoutRetryDecision() below against `maxAttempts` — never
   * itself a business value, so no CHECK/range constraint at the schema layer (store.ts's DDL comment: no other
   * status/count column in this file's DDL array has one either). */
  attempts: number;
  /** When this job was first created (mailIntake()) — never updated again; kept only for observability (how long
   * has this attachment set been trying to finish), not read by any decision function here. */
  startedAt: string;
  /** Last time this row was written — the staleness clock fanoutRetryDecision()'s grace period measures against;
   * DONE the outcome of the most recent finished pass, not a heartbeat. */
  updatedAt: string;
  /** Set only on a failed pass (an exception from fanOutAttachments() itself, or the "give-up" record) — absent on
   * a clean row. Human-readable, truncated by the caller (index.ts already does this for its other audit `reason`
   * fields) — never parsed back by any code here. */
  lastError?: string;
}

/**
 * The minimal shape index.ts's fanOutAttachmentsIfAny() extracts per Case member BEFORE calling into this file
 * (via `journal.get(wid)` over `caseStore.get(caseId)?.instances`, mapping to `{ workflow: i.workflow, artifactId:
 * i.input.artifactId as string | undefined }`) — kept this narrow on purpose so missingAttachments() below never
 * needs to import JournalStore/Instance or touch SQLite itself, staying a pure function over plain data (this
 * file's whole reason to exist, see the file-level doc comment above).
 */
export interface CaseMemberSummary {
  /** Instance.workflow (journal.ts) — the workflow NAME this member ran ("attachment-classify",
   * "attachment-extract", "mail-intake", …), never the workflowId. */
  workflow: string;
  /** Instance.input.artifactId when present and a string — the same field attachment-fanout.ts's own
   * fanOutAttachments() passes into classifyOrchestrator.start()'s input (attachment-fanout.ts:218:
   * `{ tenantId, artifactId, caseId, attachmentEntityId }`) and Instance.input stores verbatim
   * (journal.ts's `input: Record<string, unknown>`, orchestrator.ts's start() writes it unchanged) — confirmed
   * live against main@1d465dd before writing this file, since it is the one load-bearing assumption this whole
   * dedup mechanism rests on (see the residual-risk note in the final report about this coupling).
   */
  artifactId?: string;
}

/**
 * Which of `attempted` are NOT already represented in the Case as a finished (or in-flight, from an earlier pass
 * of THIS SAME job) attachment-classify instance — the retry-safe subset a fan-out pass should actually attempt.
 * Filters, never re-orders: a caller that needs "still in mail.ingest's own original order" gets that for free
 * from `attempted`'s own order (Array.prototype.filter preserves it).
 *
 * Only a member whose `workflow === "attachment-classify"` ever counts as "this attachment is already handled" —
 * deliberately not attachment-extract, and not any other workflow name sharing an artifactId by coincidence
 * (mail-intake's own `input.artifactId` is a DIFFERENT artifact, the combined mail-body-plus-attachments text, per
 * mailIngestPayload()'s own doc comment in index.ts — so an accidental match there is not even possible in
 * practice, but the explicit `workflow ===` check makes that a structural guarantee, not a coincidence). Every
 * fan-out pass runs classify first and only conditionally runs extract after (attachment-fanout.ts's own
 * fanOutAttachments() loop) — so "was extract's own presence used as the dedup signal instead", the other
 * plausible choice, would wrongly re-classify (and re-run extract for) an attachment whose classify succeeded but
 * whose plan() call legitimately decided NOT to extract (not an INVOICE) — extract's absence there is a correct,
 * final outcome, not unfinished work.
 */
export function missingAttachments(caseMembers: readonly CaseMemberSummary[], attempted: readonly AttachmentFanoutAttachment[]): AttachmentFanoutAttachment[] {
  const done = new Set(caseMembers.filter((m) => m.workflow === "attachment-classify" && typeof m.artifactId === "string").map((m) => m.artifactId as string));
  return attempted.filter((a) => !done.has(a.artifactId));
}

/**
 * What an alarm tick should do with a given fanout_job row, pure over the row plus the current time — no I/O, so
 * it is unit-testable under plain Node vitest alongside missingAttachments() above.
 *
 *   - "none": no job (nothing was ever pending for this instance) or the job is already DONE — nothing to do.
 *   - "give-up": PENDING but `attempts` has already reached `maxAttempts` — the caller (index.ts's
 *     maybeRetryFanoutJob()) writes one audited FAILED record and moves the row to DONE with `lastError` set
 *     (FanoutJobRecord's own doc comment above explains why this stays a 2-state schema rather than growing a
 *     dedicated DEAD status).
 *   - "wait": PENDING, under the cap, but the row was updated more recently than `graceMs` ago — a fan-out pass
 *     may still be legitimately in flight (this same isolate via `fanoutRetryInFlight`, or, the real reason a
 *     durable grace period exists at all, a DIFFERENT isolate that has not yet been evicted). Retrying here would
 *     race a still-running first attempt into starting duplicate AI-model calls for the same attachment — the
 *     residual risk the prior P0 pass itself flagged as accepted-but-bounded (attempts-capped) rather than solved.
 *   - "retry": PENDING, under the cap, stale enough that whatever pass last touched this row has had long enough
 *     to either finish or actually be gone (eviction, or a genuine crash) — safe to attempt again.
 */
export type FanoutRetryDecision = "none" | "wait" | "retry" | "give-up";

export function fanoutRetryDecision(job: FanoutJobRecord | undefined, nowMs: number, opts: { graceMs: number; maxAttempts: number }): FanoutRetryDecision {
  if (!job || job.status === "DONE") return "none";
  if (job.attempts >= opts.maxAttempts) return "give-up";
  const staleMs = nowMs - Date.parse(job.updatedAt);
  return staleMs < opts.graceMs ? "wait" : "retry";
}

/**
 * When rearmReviewAlarm() (index.ts) should next wake this object purely to check on a fan-out job — folded into
 * that method's own `Math.min(...)` over every open review deadline, so a mail with zero open reviews but a stuck
 * PENDING fan-out job no longer gets its alarm deleted out from under it (the exact gotcha the prior P0 pass
 * flagged live: rearmReviewAlarm() called `ctx.storage.deleteAlarm()` whenever `openDeadlines.length === 0`,
 * with no awareness that anything else might still need a wake-up — confirmed still true against main@1d465dd
 * before this file existed). Returns undefined for the same two "nothing to wait for" cases
 * fanoutRetryDecision() maps to "none"/"give-up" — a job already resolved (one way or the other) needs no future
 * wake-up on its account.
 */
export function fanoutNextWakeAt(job: FanoutJobRecord | undefined, opts: { graceMs: number; maxAttempts: number }): number | undefined {
  if (!job || job.status === "DONE" || job.attempts >= opts.maxAttempts) return undefined;
  return Date.parse(job.updatedAt) + opts.graceMs;
}
