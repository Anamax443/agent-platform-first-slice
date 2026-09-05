# document.validate/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (document-intake.v1 workflow) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared; `CDC-COMP-001` does not run. Dependency: `registry.lookup` through `RegistryAdapter` with a fake that carries every failure mode of `INT-FAIL-001..004`.

Transport binding: `signed-envelope` (Ed25519, JCS).
