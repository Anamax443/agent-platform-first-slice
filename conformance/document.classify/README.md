# Conformance package: document.classify/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

## How golden outputs are compared

Golden files are a **subset** of the result envelope: every field present in the golden must be equal in the result, everything else is DON'T CARE. `anyOf` lists alternatives; the contract is satisfied when at least one matches. Placeholders `$artifactId`, `$sha256`, `$now` are substituted per run.

| MUST (owner: capability contract) | DON'T CARE (provider may vary) |
|---|---|
| `status` | `confidence` |
| `payload.documentType.value` (enum allowlist) | `completedAt`, `messageId`, `executionId` |
| `payload.documentType.trustLevel`, `source` where stated | `provenance.modelId`, `promptVersion` (checked by INT-REPLACE-001 changelog rule, not here) |
| `payload.sha256` = hash of the original | diagnostic texts in `error.message` |
| `error.code`, `error.class`, `error.retryable` for FAILED | `error.details` |

## Fixture set

Minimum for the first capability of a new component (VC §5): 5 canonical, 1 damaged, 1 injection, 1 boundary. This suite: 8 canonical, 1 damaged, 3 injection, 2 boundary, 4 error.

`injection-in-allowlist` deliberately has two acceptable outcomes: a model that follows the injected instruction returns a value that is still inside the allowlist. The schema boundary (F2) cannot see the difference at this capability. The next step catches it: `document.validate` recomputes the value with a deterministic second signal and disputes the disagreement (W4 in docs/MEASUREMENT.md); `AI-EVAL-ADV-001` over a real model remains deferred.

## Run

`npm test -- tests/ctr.test.ts` runs every fixture through gateway → router → handler against a fresh slice.
