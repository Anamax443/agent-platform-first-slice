# Conformance package: cz.vat.verify/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md` for the comparison
rules — this capability takes no artifact, only a `dic`, so none of the `$artifactId`/`$sha256`
placeholders apply).

| MUST (owner: capability contract) | DON'T CARE |
|---|---|
| `status` | `error.message`, `error.details` |
| `payload.dic`, `reliability`, `found` | `verifiedAt` |
| `payload.companyName`, `publishedAccounts` when `found: true` | |
| `error.code`, `error.class`, `error.retryable` for FAILED | |

Fixture set: 2 canonical, 1 boundary, 1 injection, 4 error.

The only dependency is MOJE daně (`dependsOn: mojedane.lookup`), a SOAP 1.1 service verified against
the real endpoint 13. 9. 2026 (`src/adapters/moje-dane.ts`'s doc comment carries the exact request/
response shapes seen, including a captured real SOAP Fault). A response is untrusted data like any
adapter response — the handler checks it before trusting it (INT-FAIL-004a pattern, same split as
`document.validate`/`cz.company.verify`).

**Protocol asymmetry with `cz.company.verify`, worth remembering:** ARES signals "IČO doesn't exist"
via HTTP 404 (an error-shaped transport signal this adapter turns into an exception). MOJE daně signals
"DIČ doesn't exist" (`nespolehlivyPlatce="NENALEZEN"`) as an ordinary field inside an ordinary 200
response — no exception, the handler just reads it off the result like any other field. Same business
outcome (`SUCCEEDED found:false`) reached two structurally different ways because the two real
protocols are structurally different — this capability does not paper over that, it reads each
protocol on its own terms.

`reliability`/`found` are independent fields the same way `cz.company.verify`'s `found`/`active` are:
`found: false` only when `reliability === "NENALEZEN"`; a `found: true` subject can still be `ANO`
(nespolehlivý plátce) — reliability and existence are not the same question.
