# BUILD — od nuly k běžícím testům

## Požadavky

- Node.js 20+ (vyvíjeno na 24)
- npm

Žádná tajemství. Žádný cloud. Všechny externí systémy mají fakes.

## Kroky

```bash
git clone https://github.com/Anamax443/agent-platform-first-slice.git
cd agent-platform-first-slice
npm ci
npm test
```

`npm test` spustí Vitest nad `tests/**/*.test.ts`. Názvy testů nesou Test ID z `agent-platform-foundation/VERIFICATION-CONTRACT.md`, takže výpis je zároveň evidence pro P1.

## Další příkazy

| Příkaz | Co dělá |
|---|---|
| `npm run typecheck` | `tsc --noEmit` nad `src`, `tests` |
| `npm run arch` | `ARCH-DEP-001`: komponenta smí importovat jen `platform/api` a vlastní adresář |
| `npm run test:watch` | Vitest ve watch režimu |

## Aktualizace kontraktů

Schémata v `contracts/` jsou kopie z foundation a jsou pinované v `contracts/CONTRACTS-VERSION`. Aktualizace = nová kopie + nový pin + běh `npm test`. Nikdy se needitují tady.

## CI

`.github/workflows/kontrola.yml` (Node 24): `npm ci`, `npm run typecheck`, `npm test`, `npm run arch`, gitleaks, kontrola odkazů.

## Testy

`tests/` má jeden soubor na rodinu (`ctr`, `sec`, `mut`, `idm`, `wf`, `res`, `int`, `evd`, `arch`). Názvy testů nesou Test ID z `VERIFICATION-CONTRACT.md`. Conformance fixtures a golden výstupy jsou v `conformance/<capability>/`, golden master workflow v `conformance/workflows/document-intake.v1/`. Testy zapisující journal a audit soubory používají dočasný adresář systému; nic nezůstává v repu.
