# Golden master: workflow document-intake.v1 (INT-E2E-001)

conformanceTier of the workflow definition: `semantic` (FOUNDATION-core §5.7).

`scenarios.json` names a classify fixture as input plus adapter modes; `golden.json` is a subset of the trace that `tests/harness/index.ts#trace` builds from the journal, the audit trail (filtered by `correlationId`), the review service and the DMS fake.

| MUST (semantic tier) | DON'T CARE |
|---|---|
| instance status, published status | timestamps, ids, message contents |
| per step: `stepId`, `status`, `strategy`, `sideEffects`, error `code` where FAILED/WAITING | technical `attempt` unless stated |
| audit record **kinds in order** for the correlation | audit details |
| review tasks: `reasonCode`, `requiredRole`, `status` | task ids, deadlines |
| `writes` = number of DMS stamp calls | |

The test runs only because the workflow has an `internal-write` step (X-32); a read-only workflow would not carry this golden.
