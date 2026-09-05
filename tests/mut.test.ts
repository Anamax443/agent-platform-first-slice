// MUT family: each MUST mutant removes one guard; the matching BLOCK test must then fail (VERIFICATION-CONTRACT §6).
// These tests assert the NEGATIVE branch: with the mutant on, the forbidden thing happens.
import { describe, expect, it } from "vitest";
import { FakeDmsAdapter } from "../src/adapters/dms.js";
import { command, createSlice, dispatch, INVOICE_CZ, ORCHESTRATOR, ORCHESTRATOR_B, putArtifact, validatedStampPayload } from "./harness/index.js";
import { createRogueArchiveHandler } from "./harness/rogue.js";

describe("MUT mutants prove the BLOCK tests can fail", () => {
  it("MUT-PRIV-001 host without allowlist check runs the stamp handler for an email.send message (SEC-PRIV-001 would fail)", async () => {
    const slice = createSlice({ hostMutants: { skipAllowlist: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "email.send", payload: validatedStampPayload(slice, art) });
    const outcome = await slice.host.handlerFor("document.stamp")({ message: msg, context: slice.gateway.dispatch(msg, ORCHESTRATOR).context });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(slice.dms.stampCalls).toBe(1);
  });

  it("MUT-CTX-001 host without tenant comparison writes for a resource of another tenant (SEC-CTX-002 would fail)", async () => {
    const slice = createSlice({ hostMutants: { skipContextMatch: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const r = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art) }), ORCHESTRATOR_B);
    expect(r.status).toBe("SUCCEEDED");
    expect(slice.dms.stampCalls).toBe(1);
  });

  it("MUT-IDM-001 handler ignoring notValidAfter writes an expired command (IDM-DEADLINE-001 would fail)", async () => {
    const slice = createSlice({ hostMutants: { skipDeadline: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const r = await dispatch(slice, command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), deadlineMs: -60_000 }));
    expect(r.status).toBe("SUCCEEDED");
    expect(slice.dms.stampCalls).toBe(1);
  });

  it("MUT-IDM-002 host without dedup record writes twice for one idempotency key (IDM-REPLAY-001 would fail)", async () => {
    const slice = createSlice({ hostMutants: { skipIdempotencyStore: true } });
    const art = putArtifact(slice, INVOICE_CZ);
    const msg = command(slice, { capability: "document.stamp", payload: validatedStampPayload(slice, art), idempotencyKey: "wf-1:stamp:default:1" });
    await dispatch(slice, msg);
    await dispatch(slice, msg);
    expect(slice.dms.stampCalls).toBe(2);
    expect(slice.audit.byKind("duplicate")).toHaveLength(0);
  });

  it("MUT-HOST-001 resolver in mutant mode hands the neighbour credential to the rogue handler (SEC-HOST-001 would fail)", async () => {
    const dms = new FakeDmsAdapter();
    const slice = createSlice({ dms, archiveHandler: (deps) => createRogueArchiveHandler({ ...deps, dms }) });
    slice.credentials.setMode("mutant");
    const art = putArtifact(slice, INVOICE_CZ);
    const r = await dispatch(slice, command(slice, { capability: "document.archive", payload: { artifactId: art.artifactId, sha256: art.sha256 } }));
    expect(r.status).toBe("SUCCEEDED");
    expect(dms.stampCalls).toBe(1);
    expect(slice.audit.byKind("security").some((a) => a.details?.event === "CREDENTIAL_DENIED")).toBe(false);
  });
});
