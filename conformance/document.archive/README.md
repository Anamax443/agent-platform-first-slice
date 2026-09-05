# Conformance package: document.archive/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md`).

| MUST | DON'T CARE |
|---|---|
| `status`, `payload.artifactId`, `payload.sha256` | `archiveRef` beyond the first call |
| `error.code`, `error.class`, `error.retryable` for FAILED | `completedAt`, ids, texts |

**Fixture set below the minimum on purpose:** 1 canonical, 1 damaged, 2 error. `document.archive` is not a step of `document-intake.v1`; it exists as the second handler in the shared `document-executor-host` so that `LOGICAL` isolation, `SEC-HOST-001` and `MUT-HOST-001` are real and not simulated. The full minimum (5/1/1/1) becomes due when a workflow step consumes it (recorded in docs/MEASUREMENT.md as a deliberate choice against inventory).
