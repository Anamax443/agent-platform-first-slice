# invoice.extract/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| artifact does not exist | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| artifact belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | handler |
| model output is not valid JSON, or not a JSON object (including an injected instruction that breaks the shape) | `MODEL_OUTPUT_NOT_ALLOWED` | QUALITY | true | false | handler |
| model call fails | `MODEL_UNAVAILABLE` | DEPENDENCY | true | false | handler |
| model does not answer before the deadline | `DEPENDENCY_TIMEOUT` | DEPENDENCY | true | false | platform |
| strategy has no configured model | `STRATEGY_UNKNOWN` | VALIDATION | false | false | handler |
| payload is not the typed input (free text, unknown field, wrong enum) | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| actor holds no scope for the capability | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | router |

`retryable` = the same command may be attempted again by the executor. QUALITY + retryable = with another strategy and a new idempotency key (FOUNDATION-core §5.2).

A field that fails its own structural check (bad IČO shape, non-positive amount, ...) is not an error here — it is simply omitted from the payload. Only the candidate JSON's overall shape being unusable is `MODEL_OUTPUT_NOT_ALLOWED`.
