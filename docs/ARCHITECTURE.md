# ARCHITECTURE — jak je řez poskládaný

Norma je v `agent-platform-foundation` (zmrazeno 1.0-rc2.1). Tady je jen to, jak ji tento projekt naplňuje.

## Toky

```text
                 ┌──────────────────────────────────────────────────────────────────────────┐
                 │ Gateway ──sign Ed25519──> DispatchEnvelope { message, context, binding } │
                 └──────────────────────────────────────────────────────────────────────────┘
                                                   |
                                                   v
   Router: schema -> mechanism -> binding -> context expiry -> scope -> version -> policy (tenant) -> input schema -> handler
      |
      +--> document.classify   (AI, LlmAdapter, enum allowlist z output schématu, provenance)         sideEffects: none
      +--> document.validate   (deterministic, RegistryAdapter, dependsOn, druhý signál pravidly)      sideEffects: none
      +--> document-executor-host  (LOGICAL, credential doména A: cred:dms-stamp, cred:archive-store)
      |        +--> document.stamp    (LOW, DmsAdapter, reconcile přes clientRef = idempotencyKey)      sideEffects: internal-write
      |        +--> document.archive  (LOW, ArchiveAdapter)                                             sideEffects: internal-write
      +--> mail-ingest              (LOGICAL, bez credentialů; immutable originál do ArtifactStore)
      |        +--> mail.ingest       (LOW, hlavičky parsovány pravidly, vše zůstává data)              sideEffects: internal-write
      +--> email-executor           (PRINCIPAL, credential doména B: jen cred:smtp)
               +--> email.send       (MEDIUM, IRREVERSIBLE, SmtpAdapter, příjemce jen z allowlistu policy) sideEffects: external-write

   Orchestrátory (společný Journal, Review Service, Audit; každý jen svou definici):
     document-intake.v1:  classify -> validate -> stamp
     mail-intake.v1:      ingest -> classify -> validate -> stamp -> notify(email.send)
```

Kompoziční kořen je `src/slice.ts`: jediné místo, které zná všechny konkrétní třídy. `createSlice(installation, secrets, volby)` bere **instalaci** (profil + policy sestavené fail-closed z `config/<instalace>/`, viz `src/installation.ts`), zdroj hodnot secrets (jen podle jmen referencí z profilu) a volby (journal soubor, adaptéry, kapacita úložiště, mutanty per host, náhradní handler). Identity, tenanty, granty ani allowlist příjemců tedy nejsou v kódu; testy používají instalaci `local-fakes` (`tests/harness/installation.ts`, konstanty odvozené z profilu).

Orchestrátory dostávají `DispatchTransport` (`src/platform/transport.ts`): `InProcessTransport` = gateway + router v jednom procesu (tento řez), `HttpDispatchTransport` = klient na vzdálenou gateway (farma; v těle jen zpráva, identita z hlaviček transportu, odpověď validovaná proti result envelope). Orchestrátor rozdíl nevidí (F3). Kontrakty, descriptory, schémata, workflow definice (`workflows/workflow-definition.schema.json`, `src/platform/workflow.ts`) i schéma profilu se importují staticky; platforma při importu nečte disk, takže totéž běží pod Node i ve Workeru. Validace schémat je interpret (`@cfworker/json-schema`), ne Ajv, protože Workers zakazují generování kódu (W13); bajty jdou jen přes `Uint8Array` (`src/platform/bytes.ts`: utf8, hex, base64url) a `crypto.getRandomValues`, `Buffer` v platformě není (W14). Worker dostane instalaci build-time aliasem `apf:installation` (modul generuje `scripts/farm-config.mjs` z `config/<instalace>/`), za běhu nic nenačítá; ověřeno `wrangler dev` + `/version` pro obě instalace.

## Kde jsou hranice normy vidět v kódu

