# invoice.extract/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (future invoice-intake workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility is declared, so `CDC-COMP-001` / `INT-UPGRADE-001` do not run (VC §12). Consumers must tolerate additive fields in the payload (`CDC-ADD-001`) — a future minor version adding DIČ/currency/line items must not break a v1 consumer that only reads `companyId`/`bankAccount`/`invoiceNumber`/`totalWithVat`.

Transport binding: `signed-envelope` (Ed25519, JCS). Receivers reject any other mechanism (`SEC-CTX-005`).
