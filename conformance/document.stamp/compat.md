# document.stamp/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (document-intake.v1 workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared. The write target is the DMS through `DmsAdapter`; the fake carries the modes `ok`, `unknown-once`, `unknown-always`, `crash-after-write`, `auth-fail` and a status query keyed by the client reference (= idempotency key).

Isolation: `LOGICAL`, shared `document-executor-host` with `document.archive`. Accepted by `contracts/policy/document.stamp.v1.policy.json` for `riskClass: LOW`; evidence `SEC-HOST-001` + `MUT-HOST-001` in `tests/sec.test.ts` and `tests/mut.test.ts`.

Transport binding: `signed-envelope` (Ed25519, JCS).
