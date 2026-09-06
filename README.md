# agent-platform-first-slice

> Česky: [README.cs.md](README.cs.md)

> One sentence: the first reference implementation of `agent-platform-foundation` v1.0-rc2.1, two vertical slices over five capabilities, built to measure what the norm costs and what its tests catch.

## What it does

**Flow 1, document-intake:** a document arrives as an immutable artifact. An AI capability classifies it (with a fake, deterministic LLM adapter in tests), a deterministic module validates it against a registry adapter and against a second, rules-based signal, and a single-purpose executor produces a stamped derived artifact.

**Flow 2, mail-intake:** raw mail is ingested as an immutable original by its own host, its body goes through the same three document capabilities without any change to them, and an executor in its own credential domain (PRINCIPAL) notifies a mailbox that only the platform policy may name.

Around both: a gateway that signs dispatch envelopes with Ed25519, a capability router that enforces mechanism, scopes and tenant context, executor hosts with the ten-step decision chain, a durable journal shared by two orchestrators, a review service with expiry policies, and an append-only audit log.

Nothing here is a shared runtime. Everything under `src/platform` is local to this project; it becomes a package only after a second project needs the same thing (foundation §9, P2).

## Stack

TypeScript, Node 20+, Vitest, `@cfworker/json-schema` (an interpreting validator: the same platform code runs in a Worker, which forbids code generation). No framework, no cloud, no API key. Adapters (LLM, registry, DMS, archive, SMTP) have fakes so every test family runs deterministically and offline.

## Run

```bash
npm ci
npm test          # 10 files, 198 tests, 46 Test IDs, named by Test ID
npm run typecheck
npm run arch      # ARCH-DEP-001: no component imports another component or platform internals; no direct system clock
```

## Layout

| Path | Role |
|---|---|
| `contracts/` | frozen schemas pinned in `CONTRACTS-VERSION.json`; the foundation policy example |
| `config/` | installation profiles, nothing of them in code: `profile.schema.json`; `local-fakes/` (tests) and `farm-bass443/` (farm, draft), each with `profile.json` (tenants, identities, roles, credential references by name, channels, retention) and `policy/*.policy.json` (ADR-016 grants, recipient allowlist of `email.send`); `farm.json` = per-deployable wrangler overlay. New installation = new directory + secrets, zero changes in `src/` (`npm run arch` enforces it) |
| `src/platform/` | clock, ids, schemas, canonical JSON, signing, gateway, router, policy, transport (in-process, HTTP), executor host, credentials, journal, orchestrator, workflow definitions, review, audit, artifacts |
| `src/components/` | five capabilities in five components: document-classifier, document-validator, document-executor-host (stamp + archive), mail-ingest, email-executor |
| `src/adapters/` | LLM, registry, DMS, archive and SMTP adapters with fakes and failure modes |
| `src/slice.ts` | composition root: `createSlice(installation, secrets, options)`; two flows, three hosts, two credential domains, in-process transport |
| `src/installation.ts` | installation profile: types, fail-closed assembly (schema, policies, grants against identities and tenants), credential table; `installation-node.ts` is the Node loader used by tests |
| `workflows/` | `document-intake.v1.json`, `mail-intake.v1.json`, `workflow-definition.schema.json` |
| `conformance/` | per capability: fixtures, golden, `errors.md`, `compat.md`; per workflow: scenarios and golden master |
| `tests/` | one file per test family plus `mail.test.ts` for the second flow; test names carry Test IDs |
| `docs/MEASUREMENT.md` | hours, lines, findings caught, waste by lean category, what had to be worked around |

## Status

- [STATUS.en.html](STATUS.en.html) — status page for the browser (overview, flows, measurement, findings, decisions); Czech: [STATUS.html](STATUS.html)
- [VYVOJOVY-DIAGRAM.en.html](VYVOJOVY-DIAGRAM.en.html) — flowchart: the path of one command through the security chain, and the run of a flow from e-mail to notification with every ending; Czech: [VYVOJOVY-DIAGRAM.html](VYVOJOVY-DIAGRAM.html)
- [HANDOFF.md](HANDOFF.md) — state diary, newest first
- [docs/MEASUREMENT.md](docs/MEASUREMENT.md) — what the norm cost and what it caught

## License

Proprietary, see [LICENSE](LICENSE).
