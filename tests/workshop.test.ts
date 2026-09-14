// Kravská dílna (HANDOFF 2026-09-14): pure session/prompt logic, no Cloudflare-runtime import — same reasoning
// as self-test.ts/page.ts staying directly testable here. The LLM call itself is a plain LlmAdapter.complete(),
// so a FakeLlmAdapter-style stub stands in for a real model exactly like tests/harness already does elsewhere.
import { describe, expect, it } from "vitest";
import { FakeClock, iso } from "../src/platform/clock.js";
import { buildPrompt, newSession, sendMessage, type WorkshopSession } from "../deploy/cloudflare/apf-gateway/src/workshop.js";
import type { LlmAdapter } from "../src/adapters/llm.js";

const START = "2026-09-14T16:00:00Z";

class StubAdapter implements LlmAdapter {
  readonly modelId = "stub-1";
  readonly promptVersion = "workshop-1";
  calls = 0;
  lastPrompt = "";
  constructor(private readonly reply: string | ((prompt: string) => string) = "OK") {}
  async complete(prompt: string): Promise<string> {
    this.calls += 1;
    this.lastPrompt = prompt;
    return typeof this.reply === "function" ? this.reply(prompt) : this.reply;
  }
}

describe("newSession() — title is the first message, trimmed, never re-typed separately", () => {
  it("uses the first 80 chars of the opening message as the title", () => {
    const clock = new FakeClock(START);
    const long = "a".repeat(100);
    const session = newSession(long, clock);
    expect(session.title).toBe("a".repeat(80));
    expect(session.title.length).toBe(80);
  });

  it("a short message is used in full, sessionId/timestamps are set, messages start empty", () => {
    const clock = new FakeClock(START);
    const session = newSession("Potřebuju krávu na ověření datové schránky", clock);
    expect(session.title).toBe("Potřebuju krávu na ověření datové schránky");
    expect(session.sessionId).toMatch(/^cow-/);
    expect(session.createdAt).toBe(iso(clock.now()));
    expect(session.updatedAt).toBe(iso(clock.now()));
    expect(session.messages).toEqual([]);
  });
});

describe("buildPrompt() — flattens the whole transcript into one string for LlmAdapter.complete()", () => {
  it("admin/ai roles render in order, ending with the model's own turn cue", () => {
    const session: WorkshopSession = {
      sessionId: "cow-1",
      createdAt: START,
      updatedAt: START,
      title: "test",
      messages: [
        { role: "admin", text: "první zpráva", at: START },
        { role: "ai", text: "odpověď", at: START },
      ],
    };
    const prompt = buildPrompt(session, "Erwin");
    expect(prompt).toContain("Admin: první zpráva");
    expect(prompt).toContain("Asistent: odpověď");
    expect(prompt.indexOf("Admin: první zpráva")).toBeLessThan(prompt.indexOf("Asistent: odpověď"));
    expect(prompt.trimEnd().endsWith("Asistent:")).toBe(true);
  });

  it("carries the platform conventions (descriptor/policy/fixtures) so a fresh model turn always sees them, not just turn 1", () => {
    const session = newSession("ahoj", new FakeClock(START));
    const prompt = buildPrompt(session, "Erwin");
    expect(prompt).toContain("descriptor.json");
    expect(prompt).toContain("policy");
    expect(prompt).toContain("VC §5");
    expect(prompt).toContain("Nikdy sám nic nenasazuješ");
  });

  it("farmName is a genuine parameter, not a renamed constant — a different installation gets a different prompt", () => {
    const session = newSession("ahoj", new FakeClock(START));
    const erwin = buildPrompt(session, "Erwin");
    const other = buildPrompt(session, "Testbeda");
    expect(erwin).toContain("farmy Erwin");
    expect(other).toContain("farmy Testbeda");
    expect(erwin).not.toContain("Testbeda");
    expect(other).not.toContain("farmy Erwin");
  });
});

describe("sendMessage() — appends admin text and the model's reply, never mutates the input session", () => {
  it("returns a new session object with both messages appended, in order", async () => {
    const clock = new FakeClock(START);
    const session = newSession("start", clock);
    const adapter = new StubAdapter("navrhuji descriptor.json takto...");
    const after = await sendMessage(session, "doplňuji detail", adapter, clock, "Erwin");
    expect(after).not.toBe(session);
    expect(session.messages).toEqual([]); // original untouched
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]).toMatchObject({ role: "admin", text: "doplňuji detail" });
    expect(after.messages[1]).toMatchObject({ role: "ai", text: "navrhuji descriptor.json takto..." });
  });

  it("the adapter sees the admin's new message inside the prompt it's asked to complete", async () => {
    const clock = new FakeClock(START);
    const session = newSession("start", clock);
    const adapter = new StubAdapter();
    await sendMessage(session, "kráva pro ISDS", adapter, clock, "Erwin");
    expect(adapter.calls).toBe(1);
    expect(adapter.lastPrompt).toContain("Admin: kráva pro ISDS");
  });

  it("a second turn's prompt includes the full prior history, not just the latest message", async () => {
    const clock = new FakeClock(START);
    let session = newSession("start", clock);
    const adapter = new StubAdapter((p) => (p.includes("druhá") ? "druhá odpověď" : "první odpověď"));
    session = await sendMessage(session, "první zpráva", adapter, clock, "Erwin");
    session = await sendMessage(session, "druhá zpráva", adapter, clock, "Erwin");
    expect(adapter.lastPrompt).toContain("Admin: první zpráva");
    expect(adapter.lastPrompt).toContain("Asistent: první odpověď");
    expect(adapter.lastPrompt).toContain("Admin: druhá zpráva");
    expect(session.messages).toHaveLength(4);
  });
});
