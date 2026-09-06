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
| `npm run arch` | `ARCH-DEP-001`: komponenta smí importovat jen `platform/api`, vlastní adresář a adaptéry (nic z `node:*`); platforma nečte systémové hodiny; **lint instalačních hodnot**: žádný tenant, actor id, adresa kanálu ani host z `config/*/` a žádný e-mail či veřejný hostname jako literál v `src/**`, `deploy/cloudflare/*/src/**` a base `wrangler.jsonc` (tam ani `routes`) |
| `npm run farm:check` | `wrangler deploy --dry-run` nad pěti base configy a nad configy vygenerovanými per instalace, pak `tsc` nad `deploy/cloudflare` |
| `node scripts/farm-config.mjs [instalace]` | sloučí `deploy/cloudflare/<deployable>/wrangler.jsonc` (kód) s `config/<instalace>/farm.json` (routes, vars) do `.wrangler/generated/<instalace>/<deployable>/wrangler.jsonc` (git-ignored); z něj se nasazuje |
| `npm run test:watch` | Vitest ve watch režimu |

## Aktualizace kontraktů

Schémata v `contracts/` jsou kopie z foundation a jsou pinované v `contracts/CONTRACTS-VERSION.json` (`src/platform/schemas.ts` je importuje staticky, stejně jako komponenty své descriptory a schémata; nic se nečte z disku při importu, aby totéž běželo pod Node i ve Workeru). Aktualizace = nová kopie + nový pin + běh `npm test`. Nikdy se needitují tady.

## Instalační profil

Vše vázané na zákazníka nebo prostředí je mimo kód, v `config/<instalace>/`:

| Soubor | Obsah |
|---|---|
| `profile.json` | tenanty, identity se scopes, role orchestrátoru, reference credentialů per handler (jen jména `cred:*`), kanály (`apiHost`, `intakeAddress`, `notifyFrom`), retence, seznam capability, které musí mít policy; schéma `config/profile.schema.json` |
| `policy/*.policy.json` | platform policy per capability (ADR-016): granty per tenant, allowlist příjemců pro `email.send`, `failClosed: true` |
| `farm.json` | jen u instalací na Cloudflare: overlay per deployable (routes, vars) pro `scripts/farm-config.mjs` |

`src/installation.ts` profil sestaví fail-closed (schéma, každá policy přítomna, každý grant na známou identitu se scope, který drží, a na známý tenant) a `credentialTable()` ověří, že kód handleru chce jen reference, které mu profil přiznává, a že každá má hodnotu ze zdroje secrets (env, wrangler secret, testovací mapa). `createSlice(installation, secrets, volby)` pak nezná žádný literál. Instalace v repu: `local-fakes` (testy, `tests/harness/installation.ts`) a `farm-bass443` (farma, adresy jsou návrh). **Nová instalace = nový adresář + secrets, nula změn v `src/`**; hlídá to `npm run arch`.

## CI

`.github/workflows/kontrola.yml` (Node 24): `npm ci`, `npm run typecheck`, `npm test`, `npm run arch`, `npm run farm:check`, gitleaks, kontrola odkazů.

## Testy

`tests/` má jeden soubor na rodinu (`ctr`, `sec`, `mut`, `idm`, `wf`, `res`, `int`, `evd`, `arch`), `mail` pro druhý tok a `inst` pro fail-closed načtení instalačního profilu a workflow definic (Test ID řezu `INST-001..003`, ne normy). Názvy testů nesou Test ID z `VERIFICATION-CONTRACT.md`. Conformance fixtures a golden výstupy jsou v `conformance/<capability>/`, golden mastery workflow v `conformance/workflows/<workflow>/`. Testy staví svět přes `tests/harness/index.ts` (`createSlice(volby)` = instalace `config/local-fakes` + fake secrets). Testy zapisující journal a audit soubory používají dočasný adresář systému; nic nezůstává v repu.
