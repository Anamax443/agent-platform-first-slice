# email.send/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| recipient reference not in the allowlist of the caller's tenant | `RECIPIENT_NOT_ALLOWED` | POLICY | false | false | handler |
| referenced artifact does not exist | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| referenced artifact belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | host |
| mail provider rejects the message (5xx, auth) | `SMTP_REJECTED` | DEPENDENCY | true | false | handler |
| `notValidAfter` passed by more than 30 s | `COMMAND_EXPIRED` | POLICY | false | true | host |
| capability not served by this host, or actor without scope | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | host, router |
| handler resolves a credential reference that is not its own | `CREDENTIAL_DENIED` | SECURITY | false | false | host |
| address instead of reference, free text, unknown template, unknown field | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | host |

Not an error: `status: UNKNOWN_OUTCOME` with `reconciliationRef` when the provider may have delivered (`WF-UNK-001`). The executor never resends; the provider deduplicates by client reference (`IDM-RET-002`).
