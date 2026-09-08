# document.stamp/1: error contract (CTR-ERR-001)

| Input class | code | class | retryable | reissuable | enforced by |
|---|---|---|---|---|---|
| artifact does not exist (normal path: caught before the handler runs) | `RESOURCE_TENANT_UNRESOLVED` | SECURITY | false | false | host |
| artifact does not exist, reached only if the host's resourceTenant gate is bypassed (defense in depth, MUT-CTX-001) | `ARTIFACT_NOT_FOUND` | BUSINESS | false | false | handler |
| resource belongs to another tenant than the trusted context | `TENANT_SCOPE_MISMATCH` | SECURITY | false | false | host |
| claimed hash differs from the stored original | `ARTIFACT_HASH_MISMATCH` | SECURITY | false | false | handler |
| documentType without `validation.status: passed` from `document-validator` | `VALIDATION_EVIDENCE_MISSING` | POLICY | false | false | handler |
| DMS rejects the request (authentication, 4xx) | `DMS_REJECTED` | DEPENDENCY | true | false | handler |
| `notValidAfter` passed by more than 30 s | `COMMAND_EXPIRED` | POLICY | false | true | host |
| capability not served by this host, or actor without scope | `CAPABILITY_NOT_ALLOWED` | SECURITY | false | false | host, router |
| handler resolves a credential reference that is not its own | `CREDENTIAL_DENIED` | SECURITY | false | false | host |
| free text, unknown field, stampText outside the allowed character set, command without notValidAfter | `SCHEMA_VALIDATION_FAILED` | VALIDATION | false | false | router |
| handler throws | `HANDLER_CRASHED` | TECHNICAL | true | false | host |
| same idempotencyKey reused with a different payload (Posudek 5/6) | `IDEMPOTENCY_CONFLICT` | VALIDATION | false | false | host |
| another attempt for the same idempotencyKey is still reserved/in flight | `IDEMPOTENCY_IN_FLIGHT` | TECHNICAL | true | false | host |

Not an error: `status: UNKNOWN_OUTCOME` with `reconciliationRef` when the DMS may have written (`WF-UNK-001`). The executor never resends on its own.
