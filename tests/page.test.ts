// PAGE family: /farm actually renders without throwing, with realistic data — the class of bug typecheck and
// `wrangler deploy --dry-run` cannot catch (found live on farm-bass443, HANDOFF 73: a closure inside renderFarm()
// read a `const` before its declaration line ran — a temporal-dead-zone ReferenceError, not a type error).
// page.ts has no Cloudflare-runtime imports (only src/platform types + bank.js/farm-theme.js, both plain strings),
// so it is directly callable here — same reasoning as relay-audit.ts being split out of index.ts for testability.
import { describe, expect, it } from "vitest";
import { renderFarm, type CapabilityRow, type FarmModel } from "../deploy/cloudflare/apf-gateway/src/page.js";

const model: FarmModel = {
  installation: "local-fakes",
  gitSha: "abc1234",
  gatewaySigning: "secret",
  deployables: [
    { name: "apf-gateway", ok: true, status: 200, body: { isolation: "self", wired: true } },
    { name: "apf-document-host", ok: true, status: 200, body: { isolation: "LOGICAL", capabilities: ["document.stamp", "document.archive"] } },
    { name: "apf-email-executor", ok: true, status: 200, body: { isolation: "PRINCIPAL", capabilities: ["email.send"] } },
    { name: "apf-mail-ingest", ok: true, status: 200, body: { wired: false } },
    { name: "apf-fakes", ok: true, status: 200, body: { isolation: "LOGICAL" } },
  ],
  capabilities: [
    { capability: "document.classify", version: "1", module: "document-classifier", riskClass: "LOW", isolationClass: undefined, sideEffects: "none", usesLlm: true, lifecycleStatus: "ACTIVE" },
    { capability: "document.stamp", version: "1", module: "document-executor-host", riskClass: "LOW", isolationClass: "LOGICAL", sideEffects: "internal-write", lifecycleStatus: "ACTIVE" },
    { capability: "document.archive", version: "1", module: "document-executor-host", riskClass: "LOW", isolationClass: "LOGICAL", sideEffects: "internal-write", lifecycleStatus: "QUARANTINED" },
    { capability: "email.send", version: "1", module: "email-executor", riskClass: "MEDIUM", isolationClass: "PRINCIPAL", sideEffects: "external-write", lifecycleStatus: "ACTIVE" },
  ] satisfies CapabilityRow[],
  instances: [
    {
      workflowId: "wf-waiting1",
      workflow: "document-intake",
      workflowVersion: "2",
      tenantId: "tenant-42",
      actorId: "svc-orchestrator",
      status: "WAITING",
      createdAt: "2026-09-09T08:00:00Z",
      updatedAt: "2026-09-09T08:01:00Z",
      steps: [],
    },
    {
      workflowId: "wf-ok1",
      workflow: "document-intake",
      workflowVersion: "2",
      tenantId: "tenant-42",
      actorId: "svc-orchestrator",
      status: "SUCCEEDED",
      createdAt: "2026-09-09T07:00:00Z",
      updatedAt: "2026-09-09T07:01:00Z",
      steps: [],
    },
    { workflowId: "wf-purged1", purged: true, at: "2026-09-09T06:00:00Z" },
  ],
  instanceLimit: 15,
  instanceWindow: "",
  auditLog: [{ at: "2026-09-09T08:00:00Z", kind: "state", workflowId: "wf-ok1", tenantId: "tenant-42", capability: "document.classify", details: {} }],
  inbox: { pending: [], failed: [], batchLimit: 20 },
  workflows: ["document-intake", "mail-intake"],
  models: { default: "llama-8b", choices: [{ key: "llama-8b", label: "Llama 8B", provider: "workers-ai", model: "@cf/meta/llama-3.1-8b", isDefault: true }] },
  stats: { totalProcessed: 12, processedToday: 3, avgProcessingMs: 4200, byType: [{ type: "INVOICE", count: 8 }] },
};

describe("PAGE-FARM-001 renderFarm() actually runs, not just typechecks", () => {
  it("renders without throwing and carries the farm theme + new sections", () => {
    const html = renderFarm(model);
    expect(html).toContain('data-style="farm"');
    expect(html).toContain("Kravičky");
    expect(html).toContain("Argos hlídá");
  });

  it("Kapability karty jsou seskupené po modulu (pen), jedna karta pro každou kapabilitu", () => {
    const html = renderFarm(model);
    expect(html).toContain(">document-executor-host<");
    expect(html).toContain(">email-executor<");
    expect(html).toContain("document.stamp");
    expect(html).toContain("document.archive");
    expect(html).toContain("QUARANTINED");
  });

  it("Ohrada filtruje na WAITING/FAILED/UNKNOWN_OUTCOME a nezahrnuje SUCCEEDED ani PURGED", () => {
    const html = renderFarm(model);
    expect(html).toContain("Ohrada (1)");
    const ohradaSection = html.slice(html.indexOf('id="view-ohrada"'), html.indexOf('id="view-instance"'));
    expect(ohradaSection).toContain("wf-waiting1");
    expect(ohradaSection).not.toContain("wf-ok1");
    expect(ohradaSection).not.toContain("wf-purged1");
  });

  it("renders cleanly with zero capabilities and zero instances (empty-state paths)", () => {
    const empty: FarmModel = { ...model, capabilities: [], instances: [] };
    expect(() => renderFarm(empty)).not.toThrow();
    expect(renderFarm(empty)).toContain("zatím žádné");
  });
});
