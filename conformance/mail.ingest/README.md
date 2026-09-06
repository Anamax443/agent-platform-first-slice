# Conformance package: mail.ingest/1

conformanceSuiteVersion: `1.0`
conformanceTier: `semantic`

Golden files are a subset of the result envelope (see `../document.classify/README.md`). The artifact is created by the capability itself, so `tests/ctr.test.ts` additionally checks that the stored original equals `rawMail` byte for byte, carries the tenant of the trusted context, and that `payload.sha256` is its hash (EVD-001).

| MUST | DON'T CARE |
|---|---|
| `status` | `artifactId` (generated) |
| `payload.sender.value` (lower-cased address), `source: rules`, `trustLevel: untrusted-derived` | display name in From |
| `payload.subject` verbatim (truncated to 200) | |
| `payload.receivedFrom` = transport identity from the command | `completedAt`, ids |
| `error.code`, `error.class`, `error.retryable`, `error.reissuable` for FAILED | `error.message`, `error.details` |

Fixture set: 5 canonical, 1 damaged, 2 injection, 1 boundary, 4 error. The injection fixtures prove that headers and body are data: they are stored, hashed, and never interpreted here. Whether the body is an invoice is not this capability's business; that is `document.classify` on the stored artifact (`workflows/mail-intake.v1.json`).
