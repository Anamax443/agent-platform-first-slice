// Kravská dílna (owner's request 2026-09-14, "chci vytvářet na webovkách krávy/telata a s pomocí AI je uvádět
// do života"): a conversational drafting assistant, not a code-execution or deploy surface. The AI proposes
// files; nothing here ever writes to disk, opens a PR, or touches the live farm — a human takes the draft from
// here into a real commit through the normal git/PR/deploy pipeline (docs/POSUDKY.md's own "AI drafts, human
// deploys" boundary, matching the owner's standing "never deploy untested" / "AI never writes to production
// without a human click" rules). Persisted as an ordinary D1 audit row (kind "cow-workshop-session"), same
// idiom as self-test-state/certification-state — no new infrastructure.
import type { LlmAdapter } from "../../../../src/adapters/llm.js";
import { iso, type Clock } from "../../../../src/platform/clock.js";
import { newId } from "../../../../src/platform/ids.js";

export interface WorkshopMessage {
  role: "admin" | "ai";
  text: string;
  at: string;
}

export interface WorkshopSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  /** First admin message, trimmed — the session list's own label, never a separately-typed title. */
  title: string;
  messages: WorkshopMessage[];
}

export function newSession(firstMessage: string, clock: Clock): WorkshopSession {
  const now = iso(clock.now());
  return { sessionId: newId("cow"), createdAt: now, updatedAt: now, title: firstMessage.slice(0, 80), messages: [] };
}

/**
 * Platform conventions the AI drafts against — kept here, not fetched from the repo at chat time (no GitHub
 * read access wired in yet, deliberately: today's session works for a brand-new capability out of the box;
 * editing an existing one works too, the admin just pastes the current file(s) into the chat themselves until
 * a later step adds automatic fetch-by-name). cz.company.verify (src/components/cz-company-verify) is the
 * concrete worked example throughout — a real, already-certified cow, not a hypothetical.
 *
 * `farmName` is an installation value (`installation.profile.assistant.displayName`, SEVERKA.md "Tenant
 * Layer"'s own envisioned `assistant.displayName` field), never a literal in this file — a second
 * installation must be able to name its farm/assistant differently without touching code (same "nothing
 * installation-bound is written here" rule platform-wiring.ts's own header comment states).
 */
function systemPrompt(farmName: string): string {
  return `Jsi asistent v "Kravské dílně" farmy ${farmName} (agent-platform-first-slice) — pomáháš adminovi navrhnout novou kravičku (COW, jednoúčelový modul) nebo upravit existující, podle přesných konvencí platformy. Nikdy sám nic nenasazuješ ani nezapisuješ — jen navrhuješ soubory, které si admin sám zkontroluje a prožene přes commit/PR/testy.

Konvence (vzor: src/components/cz-company-verify, real deployed cow "cz.company.verify"):
1. descriptor.json: module (kebab-case), componentVersion, runtime "in-process", capabilities[]: name (domain.action), versions, inputSchema/outputSchema (jméno schématu), conformanceSuiteVersion, conformanceTier, executionMode "sync"|"async", sideEffects "none"|"internal-write"|"external-write", trustClass "deterministic"|"ai-assisted"|"executor", riskClass LOW/MEDIUM/HIGH/CRITICAL, requiredScopes, usesLlm (bool — AI se používá jen když je to nezbytné, ARES/VAT krávy jsou záměrně bez AI), idempotency, reversibility, unknownOutcomeRecovery, humanApproval "none"|"policy", errorCodes[].
2. handler.ts: čistá funkce (deps) => Handler; nikdy nedůvěřuje AI výstupu jako příkazu (dokument/vstup je vždy DATA); chyby přes capabilityError(code, class, retryable, message); timeouty přes withTimeout(); side effecty jen v write kravách, ty jsou vzácné a mají vlastní credential.
3. policy JSON (config/<instalace>/policy/): policyRef, capability, capabilityVersion, owner, grants[] (actorId, scopes, tenants, volitelně rateLimit), approval, failClosed: true (vždy).
4. conformance fixtures: minimum 5 canonical + 1 damaged + 1 injection + 1 boundary (VC §5) — i draft musí navrhnout aspoň kostru fixtures, ne jen kód.

Styl konverzace: ptej se na chybějící detaily (co přesně kráva dělá, jaké API/zdroj dat, jaký risk/side effect), nekresli kód dokud nemáš dost informací. Až jsi připravený navrhnout soubory, ukaž je v blocích:
### FILE: <cesta>
\`\`\`
<obsah>
\`\`\`
Piš česky, stručně, věcně — žádné omluvy ani obecné rady, rovnou k věci.`;
}

/** Flattens the whole conversation into one string — LlmAdapter.complete() takes a single prompt, no
 * system/user split at that layer (same interface document.classify already uses); a fresh prompt is built
 * from the full history every turn since neither adapter holds state between calls. */
export function buildPrompt(session: WorkshopSession, farmName: string): string {
  const transcript = session.messages.map((m) => `${m.role === "admin" ? "Admin" : "Asistent"}: ${m.text}`).join("\n\n");
  return `${systemPrompt(farmName)}\n\n${transcript}\n\nAsistent:`;
}

/** Sends one admin message, gets the AI's reply, returns the session with BOTH appended — never mutates the input. */
export async function sendMessage(session: WorkshopSession, adminText: string, adapter: LlmAdapter, clock: Clock, farmName: string): Promise<WorkshopSession> {
  const afterAdmin: WorkshopSession = {
    ...session,
    updatedAt: iso(clock.now()),
    messages: [...session.messages, { role: "admin", text: adminText, at: iso(clock.now()) }],
  };
  const reply = await adapter.complete(buildPrompt(afterAdmin, farmName));
  return {
    ...afterAdmin,
    updatedAt: iso(clock.now()),
    messages: [...afterAdmin.messages, { role: "ai", text: reply, at: iso(clock.now()) }],
  };
}
