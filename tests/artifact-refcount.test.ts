// Reliability Gate R0 (commit 1d465dd, src/platform/r2-refcount.ts): purge() used to delete a content-addressed R2
// object unconditionally, even when a second Case's artifact still pointed at that same key. This is the module's
// own test, same real-SQL-via-node:sqlite pattern tests/zlab-mirror.test.ts already uses for evidence-mirror.ts
// (openAsyncSql from tests/harness/sqlite.ts) — no new test harness needed, against the real R2_REF_DDL table, not
// a mock.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerR2Refs, releaseR2Ref, R2_REF_DDL, SqliteR2RefCounter } from "../src/platform/r2-refcount.js";
import { tmpDir } from "./harness/index.js";
import { openAsyncSql } from "./harness/sqlite.js";

async function counter() {
  const d1 = openAsyncSql(join(tmpDir(), "d1.sqlite"));
  await d1.sql.run(R2_REF_DDL);
  return { counter: new SqliteR2RefCounter(d1.sql), close: () => d1.close() };
}

describe("Reliability Gate R0 — purge() must not delete an R2 object another Case still references", () => {
  it("the target scenario: two Cases share one R2 key; releasing one while the other still holds it must not clear it, releasing both must", async () => {
    const f = await counter();
    await registerR2Refs([{ r2Key: "originals/tenant-a/K", workflowId: "wf-caseA", tenantId: "tenant-a" }], f.counter);
    await registerR2Refs([{ r2Key: "originals/tenant-a/K", workflowId: "wf-caseB", tenantId: "tenant-a" }], f.counter);

    // Case A is purged first: Case B's own claim on the same key is still there, so the R2 object must survive.
    expect(await releaseR2Ref("originals/tenant-a/K", "wf-caseA", f.counter)).toEqual({ safeToDelete: false });
    expect(await f.counter.hasAny("originals/tenant-a/K")).toBe(true); // Case B's row remains

    // Now Case B is purged too: nothing left claims the key, so it is finally safe to delete from R2.
    expect(await releaseR2Ref("originals/tenant-a/K", "wf-caseB", f.counter)).toEqual({ safeToDelete: true });
    expect(await f.counter.hasAny("originals/tenant-a/K")).toBe(false);
    f.close();
  });

  it("registering the same (key, workflowId) pair twice — one Case's own duplicate attachment, or copyOut() re-running — collapses to one row: a single release fully clears it", async () => {
    const f = await counter();
    // Two identical attachments in the same email both resolve to the same sha256, so copyOut() would register
    // the same (r2Key, workflowId) pair twice within one instance's own artifact list.
    await registerR2Refs([{ r2Key: "originals/tenant-a/K", workflowId: "wf-caseA", tenantId: "tenant-a" }], f.counter);
    await registerR2Refs([{ r2Key: "originals/tenant-a/K", workflowId: "wf-caseA", tenantId: "tenant-a" }], f.counter);
    expect(await f.counter.hasAny("originals/tenant-a/K")).toBe(true);

    // One release is enough — INSERT OR IGNORE on the composite (r2_key, workflow_id) PRIMARY KEY means the
    // second addRef() never created a second row a second release would be needed to clear.
    expect(await releaseR2Ref("originals/tenant-a/K", "wf-caseA", f.counter)).toEqual({ safeToDelete: true });
    f.close();
  });

  it("a key that was never registered at all releases as safeToDelete: true — the same code path also (deliberately, not fully closed) covers the copyOut() timing race", async () => {
    const f = await counter();
    // No addRef() ever ran for this key. This is correct for a genuinely orphaned artifact nobody ever claimed —
    // but it is the EXACT SAME return value a purge() would see if a second Case had already written this same
    // content-addressed key to R2 and to its own artifact table, but its own copyOut() (which runs via
    // ctx.waitUntil(), after its own request already returned — see index.ts's copyOut() doc comment) simply has
    // not reached D1 yet at the moment this purge() runs. This test intentionally documents that this module does
    // NOT distinguish the two: closing that window would require making artifact registration synchronous inside
    // the request path (intake()/mailIntake()), which is out of scope here — see this commit's message and
    // r2-refcount.ts's own header. Left as a named, bounded residual risk, not silently passed over.
    expect(await releaseR2Ref("originals/tenant-a/never-registered", "wf-caseA", f.counter)).toEqual({ safeToDelete: true });
    f.close();
  });

  it("a second registerR2Refs() call for the same entries is a safe no-op — copyOut() can re-register every cycle without unbounded row growth", async () => {
    const f = await counter();
    const entries = [
      { r2Key: "originals/tenant-a/K1", workflowId: "wf-caseA", tenantId: "tenant-a" },
      { r2Key: "derived/tenant-a/K2", workflowId: "wf-caseA", tenantId: "tenant-a" },
    ];
    expect(await registerR2Refs(entries, f.counter)).toBe(2);
    expect(await registerR2Refs(entries, f.counter)).toBe(2); // same count returned — registerR2Refs doesn't filter, addRef() itself no-ops

    // Both keys still resolve to exactly one claim each: no duplicate rows accumulated from the repeat call.
    expect(await releaseR2Ref("originals/tenant-a/K1", "wf-caseA", f.counter)).toEqual({ safeToDelete: true });
    expect(await releaseR2Ref("derived/tenant-a/K2", "wf-caseA", f.counter)).toEqual({ safeToDelete: true });
    f.close();
  });
});
