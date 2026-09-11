// PAGE family: /farm actually renders without throwing, with realistic data — the class of bug typecheck and
// `wrangler deploy --dry-run` cannot catch (found live on farm-bass443, HANDOFF 73: a closure inside renderFarm()
// read a `const` before its declaration line ran — a temporal-dead-zone ReferenceError, not a type error).
// page.ts has no Cloudflare-runtime imports (only src/platform types + bank.js/farm-theme.js, both plain strings),
// so it is directly callable here — same reasoning as relay-audit.ts being split out of index.ts for testability.
import { describe, expect, it } from "vitest";
import { composeIncidentAlert, computeWatchdog, reconcileIncidents, renderFarm, type CapabilityRow, type FarmModel, type IncidentRecord, type WatchdogFinding } from "../deploy/cloudflare/apf-gateway/src/page.js";

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
        { capability: "document.classify", worker: "apf-gateway", id: "canonical-invoice-cz", kind: "canonical", description: "Czech invoice with IBAN and VAT; the IBAN also feeds EVD-005.", why: "Kontroluje základní extrakci na reálném českém formátu faktury.", onFailure: "Never shown: this fixture passes.", ok: true, diff: [], at: "2026-09-09T13:20:00Z" },
        { capability: "document.classify", worker: "apf-gateway", id: "injection-approve", kind: "injection", description: "Injected instruction outside the allowlist: quality retry, then a legitimate stamp.", why: "Dokument je vždy DATA, nikdy příkaz platformě.", onFailure: "Capabilitu okamžitě prověřit, zvážit karanténu.", ok: false, diff: ['$.status: "FAILED" != "SUCCEEDED"'], at: "2026-09-09T13:20:00Z" },
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
  now: "2026-09-09T13:25:00Z",
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

  it("owner 2026-09-09 'není špatné, když je vidět co která kontrola kontroluje': a passing check shows its fixture description instead of the useless 'shoda s golden', a failing check still shows the diff", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    expect(argosSection).toContain("Czech invoice with IBAN and VAT; the IBAN also feeds EVD-005.");
    expect(argosSection).not.toContain("shoda s golden");
    // Failing fixture: the diff is the actionable part — must win over the description even though both exist.
    expect(argosSection).toContain("$.status: &quot;FAILED&quot; != &quot;SUCCEEDED&quot;");
    expect(argosSection).not.toContain("Injected instruction outside the allowlist");
  });

  it("owner 2026-09-10 'nestačí PASS/FAIL, chci vědět proč a co dělat': why shows on both outcomes, onFailure only on the failing one", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    // Passing fixture: "why" shows, its "onFailure" text never renders even though the field is set.
    expect(argosSection).toContain("Kontroluje základní extrakci na reálném českém formátu faktury.");
    expect(argosSection).not.toContain("Never shown: this fixture passes.");
    // Failing fixture: both "why" and "onFailure" show.
    expect(argosSection).toContain("Dokument je vždy DATA, nikdy příkaz platformě.");
    expect(argosSection).toContain("Capabilitu okamžitě prověřit, zvážit karanténu.");
  });

  it("Argos tab shows a watchdog verdict banner, not just the Kapability cards", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    expect(argosSection).toContain(">INCIDENT<");
    expect(argosSection).toContain("apf-mail-ingest neodpovídá nebo není zapojen");
    expect(argosSection).toContain("document.archive je v karanténě");
  });

  it("renders cleanly with zero capabilities and zero instances (empty-state paths)", () => {
    const empty: FarmModel = { ...model, capabilities: [], instances: [] };
    expect(() => renderFarm(empty)).not.toThrow();
    expect(renderFarm(empty)).toContain("zatím žádné");
  });
});

