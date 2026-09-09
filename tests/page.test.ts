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
    { name: "apf-gateway", ok: true, status: 200, body: { isolation: "self", wired: true }, selfTest: { passed: 41, total: 41 } },
    { name: "apf-document-host", ok: true, status: 200, body: { isolation: "LOGICAL", capabilities: ["document.stamp", "document.archive"] }, selfTest: { passed: 14, total: 18 } },
    { name: "apf-email-executor", ok: true, status: 200, body: { isolation: "PRINCIPAL", capabilities: ["email.send"] } },
    { name: "apf-mail-ingest", ok: true, status: 200, body: { wired: false } },
    { name: "apf-fakes", ok: true, status: 200, body: { isolation: "LOGICAL" } },
  ],
  capabilities: [
    {
      capability: "document.classify",
      version: "1",
      module: "document-classifier",
      riskClass: "LOW",
      isolationClass: undefined,
      sideEffects: "none",
      usesLlm: true,
      lifecycleStatus: "ACTIVE",
      selfTest: { passed: 18, total: 18 },
      selfTestFixtures: [
        { capability: "document.classify", worker: "apf-gateway", id: "canonical-invoice-cz", kind: "canonical", ok: true, diff: [], at: "2026-09-09T13:20:00Z" },
        { capability: "document.classify", worker: "apf-gateway", id: "injection-approve", kind: "injection", ok: false, diff: ['$.status: "FAILED" != "SUCCEEDED"'], at: "2026-09-09T13:20:00Z" },
      ],
    },
    { capability: "document.stamp", version: "1", module: "document-executor-host", riskClass: "LOW", isolationClass: "LOGICAL", sideEffects: "internal-write", lifecycleStatus: "ACTIVE", selfTest: { passed: 12, total: 14 } },
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
  selfTestAt: "2026-09-09T13:20:00Z",
};

