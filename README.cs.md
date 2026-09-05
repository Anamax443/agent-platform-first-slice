# agent-platform-first-slice

> English: [README.md](README.md)

> Jednou větou: první referenční implementace `agent-platform-foundation` v1.0-rc2.1, jeden svislý řez `document.classify` (AI) → `document.validate` (deterministický) → `document.stamp` (write executor), postavený proto, aby se změřilo, co norma stojí a co její testy chytají.

## Co to dělá

Dokument přijde jako immutable artefakt. AI capability ho klasifikuje (v testech s deterministickým fake LLM adapterem), deterministický modul ho ověří proti registru přes adapter a jednoúčelový executor vytvoří orazítkovanou odvozeninu. Kolem toho: gateway podepisující dispatch obálky Ed25519, capability router vynucující scopes a tenant context, executor host s desetikrokovým rozhodovacím řetězcem, durable journal, který přežije restart, review service s expiry policy a append-only audit.

Nic z toho není sdílený runtime. Vše v `src/platform` je lokální pro tento projekt; balíčkem se to stane až ve chvíli, kdy totéž potřebuje druhý projekt (foundation §9, P2).

## Stack

TypeScript, Node 20+, Vitest, Ajv. Bez frameworku, bez cloudu. Adaptéry (LLM, registr, DMS) mají fakes, takže každá testovací rodina běží deterministicky a offline.

## Spuštění

```bash
npm ci
npm test          # všechny rodiny, názvy testů nesou Test ID
npm run typecheck
npm run arch      # ARCH-DEP-001: komponenta neimportuje jinou komponentu ani vnitřnosti platformy
```

## Struktura

| Cesta | Role |
|---|---|
| `contracts/` | zmrazená schémata a vzor policy, pin v `CONTRACTS-VERSION` |
| `src/platform/` | hodiny, id, schémata, kanonický JSON, podpis, gateway, router, policy, executor host, credentials, journal, orchestrátor, review, audit, artefakty |
| `src/components/` | tři capability, každá s `descriptor.json` a handlerem |
| `src/adapters/` | LLM, registr a DMS adaptéry s fakes a režimy selhání |
| `workflows/` | `document-intake.v1.json` |
| `conformance/` | per capability: fixtures, golden výstupy, `errors.md`, `compat.md` |
| `tests/` | jeden soubor na rodinu, názvy testů nesou Test ID |
| `docs/MEASUREMENT.md` | hodiny, řádky, zachycené nálezy, plýtvání podle lean kategorií |

## Stav

Viz [HANDOFF.md](HANDOFF.md) a [docs/MEASUREMENT.md](docs/MEASUREMENT.md).

## Licence

Proprietary, viz [LICENSE](LICENSE).
