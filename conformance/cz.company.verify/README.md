# Conformance package: cz.company.verify/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md` for the comparison
rules and placeholders — this capability needs none of the `$artifactId`/`$sha256` substitutions since it
takes no artifact, only an `ico`).

| MUST (owner: capability contract) | DON'T CARE |
|---|---|
| `status` | `error.message`, `error.details` |
| `payload.ico`, `found`, `active` | `verifiedAt` |
| `payload.companyName`, `ceasedOn` when `found: true` | |
| `error.code`, `error.class`, `error.retryable` for FAILED | |

Fixture set: 2 canonical, 1 boundary, 1 injection, 3 error.

The only dependency is ARES (`dependsOn: ares.lookup`), verified against the real endpoint 13. 9. 2026
(`src/adapters/ares.ts` doc comment carries the exact shapes seen). A 200 body from ARES is untrusted data
like any adapter response — the handler checks it before trusting it (INT-FAIL-004a pattern, same split as
`document.validate`/`RegistryAdapter`).

**`found` and `active` are independent signals, deliberately not collapsed into one.** ARES can say an IČO
exists (`found: true`) while `datumZaniku` shows it has ceased (`active: false`) — SEVERKA's own framing:
"datumZaniku = subjekt zanikl i když 'existuje'". `found: false` (`VYSTUP_SUBJEKT_NENALEZEN`, ARES HTTP 404)
is a **business** result, exactly like `document.classify`'s `OTHER` — `SUCCEEDED`, not `FAILED`. A caller
that needs "is this a real, currently-active company" checks `found && active`, not either bit alone.
