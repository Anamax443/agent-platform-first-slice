# document.classify/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (document-intake.v1 workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility is declared, so `CDC-COMP-001` / `INT-UPGRADE-001` do not run (VC §12). Consumers must tolerate additive fields in the payload (`CDC-ADD-001`); the orchestrator only reads `sha256` and `documentType`.

Transport binding: `signed-envelope` (Ed25519, JCS). Receivers reject any other mechanism (`SEC-CTX-005`).
