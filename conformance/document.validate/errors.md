# document.validate/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| artifact does not exist | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| artifact belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | handler |
| claimed hash differs from the stored original | `ARTIFACT_HASH_MISMATCH` | SECURITY | false | false | handler |
| registry does not answer before the deadline | `DEPENDENCY_TIMEOUT` | DEPENDENCY | true | false | platform |
| registry returns 5xx | `DEPENDENCY_UNAVAILABLE` | DEPENDENCY | true | false | platform |
| registry rejects the type (business 4xx) | `REGISTRY_REJECTED` | BUSINESS | false | false | handler |
| registry value outside the business range | `REGISTRY_RESPONSE_INVALID` | VALIDATION | false | false | handler |
| registry answers for a different type than asked | `REGISTRY_TYPE_CONFLICT` | QUALITY | false | false | handler |
| type exists but must not be stamped | `STAMP_NOT_ALLOWED` | BUSINESS | false | false | handler |
| documentType outside the allowlist, free text, unknown field | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| actor holds no scope for the capability | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | router |

`REGISTRY_TYPE_CONFLICT` is QUALITY and not retryable by the executor: the workflow routes it to human review (`INT-FAIL-004` b).
