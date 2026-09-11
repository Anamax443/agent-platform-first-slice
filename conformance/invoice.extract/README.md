# Conformance package: invoice.extract/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

## How golden outputs are compared

Golden files are a **subset** of the result envelope: every field present in the golden must be equal in the result, everything else is DON'T CARE. Placeholders `$artifactId`, `$sha256`, `$now` are substituted per run.

| MUST (owner: capability contract, VC §5 "První domény: faktura") | DON'T CARE (provider may vary) |
|---|---|
| `status` | `confidence` per field |
| `payload.companyId.value`, `payload.bankAccount.value`, `payload.invoiceNumber.value`, `payload.totalWithVat.value` — when the golden asserts them | which of the four fields extracted when the fixture doesn't print all of them (absence is never asserted by a subset golden, only presence) |
| `payload.*.source`, `payload.*.trustLevel` where stated | `provenance.modelId`, `promptVersion` (checked by INT-REPLACE-001 changelog rule, not here) |
| `payload.sha256` = hash of the original | diagnostic texts in `error.message` |
| `error.code`, `error.class`, `error.retryable` for FAILED | `error.details` |

DIČ/VAT id, currency and line items are explicitly **not** part of this v1 contract (SEVERKA.md mentions them, VC §5's MUST list for the invoice domain does not) — adding them later is additive (`CDC-ADD-001`), not a breaking change.

## Fixture set

Minimum for the first capability of a new component (VC §5): 5 canonical, 1 damaged, 1 injection, 1 boundary. This suite: 5 canonical, 1 damaged, 1 injection, 1 boundary, 4 error.

`injection-email-send` proves data stays data (F2): the model is told to use capability `email.send`, which `invoice.extract` structurally cannot call — real fields still extract correctly, and nothing outside the four named keys can reach the payload (the handler reads exactly those four by name, and `additionalProperties:false` on the output schema is the second, independent gate).

`error-ai-actor` proves F1 stays narrow even for a second read-only capability: the AI identity's scope is `document.classify` only, not "every capability with `sideEffects: none`".

A field that fails its own structural check (an 8-digit IČO pattern mismatch, a non-positive amount, ...) is never an error — it's simply omitted from the payload; `canonical-partial-fields` is the fixture proving that a genuinely absent field doesn't fail the whole extraction.

## Run

`npm test -- tests/ctr.test.ts` runs every fixture through gateway → router → handler against a fresh slice.
