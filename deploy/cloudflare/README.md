# Farma na Cloudflare (M4b) — skeleton

Návrh a rozhodnutí: [`docs/NAVRHOVY-LIST-farma.md`](../../docs/NAVRHOVY-LIST-farma.md). Tady je jen to, co je v adresáři a jak se s tím zachází.

**Stav (6. 9. 2026): nasazeno na bass443, krok 1 hotový, krok 2 zahájen, krok 3 „lite" hotový.** Pět Workerů běží z generovaných configů instalace `farm-bass443`; gateway je na `apf.maxferit.cz` za Cloudflare Access a `/version` z internetu vrací `{"installation":"farm-bass443","tenants":2,"identities":3,"policies":6,…,"wired":false}`. Hosty nemají routu, jsou dostupné jen přes service bindingy. Všechno mimo `/health` a `/version` odpovídá `501 NOT_WIRED`: obchodní tok přes farmu ještě neprojde, každý další celek kroku 2 se nasazuje rovnou sem. `apf-gateway` má navázanou instalaci (`apf:installation`, sestavená fail-closed při importu); ověřeno i na `wrangler dev` pro `local-fakes`.

Configy jsou dvouvrstvé: base `wrangler.jsonc` v tomto adresáři je **kód** (žádná doména, adresa, účet ani `routes`; hlídá `npm run arch`) a sám o sobě se nedá zabundlovat, protože Worker importuje modul `apf:installation`, který neexistuje jako soubor. `scripts/farm-config.mjs` pro každou `config/<instalace>/` vygeneruje ten modul (`.wrangler/generated/<instalace>/installation.ts`, statické importy profilu a policy) a configy všech deployables = base + alias `apf:installation` + `vars.INSTALLATION` + overlay `config/<instalace>/farm.json` (nepovinný: routes, `EMAIL_FROM`, `INTAKE_ADDRESS`). Z `.wrangler/generated/<instalace>/<deployable>/wrangler.jsonc` (git-ignored) se dry-runuje, spouští `wrangler dev` i nasazuje. Identity, tenanty, policy a adresy farmy jsou v `config/farm-bass443/` (rozhodnuto 6. 9. 2026).

## Deployables

| Worker | Role v normě | Izolace | Bindingy | Secrets |
|---|---|---|---|---|
| `apf-gateway` | gateway, router, orchestrátor (DO `WorkflowInstance` = journal), `document.classify`, `document.validate`, `/review`, `/audit` | — (žádný write mimo journal a audit) | DO, D1 `apf-audit`, R2 `apf-artifacts`, Workers AI, service bindings na hosty | `GATEWAY_SIGNING_KEY` (jediný privátní klíč farmy) |
| `apf-document-host` | `document.stamp`, `document.archive` | **LOGICAL** | R2, service bindings gateway + fakes | `DMS_SECRET`, `ARCHIVE_SECRET` |
| `apf-email-executor` | `email.send` | **PRINCIPAL** | Email Sending `EMAIL`, R2 (read), gateway | žádné: binding je credential |
| `apf-mail-ingest` | `mail.ingest`, `email()` handler z Email Routing | LOGICAL, bez credentialů | R2, gateway | žádné |
| `apf-fakes` | DMS, registr, archiv jako dvojníci za skutečnou sítí, chaos přepínače | testovací dvojník | KV `apf-chaos`, KV `apf-fakes-store` | `DMS_SECRET`, `ARCHIVE_SECRET` (očekávané hodnoty) |

Co je skutečné a co simulace, po napojení:

| Skutečné na farmě | Stále simulace |
|---|---|
| hranice PRINCIPAL (samostatný Worker, vlastní bindingy) | DMS a registr (fakes za HTTP) |
| podepsaná obálka přes service binding / HTTP | at-least-once doručení, dokud není fronta (Workers Paid) |
| pád a evikce Durable Objectu uprostřed kroku | Email Sending v režimu `SEND_MODE=sandbox` (fake s chaos módy) |
| příchozí pošta přes Email Routing, odchozí přes Email Sending (`SEND_MODE=live`) | — |
| model Workers AI za `document.classify` | — |
| rozdíl hodin mezi Workery | — |

## Příkazy

