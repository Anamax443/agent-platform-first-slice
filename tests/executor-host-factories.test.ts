// RG2-C (2026-09-18 Reliability Gate audit): ExecutorHost's constructor used to read
// `this.idempotency = opts.idempotency ?? new InMemoryIdempotencyStore()` — idempotency was optional with a
// silent RAM fallback. That exact pattern already caused a real production gap TWICE: docs/POSUDKY.md's MAJOR 4
// (apf-email-executor's ExecutorHost was wired without it, silently non-durable in production, fixed by manually
// adding a DurableIdempotencyStore) and again R1 (mail.ingest's ExecutorHost inside platform-wiring.ts, fixed by
// explicitly threading a durable store through WiringOptions.idempotency). A comment documented the second
// near-miss; nothing structural stopped a third occurrence. This file is that structural stop.
//
// ExecutorHost's constructor is now private and its `idempotency` field is required (executor-host.ts's
// `ExecutorHostOpts`); the only ways to build one are `ExecutorHost.production()` (idempotency required, no
// default) and `ExecutorHost.forTests()` (idempotency optional, explicit RAM-only opt-in). There is nothing to
// runtime-test for the acceptance criterion itself ("production wiring + write/internal-write capability +
// missing durable idempotency -> constructor/wiring FAIL, not a warning") — once the type makes the omission
// impossible to write, the only way to prove the constraint is enforced is to attempt the forbidden call and let
// tsc catch it. `npm run typecheck` and `npm run farm:check`'s own `tsc -p deploy/cloudflare/tsconfig.json` pass
// are what actually enforce the `@ts-expect-error` below; this test file exists so that assertion runs (and this
// test module gets type-checked) on every `npm test` too, not only on an explicit typecheck invocation.
//
// This repo has no prior `@ts-expect-error` convention (grepped for the literal string across the whole repo
// before adding one, per the task's own instruction — none found). `@ts-expect-error` is TypeScript's standard,
// built-in way to assert "the next line must not compile", and it doubles as its own trip-wire: if a future
// change ever makes `idempotency` optional again on `.production()`, the directive becomes an unused
// `@ts-expect-error` directive — itself a `tsc` error — so this test keeps failing loudly either way, never
// silently passing because the thing it was guarding against quietly stopped being true.
import { describe, expect, it } from "vitest";
import { Audit } from "../src/platform/audit.js";
import { FakeClock } from "../src/platform/clock.js";
import { CredentialResolver } from "../src/platform/credentials.js";
import { ExecutorHost } from "../src/platform/executor-host.js";
import { InMemoryIdempotencyStore } from "../src/platform/idempotency.js";

const HOST_ID = "test-rg2c-module";

function deps() {
  const clock = new FakeClock("2026-09-18T08:00:00Z");
  const audit = new Audit(clock);
  const credentials = new CredentialResolver({}, audit);
  return { clock, audit, credentials };
}

describe("RG2-C: ExecutorHost.production() requires a durable idempotency store — no silent constructor fallback", () => {
  it("positive control: ExecutorHost.production() compiles and works with an explicit idempotency store", () => {
    const { clock, audit, credentials } = deps();
    const executor = ExecutorHost.production({ hostId: HOST_ID, clock, audit, credentials, idempotency: new InMemoryIdempotencyStore() });
    expect(executor.capabilities()).toEqual([]);
  });

  it("ExecutorHost.production() without `idempotency` is a compile-time TYPE ERROR, not a runtime warning or silent fallback", () => {
    const { clock, audit, credentials } = deps();
    // @ts-expect-error — `idempotency` is required on ExecutorHostOpts; omitting it here must fail `tsc`, not
    // silently construct an in-memory store. This IS the acceptance test the owner asked for: "production wiring
    // + write/internal-write capability + missing durable idempotency -> constructor/wiring FAIL. Not a
    // warning." If this stops erroring, the directive itself becomes an unused-directive error, so
    // `npm run typecheck` / `npm run farm:check` fail either way.
    ExecutorHost.production({ hostId: HOST_ID, clock, audit, credentials });
  });

  it("ExecutorHost.forTests() still allows omitting idempotency — the named, explicit RAM-only opt-in for plain unit tests", () => {
    const { clock, audit, credentials } = deps();
    const executor = ExecutorHost.forTests({ hostId: HOST_ID, clock, audit, credentials });
    expect(executor.capabilities()).toEqual([]);
  });
});