describe("computeWatchdog() — Argos's own deterministic verdict (HANDOFF 83, oponentura 'Argos dnes sám nic systematicky nehlídá')", () => {
  it("a farm with a dead worker, a quarantined module and an Ohrada backlog is INCIDENT, not just individually red cards", () => {
    const snapshot = computeWatchdog(model);
    expect(snapshot.level).toBe("INCIDENT");
    expect(snapshot.findings.some((f) => f.level === "INCIDENT" && f.text.includes("apf-mail-ingest"))).toBe(true);
    expect(snapshot.findings.some((f) => f.level === "INCIDENT" && f.text.includes("document.archive"))).toBe(true);
    expect(snapshot.findings.some((f) => f.level === "WARN" && f.text.includes("Ohrad"))).toBe(true);
  });

  it("a clean farm (every worker wired, nothing quarantined, no self-test failures, empty Ohrada, self-test not stale) is HEALTHY with zero findings", () => {
    const clean: FarmModel = {
      ...model,
      deployables: model.deployables.map((d) => ({ ...d, body: { ...(d.body as Record<string, unknown>), wired: true } })),
      capabilities: model.capabilities.map((c) => ({ ...c, lifecycleStatus: "ACTIVE" as const, selfTest: c.selfTest ? { passed: c.selfTest.total, total: c.selfTest.total } : undefined })),
      instances: [],
    };
    const snapshot = computeWatchdog(clean);
    expect(snapshot).toEqual({ level: "HEALTHY", findings: [] });
  });

  it("a capability whose self-test is 0/N (not just partially failing) escalates to INCIDENT, not WARN", () => {
    const classify = model.capabilities.find((c) => c.capability === "document.classify") as CapabilityRow;
    const brokenCapability: FarmModel = { ...model, capabilities: [{ ...classify, selfTest: { passed: 0, total: 18 } }] };
    const snapshot = computeWatchdog(brokenCapability);
    expect(snapshot.level).toBe("INCIDENT");
    expect(snapshot.findings.some((f) => f.level === "INCIDENT" && f.text.includes("0/18"))).toBe(true);
  });

  it("self-test that never ran at all (selfTestAt undefined) is a WARN, not silently HEALTHY", () => {
    const neverRan: FarmModel = { ...model, selfTestAt: undefined, capabilities: [], deployables: model.deployables.map((d) => ({ ...d, body: { ...(d.body as Record<string, unknown>), wired: true } })), instances: [] };
    const snapshot = computeWatchdog(neverRan);
    expect(snapshot.level).toBe("DEGRADED");
    expect(snapshot.findings).toEqual([{ key: "selftest-stale", level: "WARN", text: expect.stringContaining("self-test nikdy neproběhl") }]);
  });

  const cleanBase: FarmModel = {
    ...model,
    deployables: model.deployables.map((d) => ({ ...d, body: { ...(d.body as Record<string, unknown>), wired: true } })),
    capabilities: [],
    instances: [],
  };

  it("dead-man switch (HANDOFF 92, MAJOR 2): selfTestAt older than the 90-minute heartbeat threshold escalates to its own INCIDENT — the scheduled cron itself looks dead, not just 'nobody ran it recently'", () => {
    const stale: FarmModel = { ...cleanBase, selfTestAt: "2026-09-10T08:00:00Z", now: "2026-09-10T09:35:00Z" }; // 95 min gap
    const snapshot = computeWatchdog(stale);
    expect(snapshot.level).toBe("INCIDENT");
    expect(snapshot.findings).toEqual([{ key: "selftest-stale", level: "INCIDENT", text: expect.stringContaining("scheduled self-test") }]);
  });

  it("selfTestAt within the heartbeat threshold (89 min) produces no finding at all — a normal gap between 30-minute ticks", () => {
    const fresh: FarmModel = { ...cleanBase, selfTestAt: "2026-09-10T08:00:00Z", now: "2026-09-10T09:29:00Z" }; // 89 min gap
    expect(computeWatchdog(fresh)).toEqual({ level: "HEALTHY", findings: [] });
  });

  it("alert channel health (HANDOFF 92, MAJOR 3): the most recent attempt failed and nothing later succeeded -> its own INCIDENT finding, so a broken alert channel is visible even though it couldn't announce itself", () => {
    const brokenChannel: FarmModel = { ...cleanBase, alertHealth: { lastAttemptAt: "2026-09-10T09:00:00Z", lastFailureAt: "2026-09-10T09:00:00Z", lastFailureReason: "destination address is not a verified address" } };
    const snapshot = computeWatchdog(brokenChannel);
    expect(snapshot.level).toBe("INCIDENT");
    expect(snapshot.findings).toEqual([{ key: "alert-channel", level: "INCIDENT", text: expect.stringContaining("destination address is not a verified address") }]);
  });

  it("alert channel that failed once but succeeded since is healthy again — no finding, and a fixed earlier failure never resurfaces", () => {
    const recovered: FarmModel = { ...cleanBase, alertHealth: { lastAttemptAt: "2026-09-10T09:10:00Z", lastFailureAt: "2026-09-10T09:00:00Z", lastSuccessAt: "2026-09-10T09:10:00Z", lastFailureReason: "old, now fixed" } };
    expect(computeWatchdog(recovered)).toEqual({ level: "HEALTHY", findings: [] });
  });

  it("alertHealth absent (no send ever attempted on this installation) is not itself a problem — no finding", () => {
    expect(computeWatchdog(cleanBase)).toEqual({ level: "HEALTHY", findings: [] });
  });

  it("MAJOR 5 (HANDOFF 93): a worker whose /capabilities fetch failed gets its own WARN finding, explaining a gap instead of leaving it silent", () => {
    const withGap: FarmModel = { ...cleanBase, capabilitiesUnavailableFrom: ["apf-document-host"] };
    const snapshot = computeWatchdog(withGap);
    expect(snapshot.level).toBe("DEGRADED");
    expect(snapshot.findings).toEqual([{ key: "capabilities-unavailable:apf-document-host", level: "WARN", text: expect.stringContaining("apf-document-host") }]);
  });
});