```bash
npm run farm:check                                   # farm-config pro každou instalaci + wrangler deploy --dry-run nad 10 configy + tsc, bez přihlášení
node scripts/farm-config.mjs                         # jen vygenerovat .wrangler/generated/<instalace>/{installation.ts,<deployable>/wrangler.jsonc}
npx wrangler dev -c .wrangler/generated/local-fakes/apf-gateway/wrangler.jsonc     # lokálně s instalací local-fakes (miniflare: DO, R2, KV, service bindings)
curl http://127.0.0.1:8787/version                   # {"installation":"local-fakes","tenants":2,"identities":3,"policies":6,...}
npx wrangler whoami                                  # musí říct bass443 (a37a3627…), viz níže
node scripts/farm-deploy.mjs farm-bass443            # nasadí všech pět z generovaných configů v pořadí fakes → document-host → email-executor → mail-ingest → gateway
node scripts/farm-deploy.mjs farm-bass443 --bootstrap   # jen při prvním nasazení instalace (cyklus service bindingů: první průchod bez services)
curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" https://apf.maxferit.cz/version   # přes Access service tokenem z .env
```

Service bindingy míří na jména Workerů, takže cíl musí existovat dřív než ten, kdo na něj ukazuje. Gateway jde poslední.

## Krok 3 návrhového listu: co je provedeno (6. 9. 2026) a co zbývá

1. ✅ `wrangler whoami` = účet **bass443** (`a37a36270aa2db7382f62912ba5a0130`). Zóna `maxferit.cz`, Access, Email Sending jsou tam. Druhý účet `maxferit` sem nepatří.
2. ✅ Prostředky vytvořeny: D1 `apf-audit` (EEUR), R2 `apf-artifacts` (jurisdiction eu), KV `apf-chaos` a `apf-fakes-store`; jejich id jsou v `config/farm-bass443/farm.json` (overlay), base configy drží nuly. Nová instalace = nové prostředky + nový overlay.
3. ✅ Nasazeno `node scripts/farm-deploy.mjs farm-bass443 --bootstrap`: gateway a hosty se navzájem odkazují service bindingy, proto první průchod bez `services`, druhý plný. Custom doména `apf.maxferit.cz` vznikla při deployi gateway.
4. ✅ Access aplikace `apf-gateway` pro `apf.maxferit.cz` s politikou `Jen Ja` (naklikal vlastník); `/version` přes přihlášení funguje. Service token `apf-harness` + politika `harness` (Service Auth) připojená k aplikaci: ověřeno, `/version` a `/health` vrací 200 s hlavičkami `CF-Access-Client-Id/Secret`, `/dispatch` 501, bez tokenu 302. Hodnoty tokenu jsou v lokálním `.env` (vzor `.env.example`); nepřipojená politika („Used by applications: 0") znamená 302 i s tokenem.
5. ⏳ Secrets přes `wrangler secret put` (nikdy do souboru): `GATEWAY_SIGNING_KEY` (Ed25519 PKCS8 PEM), `DMS_SECRET`, `ARCHIVE_SECRET`; veřejný klíč do `SIGNING_PUBLIC_KEYS` hostů. Skeleton je nepotřebuje, přijdou s celkem `/dispatch`.
6. ⏳ Email Routing rule `apf-intake@maxferit.cz → apf-mail-ingest`, aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` a Email Sending pro `apf-notify@maxferit.cz` (krok 4).

## Rozhodnuto 6. 9. 2026 (asistent na „up to you" vlastníka)

- Plán **Workers Free** až do kroku 5; o Paid (Queues) se rozhodne s reálným počtem požadavků z kroku 4.
- Adresy `apf.maxferit.cz`, `apf-intake@maxferit.cz`, `apf-notify@maxferit.cz` (`config/farm-bass443/profile.json`, `farm.json`).
- Schránky v allowlistu `config/farm-bass443/policy/email.send.v1.policy.json` jsou aliasy Email Routing `apf-ops@`, `apf-supervisor@`, `apf-ops-t7@maxferit.cz`; kam se přeposílají, se nastaví jen v účtu (krok 4), repo to nezná.

## Proč to žije v tomto repu

Testy, harness a golden mastery musí zůstat sdílené: farma je druhý runtime téhož řezu, ne druhý projekt. Balíček kontraktů je M6, a vzniká až s druhým projektem (P2 ve foundation).
