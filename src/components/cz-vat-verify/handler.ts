// cz.vat.verify/1: deterministic module, no AI. Verifies VAT reliability and published bank accounts
// against MOJE daně (Finanční správa). "DIČ does not exist" (NENALEZEN) is a business result
// (found: false), not a technical error — same pattern as cz.company.verify's not-found and
// document.classify's OTHER (SEVERKA docs/SEVERKA.md "## Připravované doménové COW").
import { MojeDaneUnavailable, type MojeDaneAdapter } from "../../adapters/moje-dane.js";
import { capabilityError, DependencyTimeout, iso, platformError, sha256, withTimeout } from "../../platform/api.js";
import type { Clock, EvidenceWriter, Handler, HandlerInput, HandlerOutcome, Provenance } from "../../platform/api.js";
import descriptor from "./descriptor.json" with { type: "json" };
import inputSchema from "./input.schema.json" with { type: "json" };
import outputSchema from "./output.schema.json" with { type: "json" };

export { descriptor, inputSchema, outputSchema };

export interface VatVerifierDeps {
  mojeDane: MojeDaneAdapter;
  clock: Clock;
  mojeDaneTimeoutMs?: number;
  /** Same "present = sealed into the Žlab, absent = skipped" shape as cz-company-verify's `evidence`
   * (SEVERKA.md "Průsvitná stáj" / HANDOFF 143) — see that handler's comment for the full reasoning. */
  evidence?: EvidenceWriter;
}

interface Input {
  dic: string;
}

const RELIABILITY = new Set(["ANO", "NE", "NENALEZEN"]);

export function createVatVerifier(deps: VatVerifierDeps): Handler {
  const failed = (error: ReturnType<typeof capabilityError>): HandlerOutcome => ({ status: "FAILED", error });
  const provenance: Provenance = { producerComponent: descriptor.module, producerVersion: descriptor.componentVersion };
  // inputField "vatId" matches invoice.v1's supplier.vatId naming (NAVRHOVY-LIST-farma.md krok 8a).
  const seal = (input: HandlerInput, dic: string, result: string) =>
    deps.evidence?.write(input, { inputField: "vatId", inputValueHash: sha256(dic), result });

  return async (input) => {
    const { message } = input;
    const p = message.payload as unknown as Input;
    const verifiedAt = iso(deps.clock.now());

    try {
      const record = await withTimeout(deps.mojeDane.lookup(p.dic), deps.mojeDaneTimeoutMs ?? 5_000);
      // INT-FAIL-004a-style range check: a response from MOJE daně is untrusted data, same as any adapter response.
      if (!RELIABILITY.has(record.reliability) || !Array.isArray(record.publishedAccounts)) {
        return failed(capabilityError("REGISTRY_RESPONSE_INVALID", "VALIDATION", false, "MOJE daně returned a malformed record", { dic: p.dic }));
      }
      // reliability (ANO/NE/NENALEZEN) is already exactly the kind of capability-specific vocabulary
      // Evidence.result is meant to carry (evidence.ts's own doc comment uses this same example) — sealed as-is.
      seal(input, p.dic, record.reliability);
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
