# mail.ingest/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (mail-intake.v1 workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared. Own host `mail-ingest` (LOGICAL, one handler, no credentials); the only write target is the platform artifact store.

Transport binding: `signed-envelope` (Ed25519, JCS).
