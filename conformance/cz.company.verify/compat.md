# cz.company.verify/1: compatibility

| Consumer | Provider | Expectation |
|---|---|---|
| v1 (no workflow wired yet — see HANDOFF) | v1 | pass |
| any | other versions | none exist; `INCOMPATIBLE_VERSION` on the router |

No backward compatibility declared; `CDC-COMP-001` does not run. Dependency: `ares.lookup` through
`AresAdapter` — a fake in tests (`FakeAresAdapter`, every mode from `INT-FAIL-001..004` family), the real
ARES REST endpoint in `HttpAresAdapter` once an installation wires it up with its own `baseUrl` (installation
value, ARCH-DEP-001 — not hardcoded in adapter code).

Transport binding: `signed-envelope` (Ed25519, JCS).
