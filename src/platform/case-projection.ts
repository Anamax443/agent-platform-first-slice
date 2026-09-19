// CurrentCaseProjection (docs/AUTONOMOUS-RUNTIME-V1.md část 4, TARGET until this file): the deterministic
// materialization of "what this Case currently, provably knows" — the layer AR-1 exists to protect and the
// layer the Planner (planner.ts's plan()) will read `available` from instead of a hand-written list. Built on
// the boundary část 2/część 11 fixed first (Evidence.originCaseId/subject/reusePolicy, EvidenceLedger.forCase(),
// entity-scoped FactAddress) — this file adds nothing to that boundary, it only reads through it.
//
// Hard invariant, reviewed and sharpened by the owner 2026-09-18 (external review of this ADR before this file
// existed): a Projection may carry identity, address, state, provenance and references — NEVER a fact's value.
// Concretely: no field here is ever `record.result` or `record.inputValueHash` or anything derived from them
// beyond "are records at this address consistent with each other" — this module answers "is X known and
// trustworthy right now", never "what is X". A caller that needs the actual value re-reads it from the ledger
// (`EvidenceLedger.get(recordId)`) or the artifact it derives from, through its own, separately-authorized path
// — this module hands out `recordId`s to look up, never the payload.
//
// Second hard invariant from the same review: ambiguity is never silently resolved. Two currently-valid
// records at the same FactAddress that disagree on what they verified (different inputValueHash) are NOT
// collapsed by a "latest wins" heuristic — both are reported BLOCKED, neither is available. A FactAddress is
// grouped by its FULL (scope, key, entityId) tuple, never by `formatFactAddress()`'s string alone (that string
// omits `scope` — two facts sharing key+entityId but declared under different scopes must never be folded
// together on this shortcut).
//
// No AI, no I/O beyond the three reads named in its own input (Case, EvidenceLedger, ArtifactReader) — same
// "platform never reads files itself" discipline fact-catalog.ts holds for its own inputs. Deterministic: the
// same Case+ledger contents+`now` always produce byte-for-byte the same output, regardless of what order the
// ledger's backing store happens to iterate records in (tests/case-projection.test.ts PROJ-009/PROJ-010).
import { AuthorityRegistry } from "./authorities.js";
import type { ArtifactReader } from "./artifacts.js";
import type { ArtifactRef, Case } from "./case.js";
import type { Evidence, EvidenceLedger } from "./evidence.js";
import type { FactAddress } from "./fact-address.js";
import { LifecycleRegistry } from "./lifecycle.js";

export const PROJECTION_SCHEMA_VERSION = 1;

/**
 * Why a FactAddress isn't (or is) usable right now — Milan, 2026-09-18: "implementace musí vědět rozdíl mezi
 * fakt neexistuje a fakt existuje, ale evidence je expired / wrong hash / wrong scope / untrusted." Every
 * category below except AVAILABLE always carries a `reason` (ProjectedFact.reason) built only from ids,
 * timestamps and domain names — never a value.
 */
export type FactAvailability = "AVAILABLE" | "EXPIRED" | "INVALID_EVIDENCE" | "BLOCKED";

export interface ProjectedFact {
  readonly address: FactAddress;
  readonly availability: FactAvailability;
  /** Which sealed record this entry reports on — the caller's handle to re-read the real thing, never the thing itself. */
  readonly recordId: string;
  readonly producerId: string;
  readonly observedAt: string;
  /** Present iff availability !== "AVAILABLE". */
  readonly reason?: string;
}

export interface CurrentCaseProjection {
  readonly projectionSchemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  readonly caseId: string;
  readonly tenantId: string;
  /** The impulse's own artifacts (+ `content`, when the channel set one) — refs only, never bytes. This cut
   * does not additionally walk derived-artifact chains produced by the Case's instances; that is a documented,
   * separate future extension, not silently attempted here. */
  readonly availableArtifacts: readonly ArtifactRef[];
  /** AVAILABLE addresses only, deduplicated — exactly the shape planner.ts's PlanRequest.available wants
   * (address strings via formatFactAddress(), never values). AR-1: addresses, never values. */
  readonly availableFacts: readonly FactAddress[];
  /** Every address this Case's evidence touches, in every category — the full diagnostic picture. Sorted by
   * (scope, key, entityId, recordId) so the output never depends on ledger iteration order. */
  readonly facts: readonly ProjectedFact[];
  /**
   * TARGET, deliberately always [] today: which capabilities are still running/waiting for this Case.
   * `Case.instances` (case.ts) holds only workflowIds, not per-instance execution state — computing this for
   * real needs journal access this function's own input contract (Case + Žlab + Artifact store) does not
   * include, and adding it would pull per-instance execution plumbing into what is meant to stay a pure,
   * evidence-only read. Kept as a field (matching část 4's own draft, "volitelně") so a later step can fill it
   * in without a breaking schema change — bump projectionSchemaVersion when that happens.
   */
  readonly pendingCapabilities: readonly string[];
}

