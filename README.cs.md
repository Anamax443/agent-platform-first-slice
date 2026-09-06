# agent-platform-first-slice

> English: [README.md](README.md)

> Jednou větou: první referenční implementace `agent-platform-foundation` v1.0-rc2.1, dva svislé řezy nad pěti capability, postavené proto, aby se změřilo, co norma stojí a co její testy chytají.

## Co to dělá

**Tok 1, document-intake:** dokument přijde jako immutable artefakt. AI capability ho klasifikuje (v testech s deterministickým fake LLM adapterem), deterministický modul ho ověří proti registru přes adapter a proti druhému, pravidlovému signálu, a jednoúčelový executor vytvoří orazítkovanou odvozeninu.

**Tok 2, mail-intake:** surový e-mail uloží vlastní host jako immutable originál, jeho tělo projde stejnými třemi dokumentovými capability beze změny v nich, a executor ve vlastní credential doméně (PRINCIPAL) upozorní schránku, kterou smí pojmenovat jen platform policy.

Kolem obou: gateway podepisující dispatch obálky Ed25519, capability router vynucující mechanismus bindingu, scopes a tenant context, executor hosty s desetikrokovým rozhodovacím řetězcem, durable journal sdílený dvěma orchestrátory, review service s expiry policy a append-only audit.

Nic z toho není sdílený runtime. Vše v `src/platform` je lokální pro tento projekt; balíčkem se to stane až ve chvíli, kdy totéž potřebuje druhý projekt (foundation §9, P2).

## Stack

TypeScript, Node 20+, Vitest, `@cfworker/json-schema` (interpretační validátor: tentýž platformový kód běží i ve Workeru, který zakazuje generování kódu). Bez frameworku, bez cloudu, bez API klíče. Adaptéry (LLM, registr, DMS, archiv, SMTP) mají fakes, takže každá testovací rodina běží deterministicky a offline.

## Spuštění

```bash
npm ci
npm test          # 10 souborů, 198 testů, 46 Test ID, názvy testů nesou Test ID
npm run typecheck
npm run arch      # ARCH-DEP-001: komponenta neimportuje jinou komponentu ani vnitřnosti platformy; žádný přímý systémový čas
```

## Struktura

| Cesta | Role |
|---|---|
| `contracts/` | zmrazená schémata s pinem v `CONTRACTS-VERSION.json`; vzor policy z foundation |
| `config/` | instalační profily, nic z nich není v kódu: `profile.schema.json`; `local-fakes/` (testy) a `farm-bass443/` (farma, návrh), každý s `profile.json` (tenanty, identity, role, reference credentialů jen jménem, kanály, retence) a `policy/*.policy.json` (granty ADR-016, allowlist příjemců pro `email.send`); `farm.json` = overlay wrangler configů per deployable. Nová instalace = nový adresář + secrets, nula změn v `src/` (hlídá `npm run arch`) |
| `src/platform/` | hodiny, id, schémata, kanonický JSON, podpis, gateway, router, policy, transport (in-process, HTTP), executor host, credentials, journal, orchestrátor, workflow definice, review, audit, artefakty |
| `src/components/` | pět capability v pěti komponentách: document-classifier, document-validator, document-executor-host (stamp + archive), mail-ingest, email-executor |
| `src/adapters/` | LLM, registr, DMS, archiv a SMTP adaptéry s fakes a režimy selhání |
| `src/slice.ts` | kompoziční kořen: `createSlice(installation, secrets, volby)`; dva toky, tři hosty, dvě credential domény, in-process transport |
| `src/installation.ts` | instalační profil: typy, fail-closed sestavení (schéma, policy, granty proti identitám a tenantům), tabulka credentialů; `installation-node.ts` je Node loader pro testy |
| `workflows/` | `document-intake.v1.json`, `mail-intake.v1.json`, `workflow-definition.schema.json` |
| `conformance/` | per capability: fixtures, golden, `errors.md`, `compat.md`; per workflow: scénáře a golden master |
| `tests/` | jeden soubor na rodinu plus `mail.test.ts` pro druhý tok; názvy testů nesou Test ID |
| `docs/MEASUREMENT.md` | hodiny, řádky, zachycené nálezy, plýtvání podle lean kategorií, co bylo nutné obejít |

## Stav

- [STATUS.html](STATUS.html) — stavový list ke čtení v prohlížeči (přehled, toky, měření, nálezy, rozhodnutí); anglicky: [STATUS.en.html](STATUS.en.html)
- [VYVOJOVY-DIAGRAM.html](VYVOJOVY-DIAGRAM.html) — vývojový diagram: cesta jednoho příkazu bezpečnostním řetězcem a běh toku od e-mailu k notifikaci se všemi konci; anglicky: [VYVOJOVY-DIAGRAM.en.html](VYVOJOVY-DIAGRAM.en.html)
- [HANDOFF.md](HANDOFF.md) — deník stavu, nejnovější nahoře
- [docs/MEASUREMENT.md](docs/MEASUREMENT.md) — co norma stála a co zachytila

## Licence

Proprietary, viz [LICENSE](LICENSE).
