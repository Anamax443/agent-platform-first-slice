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

`.github/workflows/kontrola.yml`: `npm ci`, `npm run typecheck`, `npm test`, `npm run arch`, gitleaks, kontrola odkazů.
