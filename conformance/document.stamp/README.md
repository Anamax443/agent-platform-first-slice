# Conformance package: document.stamp/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md` for the comparison rules and placeholders). The tier is `semantic` and not `exact` because artifact ids are generated; the stamped bytes themselves are deterministic and `tests/ctr.test.ts` additionally checks `stampedSha256` against the derived artifact.

| MUST (owner: capability contract) | DON'T CARE |
|---|---|
| `status` (SUCCEEDED / FAILED / UNKNOWN_OUTCOME) | `stampedArtifactId` (generated) |
| `payload.originalArtifactId`, `payload.originalSha256` = untouched original | `completedAt`, ids |
| `payload.stampText` as sent, or the derived default | `dmsRef` beyond the first call |
| `payload.stampedSha256` = hash of the derived artifact (property, checked in code) | `error.message`, `error.details` |
| `error.code`, `error.class`, `error.retryable`, `error.reissuable` for FAILED | |
| `reconciliationRef` present for UNKNOWN_OUTCOME | |

Fixture set: 5 canonical, 1 damaged, 1 injection, 2 boundary, 7 error. The error fixtures walk the executor decision chain of FOUNDATION-core §3.3 from the outside: scope (router), tenant (host), deadline (host), evidence (handler), dependency (adapter), unknown outcome (adapter).

`UNKNOWN_OUTCOME` is not an error object; it is a status with a `reconciliationRef` (the idempotency key, which the DMS keeps as client reference). Reconciliation is exercised in `tests/wf.test.ts` (`WF-UNK-001..003`) and `tests/res.test.ts` (`RES-CRASH-001`).
