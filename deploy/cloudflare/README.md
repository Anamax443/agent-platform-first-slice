# Farma na Cloudflare (M4b) — skeleton

Návrh a rozhodnutí: [`docs/NAVRHOVY-LIST-farma.md`](../../docs/NAVRHOVY-LIST-farma.md). Tady je jen to, co je v adresáři a jak se s tím zachází.

**Stav: skeleton.** Pět `wrangler.jsonc` s bindingy a pět Workerů, které odpovídají `501 NOT_WIRED` na všechno kromě `/health` a `/version`. Nic není nasazené. Napojení `src/platform` a `src/components` je krok 2 a dál v návrhovém listu.

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
npm run farm:check                 # wrangler deploy --dry-run pro všech pět configů, bez přihlášení
npx wrangler dev -c deploy/cloudflare/apf-gateway/wrangler.jsonc      # lokálně (miniflare: DO, R2, KV, service bindings)
npx wrangler whoami                # musí říct bass443 (a37a3627…), viz níže
npx wrangler deploy -c deploy/cloudflare/apf-fakes/wrangler.jsonc     # pořadí nasazení: fakes → document-host → email-executor → mail-ingest → gateway
```

Service bindingy míří na jména Workerů, takže cíl musí existovat dřív než ten, kdo na něj ukazuje. Gateway jde poslední.

## Před prvním nasazením (krok 3 návrhového listu)

1. `wrangler whoami` = účet **bass443** (`a37a36270aa2db7382f62912ba5a0130`). Ověřeno 6. 9. 2026. Zóna `maxferit.cz`, Access, Email Sending jsou tam. Druhý účet `maxferit` sem nepatří.
2. Prostředky: `wrangler d1 create apf-audit`, `wrangler r2 bucket create apf-artifacts --jurisdiction eu`, `wrangler kv namespace create apf-chaos`, `wrangler kv namespace create apf-fakes-store`; doplnit id do configů.
3. Secrets přes `wrangler secret put` (nikdy do souboru): `GATEWAY_SIGNING_KEY` (Ed25519 PKCS8 PEM, `< key.pem`), `DMS_SECRET`, `ARCHIVE_SECRET`. Veřejný klíč do `SIGNING_PUBLIC_KEYS` každého hostu.
4. Access aplikace pro `apf.maxferit.cz` se service tokenem pro harness (Access musí vzniknout v účtu, kde je zóna: bass443).
5. Email Routing rule `apf-intake@maxferit.cz → apf-mail-ingest`; Email Sending pro `apf-notify@maxferit.cz` (doména je onboardovaná).

## Co se ještě nerozhodlo

- Workers Paid kvůli Queues (krok 5), nebo první verze bez front.
- Skutečná schránka za `ops-mailbox` v `contracts/policy/email.send.v1.policy.json` pro režim `live`.

## Proč to žije v tomto repu

Testy, harness a golden mastery musí zůstat sdílené: farma je druhý runtime téhož řezu, ne druhý projekt. Balíček kontraktů je M6, a vzniká až s druhým projektem (P2 ve foundation).
