// cz.company.verify/1: deterministic module, no AI. Verifies an IČO exists in ARES and whether it is still active.
// "IČO does not exist" is a business result (found: false), not a technical error — same pattern as
// document.classify's OTHER (SEVERKA docs/SEVERKA.md "## Připravované doménové COW").
import { AresSubjectNotFound, AresUnavailable, type AresAdapter } from "../../adapters/ares.js";
import { capabilityError, DependencyTimeout, iso, platformError, withTimeout } from "../../platform/api.js";
import type { Clock, Handler, HandlerOutcome, Provenance } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export interface CompanyVerifierDeps {
  ares: AresAdapter;
  clock: Clock;
  aresTimeoutMs?: number;
}

interface Input {
  ico: string;
}

export function createCompanyVerifier(deps: CompanyVerifierDeps): Handler {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  const provenance: Provenance = { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion };

  return async ({ message }) => {
    const p = message.payload as unknown as Input;
    const verifiedAt = iso(deps.clock.now());

    try {
      const record = await withTimeout(deps.ares.lookup(p.ico), deps.aresTimeoutMs ?? 5_000);
      // INT-FAIL-004a-style range check: a 200 body from ARES is untrusted data, same as any adapter response.
      if (typeof record.obchodniJmeno !== "string" || (record.datumZaniku !== null && typeof record.datumZaniku !== "string")) {
        return failed(capabilityError("REGISTRY_RESPONSE_INVALID", "VALIDATION", false, "ARES returned a malformed record", { ico: p.ico }));
      }
      return {
        status: "SUCCEEDED",
        payload: {
          ico: p.ico,
          found: true,
          active: !record.datumZaniku && record.registraceAktivni,
          companyName: record.obchodniJmeno,
          ceasedOn: record.datumZaniku,
          verifiedAt,
        },
        provenance,
      };
    } catch (e) {
      if (e instanceof AresSubjectNotFound) {
        // Business result, not FAILED: the IČO simply does not exist in ARES.
        return { status: "SUCCEEDED", payload: { ico: p.ico, found: false, active: false, verifiedAt }, provenance };
      }
      if (e instanceof DependencyTimeout) return failed(platformError("DEPENDENCY_TIMEOUT", "ARES did not answer before the deadline", { ms: e.ms }));
      if (e instanceof AresUnavailable) return failed(platformError("DEPENDENCY_UNAVAILABLE", "ARES unavailable"));
      throw e;
    }
  };
}