export interface ProjectCurrentCaseInput {
  readonly case: Case;
  readonly ledger: EvidenceLedger;
  /** Accepted for contract completeness (część 4: "čte Case + Žlab + Artifact store") — this cut never calls
   * `.get()` on it (only impulse-level ArtifactRefs are surfaced, never bytes, which AR-1 would forbid handing
   * out as a value anyway). Kept as a required, properly-typed param so a later extension that does need
   * artifact metadata doesn't change this function's call shape. */
  readonly artifacts: ArtifactReader;
  /** ISO instant this projection is computed as of, caller-supplied so the function itself stays pure (no
   * Date.now() — same discipline every other pure platform primitive holds, e.g. entity-continuity.ts). */
  readonly now: string;
  /** Omitting either of these two is safe (fail-closed), never accidentally permissive — but it is also a
   * silent trap worth knowing about before wiring a real caller: `AuthorityRegistry.empty()`/a fresh
   * `LifecycleRegistry()` (this function's own defaults) make EVERY authorityDomain-bearing record BLOCKED
   * unconditionally (empty() has no grants; a plain LifecycleRegistry defaults every producer to QUARANTINED,
   * lifecycle.ts) — not "no opinion", but "always untrusted". A future caller (the Planner integration this
   * module's header describes as TARGET) that forgets to thread the installation's real authorities.json/
   * lifecycle.json through will see every authority-backed fact quietly read as "nothing is trustworthy yet"
   * rather than get an error pointing at the missing wiring. Adversarial verification flagged this
   * (18.9.2026) as worth a comment, not a bug — pass the installation's real registries once that caller exists. */
  readonly authorities?: AuthorityRegistry;
  readonly lifecycle?: LifecycleRegistry;
}

export function projectCurrentCase(input: ProjectCurrentCaseInput): CurrentCaseProjection {
  const authorities = input.authorities ?? AuthorityRegistry.empty();
  const lifecycle = input.lifecycle ?? new LifecycleRegistry();

  // The ONE place case-scoping is applied: forCase() is originCaseId===caseId-or-TENANT_WIDE (evidence.ts,
  // proven by ZLAB-CASE-001) — never forTenant() directly, which would silently leak every other Case's
  // CASE_ONLY evidence into this one.
  const records = input.ledger.forCase(input.case.tenantId, input.case.caseId);
  const checked = records.map((record) => ({ record, ...checkRecord(record, input.ledger, input.now, authorities, lifecycle) }));

  const byAddress = new Map<string, Checked[]>();
  for (const c of checked) {
    const key = addressKey(c.record.subject);
    const list = byAddress.get(key) ?? [];
    list.push(c);
    byAddress.set(key, list);
  }

  const facts: ProjectedFact[] = [];
  for (const group of byAddress.values()) facts.push(...resolveGroup(group));
  facts.sort(compareProjectedFacts);

  const availableFacts: FactAddress[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.availability !== "AVAILABLE") continue;
    const key = addressKey(f.address);
    if (seen.has(key)) continue;
    seen.add(key);
    availableFacts.push(f.address);
  }

  return {
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    caseId: input.case.caseId,
    tenantId: input.case.tenantId,
    availableArtifacts: input.case.impulse.content ? [...input.case.impulse.artifacts, input.case.impulse.content] : input.case.impulse.artifacts,
    availableFacts,
    facts,
    pendingCapabilities: [],
  };
}

interface Checked {
  record: Evidence;
  availability: FactAvailability;
  reason?: string;
}

/** Per-record trust check — same chain as aggregator.ts's (Dojička) own `aggregate()`, minus the checks that
 * don't apply to a case-wide bulk read (tenant is already guaranteed by forCase(); there is no single
 * workflowId to match against, this Case may span several instances by design). */