describe("reconcileIncidents() — Incident Store, first slice (HANDOFF 84 continued, oponentura item 2)", () => {
  const finding = (key: string, level: WatchdogFinding["level"] = "INCIDENT", text = key): WatchdogFinding => ({ key, level, text });

  it("a brand new finding becomes a fresh incident: firstSeenAt = lastSeenAt = now, occurrences 1", () => {
    const changed = reconcileIncidents([], [finding("worker:apf-mail-ingest")], "2026-09-10T10:00:00Z", []);
    expect(changed).toEqual([{ key: "worker:apf-mail-ingest", level: "INCIDENT", text: "worker:apf-mail-ingest", firstSeenAt: "2026-09-10T10:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 1 }]);
  });

  it("the same finding on the next run updates the SAME incident (lastSeenAt moves, occurrences+1, firstSeenAt untouched) instead of creating a second one", () => {
    const existing: IncidentRecord[] = [{ key: "worker:apf-mail-ingest", level: "INCIDENT", text: "old text", firstSeenAt: "2026-09-10T10:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 1 }];
    const changed = reconcileIncidents(existing, [finding("worker:apf-mail-ingest", "INCIDENT", "new text")], "2026-09-10T10:05:00Z", []);
    expect(changed).toEqual([{ key: "worker:apf-mail-ingest", level: "INCIDENT", text: "new text", firstSeenAt: "2026-09-10T10:00:00Z", lastSeenAt: "2026-09-10T10:05:00Z", occurrences: 2 }]);
  });

  it("an open incident whose finding stopped appearing gets resolvedAt set — auto-resolved, not left open forever", () => {
    const existing: IncidentRecord[] = [{ key: "ohrada-backlog", level: "WARN", text: "6 instancí čeká", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 3 }];
    const changed = reconcileIncidents(existing, [], "2026-09-10T10:05:00Z", []);
    expect(changed).toEqual([{ key: "ohrada-backlog", level: "WARN", text: "6 instancí čeká", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 3, resolvedAt: "2026-09-10T10:05:00Z" }]);
  });

  it("already-resolved incidents are untouched history — reappearing with the same key opens a NEW incident, never reopens the old one", () => {
    const existing: IncidentRecord[] = [{ key: "worker:apf-mail-ingest", level: "INCIDENT", text: "old outage", firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:10:00Z", occurrences: 2, resolvedAt: "2026-09-01T00:10:00Z" }];
    const changed = reconcileIncidents(existing, [finding("worker:apf-mail-ingest")], "2026-09-10T10:00:00Z", []);
    expect(changed).toEqual([{ key: "worker:apf-mail-ingest", level: "INCIDENT", text: "worker:apf-mail-ingest", firstSeenAt: "2026-09-10T10:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 1 }]);
  });

  it("a mixed run (one incident continues, a second one is brand new, a third one just resolved) handles all three independently", () => {
    const existing: IncidentRecord[] = [
      { key: "ohrada-backlog", level: "WARN", text: "1 instance čeká", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 1 },
      { key: "selftest-stale", level: "WARN", text: "self-test nikdy neproběhl", firstSeenAt: "2026-09-09T08:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 5 },
    ];
    const changed = reconcileIncidents(existing, [finding("ohrada-backlog", "WARN"), finding("worker:apf-mail-ingest")], "2026-09-10T09:05:00Z", []);
    expect(changed).toHaveLength(3);
    expect(changed.find((i) => i.key === "ohrada-backlog")).toMatchObject({ occurrences: 2, lastSeenAt: "2026-09-10T09:05:00Z", firstSeenAt: "2026-09-10T09:00:00Z" });
    expect(changed.find((i) => i.key === "worker:apf-mail-ingest")).toMatchObject({ occurrences: 1, firstSeenAt: "2026-09-10T09:05:00Z" });
    expect(changed.find((i) => i.key === "selftest-stale")).toMatchObject({ resolvedAt: "2026-09-10T09:05:00Z", occurrences: 5 });
  });

  it("MAJOR 5 (HANDOFF 93): a capability-scoped incident stays OPEN when its capability fell out of this run's known list (a transient capabilitiesOf() fetch failure), instead of falsely resolving", () => {
    const existing: IncidentRecord[] = [{ key: "selftest-degraded:document.stamp", level: "WARN", text: "document.stamp: self-test 12/14", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 1 }];
    // No finding for it this run (capabilitiesOf() failed, document.stamp isn't in knownCapabilities either) —
    // the naive rule ("not seen this run -> resolved") would close it; it must stay untouched instead.
    const changed = reconcileIncidents(existing, [], "2026-09-10T09:30:00Z", ["document.classify"]);
    expect(changed).toEqual([]);
  });

  it("the same capability-scoped incident DOES resolve normally once its capability is genuinely back in the known list with no finding for it", () => {
    const existing: IncidentRecord[] = [{ key: "selftest-degraded:document.stamp", level: "WARN", text: "document.stamp: self-test 12/14", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 1 }];
    const changed = reconcileIncidents(existing, [], "2026-09-10T09:30:00Z", ["document.stamp"]);
    expect(changed).toEqual([{ key: "selftest-degraded:document.stamp", level: "WARN", text: "document.stamp: self-test 12/14", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 1, resolvedAt: "2026-09-10T09:30:00Z" }]);
  });

  it("worker/global-scoped incidents (not capability-scoped) resolve as before regardless of knownCapabilities — they have no silent-absence failure mode to protect against", () => {
    const existing: IncidentRecord[] = [{ key: "ohrada-backlog", level: "WARN", text: "1 instance čeká", firstSeenAt: "2026-09-10T09:00:00Z", lastSeenAt: "2026-09-10T09:00:00Z", occurrences: 1 }];
    const changed = reconcileIncidents(existing, [], "2026-09-10T09:30:00Z", []);
    expect(changed).toEqual([{ ...existing[0], resolvedAt: "2026-09-10T09:30:00Z" }]);
  });
});

describe("composeIncidentAlert() — Argos's e-mail content (HANDOFF 85, oponentura bod 11 'hlídací pes potřebuje štěkat')", () => {
  const opened = (level: WatchdogFinding["level"], text: string): IncidentRecord => ({ key: text, level, text, firstSeenAt: "2026-09-10T10:00:00Z", lastSeenAt: "2026-09-10T10:00:00Z", occurrences: 1 });
  const resolvedAfter = (text: string, firstSeenAt: string, resolvedAt: string): IncidentRecord => ({ key: text, level: "WARN", text, firstSeenAt, lastSeenAt: firstSeenAt, occurrences: 3, resolvedAt });

  it("nothing new and nothing resolved -> undefined, never an empty e-mail", () => {
    expect(composeIncidentAlert([], [])).toBeUndefined();
  });

  it("a new INCIDENT-level finding gets the red icon and shows up under NOVÉ", () => {
    const alert = composeIncidentAlert([opened("INCIDENT", "apf-mail-ingest neodpovídá")], []);
    expect(alert?.subject).toContain("🔴");
    expect(alert?.subject).toContain("1 nový nález");
    expect(alert?.body).toContain("NOVÉ:");
    expect(alert?.body).toContain("[INCIDENT] apf-mail-ingest neodpovídá");
  });

  it("a new finding that's only WARN (no INCIDENT among them) gets the yellow icon, not red", () => {
    const alert = composeIncidentAlert([opened("WARN", "self-test nikdy neproběhl")], []);
    expect(alert?.subject).toContain("🟡");
    expect(alert?.subject).not.toContain("🔴");
  });

  it("only a resolution (nothing new) gets the green icon and shows duration under VYŘEŠENO", () => {
    const alert = composeIncidentAlert([], [resolvedAfter("6 instancí čeká v Ohradě", "2026-09-10T09:00:00Z", "2026-09-10T09:17:00Z")]);
    expect(alert?.subject).toContain("🟢");
    expect(alert?.subject).toContain("1 vyřešený nález");
    expect(alert?.body).toContain("VYŘEŠENO:");
    expect(alert?.body).toContain("6 instancí čeká v Ohradě (trvalo 17 min)");
  });

  it("both new and resolved findings in the same run appear in the same e-mail, each under its own heading", () => {
    const alert = composeIncidentAlert([opened("INCIDENT", "email.send: self-test 0/13")], [resolvedAfter("document.archive je v karanténě", "2026-09-09T08:00:00Z", "2026-09-10T10:00:00Z")]);
    expect(alert?.subject).toContain("1 nový nález");
    expect(alert?.subject).toContain("1 vyřešený nález");
    expect(alert?.body.indexOf("NOVÉ:")).toBeLessThan(alert?.body.indexOf("VYŘEŠENO:") as number);
  });
});

describe("Kapability karta ukazuje Argosův živý nález odděleně od formálního Admission Gate stavu (HANDOFF 89)", () => {
  it("quarantined capability gets its own 'Argos: INCIDENT' badge next to the formal QUARANTINED one — two separate facts, not merged into one", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    const cardStart = argosSection.indexOf(">document.archive<");
    const card = argosSection.slice(cardStart - 200, cardStart + 900);
    expect(card).toContain("QUARANTINED");
    expect(card).toContain("Argos:");
    expect(card).toContain(">INCIDENT<");
  });

  it("a capability with no open Argos finding (email.send: ACTIVE, no self-test data) shows no Argos badge at all", () => {
    const html = renderFarm(model);
    const argosSection = html.slice(html.indexOf('id="view-argos"'), html.indexOf('id="view-kravicky"'));
    const cardStart = argosSection.indexOf(">email.send<");
    const card = argosSection.slice(cardStart - 200, cardStart + 600);
    expect(card).not.toContain("Argos:");
  });
});
