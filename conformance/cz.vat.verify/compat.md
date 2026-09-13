# cz.vat.verify/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (no workflow wired yet — see HANDOFF) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared; `CDC-COMP-001` does not run. Dependency: `mojedane.lookup` through
`MojeDaneAdapter` — a fake in tests (`FakeMojeDaneAdapter`, every mode from the `INT-FAIL-001..004`
family plus a `maintenance` mode for the real service's own predictable downtime window), the real SOAP
service in `HttpMojeDaneAdapter` once an installation wires it up with its own `baseUrl` (installation
value, ARCH-DEP-001 — not hardcoded in adapter code).

Transport binding: `signed-envelope` (Ed25519, JCS) for this capability's own dispatch — independent of
`mojedane.lookup`'s own transport (SOAP/XML over HTTPS), which is internal to the adapter.