describe("PAGE-FARM-001 renderFarm() actually runs, not just typechecks", () => {
  it("renders without throwing and carries the farm theme + hero image", () => {
    const html = renderFarm(model);
    expect(html).toContain('data-style="farm"');
    expect(html).toContain('src="/farm/ilustrace.png"');
  });

  it("all 7 role sections exist (owner's request 2026-09-09: strana podle rolí z obrázku, ne podle typu dat)", () => {
    const html = renderFarm(model);
    for (const id of ["view-zadani", "view-erwin", "view-argos", "view-kravicky", "view-ohrada", "view-vysledek", "view-denik"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(">Erwin<");
    expect(html).toContain("Argos hlídá");
    expect(html).toContain(">Kravičky<");
    expect(html).toContain(">Výsledek<");
    expect(html).toContain("Audit — Deník");
  });

  it("Kapability karty (na Argosovi) jsou seskupené po modulu (pen), jedna karta pro každou kapabilitu", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    expect(argosSection).toContain(">document-executor-host<");
    expect(argosSection).toContain(">email-executor<");
    expect(argosSection).toContain("document.stamp");
    expect(argosSection).toContain("document.archive");
    expect(argosSection).toContain("QUARANTINED");
  });

  it("Erwin's sekce ukazuje workflows a modely, a apf-gateway je JEHO karta, ne krávy", () => {
    const html = renderFarm(model);
    const erwinSection = html.slice(html.indexOf('id="view-erwin"'), html.indexOf('id="view-argos"'));
    expect(erwinSection).toContain("document-intake");
    expect(erwinSection).toContain("mail-intake");
    expect(erwinSection).toContain("Llama 8B");
    expect(erwinSection).toContain("apf-gateway");

    // owner's screenshot 2026-09-09: "toto je spíš farmář, ne?" — apf-gateway may still be *mentioned* on
    // Kravičky (e.g. the self-test description explains classify/validate run there, in <code>), just never
    // as its own p-card (that exact structural pattern is unique to deployableCard()'s output).
    const kravickySection = html.slice(html.indexOf('id="view-kravicky"'), html.indexOf('id="view-ohrada"'));
    expect(kravickySection).not.toContain('<div class="p-card-head"><code>apf-gateway</code>');
    expect(kravickySection).toContain("apf-document-host");
  });

  it("Ohrada filtruje na WAITING/FAILED/UNKNOWN_OUTCOME a nezahrnuje SUCCEEDED ani PURGED", () => {
    const html = renderFarm(model);
    expect(html).toContain("Ohrada (1)");
    const ohradaSection = html.slice(html.indexOf('id="view-ohrada"'), html.indexOf('id="view-vysledek"'));
    expect(ohradaSection).toContain("wf-waiting1");
    expect(ohradaSection).not.toContain("wf-ok1");
    expect(ohradaSection).not.toContain("wf-purged1");
  });

  it("Výsledek sekce ukazuje statistiky i poslední instance (SUCCEEDED tam být má, na rozdíl od Ohrady)", () => {
    const html = renderFarm(model);
    const vysledekSection = html.slice(html.indexOf('id="view-vysledek"'), html.indexOf('id="view-denik"'));
    expect(vysledekSection).toContain("wf-waiting1");
    expect(vysledekSection).toContain("wf-ok1");
    expect(vysledekSection).toContain("12"); // totalProcessed
  });

  it("self-test výsledky (owner 2026-09-09: 'nevím jestli jsou zdravé, jen je zelené OK') se ukazují na kartách, ne jen jako holé OK/ACTIVE", () => {
    const html = renderFarm(model);
    // apf-gateway (41/41) is Erwin's own card (77), not one of the cows — checked in the Erwin section instead.
    const erwinSection = html.slice(html.indexOf('id="view-erwin"'), html.indexOf('id="view-argos"'));
    expect(erwinSection).toContain("self-test <b>41/41</b>");

    const kravickySection = html.slice(html.indexOf('id="view-kravicky"'), html.indexOf('id="view-ohrada"'));
    expect(kravickySection).toContain("self-test <b>14/18</b>");
    expect(kravickySection).toContain("naposledy proběhlo 2026-09-09 13:20:00");
    // apf-mail-ingest and apf-fakes never had a self-test recorded — must say so plainly, not silently omit it.
    expect(kravickySection).toContain("self-test: nikdy");

    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    expect(argosSection).toContain("self-test <b>18/18</b>");
    expect(argosSection).toContain("self-test <b>12/14</b>");

    // Never-run summary: no selfTestAt at all, no capability/deployable carries a selfTest field.
    const neverRun: FarmModel = { ...model, selfTestAt: undefined, deployables: model.deployables.map((d) => ({ ...d, selfTest: undefined })), capabilities: model.capabilities.map((c) => ({ ...c, selfTest: undefined })) };
    const neverRunHtml = renderFarm(neverRun);
    expect(neverRunHtml).toContain("ještě nikdy neproběhl");
    expect(neverRunHtml).not.toContain("naposledy proběhlo");
  });

  it("owner 2026-09-09 'ale já chci vidět kontroly a i si je být schopen individuálně vyvolat': Argos karta ukáže jednotlivé fixtures a nabídne spustit jen tuhle kapabilitu", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    expect(argosSection).toContain("Zobrazit kontroly (2)");
    expect(argosSection).toContain("canonical-invoice-cz");
    expect(argosSection).toContain("injection-approve");
    expect(argosSection).toContain("$.status: &quot;FAILED&quot; != &quot;SUCCEEDED&quot;");
    expect(argosSection).toContain('action="/farm/self-test?capability=document.classify"');
    expect(argosSection).toContain("Spustit jen document.classify");

    // document.archive/email.send carry no selfTestFixtures in this model — no empty <details>, still get the button.
    expect(argosSection).toContain('action="/farm/self-test?capability=document.archive"');
    const archiveCardStart = argosSection.indexOf("document.archive");
    const archiveCardSlice = argosSection.slice(archiveCardStart, archiveCardStart + 400);
    expect(archiveCardSlice).not.toContain("<details>");
  });

  it("renders cleanly with zero capabilities and zero instances (empty-state paths)", () => {
    const empty: FarmModel = { ...model, capabilities: [], instances: [] };
    expect(() => renderFarm(empty)).not.toThrow();
    expect(renderFarm(empty)).toContain("zatím žádné");
  });
});
