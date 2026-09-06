// INT family over the network protocol of the fakes (slice Test IDs INT-HTTP-*, outside the norm): the registry client
// meets the same failure classes through HTTP as in process, a chaos switch changes the outcome between two runs
// without a rebuild, a protocol violation ends fail-closed, and the DMS / archive doubles keep the protocol the document
// host will use (unit D). The handler under test is the one apf-fakes runs; here it is called in process over Request.
import { describe, expect, it } from "vitest";
import { HttpRegistryAdapter, type HttpClient } from "../src/adapters/registry.js";
import { createSlice, INVOICE_CZ, runIntake } from "./harness/index.js";
import { postJson, world } from "./harness/fakes-world.js";

describe("INT-HTTP registry over the fakes protocol (same error classes as INT-FAIL, now across a network hop)", () => {
  it("INT-HTTP-001 ok -> validate SUCCEEDED, stamp written once, one registry call", async () => {
    const w = world();
    const slice = createSlice({ registry: w.registry });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    expect(instance.status).toBe("SUCCEEDED");
    expect(instance.steps.find((s) => s.stepId === "validate")?.status).toBe("SUCCEEDED");
    expect(w.registry.calls).toBe(1);
    expect(slice.dms.stampCalls).toBe(1);
  });

  it("INT-HTTP-002 503 -> DEPENDENCY_UNAVAILABLE after 3 attempts; 422 with a code -> REGISTRY_REJECTED and review, no retry", async () => {
    const unavailable = world({ chaos: { "registry.mode": "unavailable" } });
    const a = createSlice({ registry: unavailable.registry });
    const ra = await runIntake(a, { bytes: INVOICE_CZ });
    expect(ra.instance.status).toBe("FAILED");
    expect(ra.instance.steps.find((s) => s.stepId === "validate")?.result?.error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", class: "DEPENDENCY", retryable: true });
    expect(unavailable.registry.calls).toBe(3);

    const business = world({ chaos: { "registry.mode": "business" } });
    const b = createSlice({ registry: business.registry });
    const rb = await runIntake(b, { bytes: INVOICE_CZ });
    expect(business.registry.calls).toBe(1);
    expect(rb.instance.status).toBe("WAITING");
    expect(b.review.get(rb.instance.waiting?.reviewTaskId as string)?.reasonCode).toBe("REGISTRY_REJECTED");
    expect(rb.instance.steps.find((s) => s.stepId === "validate")?.result?.error?.details).toMatchObject({ registryCode: "DOCUMENT_TYPE_UNKNOWN" });
    expect(b.dms.stampCalls).toBe(0);
  });

  it("INT-HTTP-003 schema-valid nonsense over the wire -> VALIDATION (range) / QUALITY + review (semantic), never SUCCEEDED", async () => {
    const range = world({ chaos: { "registry.mode": "nonsense-range" } });
    const a = createSlice({ registry: range.registry });
    const ra = await runIntake(a, { bytes: INVOICE_CZ });
    expect(ra.instance.steps.find((s) => s.stepId === "validate")?.result?.error).toMatchObject({ code: "REGISTRY_RESPONSE_INVALID", class: "VALIDATION", retryable: false });
    expect(ra.instance.status).toBe("FAILED");

    const semantic = world({ chaos: { "registry.mode": "nonsense-semantic" } });
    const b = createSlice({ registry: semantic.registry });
    const rb = await runIntake(b, { bytes: INVOICE_CZ });
    expect(rb.instance.steps.find((s) => s.stepId === "validate")?.result?.error).toMatchObject({ code: "REGISTRY_TYPE_CONFLICT", class: "QUALITY" });
    expect(rb.instance.status).toBe("WAITING");
    expect(a.dms.stampCalls + b.dms.stampCalls).toBe(0);
  });

  it("INT-HTTP-004 late answer -> the caller's deadline wins: DEPENDENCY_TIMEOUT, bounded retries, no write", async () => {
    const w = world({ chaos: { "registry.mode": "timeout", "registry.delayMs": "80" } });
    const slice = createSlice({ registry: w.registry, registryTimeoutMs: 20 });
    const { instance } = await runIntake(slice, { bytes: INVOICE_CZ });
    expect(instance.status).toBe("FAILED");
    const validate = instance.steps.find((s) => s.stepId === "validate");
    expect(validate?.result?.error).toMatchObject({ code: "DEPENDENCY_TIMEOUT", class: "DEPENDENCY", retryable: true });
    expect(validate?.attempt).toBe(3);
    expect(slice.dms.stampCalls).toBe(0);
  });

  it("INT-HTTP-005 a chaos switch flips the outcome between runs of the same slice, without a rebuild", async () => {
    const w = world();
    const slice = createSlice({ registry: w.registry });
    expect((await runIntake(slice, { bytes: INVOICE_CZ })).instance.status).toBe("SUCCEEDED");
    w.chaos.set("registry.mode", "unavailable");
    expect((await runIntake(slice, { bytes: INVOICE_CZ })).instance.status).toBe("FAILED");
    w.chaos.delete("registry.mode");
    expect((await runIntake(slice, { bytes: INVOICE_CZ })).instance.status).toBe("SUCCEEDED");
    expect(w.registry.calls).toBe(1 + 3 + 1);
  });

  it("INT-HTTP-006 unreachable double, garbage 200 and an unknown chaos value all end fail-closed", async () => {
    // The binding itself fails (network): a dependency that cannot be reached is unavailable, retryable, never a crash.
    const down: HttpClient = { fetch: async () => { throw new Error("connection refused"); } };
    const a = createSlice({ registry: new HttpRegistryAdapter(down) });
    const ra = await runIntake(a, { bytes: INVOICE_CZ });
    expect(ra.instance.steps.find((s) => s.stepId === "validate")?.result?.error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(ra.instance.steps.find((s) => s.stepId === "validate")?.attempt).toBe(3);

    // A 200 that is not a record: the validator treats the body as untrusted and ends it as VALIDATION.
    const garbage: HttpClient = { fetch: async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }) };
    const b = createSlice({ registry: new HttpRegistryAdapter(garbage) });
    const rb = await runIntake(b, { bytes: INVOICE_CZ });
    expect(rb.instance.steps.find((s) => s.stepId === "validate")?.result?.error).toMatchObject({ code: "REGISTRY_RESPONSE_INVALID", class: "VALIDATION" });

    // A chaos value nobody defined is refused by the double (500), reported by /chaos, and never guessed as "ok".
    const w = world({ chaos: { "registry.mode": "explode" } });
    const chaos = (await (await w.call("/chaos")).json()) as { invalid: string[] };
    expect(chaos.invalid).toEqual(["registry.mode=explode"]);
    const lookup = await w.call("/registry/lookup", postJson({ documentType: "INVOICE" }));
    expect(lookup.status).toBe(500);
    expect(await lookup.json()).toMatchObject({ error: "CHAOS_MODE_UNKNOWN" });
    const c = createSlice({ registry: w.registry });
    expect((await runIntake(c, { bytes: INVOICE_CZ })).instance.steps.find((s) => s.stepId === "validate")?.result?.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(a.dms.stampCalls + b.dms.stampCalls + c.dms.stampCalls).toBe(0);
  });
});

describe("INT-HTTP DMS and archive doubles keep the protocol the document host will use (unit D)", () => {
  it("INT-HTTP-007 DMS: bearer required only for the write, status and read are open reads (W22), stamp is idempotent per clientRef, unknown-once loses the answer but not the write", async () => {
    const w = world();
    const stamp = { bytes: "faktura", stampText: "PRIJATO", clientRef: "key-1" };
    expect((await w.call("/dms/stamp", postJson(stamp))).status).toBe(401);
    expect((await w.call("/dms/stamp", postJson(stamp, "wrong"))).status).toBe(401);
    // status/read never checked a bearer, matching FakeDmsAdapter (MEASUREMENT W22): no Authorization header at all still works.
    expect((await w.call("/dms/status?clientRef=key-1")).status).toBe(200);
    expect(await (await w.call("/dms/status?clientRef=key-1")).json()).toEqual({ status: "NOT_FOUND" });

    const first = await w.call("/dms/stamp", postJson(stamp, "dms-secret"));
    expect(first.status).toBe(200);
    const record = (await first.json()) as { bytes: string; ref: string };
    expect(record.bytes).toBe("faktura\n--- PRIJATO ---");
    expect(record.ref).toMatch(/^dms-[0-9a-f]{12}$/);
    const again = (await (await w.call("/dms/stamp", postJson(stamp, "dms-secret"))).json()) as { ref: string };
    expect(again.ref).toBe(record.ref);
    expect(await (await w.call("/dms/status?clientRef=key-1", { headers: { authorization: "Bearer dms-secret" } })).json()).toEqual({ status: "DONE" });
    expect(await (await w.call("/dms/read?clientRef=key-1", { headers: { authorization: "Bearer dms-secret" } })).json()).toEqual(record);
    expect((await w.call("/dms/read?clientRef=nobody", { headers: { authorization: "Bearer dms-secret" } })).status).toBe(404);

    // unknown-once: the side effect happens, the first answer is lost, the second answer and the status show the write.
    const u = world({ chaos: { "dms.mode": "unknown-once" } });
    const lost = await u.call("/dms/stamp", postJson({ ...stamp, clientRef: "key-2" }, "dms-secret"));
    expect(lost.status).toBe(500);
    expect(await lost.json()).toEqual({ error: "UNKNOWN_OUTCOME", reconciliationRef: "key-2" });
    expect(await (await u.call("/dms/status?clientRef=key-2", { headers: { authorization: "Bearer dms-secret" } })).json()).toEqual({ status: "DONE" });
    expect((await u.call("/dms/stamp", postJson({ ...stamp, clientRef: "key-2" }, "dms-secret"))).status).toBe(200);
    u.chaos.set("dms.status", "unknown");
    expect(await (await u.call("/dms/status?clientRef=key-2", { headers: { authorization: "Bearer dms-secret" } })).json()).toEqual({ status: "UNKNOWN" });

    // No secret configured on the double = nothing can authenticate, and the answer says why.
    const bare = world({ secrets: {} });
    const refused = await bare.call("/dms/stamp", postJson(stamp, "dms-secret"));
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { message: string }).message).toContain("DMS_SECRET");
  });

  it("INT-HTTP-008 archive: bearer required, put is idempotent per clientRef; /version names the endpoints and the chaos in force", async () => {
    const w = world();
    const put = { bytes: "faktura", sha256: "ab".repeat(32), clientRef: "key-9" };
    expect((await w.call("/archive/put", postJson(put))).status).toBe(401);
    const first = (await (await w.call("/archive/put", postJson(put, "archive-secret"))).json()) as { ref: string };
    expect(first.ref).toMatch(/^arch-[0-9a-f]{12}$/);
    const again = (await (await w.call("/archive/put", postJson(put, "archive-secret"))).json()) as { ref: string };
    expect(again.ref).toBe(first.ref);
    expect((await w.call("/archive/put", postJson({ bytes: "x" }, "archive-secret"))).status).toBe(400);

    const version = (await (await w.call("/version")).json()) as { deployable: string; wired: boolean; endpoints: string[]; chaos: { registry: string; dms: string } };
    expect(version).toMatchObject({ deployable: "apf-fakes", wired: true, chaos: { registry: "ok", dms: "ok" } });
    expect(version.endpoints).toContain("POST /registry/lookup");
    expect((await w.call("/nothing")).status).toBe(404);
  });
});
