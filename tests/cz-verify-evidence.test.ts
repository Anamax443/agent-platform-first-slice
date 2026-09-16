// CZV-EVD family: cz.company.verify/cz.vat.verify sealing their result into the Žlab (SEVERKA.md
// "Průsvitná stáj" / HANDOFF 143-144). Not a re-test of EvidenceWriter's own trust boundary — that's
// EW-* in tests/evidence-writer.test.ts — this proves the two real capabilities actually call it
// through the live slice (command -> dispatch -> handler -> ledger), the first capabilities to do so.
import { describe, expect, it } from "vitest";
import { FakeAresAdapter } from "../src/adapters/ares.js";
import { FakeMojeDaneAdapter } from "../src/adapters/moje-dane.js";
import { sha256 } from "../src/platform/artifacts.js";
import { command, createSlice, dispatch, ORCHESTRATOR, TENANT_A } from "./harness/index.js";

describe("CZV-EVD-001 cz.company.verify seals a Žlab record for a SUCCEEDED (found, active) lookup", () => {
  it("record carries companyId, the ICO's hash, ACTIVE, and verifies clean", async () => {
    const slice = createSlice({ ares: new FakeAresAdapter("ok") });
    const msg = command(slice, { capability: "cz.company.verify", payload: { ico: "27074358" } });
    const result = await dispatch(slice, msg, ORCHESTRATOR);
    expect(result.status).toBe("SUCCEEDED");

    const records = slice.evidence.forTenant(TENANT_A);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.producerId).toBe("cz.company.verify");
    expect(record.inputField).toBe("supplier.companyId");
    expect(record.authorityDomain).toBe("cz.company.registry"); // stamped from config/local-fakes/authorities.json, never by the cow (M0 C-1)
    expect(record.expiresAt).toBeDefined(); // capped by the grant TTL (P30D)
    expect(record.inputValueHash).toBe(sha256("27074358"));
    expect(record.result).toBe("ACTIVE");
    expect(record.tenantId).toBe(TENANT_A);
    expect(slice.evidence.verify(record)).toEqual({ ok: true });
  });
});

describe("CZV-EVD-002 cz.company.verify seals NOT_FOUND for an ICO absent from ARES — a business result, not a skipped record", () => {
  it("the not-found business outcome is still sealed, with result NOT_FOUND", async () => {
    const slice = createSlice({ ares: new FakeAresAdapter("ok") });
    const msg = command(slice, { capability: "cz.company.verify", payload: { ico: "00000000" } });
    const result = await dispatch(slice, msg, ORCHESTRATOR);
    expect(result.status).toBe("SUCCEEDED");

    const records = slice.evidence.forTenant(TENANT_A);
    expect(records).toHaveLength(1);
    expect(records[0]!.result).toBe("NOT_FOUND");
  });
});

describe("CZV-EVD-003 cz.vat.verify seals a Žlab record naming vatId, result = MOJE daně's own reliability vocabulary", () => {
  it("record carries vatId, the DIČ's hash, and the raw ANO/NE/NENALEZEN value unchanged", async () => {
    const slice = createSlice({ mojeDane: new FakeMojeDaneAdapter("ok") });
    const msg = command(slice, { capability: "cz.vat.verify", payload: { dic: "99999999" } });
    const result = await dispatch(slice, msg, ORCHESTRATOR);
    expect(result.status).toBe("SUCCEEDED");

    const records = slice.evidence.forTenant(TENANT_A);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.producerId).toBe("cz.vat.verify");
    expect(record.inputField).toBe("supplier.vatId");
    expect(record.authorityDomain).toBe("cz.vat.registry");
    expect(record.expiresAt).toBeDefined();
    expect(record.inputValueHash).toBe(sha256("99999999"));
    expect(record.result).toBe("ANO");
  });
});

describe("CZV-EVD-004 a FAILED outcome never reaches the Žlab — it holds completed verifications, not attempts", () => {
  it("cz.company.verify FAILED (ARES unavailable) leaves the tenant's evidence empty", async () => {
    const slice = createSlice({ ares: new FakeAresAdapter("unavailable") });
    const msg = command(slice, { capability: "cz.company.verify", payload: { ico: "27074358" } });
    const result = await dispatch(slice, msg, ORCHESTRATOR);
    expect(result.status).toBe("FAILED");
    expect(slice.evidence.forTenant(TENANT_A)).toHaveLength(0);
  });

  it("cz.vat.verify FAILED (MOJE daně unavailable) leaves the tenant's evidence empty", async () => {
    const slice = createSlice({ mojeDane: new FakeMojeDaneAdapter("unavailable") });
    const msg = command(slice, { capability: "cz.vat.verify", payload: { dic: "99999999" } });
    const result = await dispatch(slice, msg, ORCHESTRATOR);
    expect(result.status).toBe("FAILED");
    expect(slice.evidence.forTenant(TENANT_A)).toHaveLength(0);
  });
});

describe("CZV-EVD-005 two verifications of the same capability each get their own record — Žlab is append-only, never overwritten", () => {
  it("re-verifying the same ICO twice produces two distinct recordIds, both present", async () => {
    const slice = createSlice({ ares: new FakeAresAdapter("ok") });
    await dispatch(slice, command(slice, { capability: "cz.company.verify", payload: { ico: "27074358" } }), ORCHESTRATOR);
    await dispatch(slice, command(slice, { capability: "cz.company.verify", payload: { ico: "27074358" } }), ORCHESTRATOR);

    const records = slice.evidence.forTenant(TENANT_A);
    expect(records).toHaveLength(2);
    expect(records[0]!.recordId).not.toBe(records[1]!.recordId);
  });
});
