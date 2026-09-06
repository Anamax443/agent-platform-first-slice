# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

## 2026-09-06 (12) — Čas vlastníka doplněn, limit 40 h vyhodnocen; vlastník chce ověření v provozu

**Čas vlastníka (odhad vlastníka, potvrzeno „sedí"):** architektura a rozhodování 1,5 h · posudky a review 2 h · ladění 0,25 h · provoz a účty 0,5 h = **4,25 h za M0–M4b**. Zapsáno do MEASUREMENT (tabulka + vyhodnocení: s AI wall-clock ≈ 3 h 45 min celkem ≈ 8 h, limit 40 h na MUST sadu splněn s velkou rezervou; lidský čas se s asistentem přesouvá do rozhodování a review), STATUS CZ/EN (kpi, tabulka měření včetně řádků M4b, warnbox, Zbývá 5 hotové, rozhodnutí), POSUDKY (otevřené položky uzavřeny). Kód beze změny.

**Nový pokyn vlastníka (6. 9. 2026 odpoledne): „chtěl bych to ověřit v provozu."** Návrh postupu je v odpovědi asistenta a v dalším záznamu, až se rozhodne: nejdřív krok 3 „lite" = nasazení skeletonu pěti Workerů na bass443 za Access s custom doménou (ověří účet, prostředky D1/R2/KV, Access, doménu, `/version` z farmy), pak zbytek kroku 2 (journal DO, audit D1, `/dispatch`, hosty, fakes, harness) a teprve potom golden mastery proti farmě. Id prostředků (D1, KV) jsou instalační hodnoty → patří do `config/farm-bass443/farm.json`, ne do base configů.

**Zbývá rozhodnout (Milan):** jestli aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` míří do jedné schránky (krok 4); souhlas s nasazením skeletonu na účet bass443 (vytváří DNS záznam pro `apf.maxferit.cz`, Access aplikaci a prostředky D1/R2/KV; na Free plánu bez nákladů).

## 2026-09-06 (11) — M4b krok 2, celek 1: instalace navázaná do Workeru, validátor bez generování kódu, rozhodnutí o adresách a plánu

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **208 testů**), `npm run arch` (20 instalačních hodnot, 0 nálezů), `npm run farm:check` (**10 configů** = 2 instalace × 5 deployables, včetně `tsc` nad deploy s generovanými moduly) zelené. **Ověřeno na `wrangler dev`** (což dry-run neumí, viz W13): gateway z `.wrangler/generated/{local-fakes,farm-bass443}/apf-gateway/wrangler.jsonc` odpovídá na `/version` `{"installation":"…","tenants":2,"identities":3,"policies":6,…}`; `/health` ok; `/dispatch` dál 501.

**Rozhodnutí (asistent na „up to you" vlastníka, 6. 9. 2026):** adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@maxferit.cz`; schránky v allowlistu = aliasy Email Routing `apf-ops@`, `apf-supervisor@` (tenant-42), `apf-ops-t7@maxferit.cz` (tenant-7), cíl přeposílání jen v účtu (repo skutečnou schránku nezná); plán **Workers Free** do kroku 5. Zapsáno v `config/farm-bass443/` (profil, policy, farm.json), v návrhovém listu (otevřené otázky) a ve STATUS. Čas vlastníka zůstává nezměřen (nejde rozhodnout za něj).

**Hotové v tomto celku:**
- `src/platform/schemas.ts`: Ajv nahrazen `@cfworker/json-schema` (interpret draft 2020-12; jediný `format` v kontraktech je `date-time`; jeden `Validator` per kontrakt s ostatními schématy přidanými kvůli `$ref`). Důvod: Ajv staví validátory přes `new Function`, workerd to zakazuje, dry-run bundle přesto projde (W13). `ajv`, `ajv-formats` odinstalovány.
- `src/platform/bytes.ts` (utf8, hex, base64url nad `Uint8Array`); `ids.ts` přes `crypto.getRandomValues`, `signing.ts` a `artifacts.ts` bez `Buffer`. Důvod: workers-types deklaruje globální `Buffer: any`, vedle @types/node to rozbíjí typy (W14).
- `scripts/farm-config.mjs`: pro každou `config/<inst>/` s profilem generuje `.wrangler/generated/<inst>/installation.ts` (statické importy profilu + policy, `assembleInstallation` při importu) a configy všech deployables s aliasem `apf:installation`, `vars.INSTALLATION` a nepovinným overlay `farm.json`. `farm-check` dry-runuje jen generované (base config sám build neprojde: kód + instalace = deployable). `farm.json` zjednodušen (INSTALLATION doplňuje generátor).
- `deploy/cloudflare/types/apf-installation.d.ts`; deploy tsconfig `types: [workers-types, node]` + include generovaných modulů; `apf-gateway` importuje `apf:installation`, při neshodě s `env.INSTALLATION` odpovídá 500 `INSTALLATION_MISMATCH`, `/version` hlásí instalaci.
- `tests/inst.test.ts` INST-004: každá `config/*/` se sestaví Node loaderem (farm profil je build input, ne fixture).
- Docs: BUILD (validátor, farm-config/farm-check, `apf:installation`), ARCHITECTURE, README CZ/EN (validátor), deploy README (dvouvrstvé configy, příkazy s generovaným configem, sekce Rozhodnuto), návrhový list (otázky rozhodnuty), MEASUREMENT (řádek celku, W13, W14, 208/INST-004), STATUS CZ/EN.

**Další celek (krok 2, celek 2): journal a audit s vyměnitelnou implementací.** Rozhraní `Journal`/`Audit` zůstávají v platformě; `DoSqliteJournal` (DO `WorkflowInstance`, SQLite storage) a `D1Audit` v `apf-gateway/src/`, ověřené miniflare (`wrangler dev` + D1/DO lokálně). Pak celek 3: `/dispatch` (identita z hlavičky Access service tokenu, lokálně dev hlavička; podpis klíčem z `.dev.vars`). **Pozor pro celek 3:** `signing.ts` používá `node:crypto` `sign`/`verify`/`generateKeyPairSync` s `KeyObject` (Ed25519); ve workerd přes `nodejs_compat` ověřit hned první věcí, jinak WebCrypto `crypto.subtle` (async → `Gateway.dispatch` async, dotkne se harnessu a testů `slice.gateway.dispatch(...)`). `credentials.ts` má `AsyncLocalStorage` (nodejs_compat ji podporuje). `journal.ts`/`audit.ts` s `node:fs` ve Workeru nahradí implementace z celku 2.

**Postup pro lokální ověření:** `node scripts/farm-config.mjs` → `npx wrangler dev -c .wrangler/generated/local-fakes/apf-gateway/wrangler.jsonc --port 8787` → `curl http://127.0.0.1:8787/version`.

**Zbývá rozhodnout (Milan):** čas vlastníka za M1–M4b; zda aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` míří do jedné schránky (nastavení v účtu, krok 4).

## 2026-09-06 (10) — M4b krok 1 HOTOVÝ (celek B): lint instalačních hodnot, generované wrangler configy, docs; 207 testů, pushnuto

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **207 testů**), `npm run arch` (0 nálezů, 17 instalačních hodnot z obou profilů), `npm run farm:check` (**10 configů**: 5 base + 5 vygenerovaných pro `farm-bass443`) zelené lokálně. Krok 1 návrhového listu farmy je uzavřený; po pushi ověřit CI (nově běží i lint nad `deploy/` a dry-run nad generovanými configy).

**Hotové v tomto celku:**
- `scripts/arch-dep.mjs`: komponenty už nesmí `node:path`/`node:url` (statické importy je nepotřebují); **lint instalačních hodnot**: načte `config/*/profile.json` (název instalace, tenanty, actorId identit, kanály) a `config/*/policy/*.json` (actorId grantů, allowlist příjemců: tenant, ref i adresa) a hlídá, že žádná z nich, žádný e-mail ani veřejný hostname (regex nad TLD) není literál v `src/**` (.ts řetězce mimo komentáře, .json hodnoty), `deploy/cloudflare/*/src/**` a base `wrangler.jsonc` (tam navíc zakázané `routes`). Jeden nález na literál. Bez argumentu kontroluje všechno, s argumentem jen daný strom (testy). Test v `arch.test.ts` (3. případ: tenant z profilu, e-mail, hostname → `FAILED (3)`).
- `scripts/jsonc.mjs` (sdílený JSONC reader), `scripts/farm-config.mjs` (`merge` base + `config/<instalace>/farm.json` → `.wrangler/generated/<instalace>/<deployable>/wrangler.jsonc`, `main` přepočítaný relativně, `$schema` pryč; deployable v overlay musí existovat, nepojmenovaný dostane base beze změny), `scripts/farm-check.mjs` dry-run nad base i generovanými; **natvrdo zapsané account id ze skriptu pryč** (dry-run ho nepotřebuje, ověřeno).
- Base `wrangler.jsonc`: z gateway pryč `routes`, z email-executoru `EMAIL_FROM`/`EMAIL_FROM_NAME`, z mail-ingestu adresa v komentáři; overlay je má v `config/farm-bass443/farm.json`. Lint tyto čtyři hodnoty při prvním běhu našel (shoda s auditem v (5)).
- Docs: BUILD (příkazy `arch`/`farm:check`/`farm-config`, pin `CONTRACTS-VERSION.json`, sekce „Instalační profil", CI, testy `inst` + `mail`), ARCHITECTURE (`createSlice(installation, secrets, volby)`, `DispatchTransport`, statické importy; F1/F3 řádky), README CZ/EN (řádky `contracts/`, `config/`, `src/platform/`, `src/slice.ts`, `src/installation.ts`, `workflows/`), deploy README (dvouvrstvé configy, příkazy z generovaného configu, cesta k policy), MEASUREMENT (řádek M4b krok 1: ≈ 1 h 10 min AI, ≈ 1 010 řádků; W12 „vyřešeno v řezu"; „Co je zelené" 207/11 + INST), STATUS CZ/EN (kpi 207/11, hotové M4b krok 1, zbývá 1 = krok 2).

**Poznámky pro krok 2 (wrangler dev + harness proti localhost):**
- `HttpDispatchTransport` existuje, ale nikdo ho nevolá; harness `dispatch()` a orchestrátory berou `slice.transport`, takže přepnutí na HTTP je jen jiná instance v `createSlice` (volba `transport?`) nebo v `tests/harness/index.ts`.
- `Journal` a `Audit` v `src/platform` stále umí soubor (`node:fs`); ve Workeru půjde journal do DO SQLite a audit do D1: rozhraní zůstávají, implementace se vymění v gateway Workeru, ne v platformě.
- Worker si profil vezme statickým importem `config/<instalace>/profile.json` + policy podle `INSTALLATION` var (build-time výběr přes `farm-config`, ne runtime `fs`); to je první věc kroku 2.
- Fakes očekávají hodnoty `dms-secret`/`archive-secret`/`smtp-secret` (defaulty konstruktorů adaptérů); na farmě je nahradí skutečné secrets přes `SecretsSource` z `env`.

**Rozpracované / chybí:** krok 2 (výše); krok 3 nasazení (D1, R2 eu, KV, secrets, Access, doména); krok 4 e-mail; krok 5 fronta + RES-CRASH přes evikci DO; krok 6 pentest ADR-017 + řádek M4b s cenou; čas vlastníka do MEASUREMENT; W4 do normy; část XVII ve foundation (W12 + INST jako evidence pro instalační profil v normě).

**Zbývá rozhodnout (Milan):** beze změny: adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@maxferit.cz` a schránka za `ops-mailbox` (dnes placeholder v `config/farm-bass443/policy/email.send.v1.policy.json`); čas vlastníka za M1–M4.

## 2026-09-06 (9) — M4b krok 1, celek A ZELENÝ: platforma bez disku, instalační profil v kompozičním kořeni, 206 testů

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **206 testů** = 198 + 8 nových INST), `npm run arch`, `npm run farm:check` zelené lokálně. Repo je po (8) zase funkční. Tento commit uzavírá body 1–4 z (8); body 5–7 (lint instalačních hodnot, `farm-config`, docs) jsou celek B a jdou hned za ním.

**Hotové v tomto celku:**
- `src/platform/schemas.ts`: pět schémat + `contracts/CONTRACTS-VERSION.json` importované staticky; žádné `node:fs`/`node:path`/`node:url`, žádný `projectRoot`, žádný `loadJson`. `CONTRACTS_VERSION` má stejný tvar jako dřív (`1.0-rc2.1 12a3c32`), navíc `CONTRACTS_PIN` (celý objekt).
- `workflows/workflow-definition.schema.json` (nové, slice-local, ne kontrakt foundation) + `src/platform/workflow.ts` s `parseWorkflowDef()`: schéma, unikátní id kroků, každý `$steps.<id>` ukazuje na dřívější krok; jinak výjimka.
- `src/installation.ts`: `credentialTable()` teď bere `{ handlerId: [reference, které kód potřebuje] }` a kontroluje, že profil je handleru přiznává (kód říká, co potřebuje; profil, co smí; obojí musí sedět). Přidané kontroly: duplicitní `actorId`, identita v neznámém tenantu.
- `src/installation-node.ts`: `loadInstallationFromDir(dir)` (fs až při volání) pro testy a Node.
- `src/slice.ts`: `createSlice(installation, secrets, opts)`; identity z profilu, policy přes `policyFor()`, credential tabulky přes `credentialTable()` per host, `InProcessTransport` do obou orchestrátorů i do návratu (`slice.transport`), workflow definice importované staticky a parsované (`WORKFLOW_DEFINITIONS`, `workflowDef(name)`). **Konstanty tenantů a identit ze `src/` zmizely**; `DEFAULT_CLOCK_START` zůstává (testovací default hodin, ne instalační hodnota).
- Harness: `tests/harness/paths.ts` (`projectRoot`, `loadJson` jen pro testy), `tests/harness/installation.ts` (`LOCAL_FAKES` z `config/local-fakes`, `FAKE_SECRETS`, `ORCHESTRATOR`/`TENANT_A`/`ORCHESTRATOR_B`/`TENANT_B`/`AI_AGENT` odvozené z profilu, ne literály), `index.ts` obaluje `createSlice(o)` a `dispatch()` jde přes `slice.transport`. Opravené importy v `suite.ts`, `rogue.ts`, `ctr.test.ts` (allowlist příjemců z `LOCAL_FAKES.policies`), `sec.test.ts`, `arch.test.ts`, `wf.test.ts` (dva `new Orchestrator` s `transport`).
- `tests/inst.test.ts` (INST-001..003): profil proti schématu, chybějící policy, policy bez `failClosed`, grant neznámé identitě / scope, který identita nedrží / neznámému tenantu, `roles.orchestrator` mimo identity; credential tabulka (handler bez záznamu, nepřiznaná reference, chybějící secret); workflow definice (schéma, duplicitní krok, dopředný `$steps`).

**Celek B (další commit):** 5. `scripts/arch-dep.mjs` zpřísnit (komponenty bez `node:path`/`node:url`) + lint instalačních hodnot v `src/**` a `deploy/cloudflare/*/src/**`; 6. `scripts/farm-config.mjs` + `farm:check` i nad generovanými configy, z base `wrangler.jsonc` pryč `routes` a `EMAIL_FROM*`; 7. docs (BUILD, README CZ/EN, ARCHITECTURE, deploy README, MEASUREMENT řádek M4b krok 1, STATUS CZ/EN). Push až po celku B (CI běží `farm:check`, generované configy musí projít).

## 2026-09-06 (8) — M4b krok 1 ROZPRACOVÁNO a přerušeno: portabilita platformy + instalační profil, repo je ČERVENÉ

**Pravidlo vlastníka od této chvíle:** postupovat po malých celcích jako po milnících; po každém celku aktualizovat HANDOFF a commitnout. Žádné velké dávky změn napříč deseti soubory najednou.

**Stav: NEKOMPILUJE a testy by nenaběhly.** Tento commit je záměrný snímek rozpracované práce, ne funkční stav. **Nepushovat, dokud další celek nezezelená** (CI by spadlo, GitHub je zdroj pravdy pro druhý PC). Typecheck: 5 chyb (`src/slice.ts` importuje odstraněný `loadPolicy` a orchestrátoru předává `gateway`/`router` místo `transport`; `tests/wf.test.ts` totéž na dvou místech). Runtime: `src/platform/schemas.ts` stále čte disk při importu a hledá textový `contracts/CONTRACTS-VERSION`, který je smazaný → import platformy by spadl na ENOENT.

**Hotové v tomto celku (funguje samo o sobě):**
- Pět handlerů importuje descriptor a schémata staticky (`import x from "./…json" with { type: "json" }`), bez `node:path`/`node:url`/`loadJson`. `loadJson` odebrán z `platform/api.ts`.
- `src/platform/policy.ts`: bez čtení disku; typy `Policy`, `PolicySet`, `policyFor` (fail-closed), `checkGrant`. `loadPolicy` odstraněn.
- `src/platform/transport.ts`: rozhraní `DispatchTransport`, `InProcessTransport` (gateway + router), `HttpDispatchTransport` (POST `/dispatch`, v těle jen `message`, identita jen z hlaviček, odpověď validovaná proti result-envelope). Orchestrátor už bere `transport` místo `gateway`+`router`.
- Instalační profil: `config/profile.schema.json`, `config/local-fakes/profile.json` (tenanty, identity, role orchestrátoru, credential reference per handler jen jménem, kanály null, retence, policyRefs), `config/farm-bass443/profile.json` (NÁVRH adres, čeká na vlastníka) a `config/farm-bass443/farm.json` (overlay routes/vars per deployable pro budoucí `scripts/farm-config.mjs`). Šest policy přesunuto `git mv` z `contracts/policy/` do `config/local-fakes/policy/` a zkopírováno do `config/farm-bass443/policy/`; v `contracts/policy/` zůstal jen vzor z foundation.
- `src/installation.ts`: typy `InstallationProfile`, `Installation`, `SecretsSource`; `assembleInstallation()` (schéma, každý policyRef přítomen, každý grant ukazuje na známou identitu s daným scope a známý tenant, `failClosed` povinné) a `credentialTable()` (chybějící secret = výjimka).
- `contracts/CONTRACTS-VERSION.json` místo textového souboru.

**Další malý celek = zezelenat (odhad 1 session, cca 10 souborů):**
1. `src/platform/schemas.ts`: statické importy pěti schémat a `CONTRACTS-VERSION.json`, odstranit `readFileSync`/`projectRoot`/`loadJson` (návrh byl připraven, zápis se nestihl).
2. `src/installation-node.ts`: `loadInstallationFromDir(dir)` (fs až při volání) — Node helper pro testy.
3. `src/slice.ts`: `createSlice(installation, secrets, opts)`; identity z profilu, policy přes `policyFor(installation.policies, …)`, credential tabulky přes `credentialTable()` per host, `InProcessTransport` do orchestrátorů a do návratu, workflow definice staticky importované a validované proti novému `workflows/workflow-definition.schema.json`; odstranit exportované konstanty tenantů a identit.
4. Harness: `tests/harness/paths.ts` (projectRoot, loadJson jen pro testy), `tests/harness/installation.ts` (LOCAL_FAKES z `config/local-fakes`, FAKE_SECRETS `cred:dms-stamp`→`dms-secret`, `cred:archive-store`→`archive-secret`, `cred:smtp`→`smtp-secret`, konstanty TENANT_A/B, ORCHESTRATOR(_B), AI_AGENT odvozené z profilu), `index.ts` obal `createSlice(o)` = core(LOCAL_FAKES, FAKE_SECRETS, o), `dispatch()` přes `slice.transport`; opravit importy v `suite.ts`, `rogue.ts`, `ctr.test.ts` (cesta k `email.send` policy je teď `config/local-fakes/policy/`), `sec.test.ts`, `arch.test.ts`, `wf.test.ts` (dva `new Orchestrator` s `transport`).
5. `scripts/arch-dep.mjs`: komponenty smí importovat jen `./`, `platform/api`, `adapters/*` (bez node:path/url); nový lint: žádný literál z `config/*/profile.json` a policy (tenanty, actor id, adresy, hosty) ani e-mail/doména regexem v `src/**` a `deploy/cloudflare/*/src/**`.
6. `scripts/farm-config.mjs` (merge base wrangler.jsonc + `config/<instalace>/farm.json` → `.wrangler/generated/`), `farm-check` dry-run i nad generovanými; z base configů odstranit `routes` a `EMAIL_FROM*`.
7. Docs po zezelenání: BUILD (CONTRACTS-VERSION.json, config/), README CZ/EN (řádek `config/`), ARCHITECTURE (profil, transport), deploy README, MEASUREMENT (M4b krok 1 řádek), STATUS.
Brána celku: `npm run typecheck`, `npm test` (198), `npm run arch`, `npm run farm:check` zelené; pak push.

## 2026-09-06 (7) — Posudky 2–4 nad implementací: 9,2/10 formální oponentura, dva konverzační; AI-EVAL jako podmínka v1.0, pentest o eskalaci práv

**Zdroj:** tři další posudky postoupené vlastníkem, protokol v `docs/POSUDKY.md`. Shoda se posudkem 1: norma nevyvrácena, 0 BLOCKER, 1 MAJOR (fyzická izolace, plán M4b), 3 MINOR (AI-EVAL, čas vlastníka, provozní realita).

**Co se změnilo:**
1. **Reálný model = podmínka v1.0** s konkrétním minimem: Workers AI za `document.classify`, golden set 10 faktur + 3 injection s ownerem labelů, `criticalFields: [documentType]`, `AI-EVAL-REG-001` + `AI-EVAL-ADV-001`. Krok 7 návrhového listu. Návrh pro foundation: XII.D doplnit podmínku v1.0 o AI-EVAL s reálným modelem.
2. **Pentest** kroku 6 rozšířen o scénář (d) eskalace práv (nepřímé cesty k cizím bindingům a podpisovému klíči).
3. **Durable Objects:** zapsáno, jak journal přežije evikci (stav jen v SQLite storage, `recover()` při reaktivaci, audit append-only v D1).
4. **Meze smyček** doloženy z workflow definic (2 strategie × qualityBudget 2, technicalRetries 2, reconciliationBudget 3, eskalace review 2, deadline 30 / 10 min) a zapsány do STATUS.
5. **STATUS „Zbývá" je číslované podle priority**; kategorie času vlastníka sjednoceny (posudky 1 a 2).

**Zbývá rozhodnout (Milan):** beze změny (čas vlastníka v členění, adresy pro farmu, schránka za `ops-mailbox`). Otázka posudku 3 „co bylo nejtěžší a co jinak" má v protokolu odpověď z pohledu implementace; odpověď vlastníka může být jiná.

## 2026-09-06 (6) — Posudek 1 nad implementací (9,1/10): W4 rozhodnuto jako CONDITIONAL, pořadí dalších kroků upraveno

**Zdroj:** externí posudek nad `STATUS.html`, který vlastník postoupil. Protokol s dispozicí každého doporučení: `docs/POSUDKY.md`. Hlavní závěr: první implementace normu nevyvrátila, testy našly konstrukční chyby, druhý tok prokázal reuse za 45 řádků platformy.

**Co se změnilo v plánu:**
1. **W4 rozhodnuto:** CONDITIONAL pravidlo (AI výstup → state-changing krok s `riskClass ≥ MEDIUM` vyžaduje nezávislý signál nebo human gate), ne univerzální invariant. V řezu zůstává druhý signál ve validátoru. Návrh pro foundation část XVII.
2. **Pořadí:** M4b farma → pentest credential izolace (tři otázky s očekávaným NE, kritéria v návrhovém listu krok 6) → reálný LLM + AI-EVAL → **třetí doména** kvůli mezní ceně → M5 `EXISTS × 2` → M6.
3. **M6 zúženo:** první sdílený balíček = kontrakty, schémata, fixtures, conformance runner. Orchestrátor a executor runtime zůstávají duplikované déle (P2).
4. **Měření:** čas vlastníka se člení (architektura / review / ladění / provoz); nová metrika „platforma +řádků na novou doménu" (M4 = 45).
5. **Formulace PRINCIPAL:** „design proven, physical isolation not yet proven", dokud `email.send` neběží jako vlastní deployable.

**Zbývá rozhodnout (Milan):** beze změny: čas vlastníka za M1–M4; adresy pro farmu (`apf.maxferit.cz`, `apf-intake@`, `apf-notify@`) a schránka za `ops-mailbox`. Cloudflare plán: začít na Free (fronty jsou dostupné, 10 000 operací/den), Paid až kdyby nestačil CPU limit 10 ms na požadavek.

## 2026-09-06 (5) — M4b zahájeno: farma na Cloudflare, návrhový list + skeleton pěti deployables

**Rozhodnutí vlastníka:** postavit malou farmu na Cloudflare, aby se závěry řezu ověřily na skutečném runtime (izolace PRINCIPAL, transport, fronta, pád DO, reálný model, reálná pošta). Zařazeno jako **M4b před M5/M6**, protože vyrábí evidenci pro otevřená rozhodnutí (pentest ADR-017, cena PRINCIPAL deployables). Žije v tomto repu (`deploy/cloudflare/`), testy a golden mastery zůstávají sdílené.

**Hotové v této session:**
- `docs/NAVRHOVY-LIST-farma.md` podle šablony ai-agenti: vstupy a odchozí kanály, nepřátelský vstup, regulace a retence per datová třída, scénáře S1–S5, brány a write akce, křížová kontrola, limity, selhání a vypínač, pět deployables jako moduly, pořadí stavby v šesti krocích, náklady, tři otevřené otázky.
- `deploy/cloudflare/`: `wrangler.jsonc` + stub Worker pro `apf-gateway` (DO `WorkflowInstance`, D1 audit, R2, Workers AI, service bindings, secret podpisového klíče), `apf-document-host` (LOGICAL, dva secrets), `apf-email-executor` (PRINCIPAL, jediný binding = Email Sending, žádné secrets), `apf-mail-ingest` (`email()` handler, R2), `apf-fakes` (KV chaos přepínače). Všechny odpovídají `501 NOT_WIRED` mimo `/health` a `/version`; nic není nasazené.
- `scripts/farm-check.mjs` + `npm run farm:check`: `wrangler deploy --dry-run` pro všech pět configů bez přihlášení. **Prošlo** (wrangler 4.129.0, workers-types nainstalované jako devDependency).
- Ověřeno `wrangler whoami`: účet **bass443** (`a37a36270aa2db7382f62912ba5a0130`), kde je zóna maxferit.cz, Access i Email Sending.

**Pravidlo vlastníka (6. 9. 2026): instalační profil.** Doména, adresy kanálů, identity, tenanty, granty, allowlisty a klíče jsou vázané na konkrétního zákazníka a prostředí; kód musí být pro každou instalaci stejný a nová instalace nesmí vyžadovat zásah do `src/`. Tři vrstvy (kód / instalační profil `config/<instalace>/` / secrets) a lint na instalační hodnoty v kódu jsou popsané v `docs/NAVRHOVY-LIST-farma.md` (sekce „Instalační profil"). Audit ukázal dnešní porušení: konstanty v `src/slice.ts`, `recipientAllowlist` a granty v `contracts/policy/`, doména a `EMAIL_FROM` ve `wrangler.jsonc`.

**Další krok = krok 1 návrhového listu (bez cloudu):** portabilita platformy **a instalační profil**. `src/platform/schemas.ts` a `policy.ts` čtou disk při importu (`readFileSync`, `projectRoot`), což ve Workeru neexistuje. Kontrakty se budou importovat staticky jako JSON; identity, tenanty a policy se přesunou do `config/local-fakes/` (testy) a `config/farm-bass443/` (farma), načítané přes schéma fail-closed; testy musí zůstat zelené. Pak rozhraní `DispatchTransport` (`in-process` = dnešní `slice.ts`, `http` = klient na farmu), aby týchž 198 testů běželo proti oběma.

**Rozpracované / chybí:**
1. Krok 1 (portabilita) a krok 2 (gateway + document-host + fakes na `wrangler dev`, harness proti localhost).
2. Krok 3 nasazení: D1, R2 (jurisdiction eu), KV, secrets, Access aplikace, custom doména `apf.maxferit.cz`.
3. Krok 4 e-mail: Email Routing rule `apf-intake@maxferit.cz`, Email Sending `apf-notify@maxferit.cz`, skutečná schránka za `ops-mailbox`.
4. Krok 5 fronta (Workers Paid) a `RES-CRASH-001` přes evikci DO; krok 6 pentest ADR-017 a řádek M4b v MEASUREMENT s cenou.
5. Stále: čas vlastníka do MEASUREMENT; W4 do normy?; část XVII ve foundation.

**Zbývá rozhodnout (Milan):** (a) Workers Paid kvůli Queues, nebo první verze bez front; (b) adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@` a schránka za `ops-mailbox`. Kroky 1–2 na tom nezávisí.

## 2026-09-06 (4) — M4 hotové: druhý tok mail.ingest → document.* → email.send, W4 rozhodnuto druhým signálem

**Stav:** `npm run typecheck`, `npm test` (10 souborů, 198 testů) a `npm run arch` zelené lokálně. Tři rozhodnutí z minulého zápisu vzal na sebe asistent na pokyn vlastníka („up to you"): W4 řešit v řezu druhým deterministickým signálem a měřit; M4 žije v tomto repu jako druhý deployable; čas vlastníka zůstává nezměřen (nelze vymyslet).

**Hotové v této session:**
- `src/components/mail-ingest` (`mail.ingest/1`, internal-write, vlastní host bez credentialů, immutable originál z raw mailu, From/Subject parsovány pravidly a uloženy jako data, `STORAGE_FULL` při plném úložišti).
- `src/components/email-executor` (`email.send/1`, external-write, MEDIUM, **PRINCIPAL** = vlastní `ExecutorHost` + vlastní `CredentialResolver` s jediným `cred:smtp`; `recipientRef` se překládá na adresu jen přes `recipientAllowlist` v `contracts/policy/email.send.v1.policy.json`; šablony jen z enum a id; IRREVERSIBLE, reconcile přes `smtp.status(clientRef)`).
- `src/adapters/smtp.ts` (fake s dedup podle `clientRef` = business identita, režimy ok / unknown-once / unknown-always / reject), `ArtifactStore` s kapacitou a `put` v `ArtifactWriter`.
- `workflows/mail-intake.v1.json`: ingest → classify → validate → stamp → notify; vnořené `inputs` a `deadlineMs` per krok v orchestrátoru; orchestrátor zpracovává jen instance své definice (`workflow` guard v `run` i `recover`).
- W4: `document-validator` dostal `crossCheck` (pravidla nad textem bez instrukčních řádků); neshoda = `CLASSIFICATION_DISPUTED` (QUALITY) → review. Scénář `injection-in-allowlist` teď končí WAITING(REVIEW), ne razítkem.
- Conformance `mail.ingest` (5/1/2/1 + 4 error), `email.send` (5/1/1/1 + 7 error), golden master `mail-intake.v1` (5 scénářů), scénáře `document-intake.v1` přepsány do obecného formátu (`$artifact`, `$fixtureText`).
- Testy: `tests/mail.test.ts` (MUST sada `email.send` vč. 4 mutantů na druhém hostu, SEC-CTX-002 mezi toky, SEC-HOST-001 PRINCIPAL varianta, IDM-RET-002, RES-STOR-001, WF-UNK na SMTP, EVD toku 2, dvě workflow v jednom journalu); `ctr.test.ts` a `int.test.ts` zobecněny přes všechny komponenty a workflow adresáře.
- Stavový list `STATUS.html` (CZ) + `STATUS.en.html` (EN) v kořeni repa, stejná rodina jako ai-agenti a job-watch; odkazy v obou README. Aktualizovat každou session spolu s HANDOFF a MEASUREMENT.

**Nálezy této session (detail MEASUREMENT N10–N12):** sdílený journal by bez guardu nechal orchestrátor jednoho workflow „obnovit" instanci druhého; druhý signál chytil injection uvnitř allowlistu v obou tocích; fixture injekce jen v hlavičkách neměla co „poslechnout" (chyba scénáře, ne kódu).

**Rozpracované / chybí:**
1. Čas vlastníka do MEASUREMENT (M1–M4).
2. Ověřit CI po pushi.
3. M5 podle XII.G: obnova `EVIDENCE-MATRIX.md` ve foundation se dvěma novými řádky (document-intake, mail-intake) a Core Admission review `EXISTS × 2` (kandidáti: result envelope, error object, ClockFixture, CredentialResolverFixture, conformance runner, `subsetDiff` golden porovnání).
4. Přenést N5–N12 a W1–W10 do foundation jako část XVII „Protokol implementace".
5. Backoff a circuit breaker u technického retry (W6) až s durable frontou; alert při `STORAGE_FULL` (W10).

**Zbývá rozhodnout (Milan):** (a) zda W4 zůstane v řezu jako implementační volba, nebo půjde do normy jako CONDITIONAL pravidlo pro `usesLlm → write s riskClass ≥ MEDIUM`; (b) zda M5/M6 (první sdílený kontraktový balíček) začít hned, nebo napřed pentest izolace hostu podle ADR-017.

## 2026-09-06 (3) — M1 dokončeno, M2 a M3 hotové: 132 testů, 44 Test ID, MUST sada zelená

**Stav:** `npm run typecheck`, `npm test` (9 souborů, 132 testů) a `npm run arch` procházejí lokálně. CI `kontrola` dosud padala na chybějících testech a chybějícím `scripts/arch-dep.mjs`; oboje je teď v repu, CI přepnuto na Node 24 (varování o deprecaci Node 20 na runnerech).

**Hotové v této session:**
- Komponenty: `document-classifier/handler.ts` (prompt s oddělovači, enum allowlist čtený z output schématu, QUALITY retry s novým klíčem, provenance s modelId/promptVersion), `document-validator/` (descriptor s `dependsOn`, integrita sha256, registr přes `withTimeout`, mapování chyb, obě varianty INT-FAIL-004), `document-executor-host/` (descriptor se dvěma capability LOW/LOGICAL, stamp handler + reconciler přes `clientRef = idempotencyKey`, archive handler jako druhý handler v hostu). Output schémata pro všechny čtyři capability.
- Platforma: reconciliation hook v `ExecutorHost.reconcilerFor` (dedup záznam sleduje výsledek reconciliace), orchestrátor drží stejný `idempotencyKey` při technickém retry (`logicalAttempt` v journalu), `applyReviewExpiries` (WF-REV-003 mění stav instance), `acceptedMechanisms` v routeru (podvržený `in-process` binding neprojde), grace period klíče v `KeyRegistry` (SEC-CRED-003), `correlationId` na review tascích, `Audit.all()` vrací hluboké kopie.
- Kontrakty řezu: `contracts/policy/document.{classify,validate,stamp,archive}.v1.policy.json` (ADR-016), `workflows/document-intake.v1.json`, `src/slice.ts` (kompoziční kořen), `scripts/arch-dep.mjs` (ARCH-DEP-001 + lint hodin, VC §8.1).
- Conformance: `conformance/document.{classify,validate,stamp,archive}/` (fixtures, golden, README s MUST/DON'T CARE, `errors.md`, `compat.md`), `conformance/workflows/document-intake.v1/` (5 scénářů, golden master pro INT-E2E-001).
- Testy podle rodin: `tests/{ctr,sec,mut,idm,wf,res,int,evd,arch}.test.ts`, harness v `tests/harness/` (suite loader, conformance runner, rogue handlery pro SEC-HOST).
- `docs/MEASUREMENT.md`: M1–M3 zapsáno, 9 nálezů (4 zachytil test při prvním běhu, 4 vzešly z psaní testu proti normě, 1 doložená mez normy), 9 položek „obejito / chybělo" s návrhy pro foundation.

**Nejdůležitější nálezy pro foundation (detail v MEASUREMENT):** N5 klíč při technickém retry, N6 `in-process` binding, N7/W2 kdo mění dedup záznam po reconciliaci, N9/W4 injection uvnitř allowlistu projde F2.

**Rozpracované / chybí:**
1. Čas vlastníka do MEASUREMENT (řádky M1–M3), bez něj limit 40 h nejde vyhodnotit.
2. Ověřit zelené CI po pushi (gitleaks nad `dms-secret`/`archive-secret` v `src/slice.ts` by neměl reagovat, jsou to fake hodnoty; kdyby ano, allowlist v `.gitleaks.toml`).
3. M4 podle XII.G: druhý tok `mail.received` → `email.send` (PRINCIPAL, vlastní deployable), SEC-CTX-002 mezi oběma toky. WIP limit: až po uzavření M3, což je teď.
4. Nálezy N5–N9 a W1–W7 přenést do foundation jako část XVII „Protokol implementace" (změna zmrazených dokumentů jen s evidencí odsud, viz XVI).

**Zbývá rozhodnout (Milan):** (a) zda W4 (injection uvnitř allowlistu) řešit v normě druhým signálem, nebo nechat na AI-EVAL; (b) zda M4 žije v tomto repu (druhý deployable vedle) nebo v novém.

## 2026-09-06 (2) — M1 rozpracováno: platformové minimum a adaptéry, bez testů

**Stav:** typecheck prochází (`npx tsc --noEmit`), `npm test` zatím nemá co spouštět (žádný test soubor). Vlastník zastavil práci uprostřed M1; tento commit ukládá rozpracovaný stav tak, jak je, aby se dalo pokračovat z jiného počítače.

**Hotové (`src/platform`, 1 783 řádků včetně adaptérů):**
- `types.ts` (zrcadlí schémata), `clock.ts` (`SystemClock`, `FakeClock` = ClockFixture), `ids.ts`, `canonical.ts` (JCS), `schemas.ts` (Ajv nad `contracts/`, `CONTRACTS_VERSION`), `errors.ts` (tabulka platformových kódů s `retryable`/`reissuable`, `UnknownOutcomeError`, `ProcessCrash`).
- `signing.ts`: Ed25519 přes `node:crypto`, `KeyRegistry` s okny platnosti a ověřením proti klíči platnému v `signedAt` (SEC-CRED-002/003), `Signer` jen pro gateway, `verifyBinding` nad JCS `{message, context}`.
- `gateway.ts` (identity → `TrustedContext`, podpis, `rotate`), `policy.ts` (ADR-016 JSON policy per capability, `checkGrant`), `audit.ts` (append-only, bez update/delete API), `artifacts.ts` (immutable originál, `derive` s `derivedFrom`, `ArtifactReader`/`ArtifactWriter`), `credentials.ts` (CredentialResolverFixture: identita handleru z `AsyncLocalStorage`, režimy `strict`/`mutant`), `journal.ts` (JSON soubor, `structuredClone`).
- `router.ts`: řetězec schema → binding → expirace contextu → scope → policy grant (tenant) → input schema → handler; DENY audituje; sestavuje a validuje result envelope; `seen[]` pro SEC-INJ-001.
- `executor-host.ts`: allowlist → context match → deadline s tolerancí 30 s a skew logem → idempotency store → audit před/po → side effect pod identitou handleru; `mutants` flagy (MUT-PRIV-001, MUT-CTX-001, MUT-IDM-001, MUT-IDM-002). **Nález pro MEASUREMENT:** norma neříká, které outcomes idempotency store drží; zvoleno SUCCEEDED a UNKNOWN_OUTCOME (FAILED před side effectem zůstává retryable pod stejným klíčem).
- `review.ts` (task, authz rozhodnutí, `expire()` s policy vč. ESCALATE + `escalateTo` + hloubka), `orchestrator.ts` (statická definice, technical/quality retry s novým klíčem, WAITING(REVIEW), UNKNOWN_OUTCOME → reconciliation s budgetem → review, `recover()` po restartu, `resumeAfterReview`, pinning verze, publikovaný stav při reconciliaci), `api.ts` (jediná fasáda pro komponenty).
- `src/adapters`: `llm.ts` (`FakeLlmAdapter` záměrně náchylný na injection; `KeywordClassifierAdapter` pro INT-REPLACE-001), `registry.ts` (režimy ok / timeout / unavailable / business / nonsense-range / nonsense-semantic pro INT-FAIL-001..004), `dms.ts` (režimy ok / unknown-once / unknown-always / crash-after-write / auth-fail; `status`, `read` pro reconciliaci).
- `src/components/document-classifier`: `descriptor.json` (PROVIDER + AI_CAPABILITY, `usesLlm`), `input.schema.json`. **Handler ještě není** (zápis byl přerušen).

**Rozpracované / chybí:**
1. `document-classifier/handler.ts` (prompt s `<untrusted>` oddělovači, enum allowlist, QUALITY retry jinou strategií, provenance).
2. `document-validator/` (descriptor s `dependsOn`, handler: tenant, sha256 integrita, registr přes `withTimeout`, mapování chyb, nonsense varianty).
3. `document-executor-host/` (descriptor se dvěma capability `document.stamp` + `document.archive`, LOW/LOGICAL; stamp handler + reconciler; rogue handler pro SEC-HOST-001).
4. `contracts/policy/document.{classify,validate,stamp,archive}.v1.policy.json`, `workflows/document-intake.v1.json`, `scripts/arch-dep.mjs`, `src/slice.ts` (kompoziční kořen pro testy).
5. `conformance/` balíčky (5 + 1 + 1 + 1 fixtures, golden, `errors.md`, `compat.md`) a `tests/` podle rodin (CTR, SEC, MUT, IDM, WF, INT, RES, EVD, ARCH).
6. `docs/MEASUREMENT.md`: zapsat M1 (wall-clock, řádky, nález o idempotency store).

**Zbývá rozhodnout (Milan):** nic nového; postup podle XII.G platí.

## 2026-09-06 — M0: kostra repa, pinované kontrakty

- **Účel:** první implementace podle `Anamax443/agent-platform-foundation` v1.0-rc2.1 (zmrazeno). Řez podle XII.G:
  `document.classify` (AI) → `document.validate` (deterministický) → `document.stamp` (write executor, LOW, LOGICAL).
- **Kontrakty:** zkopírovaná schémata a vzor policy z foundation, pin v `contracts/CONTRACTS-VERSION`
  (`1.0-rc2.1 12a3c32`). Schémata se tady **nemění**; nález proti nim jde do `docs/MEASUREMENT.md` a zpět do foundation s evidencí.
- **Stack:** TypeScript, Node 20+, Vitest, Ajv. Bez frameworku a bez cloudu: první řez běží lokálně s adapter fakes,
  aby testy `CTR`, `SEC`, `IDM`, `WF`, `INT`, `RES`, `EVD` byly deterministické. Nasazení na Workers je až M4+.
- **Hotové:** kostra podle project-standard, `package.json`, `tsconfig`, `vitest.config`, `docs/MEASUREMENT.md`
  s lean kategoriemi a pravidly měření (AI wall-clock ≠ hodiny vlastníka; WIP limit jeden řez).
- **Rozpracované:** M1 (descriptory + platformové minimum: hodiny, id, schémata, JCS, Ed25519 podpis, gateway, router, policy).
- **Zbývá:** M2 conformance balíčky, M3 MUST testy + mutanty + INT + E2E + RES-CRASH + SEC-HOST, pak M4 druhý tok.
