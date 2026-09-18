// Reliability Gate R3 (owner's second, "operational resilience" audit, 18.9.2026 — see fanout-retry.ts's own
// file-level doc comment for the full "why"): unit tests for the pure decision logic behind the durable
// attachment-fan-out outbox — missingAttachments() (retry dedup) and fanoutRetryDecision()/fanoutNextWakeAt()
// (staleness/give-up decisions). Deliberately a NEW file, not an extension of tests/attachment-fanout.test.ts:
// that file covers fanOutAttachments()/summarizeFanoutOutcomes() — the shared driver docs/AUTONOMOUS-RUNTIME-V1.md
// część 7 documents as deliberately transitional ("NESMÍ se replikovat"), which this item does not touch at all —
// while the logic tested here is a genuinely separate, index.ts-local concern. Naming follows the existing
// tests/gw-platform-wiring-fanout.test.ts precedent for "gw-" prefixed tests of gateway-composition-adjacent
// logic, and that same file is this test's own precedent that a plain deploy/cloudflare/apf-gateway/src/*.ts file
// (as long as it avoids "cloudflare:workers"/"apf:*" imports, which fanout-retry.ts does) loads fine under plain
// Node vitest despite living under deploy/cloudflare/ — confirmed live before writing this file that index.ts
// itself (imports "cloudflare:workers" at its own line 11) cannot be loaded the same way, which is exactly why
// this logic was split into fanout-retry.ts in the first place rather than left as private WorkflowInstance
// methods.
import { describe, expect, it } from "vitest";
import { fanoutNextWakeAt, fanoutRetryDecision, missingAttachments, type CaseMemberSummary, type FanoutJobRecord } from "../deploy/cloudflare/apf-gateway/src/fanout-retry.js";
import type { AttachmentFanoutAttachment } from "../src/platform/attachment-fanout.js";

const attachment = (artifactId: string, entityId = `ent-${artifactId}`): AttachmentFanoutAttachment => ({ artifactId, entityId });

const job = (overrides: Partial<FanoutJobRecord> = {}): FanoutJobRecord => ({
  workflowId: "wf-mail-1",
  caseId: "case-1",
  status: "PENDING",
  attempts: 1,
  startedAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
  ...overrides,
});

const OPTS = { graceMs: 5 * 60_000, maxAttempts: 5 };

describe("missingAttachments", () => {
  it("returns every attempted attachment unchanged when the Case has no members at all", () => {
    const attempted = [attachment("art-1"), attachment("art-2")];
    expect(missingAttachments([], attempted)).toEqual(attempted);
  });

  it("excludes only the attachment whose artifactId is already an attachment-classify member", () => {
    const caseMembers: CaseMemberSummary[] = [{ workflow: "attachment-classify", artifactId: "art-1" }];
    const attempted = [attachment("art-1"), attachment("art-2")];
    expect(missingAttachments(caseMembers, attempted)).toEqual([attachment("art-2")]);
  });

  it("does not let a mail-intake or attachment-extract member dedup an attachment — only attachment-classify counts", () => {
    // mail-intake's own input.artifactId is a DIFFERENT artifact (the combined mail-body-plus-attachments text,
    // per index.ts's mailIngestPayload() doc comment) — even a coincidental artifactId match there must never
    // count as "this attachment is already handled". attachment-extract's own presence is deliberately not the
    // dedup signal either (fanout-retry.ts's missingAttachments() doc comment: extract's ABSENCE after a
    // successful classify can be a correct, final "not an invoice" outcome, not unfinished work).
    const caseMembers: CaseMemberSummary[] = [
      { workflow: "mail-intake", artifactId: "art-1" },
      { workflow: "attachment-extract", artifactId: "art-2" },
    ];
    const attempted = [attachment("art-1"), attachment("art-2")];
    expect(missingAttachments(caseMembers, attempted)).toEqual(attempted);
  });

  it("preserves the attempted list's own order", () => {
    const caseMembers: CaseMemberSummary[] = [{ workflow: "attachment-classify", artifactId: "art-2" }];
    const attempted = [attachment("art-1"), attachment("art-2"), attachment("art-3")];
    expect(missingAttachments(caseMembers, attempted)).toEqual([attachment("art-1"), attachment("art-3")]);
  });
});

describe("fanoutRetryDecision", () => {
  const now = Date.parse("2026-09-18T10:10:00.000Z"); // 10 minutes after job's updatedAt in job() default

  it("is 'none' when there is no job at all", () => {
    expect(fanoutRetryDecision(undefined, now, OPTS)).toBe("none");
  });

  it("is 'none' for a DONE job regardless of attempts or staleness", () => {
    expect(fanoutRetryDecision(job({ status: "DONE", attempts: 99, updatedAt: "2020-01-01T00:00:00.000Z" }), now, OPTS)).toBe("none");
  });

  it("is 'wait' for a PENDING job updated recently (within the grace period)", () => {
    const recent = job({ updatedAt: new Date(now - 60_000).toISOString() }); // 1 minute ago, grace is 5 minutes
    expect(fanoutRetryDecision(recent, now, OPTS)).toBe("wait");
  });

  it("is 'retry' for a PENDING job that is stale and under the attempts cap", () => {
    const stale = job({ attempts: 2, updatedAt: new Date(now - 6 * 60_000).toISOString() }); // 6 minutes ago
    expect(fanoutRetryDecision(stale, now, OPTS)).toBe("retry");
  });

  it("is 'give-up' for a PENDING job at or over the attempts cap, even if also stale", () => {
    const exhausted = job({ attempts: 5, updatedAt: new Date(now - 6 * 60_000).toISOString() });
    expect(fanoutRetryDecision(exhausted, now, OPTS)).toBe("give-up");
  });

  it("is 'give-up' (not 'wait') when attempts is at the cap even if the row was JUST updated — the cap wins", () => {
    const justFailed = job({ attempts: 5, updatedAt: new Date(now).toISOString() });
    expect(fanoutRetryDecision(justFailed, now, OPTS)).toBe("give-up");
  });
});

describe("fanoutNextWakeAt", () => {
  const opts = OPTS;

  it("is undefined when there is no job", () => {
    expect(fanoutNextWakeAt(undefined, opts)).toBeUndefined();
  });

  it("is undefined for a DONE job", () => {
    expect(fanoutNextWakeAt(job({ status: "DONE" }), opts)).toBeUndefined();
  });

  it("is undefined once the job has exhausted its attempts — rearmReviewAlarm() should not keep waking for a job maybeRetryFanoutJob() has already given up on", () => {
    expect(fanoutNextWakeAt(job({ attempts: 5 }), opts)).toBeUndefined();
  });

  it("is updatedAt + graceMs for a PENDING job still under the attempts cap", () => {
    const updatedAt = "2026-09-18T10:00:00.000Z";
    expect(fanoutNextWakeAt(job({ attempts: 3, updatedAt }), opts)).toBe(Date.parse(updatedAt) + opts.graceMs);
  });
});
