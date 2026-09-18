// cz.company.verify/1: deterministic module, no AI. Verifies an IČO exists in ARES and whether it is still active.
// "IČO does not exist" is a business result (found: false), not a technical error — same pattern as
// document.classify's OTHER (SEVERKA docs/SEVERKA.md "## Připravované doménové COW").
import { AresSubjectNotFound, AresUnavailable, type AresAdapter } from "../../adapters/ares.js";
import { CASE_SCOPE, capabilityError, DependencyTimeout, iso, platformError, sha256, TrustedProviderNotConfigured, withTimeout } from "../../platform/api.js";
import type { Clock, EvidenceWriter, Handler, HandlerInput, HandlerOutcome, Provenance } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export interface CompanyVerifierDeps {
  ares: AresAdapter;
  clock: Clock;
  aresTimeoutMs?: number;
  /**
   * Bound to cz.company.verify's own identity by the caller (platform-wiring.ts) — SEVERKA.md
   * "Průsvitná stáj" / HANDOFF 143: a debugger has nothing to show on a breakpoint until the
   * capabilities that verify against authoritative registries actually seal their result into the
   * Žlab. Optional so this handler keeps working (and every existing conformance fixture keeps
   * passing unchanged) for a caller that hasn't wired a writer yet — same "present = used, absent =
   * skipped, never a hard dependency" shape as `aresTimeoutMs`.
   */
  evidence?: EvidenceWriter;
}

interface Input {
  ico: string;
}

export function createCompanyVerifier(deps: CompanyVerifierDeps): Handler {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  const provenance: Provenance = { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion };
  // subject.key "supplier.companyId" = the fact namespace key (contracts/facts.v1.json, M0 část A), also invoice.v1.s naming (NAVRHOVY-LIST-farma.md
  // krok 8a), not the payload's local "ico" — the Žlab record names the business field being
  // verified, not the wire-level parameter name. CASE_SCOPE, no entityId: a singleton fact per Case. reusePolicy
  // is NOT set here — a cow never asserts its own reuse policy (evidence-writer.ts's WriterIdentity doc comment);
  // this producer's writer is bound TENANT_WIDE at construction instead (platform-wiring.ts/slice.ts), since
  // whether a company exists in ARES doesn't depend on which Case asked (docs/AUTONOMOUS-RUNTIME-V1.md część 2).
  const seal = (input: HandlerInput, ico: string, result: string) =>
    deps.evidence?.write(input, { subject: { key: "supplier.companyId", scope: CASE_SCOPE }, inputValueHash: sha256(ico), result });

  return async (input) => {
    const { message } = input;
    const p = message.payload as unknown as Input;
    const verifiedAt = iso(deps.clock.now());

    try {
      const record = await withTimeout(deps.ares.lookup(p.ico), deps.aresTimeoutMs ?? 5_000);
      // INT-FAIL-004a-style range check: a 200 body from ARES is untrusted data, same as any adapter response.
      if (typeof record.obchodniJmeno !== "string" || (record.datumZaniku !== null && typeof record.datumZaniku !== "string")) {
        return failed(capabilityError("REGISTRY_RESPONSE_INVALID", "VALIDATION", false, "ARES returned a malformed record", { ico: p.ico }));
      }
      const active = !record.datumZaniku && record.registraceAktivni;
      seal(input, p.ico, active ? "ACTIVE" : "CEASED");
      return {
        status: "SUCCEEDED",
        payload: {
          ico: p.ico,
          found: true,
          active,
          companyName: record.obchodniJmeno,
          ceasedOn: record.datumZaniku,
          verifiedAt,
        },
        provenance,
      };
    } catch (e) {
      if (e instanceof AresSubjectNotFound) {
        // Business result, not FAILED: the IČO simply does not exist in ARES.
        seal(input, p.ico, "NOT_FOUND");
        return { status: "SUCCEEDED", payload: { ico: p.ico, found: false, active: false, verifiedAt }, provenance };
      }
      if (e instanceof DependencyTimeout) return failed(platformError("DEPENDENCY_TIMEOUT", "ARES did not answer before the deadline", { ms: e.ms }));
      if (e instanceof AresUnavailable) return failed(platformError("DEPENDENCY_UNAVAILABLE", "ARES unavailable"));
      // Reliability Gate R4 (18.9.2026 audit): platform-wiring.ts's aresFor() throws this via
      // NotConfiguredAresAdapter when this installation has no real ARES adapter wired and has not opted
      // into the fakes (InstallationProfile.allowUnconfiguredTrustedProviders) — loud and named, instead
      // of the pre-R4 behavior of silently returning FakeAresAdapter's fabricated data as if it were a
      // real ARES answer. See TrustedProviderNotConfigured's doc comment (src/platform/errors.ts).
      if (e instanceof TrustedProviderNotConfigured) return failed(platformError("TRUSTED_PROVIDER_NOT_CONFIGURED", "ARES adapter not configured for this installation"));
      throw e;
    }
  };
}
