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
Router: schema -> mechanism -> binding -> context expiry -> scope -> version -> policy (tenant) -> input schema -> handler
      |
      +--> document.classify   (AI, LlmAdapter, enum allowlist z output schématu, provenance)   sideEffects: none
      +--> document.validate   (deterministic, RegistryAdapter, dependsOn)                       sideEffects: none
      +--> ExecutorHost (LOGICAL, CredentialResolver podle identity handleru)
             +--> document.stamp    (LOW, cred:dms-stamp, DmsAdapter, reconcile přes clientRef)   sideEffects: internal-write
             +--> document.archive  (LOW, cred:archive-store, ArchiveAdapter)                    sideEffects: internal-write
      |
      v
Orchestrator (workflow document-intake.v1, Journal na disku, Review Service, Audit, reconcilers z hostu)
```

Kompoziční kořen je `src/slice.ts`: jediné místo, které zná všechny konkrétní třídy. Testy z něj staví svět s fakes; `createSlice()` bere volby (journal soubor, adaptéry, mutanty, náhradní handler) a vrací všechny části pro assert.

## Kde jsou hranice normy vidět v kódu

| Invariant / pravidlo | Kde |
|---|---|
| F1 privilege boundary | `router.ts` odmítne capability mimo `context.scopes`; policy v `contracts/policy/*.json` AI identitě write negrantuje; write jen přes `executor-host.ts` s allowlistem |
| F2 untrusted data | `document-classifier/handler.ts`: text v oddělovačích (jméno oddělovače až za blokem, nález N3), výstup modelu jen přes enum z `output.schema.json`; `document-validator/handler.ts`: odpověď registru prochází rozsahovým a sémantickým testem; `stamp-handler.ts` přijme jen hodnotu s `validation.status: passed` od validátoru |
| F3 contract boundary | komponenty importují jen `platform/api.ts`, vlastní adresář a adapter kontrakty (hlídá `scripts/arch-dep.mjs`); orchestrátor volá reconciler executora jako neprůhledný objekt |
| F4 trusted context | `gateway.ts` tvoří context z identity, `signing.ts` podpis nad JCS `{message, context}` s okny platnosti klíčů a grace period, `router.ts` ověřuje a přijímá jen `signed-envelope` |
| F5 observable execution | `orchestrator.ts` stavy, `journal.ts` persistence, `UNKNOWN_OUTCOME` + reconciliation s budgetem, publikovaný stav během reconciliace, `applyReviewExpiries` |
| F6 safe state change | `executor-host.ts` řetězec: allowlist, context, deadline s tolerancí, idempotency store (drží SUCCEEDED a UNKNOWN_OUTCOME), audit před/po, reconciliation hook mění dedup záznam podle zjištěné pravdy |
| F7 evidence | `artifacts.ts` originál immutable + `derivedFrom`; `audit.ts` append-only s hlubokými kopiemi; provenance v každém result; `correlationId` i na review tascích |
| P1 verifiable | `tests/` podle Test ID; mutanty jako flagy v `executor-host.ts` a `credentials.ts`, rogue handlery v `tests/harness/rogue.ts` (jen test harness) |

## Co je záměrně jednoduché

- Journal je JSON soubor, ne databáze. Stačí na `RES-CRASH-001`.
- Gateway a router běží in-process; dispatch obálka je přesto podepsaná, aby `SEC-CTX-003` a rotace klíčů byly reálné, ne simulované.
- Executor host je jeden proces se dvěma `LOGICAL` handlery; to je přesně případ pro `SEC-HOST-001` a pro pentest podle ADR-017.
- Technický retry je okamžitý, bez backoffu a circuit breakeru (W6 v MEASUREMENT). Přijde s durable frontou.
- `document.archive` není krok workflow. Existuje, aby sdílený host měl dva handlery se dvěma credentialy a `SEC-HOST-001` nebyl simulace.
