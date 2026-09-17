// Split out of store.ts for the same reason apf-document-host/src/relay-audit.ts is split out of that Worker's
// index.ts: store.ts's SqliteArtifacts (and its siblings SqliteJournal/SqliteAudit) are typed against the ambient
// SqlStorage/D1Database globals throughout the file, so importing anything from store.ts — even just a type — pulls
// the whole module into the TypeScript program, and the root tsconfig (no @cloudflare/workers-types, needed so
// tests/*.test.ts can import this file directly) cannot resolve those globals. This file has no such dependency:
// `ArtifactLookup` is satisfied structurally by the real SqliteArtifacts (its get()/putExternal() already match),
// nothing here needs to know that.
import type { Artifact } from "../../../../src/platform/artifacts.js";

/** The one shape this module needs from SqliteArtifacts (store.ts) — satisfied structurally, no import needed. */
export interface ArtifactLookup {
  get(artifactId: string): Artifact | undefined;
  putExternal(input: DerivedArtifactRegistration): Artifact;
}

/**
 * Body of a registration request from a remote executor host that derived an artifact out-of-process and already
 * copied its bytes to R2 itself — apf-document-host/src/artifact-relay.ts is the only caller on the farm today,
 * POSTing this to the gateway's POST /workflow/:id/artifact route (apf-gateway/src/index.ts).
 */
export interface DerivedArtifactRegistration {
  artifactId: string;
  tenantId: string;
  sha256: string;
  contentType: string;
  byteLength: number;
  location: string;
  receivedFrom: string;
  derivedFrom?: string;
  name?: string;
}

export type RegisterDerivedResult = { ok: true; artifact: Artifact } | { ok: false; reason: "INSTANCE_NOT_FOUND" | "TENANT_MISMATCH" | "DERIVED_FROM_NOT_OWNED" };

/**
 * The logic behind the WorkflowInstance Durable Object's `registerDerivedArtifact` RPC method (apf-gateway/src/index.ts).
 * Fixes the notify-step bug (RESOURCE_TENANT_UNRESOLVED, found live on farm-bass443, every mail-intake instance, all
 * day 2026-09-17): document.stamp's derived artifact was minted in apf-document-host's memory and copied to R2, but
 * never registered back with the gateway at all — so email.send's later GET /workflow/:id/artifact/:stampedArtifactId
 * 404d every single time and resourceTenant() failed closed. Now that a remote host CAN register one, it must not be
 * able to register it into an instance that doesn't exist, claim a `tenantId` that contradicts that instance's real
 * tenant, or attribute it (via `derivedFrom`) to an original this same instance never actually held under that same
 * tenant — any of those would let one tenant's remote-host dispatch plant an artifact record it has no claim to
 * (defense in depth: the signed dispatch envelope already scopes the request to one instance/tenant, this is a
 * second, independent check against the instance's own records).
 *
 * The tenantId check mirrors `auditClaimContradicts()` (page.ts, used the same way by the /audit route in index.ts)
 * for the identical threat, found missing here in review the same day this endpoint was added (GW-ARTIFACT-REG-001,
 * second/third major finding): a caller could otherwise legitimately own `derivedFrom` yet still claim an unrelated
 * `tenantId` in the same body, and `putExternal()` (store.ts) would store that spoofed tenantId verbatim — degrading
 * the artifact registry's own record integrity even though today's one consumer (email-executor's resourceTenant())
 * happens to be protected by its own independent TENANT_SCOPE_MISMATCH check downstream.
 */
export function registerDerived(artifacts: ArtifactLookup, instanceTenantId: string | undefined, input: DerivedArtifactRegistration): RegisterDerivedResult {
  if (instanceTenantId === undefined) return { ok: false, reason: "INSTANCE_NOT_FOUND" };
  if (input.tenantId !== instanceTenantId) return { ok: false, reason: "TENANT_MISMATCH" };
  if (input.derivedFrom) {
    const owned = artifacts.get(input.derivedFrom);
    if (!owned || owned.tenantId !== instanceTenantId) return { ok: false, reason: "DERIVED_FROM_NOT_OWNED" };
  }
  return { ok: true, artifact: artifacts.putExternal(input) };
}
