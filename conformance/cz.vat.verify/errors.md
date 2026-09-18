# cz.vat.verify/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| MOJE daně does not answer before the deadline | `DEPENDENCY_TIMEOUT` | DEPENDENCY | true | false | platform |
| MOJE daně unreachable / SOAP Fault (HTTP 500) / statusCode 2 (odstávka) / statusCode 3 (nedostupná) | `DEPENDENCY_UNAVAILABLE` | DEPENDENCY | true | false | platform |
| response fails the shape check (reliability outside ANO/NE/NENALEZEN, publishedAccounts not an array) | `REGISTRY_RESPONSE_INVALID` | VALIDATION | false | false | handler |
| installation has no real MOJE daně adapter wired and has not opted into the fakes (Reliability Gate R4, 18.9.2026, `InstallationProfile.allowUnconfiguredTrustedProviders`) | `TRUSTED_PROVIDER_NOT_CONFIGURED` | DEPENDENCY | false | true | platform |
| dic not 1-10 digits, free text, unknown field | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| actor holds no scope for the capability | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | router |

`NENALEZEN` (DIČ does not exist) is deliberately **not** on this table: unlike `cz.company.verify`'s
ARES 404, MOJE daně returns it as a normal field inside a normal 200 response — it is a business result
(`SUCCEEDED` with `found: false`), not a transport-level or protocol-level error. See README.md.
