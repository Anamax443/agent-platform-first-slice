# email.send/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (mail-intake.v1 workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared. Write target: mail provider through `SmtpAdapter` (fake modes `ok`, `unknown-once`, `unknown-always`, `reject`, business dedup by client reference).

Isolation: `PRINCIPAL`, own host `email-executor`, own credential domain. Accepted by `contracts/policy/email.send.v1.policy.json` for `riskClass: MEDIUM`.

Transport binding: `signed-envelope` (Ed25519, JCS).
