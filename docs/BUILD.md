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
| `npm run farm:check` | `scripts/farm-config.mjs` pro každou instalaci s profilem, pak `wrangler deploy --dry-run` nad každým vygenerovaným configem (instalace × deployables) a `tsc` nad `deploy/cloudflare` včetně generovaných modulů instalace. Base config sám build neprojde: kód + instalace = deployable. Dry-run neodhalí chyby za běhu (W13), proto brána kroku 2 zahrnuje i `wrangler dev` + `/version` |
| `node scripts/farm-config.mjs [instalace]` | pro každou instalaci vygeneruje `.wrangler/generated/<instalace>/installation.ts` (statické importy `profile.json` + `policy/*.json`, `assembleInstallation` při importu) a `<deployable>/wrangler.jsonc` = base `deploy/cloudflare/<deployable>/wrangler.jsonc` + alias `apf:installation` na ten modul + `vars.INSTALLATION` + overlay `config/<instalace>/farm.json` (nepovinný: routes, vars); `main` přepočítaný. Git-ignored; z něj se nasazuje i spouští `wrangler dev` |
| `node scripts/farm-deploy.mjs <instalace> [--bootstrap] [--dry-run]` | nasadí instalaci z generovaných configů v pořadí fakes → document-host → email-executor → mail-ingest → gateway; `--bootstrap` při prvním nasazení (gateway a hosty se navzájem odkazují service bindingy: první průchod bez `services`, druhý plný). Nic vázaného na účet ve skriptu není, vše je v `config/<instalace>/` a v přihlášení wrangleru |
| `npm run test:watch` | Vitest ve watch režimu |

## Aktualizace kontraktů

Schémata v `contracts/` jsou kopie z foundation a jsou pinované v `contracts/CONTRACTS-VERSION.json` (`src/platform/schemas.ts` je importuje staticky, stejně jako komponenty své descriptory a schémata; nic se nečte z disku při importu, aby totéž běželo pod Node i ve Workeru). Aktualizace = nová kopie + nový pin + běh `npm test`. Nikdy se needitují tady. Validátor je `@cfworker/json-schema` (interpret, draft 2020-12), ne Ajv: Ajv staví validátory přes `new Function`, což Workers zakazují; `wrangler deploy --dry-run` to neodhalí (bundle projde), spadlo by až při startu Workeru (W13).

## Instalační profil

Vše vázané na zákazníka nebo prostředí je mimo kód, v `config/<instalace>/`:

| Soubor | Obsah |
|---|---|
| `profile.json` | tenanty, identity se scopes, role orchestrátoru, reference credentialů per handler (jen jména `cred:*`), kanály (`apiHost`, `intakeAddress`, `notifyFrom`), retence, seznam capability, které musí mít policy; schéma `config/profile.schema.json` |
| `policy/*.policy.json` | platform policy per capability (ADR-016): granty per tenant, allowlist příjemců pro `email.send`, `failClosed: true` |
| `farm.json` | jen u instalací na Cloudflare: overlay per deployable (routes, vars, id prostředků) pro `scripts/farm-config.mjs`; pod `$signingPublicKeys` veřejné klíče gateway pro hosty |
| `profile.json` → `models` | modely AI per capability: `default` + `options{provider: workers-ai \| anthropic \| fake, model, label, credential jen jménem, inferenceGeo, processor}`; nedostupná volba (chybí secret) se jmenuje ve formuláři, nedostupný default = wiring se nespustí („nikdy bez modelu"). Secrets: `GATEWAY_SIGNING_KEY` (Ed25519 PKCS8), `ANTHROPIC_API_KEY` (`cred:anthropic`), `DMS_SECRET`, `ARCHIVE_SECRET`; mapa reference → jméno secretu je v `deploy/cloudflare/apf-gateway/src/index.ts` (jen jména) |

`src/installation.ts` profil sestaví fail-closed (schéma, každá policy přítomna, každý grant na známou identitu se scope, který drží, a na známý tenant) a `credentialTable()` ověří, že kód handleru chce jen reference, které mu profil přiznává, a že každá má hodnotu ze zdroje secrets (env, wrangler secret, testovací mapa). `createSlice(installation, secrets, volby)` pak nezná žádný literál. Instalace v repu: `local-fakes` (testy, `tests/harness/installation.ts`) a `farm-bass443` (farma, adresy jsou návrh). **Nová instalace = nový adresář + secrets, nula změn v `src/`**; hlídá to `npm run arch`. Worker instalaci za běhu nenačítá ani nejmenuje: importuje modul `apf:installation`, který `scripts/farm-config.mjs` vygeneruje z profilu a policy a alias ve vygenerovaném wrangler configu ho naváže při buildu (typ `deploy/cloudflare/types/apf-installation.d.ts`); `assembleInstallation` běží při importu, takže s vadným profilem Worker vůbec nenastartuje, a `env.INSTALLATION` musí souhlasit s bundlem (jinak `INSTALLATION_MISMATCH`).

## CI

`.github/workflows/kontrola.yml` (Node 24): `npm ci`, `npm run typecheck`, `npm test`, `npm run arch`, `npm run farm:check`, gitleaks, kontrola odkazů.

## Testy

`tests/` má jeden soubor na rodinu (`ctr`, `sec`, `mut`, `idm`, `wf`, `res`, `int`, `evd`, `arch`), `mail` pro druhý tok, `inst` pro fail-closed načtení instalačního profilu a workflow definic (Test ID řezu `INST-001..005`, ne normy) a `fakes` pro `document.validate` přes protokol `apf-fakes` (Test ID řezu `INT-HTTP-001..008`: stejné třídy chyb jako `INT-FAIL` přes skutečnou síť, chaos přepínač bez rebuildu, nedosažitelný dvojník i nesmyslná 200 odpověď, protokol DMS a archivu pro celek D). Názvy testů nesou Test ID z `VERIFICATION-CONTRACT.md`. Conformance fixtures a golden výstupy jsou v `conformance/<capability>/`, golden mastery workflow v `conformance/workflows/<workflow>/`. Testy staví svět přes `tests/harness/index.ts` (`createSlice(volby)` = instalace `config/local-fakes` + fake secrets). Testy zapisující journal a audit soubory používají dočasný adresář systému; nic nezůstává v repu.
