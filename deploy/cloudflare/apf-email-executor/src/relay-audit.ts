// Split out of index.ts so it can be unit-tested without pulling in the "apf:installation" wrangler alias (which only
// resolves through farm-config.mjs, not vitest). No installation-bound value belongs here regardless.
// Duplicated from apf-document-host/src/relay-audit.ts (celek D2 pattern) rather than shared across deployables —
// each deployable stays self-contained, same convention as the rest of this repo's deploy/cloudflare tree.
import type { AuditRecord, AuditTrail } from "../../../../src/platform/audit.js";
import { iso, type Clock } from "../../../../src/platform/clock.js";
import { newId } from "../../../../src/platform/ids.js";

export const GATEWAY_ORIGIN = "https://apf-gateway.internal";

/**
 * Structural subset of Cloudflare's `Fetcher`/`ExecutionContext`, so this file type-checks under both the root
 * tsconfig (no workers-types, needed so `tests/dh.test.ts` can import it directly) and
 * `deploy/cloudflare/tsconfig.json` (real Workers types). The real objects passed in from index.ts satisfy these
 * structurally; nothing changes at runtime.
 */
export interface GatewayFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Appends locally (for this request's evidence) and relays to the gateway's shared trail. `append()` itself stays
 * synchronous (AuditTrail contract, FOUNDATION-core §7 — every existing caller expects an immediate return), so the
 * relay fetch is not awaited here. Instead every relay promise is tracked in `pending`; the `/dispatch` handler
 * awaits `flush()` right before it returns, so the response is never sent while a relay is still in flight.
 * Without this, `ctx.waitUntil` alone was observed to lose the relay silently: the isolate was recycled before the
 * fetch settled, so neither its `.then` nor its `.catch` ever ran (found live on farm-bass443, 2026-09-07 — three
 * `document.stamp` audit records never reached D1, with no error logged anywhere).
 */
export class RelayAudit implements AuditTrail {
  private readonly records: AuditRecord[] = [];
  private readonly pending: Promise<void>[] = [];
  constructor(
    private readonly clock: Clock,
    private readonly gateway: GatewayFetcher,
    private readonly ctx: WaitUntilContext,
  ) {}

  append(record: Omit<AuditRecord, "auditId" | "at">): AuditRecord {
    const full: AuditRecord = { auditId: newId("aud"), at: iso(this.clock.now()), ...record };
    this.records.push(full);
    console.log(`[apf-email-executor] ${full.kind} ${full.capability ?? ""} workflowId=${full.workflowId ?? "-"} correlationId=${full.correlationId ?? "-"} :: ${JSON.stringify(full.details ?? {})}`);
    const relay = this.gateway
      .fetch(`${GATEWAY_ORIGIN}/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(full) })
      .then((res) => {
        if (!res.ok) console.error(`[apf-email-executor] audit relay to gateway answered HTTP ${res.status} for ${full.auditId}`);
      })
      .catch((e) => console.error(`[apf-email-executor] audit relay to gateway unreachable for ${full.auditId}: ${e instanceof Error ? e.message : String(e)}`));
    this.pending.push(relay);
    this.ctx.waitUntil(relay);
    return full;
  }
  /** Await every relay started so far. Call before the handler returns — never rely on `ctx.waitUntil` alone (see class comment). */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
  all(): readonly AuditRecord[] {
    return [...this.records];
  }
  byKind(kind: AuditRecord["kind"]): AuditRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }
  byCorrelation(correlationId: string): AuditRecord[] {
    return this.records.filter((r) => r.correlationId === correlationId);
  }
}
