# document.archive/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| artifact does not exist | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| resource belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | host |
| claimed hash differs from the stored original | `ARTIFACT_HASH_MISMATCH` | SECURITY | false | false | handler |
| archive store rejects the request | `ARCHIVE_REJECTED` | DEPENDENCY | true | false | handler |
| `notValidAfter` passed by more than 30 s | `COMMAND_EXPIRED` | POLICY | false | true | host |
| capability not served by this host, or actor without scope | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | host, router |
| handler resolves a credential reference that is not its own | `CREDENTIAL_DENIED` | SECURITY | false | false | host |
| free text, unknown field, command without notValidAfter | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | host |
