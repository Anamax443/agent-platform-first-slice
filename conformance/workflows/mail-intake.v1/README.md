# Golden master: workflow mail-intake.v1 (INT-E2E-001)

conformanceTier of the workflow definition: `semantic` (FOUNDATION-core §5.7).

Second flow (XII.G M4). `scenarios.json` gives the workflow input; string values may be `{ "$fixtureText": "<capability>/<fixture id>" }` (the fixture's artifact bytes or `rawMail`) or `{ "$artifact": "<capability>/<fixture id>" }` (the bytes are stored as an artifact and its id is passed). `golden.json` is a subset of the trace built by `tests/harness/index.ts#trace`.

| MUST (semantic tier) | DON'T CARE |
|---|---|
| instance status, published status | timestamps, ids, message contents |
| per step: `stepId`, `status`, `strategy`, `sideEffects`, error `code` where FAILED/WAITING | technical `attempt` unless stated |
| audit record **kinds in order** for the correlation | audit details |
| review tasks: `reasonCode`, `requiredRole`, `status` | task ids, deadlines |
| `writes` = DMS stamp calls, `sends` = SMTP deliveries, `recipients` = every address delivered to | |

What the five scenarios prove together: the two flows exchange messages through the same envelope and the same router (`document.*` capabilities are consumed by a second workflow without change), the mail body never chooses a recipient, and every ending is explicit.