| Invariant / pravidlo | Kde |
|---|---|
| F1 privilege boundary | `router.ts` odmítne capability mimo `context.scopes`; policy v `config/<instalace>/policy/*.json` AI identitě write negrantuje (a `src/installation.ts` odmítne grant scope, který identita nedrží); write jen přes `executor-host.ts` s allowlistem; `email.send` bere `recipientRef`, adresu doplní jen allowlist z policy |
| F2 untrusted data | `document-classifier/handler.ts`: text v oddělovačích (jméno oddělovače až za blokem, nález N3), výstup modelu jen přes enum z `output.schema.json`; `document-validator/handler.ts`: druhý deterministický signál nad textem bez instrukčních řádků (`CLASSIFICATION_DISPUTED`, W4), odpověď registru prochází rozsahovým a sémantickým testem; `stamp-handler.ts` přijme jen hodnotu s `validation.status: passed` od validátoru; `mail-ingest/handler.ts` čte z hlaviček jen From a Subject a ukládá je jako data; `email-executor/handler.ts` renderuje šablonu jen z enum a id |
| F3 contract boundary | komponenty importují jen `platform/api.ts`, vlastní adresář a adapter kontrakty, nic z `node:*` (hlídá `scripts/arch-dep.mjs`, který zároveň zakazuje instalační hodnoty v kódu); orchestrátor volá reconciler executora jako neprůhledný objekt a s routerem mluví jen přes `DispatchTransport`; druhé workflow konzumuje `document.*` beze změny providerů |
| F4 trusted context | `gateway.ts` tvoří context z identity, `signing.ts` podpis nad JCS `{message, context}` s okny platnosti klíčů a grace period, `router.ts` ověřuje a přijímá jen `signed-envelope`; tenant nového originálu bere `mail.ingest` z contextu, ne z payloadu |
| F5 observable execution | `orchestrator.ts` stavy, `journal.ts` persistence, `UNKNOWN_OUTCOME` + reconciliation s budgetem, publikovaný stav během reconciliace, `applyReviewExpiries`; `STORAGE_FULL` je explicitní FAILED, ne tiché 202 |
| F6 safe state change | `executor-host.ts` řetězec: allowlist, context, deadline s tolerancí (per krok, `notify` má PT10M), idempotency store (drží SUCCEEDED a UNKNOWN_OUTCOME), audit před/po, reconciliation hook mění dedup záznam podle zjištěné pravdy; u IRREVERSIBLE `email.send` deduplikuje navíc provider podle `clientRef` |
| F7 evidence | `artifacts.ts` originál immutable + `derivedFrom` + kapacita; `audit.ts` append-only s hlubokými kopiemi; provenance v každém result; `correlationId` i na review tascích |
| §3.2 izolační třídy | `LOGICAL` = dva handlery v jednom hostu se společným resolverem (document-executor-host); `PRINCIPAL` = vlastní host a vlastní `CredentialResolver` (email-executor); v jednom procesu je to simulace, skutečná hranice je samostatný deployable (PLATFORM-NOTES §7) |
| P1 verifiable | `tests/` podle Test ID; mutanty jako flagy per host v `executor-host.ts` a režim v `credentials.ts`, rogue handlery v `tests/harness/rogue.ts` (jen test harness) |

## Co je záměrně jednoduché

- Journal je JSON soubor, ne databáze. Stačí na `RES-CRASH-001`; dva orchestrátory ho sdílejí a každý zpracovává jen instance své definice.
- Gateway a router běží in-process; dispatch obálka je přesto podepsaná, aby `SEC-CTX-003` a rotace klíčů byly reálné, ne simulované.
- Technický retry je okamžitý, bez backoffu a circuit breakeru (W6 v MEASUREMENT). Přijde s durable frontou.
- `document.archive` není krok workflow. Existuje, aby sdílený host měl dva handlery se dvěma credentialy a `SEC-HOST-001` nebyl simulace.
- Druhý signál ve validátoru je heuristika (pravidla nad textem bez instrukčních řádků), ne důkaz. Měří cenu a účinek; rozhodnutí o normě je v MEASUREMENT W4.
