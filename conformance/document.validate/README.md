# Conformance package: document.validate/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md` for the comparison rules and placeholders).

| MUST (owner: capability contract) | DON'T CARE |
|---|---|
| `status` | `confidence` carried through |
| `payload.documentType.value`, `trustLevel`, `validation.status`, `validation.provider` | `validation.at` |
| `payload.stampAllowed`, `payload.retentionDays` | `completedAt`, ids |
| `payload.sha256` = hash of the original | `error.message`, `error.details` |
| `error.code`, `error.class`, `error.retryable` for FAILED | |

Fixture set: 5 canonical, 1 damaged, 1 injection, 1 boundary, 7 error (the registry failure modes double as the `INT-FAIL-001..004` inputs).

The registry is the only dependency (`dependsOn: registry.lookup`). Every answer from it is untrusted until it passes the range check and the semantic check (F2, `INT-FAIL-004`).
