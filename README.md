# agent-platform-first-slice

> Česky: [README.cs.md](README.cs.md)

> One sentence: the first reference implementation of `agent-platform-foundation` v1.0-rc2.1, one vertical slice `document.classify` (AI) → `document.validate` (deterministic) → `document.stamp` (write executor), built to measure what the norm costs and what its tests catch.

## What it does

A document arrives as an immutable artifact. An AI capability classifies it (with a fake, deterministic LLM adapter in tests), a deterministic module validates it against a registry adapter, and a single-purpose executor produces a stamped derived artifact. Around that: a gateway that signs dispatch envelopes with Ed25519, a capability router that enforces scopes and tenant context, an executor host with the ten-step decision chain, a durable journal that survives a restart, a review service with expiry policies, and an append-only audit log.

Nothing here is a shared runtime. Everything under `src/platform` is local to this project; it becomes a package only after a second project needs the same thing (foundation §9, P2).

## Stack

TypeScript, Node 20+, Vitest, Ajv. No framework, no cloud. Adapters (LLM, registry, DMS) have fakes so every test family runs deterministically and offline.

## Run

```bash
npm ci
npm test          # all test families, named by Test ID
npm run typecheck
npm run arch      # ARCH-DEP-001: no component imports another component or platform internals
```

## Layout

| Path | Role |
|---|---|
| `contracts/` | frozen schemas and policy example, pinned in `CONTRACTS-VERSION` |
| `src/platform/` | clock, ids, schemas, canonical JSON, signing, gateway, router, policy, executor host, credentials, journal, orchestrator, review, audit, artifacts |
| `src/components/` | the three capabilities, each with `descriptor.json` and a handler |
| `src/adapters/` | LLM, registry and DMS adapters with fakes and failure modes |
| `workflows/` | `document-intake.v1.json` |
| `conformance/` | per capability: fixtures, golden outputs, `errors.md`, `compat.md` |
| `tests/` | one file per test family, test names carry Test IDs |
| `docs/MEASUREMENT.md` | hours, lines, findings caught, waste by lean category |

## Status

See [HANDOFF.md](HANDOFF.md) and [docs/MEASUREMENT.md](docs/MEASUREMENT.md).

## License

Proprietary, see [LICENSE](LICENSE).
