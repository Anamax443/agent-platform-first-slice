// IDM family: replay, deadline with clock tolerance, strategy keys.
import { describe, expect, it } from "vitest";
import { FakeRegistryAdapter, RegistryUnavailable } from "../src/adapters/registry.js";
import { newId } from "../src/platform/ids.js";
import { command, createSlice, dispatch, INJECTION_APPROVE_DOC, INVOICE_CZ, putArtifact, runIntake, validatedStampPayload } from "./harness/index.js";

/** Registry that fails N times with 503 and then answers: the technical-retry path. */
class FlakyRegistry extends FakeRegistryAdapter {
  constructor(private failuresLeft: number) {
    super("ok");
  }
  override async lookup(documentType: string) {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      this.calls += 1;
      throw new RegistryUnavailable();
    }
    return super.lookup(documentType);
  }
}

describe("IDM-REPLAY-001 one logical write intent = one side effect", () => {
  it("the same write command delivered three times produces exactly one stamp and the original outcome each time", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), idempotencyKey: "wf-1:stamp:default:1" });
    const r1 = await dispatch(slice, msg);
    const r2 = await dispatch(slice, msg); // redelivery, same messageId
    const r3 = await dispatch(slice, { ...msg, messageId: newId("msg") }); // re-issue, new messageId, same key
    expect(r1.status).toBe("SUCCEEDED");
    expect(r2.payload).toEqual(r1.payload);
    expect(r3.payload).toEqual(r1.payload);
    expect(slice.dms.stampCalls).toBe(1);
    expect(slice.audit.byKind("write-intent")).toHaveLength(1);
    expect(slice.audit.byKind("duplicate")).toHaveLength(2);
    expect(slice.host.remembered("document.stamp", "wf-1:stamp:default:1")?.status).toBe("SUCCEEDED");
  });

  it("technical retry keeps the idempotency key and the step record (FOUNDATION-core §5.2)", async () => {
    const registry = new FlakyRegistry(2);
    const slice = createSlice({ registry });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ, stampText: "VALIDATED INVOICE" });
    expect(instance.status).toBe("SUCCEEDED");
    const validate = instance.steps.filter((s) => s.stepId === "validate");
    expect(validate).toHaveLength(1);
    expect(validate[0]?.attempt).toBe(3);
    expect(validate[0]?.logicalAttempt).toBe(1);
    expect(validate[0]?.idempotencyKey).toBe(`${instance.workflowId}:validate:default:1`);
    expect(registry.calls).toBe(3);
    expect(slice.audit.byKind("dispatch").filter((a) => a.capability === "document.validate")).toHaveLength(3);
  });
});

describe("IDM-DEADLINE deadline checked immediately before the side effect (§5.4)", () => {
  it("IDM-DEADLINE-001 a command delivered after notValidAfter is rejected before the write: retryable false, reissuable true, audited", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), deadlineMs: 10 * 60_000 });
    slice.clock.advance(10 * 60_000 + 31_000);
    const r = await dispatch(slice, msg);
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatchObject({ code: "COMMAND_EXPIRED", class: "POLICY", retryable: false, reissuable: true });
    expect(slice.dms.stampCalls).toBe(0);
    expect(slice.audit.byKind("write-intent")).toHaveLength(0);
    expect(slice.audit.byKind("deny").some((a) => a.details?.code === "COMMAND_EXPIRED")).toBe(true);
  });

  it("IDM-DEADLINE-002 clock skew: 5 s accepted with skew log, 30 s accepted, 60 s rejected", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const cmd = () => command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), deadlineMs: 0 });

    const m5 = cmd();
    slice.clock.advance(5_000);
    expect((await dispatch(slice, m5)).status).toBe("SUCCEEDED");
    expect(slice.host.skewLog.some((s) => s.messageId === m5.messageId && s.skewMs === 5_000)).toBe(true);

    const m30 = cmd();
    slice.clock.advance(30_000);
    expect((await dispatch(slice, m30)).status).toBe("SUCCEEDED");

    const m60 = cmd();
    slice.clock.advance(60_000);
    const r = await dispatch(slice, m60);
    expect(r.error?.code).toBe("COMMAND_EXPIRED");
    expect(slice.dms.stampCalls).toBe(2);
  });
});

describe("IDM-STRAT-001 quality retry never reuses a key", () => {
  it("a new strategy gets a new key (workflowId:stepId:strategy:n) and never a cached outcome", async () => {
    const slice = createSlice();
    const { instance } = await runIntake(slice, { bytes: INJECTION_APPROVE_DOC, stampText: "VALIDATED INVOICE" });
    const classify = instance.steps.filter((s) => s.stepId === "classify");
    expect(classify.map((s) => s.strategy)).toEqual(["llm", "keyword"]);
    expect(classify[0]?.idempotencyKey).toBe(`${instance.workflowId}:classify:llm:1`);
    expect(classify[1]?.idempotencyKey).toBe(`${instance.workflowId}:classify:keyword:2`);
    expect(classify[0]?.result?.status).toBe("FAILED");
    expect(classify[1]?.result?.status).toBe("SUCCEEDED");
  });

  it("at the executor, a new key for the same resource is a new intent; the old key still returns the old outcome", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const first = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art, "INVOICE", "STAMP A"), idempotencyKey: "wf-2:stamp:default:1" }));
    const second = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art, "INVOICE", "STAMP B"), idempotencyKey: "wf-2:stamp:enhanced:2" }));
    const replay = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art, "INVOICE", "STAMP B"), idempotencyKey: "wf-2:stamp:default:1" }));
    expect(slice.dms.stampCalls).toBe(2);
    expect(second.payload?.stampText).toBe("STAMP B");
    expect(replay.payload?.stampText).toBe("STAMP A"); // the key wins, not the payload
    expect(replay.payload).toEqual(first.payload);
  });
});

describe("IDM-HOST-SCOPE-001 dedup is scoped by capability, not by idempotencyKey alone (Posudek 5, W19)", () => {
  it("the same idempotencyKey sent to document.stamp and document.archive on the shared host runs both, never returns one's outcome for the other", async () => {
    const slice = createSlice();
    const art = putArtifact(slice, INVOICE_CZ);
    const key = "shared-key-cross-capability";
    const stamp = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), idempotencyKey: key }));
    const archive = await dispatch(slice, command(slice, { capability: "document.archive", payload: { artifactId: art.artifactId, sha256: art.sha256 }, idempotencyKey: key }));
    expect(stamp.status).toBe("SUCCEEDED");
    expect(archive.status).toBe("SUCCEEDED");
    expect(archive.payload?.archiveRef).toBeDefined(); // not the stamp's payload shape
    expect(slice.dms.stampCalls).toBe(1);
    expect(slice.archive.putCalls).toBe(1); // archive actually ran; a shared bare key would have short-circuited it
    expect(slice.audit.byKind("duplicate")).toHaveLength(0);
    expect(slice.host.remembered("document.stamp", key)).not.toEqual(slice.host.remembered("document.archive", key));
  });
});
