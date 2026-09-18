# cz.company.verify/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| ARES does not answer before the deadline | `DEPENDENCY_TIMEOUT` | DEPENDENCY | true | false | platform |
| ARES unreachable / 4xx / 5xx | `DEPENDENCY_UNAVAILABLE` | DEPENDENCY | true | false | platform |
| ARES 200 body fails the shape check (INT-FAIL-004a) | `REGISTRY_RESPONSE_INVALID` | VALIDATION | false | false | handler |
| installation has no real ARES adapter wired and has not opted into the fakes (Reliability Gate R4, 18.9.2026, `InstallationProfile.allowUnconfiguredTrustedProviders`) | `TRUSTED_PROVIDER_NOT_CONFIGURED` | DEPENDENCY | false | true | platform |
| ico not exactly 8 digits, free text, unknown field | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| actor holds no scope for the capability | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | router |

`VYSTUP_SUBJEKT_NENALEZEN` (IČO does not exist) is deliberately **not** on this table: it is a business
result (`SUCCEEDED` with `found: false`), the same pattern as `document.classify`'s `OTHER` — see README.md.
