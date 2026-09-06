# Conformance package: email.send/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md`). `tests/ctr.test.ts` additionally checks after every SUCCEEDED fixture that every address the SMTP fake delivered to is a value of the recipient allowlist in `contracts/policy/email.send.v1.policy.json` (effect field `recipientRef`, role `target`).

| MUST | DON'T CARE |
|---|---|
| `status` (SUCCEEDED / FAILED / UNKNOWN_OUTCOME) | `smtpMessageId` beyond the first call |
| `payload.recipientRef`, `payload.templateId` echoed | `completedAt`, ids |
| every delivery address ∈ allowlist of the caller's tenant (property, checked in code) | subject and body wording |
| `error.code`, `error.class`, `error.retryable`, `error.reissuable` for FAILED | `error.message`, `error.details` |
| `reconciliationRef` present for UNKNOWN_OUTCOME | |

Fixture set: 5 canonical, 1 damaged, 1 injection, 1 boundary, 7 error. The capability takes a reference and a template id; the only free-form thing it ever renders is an enum and an artifact id. That is what makes the injection in `mail-intake.v1` scenario `injection-mail` harmless: the document may ask for `audit@attacker.example`, but no field can carry it.

`riskClass: MEDIUM`, `isolationClass: PRINCIPAL`: the executor runs as its own host with its own credential domain (`cred:smtp` only). In this in-process slice that is a second `ExecutorHost` + `CredentialResolver`; the real boundary is a separate deployable (`PLATFORM-NOTES.md §7`). `SEC-HOST-001` in `tests/mail.test.ts` shows the document host cannot reach `cred:smtp` even with its resolver in mutant mode.