function checkRecord(record: Evidence, ledger: EvidenceLedger, now: string, authorities: AuthorityRegistry, lifecycle: LifecycleRegistry): { availability: FactAvailability; reason?: string } {
  const integrity = ledger.verify(record);
  if (!integrity.ok) return { availability: "INVALID_EVIDENCE", reason: `integrity check failed: ${integrity.reason}` };
  const lineage = ledger.verifyLineage(record.recordId);
  if (!lineage.ok) return { availability: "INVALID_EVIDENCE", reason: `lineage broken at ${lineage.brokenAt}: ${lineage.reason}` };
  if (record.expiresAt && record.expiresAt < now) return { availability: "EXPIRED", reason: `expired at ${record.expiresAt} (now ${now})` };
  if (record.authorityDomain) {
    const grant = authorities.forProducer(record.producerId);
    const stillGranted = grant?.domain === record.authorityDomain;
    const active = lifecycle.statusOf(record.producerId) === "ACTIVE";
    if (!stillGranted || !active) {
      return { availability: "BLOCKED", reason: `producer ${record.producerId} no longer holds an active grant for domain ${record.authorityDomain} (checked now, not at write time — fail-closed)` };
    }
  }
  return { availability: "AVAILABLE" };
}

/** Resolves one FactAddress's full record group into its final per-record verdicts. Owner, 2026-09-18:
 * "Ambiguity = unavailable, ne heuristika" — two-or-more otherwise-AVAILABLE records at the same address that
 * disagree on inputValueHash are ALL demoted to BLOCKED, never arbitrated by recency or any other heuristic.
 * Records already failing their own check keep their own reason regardless. */
function resolveGroup(group: readonly Checked[]): ProjectedFact[] {
  const passing = group.filter((c) => c.availability === "AVAILABLE");
  if (passing.length > 1 && new Set(passing.map((c) => c.record.inputValueHash)).size > 1) {
    return group.map((c) =>
      c.availability === "AVAILABLE"
        ? toProjectedFact(c.record, "BLOCKED", `${passing.length} currently-valid records at this address disagree on their verified value (different inputValueHash) — ambiguous, never auto-resolved`)
        : toProjectedFact(c.record, c.availability, c.reason),
    );
  }
  return group.map((c) => toProjectedFact(c.record, c.availability, c.reason));
}

/** Every field here is picked by name, never spread from `record` — an Evidence whose `subject` carries an
 * extra enumerable property (nothing upstream of this module validates `subject`'s runtime shape against
 * FactAddress at write time: EvidenceWriter.write()/EvidenceLedger.append() store `claim.subject` verbatim,
 * parseFactAddress()'s own ENTITY_ID_PATTERN check is never invoked on that path) must never carry that
 * property through into the output. Adversarial verification (18.9.2026) found `address: record.subject`
 * doing exactly that; explicit `{ key, scope, entityId }` construction closes it regardless of what else a
 * malformed `subject` object might contain. */
function toProjectedFact(record: Evidence, availability: FactAvailability, reason?: string): ProjectedFact {
  return {
    address: { key: record.subject.key, scope: record.subject.scope, ...(record.subject.entityId !== undefined ? { entityId: record.subject.entityId } : {}) },
    availability,
    recordId: record.recordId,
    producerId: record.producerId,
    observedAt: record.observedAt,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Groups by the FULL address, not formatFactAddress() (which omits `scope`) — two facts that share
 * key+entityId under different scopes must never be folded together by this shortcut. JSON.stringify of the
 * 3-tuple, not template-literal concatenation with a "::" separator — a naive `${scope}::${key}::${entityId}`
 * lets two DIFFERENT addresses collide onto the same key whenever "::" itself appears inside a scope or key
 * value (e.g. scope "a::b"+key "c" vs. scope "a"+key "b::c" both concatenate to "a::b::c::d"), silently
 * merging unrelated facts as if they disagreed on the same one. Adversarial verification (18.9.2026) found
 * this exact collision live; JSON.stringify's own escaping of embedded delimiter characters closes it.
 */
function addressKey(a: FactAddress): string {
  return JSON.stringify([a.scope, a.key, a.entityId ?? null]);
}

function compareProjectedFacts(a: ProjectedFact, b: ProjectedFact): number {
  return addressKey(a.address).localeCompare(addressKey(b.address)) || a.recordId.localeCompare(b.recordId);
}
