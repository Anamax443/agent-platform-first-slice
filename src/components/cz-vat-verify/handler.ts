// cz.vat.verify/1: deterministic module, no AI. Verifies VAT reliability and published bank accounts
// against MOJE daně (Finanční správa). "DIČ does not exist" (NENALEZEN) is a business result
// (found: false), not a technical error — same pattern as cz.company.verify's not-found and
// document.classify's OTHER (SEVERKA docs/SEVERKA.md "## Připravované doménové COW").
import { MojeDaneUnavailable, type MojeDaneAdapter } from "../../adapters/moje-dane.js";
import { capabilityError, DependencyTimeout, iso, platformError, withTimeout } from "../../platform/api.js";
import type { Clock, Handler, HandlerOutcome, Provenance } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export interface VatVerifierDeps {
  mojeDane: MojeDaneAdapter;
  clock: Clock;
  mojeDaneTimeoutMs?: number;
}

interface Input {
  dic: string;
}

const RELIABILITY = new Set(["ANO", "NE", "NENALEZEN"]);

export function createVatVerifier(deps: VatVerifierDeps): Handler {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  const provenance: Provenance = { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion };

  return async ({ message }) => {
    const p = message.payload as unknown as Input;
    const verifiedAt = iso(deps.clock.now());

    try {
      const record = await withTimeout(deps.mojeDane.lookup(p.dic), deps.mojeDaneTimeoutMs ?? 5_000);
      // INT-FAIL-004a-style range check: a response from MOJE daně is untrusted data, same as any adapter response.
      if (!RELIABILITY.has(record.reliability) || !Array.isArray(record.publishedAccounts)) {
        return failed(capabilityError("REGISTRY_RESPONSE_INVALID", "VALIDATION", false, "MOJE daně returned a malformed record", { dic: p.dic }));
      }
      return {
        status: "SUCCEEDED",
        payload: {
          dic: p.dic,
          reliability: record.reliability,
          found: record.found,
          companyName: record.companyName,
          publishedAccounts: record.publishedAccounts,
          verifiedAt,
        },
        provenance,
      };
    } catch (e) {
      if (e instanceof DependencyTimeout) return failed(platformError("DEPENDENCY_TIMEOUT", "MOJE daně did not answer before the deadline", { ms: e.ms }));
      if (e instanceof MojeDaneUnavailable) return failed(platformError("DEPENDENCY_UNAVAILABLE", "MOJE daně unavailable"));
      throw e;
    }
  };
}
