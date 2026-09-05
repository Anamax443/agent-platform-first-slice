# document.classify/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| artifact does not exist | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| artifact belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | handler |
| model answer outside the allowlist (including an injected instruction) | `MODEL_OUTPUT_NOT_ALLOWED` | QUALITY | true | false | handler |
| model call fails | `MODEL_UNAVAILABLE` | DEPENDENCY | true | false | handler |
| model does not answer before the deadline | `DEPENDENCY_TIMEOUT` | DEPENDENCY | true | false | platform |
| strategy has no configured model | `STRATEGY_UNKNOWN` | VALIDATION | false | false | handler |
| strategy human-corrected without a value from the allowlist | `CORRECTION_INVALID` | VALIDATION | false | false | handler |
| payload is not the typed input (free text, unknown field, wrong enum) | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| actor holds no scope for the capability | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | router |

`retryable` = the same command may be attempted again by the executor. QUALITY + retryable = with another strategy and a new idempotency key (FOUNDATION-core §5.2).
