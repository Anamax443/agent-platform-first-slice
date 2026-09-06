# mail.ingest/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| no parseable From header | `MAIL_MALFORMED` | VALIDATION | false | false | handler |
| artifact store cannot accept the original | `STORAGE_FULL` | DEPENDENCY | true | false | handler |
| `notValidAfter` passed by more than 30 s | `COMMAND_EXPIRED` | POLICY | false | true | host |
| capability not served by this host, or actor without scope | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | host, router |
| handler resolves a credential reference (it has none) | `CREDENTIAL_DENIED` | SECURITY | false | false | host |
| free text, unknown field, command without notValidAfter | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | host |

`STORAGE_FULL` is retryable on purpose: the transport keeps the mail and applies backpressure instead of dropping it (RES-STOR-001, "no false 202").
