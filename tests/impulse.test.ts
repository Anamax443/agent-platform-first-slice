// IMP family: normalizeImpulse() (docs/AUTONOMOUS-RUNTIME-V1.md część 5, src/platform/impulse.ts) — the
// normalize() step of the new /impulse ingress contract. Bar this file holds it to, straight from the ADR:
// channel-agnostic, no workflow/goal/intent field anywhere in the output (case.ts's own structural
// invariant — NormalizedImpulse has no such field to begin with), no I/O, fails closed on an impulse that
// would carry nothing at all.
import { describe, expect, it } from "vitest";
import { newCase } from "../src/platform/case.js";
import { ImpulseError, normalizeImpulse, type ImpulseInput } from "../src/platform/impulse.js";

const TENANT = "tenant-42";
const RECEIVED_AT = "2026-09-19T09:00:00Z";

function input(overrides: Partial<ImpulseInput> = {}): ImpulseInput {
  return {
    channel: "api",
    tenantId: TENANT,
    impulseId: "imp-1",
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe("normalizeImpulse", () => {
  it("IMP-000: text-only impulse carries channel/tenant/receivedAt/text through unchanged", () => {
    const impulse = normalizeImpulse(input({ text: "jake bude zitra pocasi?" }));
    expect(impulse).toEqual({
      impulseId: "imp-1",
      tenantId: TENANT,
      channel: "api",
      receivedAt: RECEIVED_AT,
      text: "jake bude zitra pocasi?",
      artifacts: [],
      metadata: {},
    });
  });

  it("IMP-001: attachments become ArtifactRefs, in order, never touched/reinterpreted", () => {
    const impulse = normalizeImpulse(input({ attachments: ["art-a", "art-b"] }));
    expect(impulse.artifacts).toEqual([{ artifactId: "art-a" }, { artifactId: "art-b" }]);
  });

  it("IMP-002: text and attachments may both be present at once", () => {
    const impulse = normalizeImpulse(input({ text: "see attached", attachments: ["art-a"] }));
    expect(impulse.text).toBe("see attached");
    expect(impulse.artifacts).toEqual([{ artifactId: "art-a" }]);
  });

  it("IMP-003: empty channel is rejected (ImpulseError), never silently accepted", () => {
    expect(() => normalizeImpulse(input({ channel: "", text: "hi" }))).toThrow(ImpulseError);
    expect(() => normalizeImpulse(input({ channel: "   ", text: "hi" }))).toThrow(ImpulseError);
  });

  it("IMP-004: an impulse with neither text nor attachments is rejected, not accepted as an empty Case seed", () => {
    expect(() => normalizeImpulse(input())).toThrow(ImpulseError);
    expect(() => normalizeImpulse(input({ text: "" }))).toThrow(ImpulseError);
    expect(() => normalizeImpulse(input({ text: "   " }))).toThrow(ImpulseError);
    expect(() => normalizeImpulse(input({ attachments: [] }))).toThrow(ImpulseError);
  });

  it("IMP-005: whitespace-only text is treated as absent, same as empty", () => {
    expect(() => normalizeImpulse(input({ text: "   ", attachments: [] }))).toThrow(ImpulseError);
    const impulse = normalizeImpulse(input({ text: "   ", attachments: ["art-a"] }));
    expect(impulse.text).toBeUndefined();
  });

  it("IMP-006: sender/thread/metadata pass through only when given, never defaulted to a truthy placeholder", () => {
    const bare = normalizeImpulse(input({ text: "hi" }));
    expect(bare.sender).toBeUndefined();
    expect(bare.thread).toBeUndefined();
    expect(bare.metadata).toEqual({});

    const full = normalizeImpulse(input({ text: "hi", sender: "user@example.com", thread: "thread-1", metadata: { subject: "hello" } }));
    expect(full.sender).toBe("user@example.com");
    expect(full.thread).toBe("thread-1");
    expect(full.metadata).toEqual({ subject: "hello" });
  });

  it("IMP-007: output never carries a workflow/goal/intent field, structurally (AR-2) — no stray key survives a real impulse", () => {
    const impulse = normalizeImpulse(input({ text: "hi", metadata: { subject: "x" } }));
    const keys = Object.keys(impulse).sort();
    expect(keys).toEqual(["artifacts", "channel", "impulseId", "metadata", "receivedAt", "tenantId", "text"].sort());
    expect(keys).not.toContain("workflow");
    expect(keys).not.toContain("goal");
    expect(keys).not.toContain("intent");
  });

  it("IMP-008: channel is carried verbatim — normalize() never maps/interprets it into a route or capability", () => {
    for (const channel of ["mail", "telegram", "api", "folder", "weird-future-channel"]) {
      expect(normalizeImpulse(input({ channel, text: "x" })).channel).toBe(channel);
    }
  });

  it("IMP-009: performs no I/O and returns synchronously — a plain function call, not a Promise", () => {
    const result = normalizeImpulse(input({ text: "hi" }));
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("IMP-010: feeding the result straight into newCase() (no instance) yields an UNSTARTED, zero-instance Case — the /impulse contract end to end at the pure-function level", () => {
    const impulse = normalizeImpulse(input({ text: "hi" }));
    const c = newCase({ caseId: "case-1", impulse });
    expect(c.status).toBe("UNSTARTED");
    expect(c.instances).toEqual([]);
    expect(c.tenantId).toBe(TENANT);
    expect(c.impulse).toEqual(impulse);
  });
});
