# ARCHITECTURE — jak je řez poskládaný

Norma je v `agent-platform-foundation` (zmrazeno 1.0-rc2.1). Tady je jen to, jak ji tento projekt naplňuje.

## Tok

```text
ArtifactStore (immutable, sha256)
      |
      v
Gateway ──sign Ed25519──> DispatchEnvelope { message, context, binding }
      |
      v
Router: schema -> binding -> context expiry -> scope -> tenant -> policy -> handler
      |
      +--> document.classify   (AI, LlmAdapter, enum allowlist, provenance)     sideEffects: none
      +--> document.validate   (deterministic, RegistryAdapter, dependsOn)      sideEffects: none
      +--> ExecutorHost
             +--> document.stamp    (LOW, LOGICAL, cred:dms-stamp, DmsAdapter) sideEffects: internal-write
             +--> document.archive  (LOW, LOGICAL, cred:archive-store)          sideEffects: internal-write
      |
      v
Orchestrator (workflow document-intake.v1, Journal na disku, Review Service, Audit)
```

## Kde jsou hranice normy vidět v kódu

| Invariant / pravidlo | Kde |
|---|---|
| F1 privilege boundary | `router.ts` odmítne capability mimo `context.scopes`; write jen přes `executor-host.ts` |
| F2 untrusted data | `document-classifier/handler.ts`: text v oddělovačích, výstup modelu jen přes enum allowlist |
| F3 contract boundary | komponenty importují jen `platform/api.ts` (hlídá `scripts/arch-dep.mjs`) |
| F4 trusted context | `gateway.ts` tvoří context z identity, `signing.ts` podpis nad `{message, context}`, `router.ts` ověřuje |
| F5 observable execution | `orchestrator.ts` stavy, `journal.ts` persistence, `UNKNOWN_OUTCOME` + reconciliation |
| F6 safe state change | `executor-host.ts` řetězec: allowlist, context, policy, deadline s tolerancí, idempotency store |
| F7 evidence | `artifacts.ts` originál immutable + `derivedFrom`; `audit.ts` append-only; provenance v result |
| P1 verifiable | `tests/` podle Test ID; mutanty jako flagy v `executor-host.ts` a `credentials.ts` (jen test harness) |

## Co je záměrně jednoduché

- Journal je JSON soubor, ne databáze. Stačí na `RES-CRASH-001`.
- Gateway a router běží in-process; dispatch obálka je přesto podepsaná, aby `SEC-CTX-003` a rotace klíčů byly reálné, ne simulované.
- Executor host je jeden proces se dvěma `LOGICAL` handlery; to je přesně případ pro `SEC-HOST-001` a pro pentest podle ADR-017.
