# NÁVRHOVÝ LIST — Farma na Cloudflare (M4b)

Vyplněno podle `ai-agenti/sablony/navrhovy-list.md` dřív, než vznikne první řádek nasazovacího kódu. Nejde o nového agenta: jde o **skutečný runtime pro oba existující toky** tohoto repa, postavený proto, aby se ověřilo to, co lokální fakes ověřit nemohou (izolace, transport, fronta, pád, skutečný model, skutečná pošta).

---

## Základ

| | |
|---|---|
| **Název** | agent-platform-farm (deployables s prefixem `apf-`) |
| **Vlastník** | Milan Trnka |
| **K čemu je** | Spustit `document-intake.v1` a `mail-intake.v1` na Cloudflare Workers tak, aby stejných 198 testů běželo proti reálnému runtime a doložilo, co v jednom procesu bylo jen simulací (W11 v MEASUREMENT). |
| **Co nahrazuje** | Kompoziční kořen `src/slice.ts` s fakes v jednom procesu. Nic v provozu; farma je testbed, ne služba pro uživatele. |
| **Kdy je hotový** | (1) `SEC-HOST-001` platí konstrukcí: executor host nemá binding na cizí secret; (2) `IDM-REPLAY-001` běží proti skutečnému at-least-once doručení; (3) `RES-CRASH-001` proti evikci Durable Objectu; (4) golden mastery obou toků procházejí beze změny; (5) `MEASUREMENT.md` má řádek M4b s cenou v Kč a s nálezy. |
| **Model nasazení** | `CLOUD_SINGLE_TENANT` (jeden tenant `tenant-42`, druhý `tenant-7` jen jako protistrana v testech) |
| **Tenant režim** | `SINGLE` |

---

## Vstupy

| Kanál | Kdo smí | Ověření identity | Čí jsou data | Souhlas dal |
|---|---|---|---|---|
| HTTPS `apf.maxferit.cz/dispatch` (start workflow, přímý dispatch pro testy) | testovací harness, vlastník | Cloudflare Access service token; identita = `CF-Access-Client-Id` → `actorId` v gateway, nikdy z těla | vlastník | — |
| Příchozí e-mail `apf-intake@maxferit.cz` (Email Routing → `apf-mail-ingest`) | kdokoli na internetu (to je smysl testu) | žádné; odesílatel je untrusted data, `mail.ingest` ho ukládá jako `untrusted-derived` | odesílatel; **v testech jen vlastní adresy** | vlastník sám sobě; cizí lidé se na adresu nepouštějí (není nikde zveřejněná) |
| Chaos přepínače (KV `apf-chaos`) | vlastník přes `wrangler kv` | wrangler login | — | — |

Identita se váže na kanál: Access token pro API, nic pro e-mail (proto e-mail nikdy nespouští zápis mimo vlastní artifact store bez průchodu celým tokem).

**Odchozí kanály**

| Kanál | Adresa / identita navenek | Vlastní údaj agenta | Jak se zneplatní | Označení AI |
|---|---|---|---|---|
| Email Sending (`apf-email-executor`) | `apf-notify@maxferit.cz` | ano (vlastní odesílací adresa, binding jen v tomto Workeru) | `wrangler delete apf-email-executor` nebo odebrání `send_email` bindingu; příjemci jen z `recipientAllowlist` v policy | ano, patička šablony „automatická notifikace agent-platform-farm" |
| DMS / archiv | žádná skutečná; `apf-fakes` Worker s R2 | — | smazání Workeru | — |

---

## Nepřátelský vstup

| Kanál | Kdo tam může psát | Co s obsahem nesmí jít |
|---|---|---|
| tělo a hlavičky e-mailu | kdokoli, kdo adresu zjistí | nesmí zvolit příjemce notifikace, typ dokumentu mimo enum, ani cokoli spustit; smí být jen klasifikován, validován, orazítkován a dohledán |
| payload HTTP dispatch | držitel Access tokenu (my) | mimo schéma nic; `recipientRef` je klíč do allowlistu, ne adresa |
| odpovědi fakes (DMS, registr) | KV přepínač | schema-valid nesmysl musí skončit VALIDATION/QUALITY, ne SUCCEEDED (`INT-FAIL-004`) |
| výstup Workers AI | model | jen enum přes allowlist + druhý signál ve validátoru |

- [x] Obsah z vnějšku je pro model **data, ne instrukce**: oddělovače v promptu, jméno oddělovače až za blokem (N3)
- [ ] Skrytý text (HTML e-mailu, přílohy) se odstraňuje před modelem: **první verze bere jen text/plain, HTML a přílohy se ukládají jako originál a ignorují** (rozšíření až po prvním měření)
- [x] Nevratná akce se nikdy nespouští z toho, co bylo napsáno ve vstupu: `email.send` bere `recipientRef` z workflow inputu, ne z mailu
- [x] Podezřelý vstup má vlastní konec scénáře: `CLASSIFICATION_DISPUTED` → review
- [x] Model nemá pole, kterým rozhoduje o akci: výstup je enum, gate je kód

---

## Regulace a data

| Otázka | Odpověď |
|---|---|
| Označuje se AI při komunikaci ven? | ano, v patičce každé notifikace |
| Zpracovává osobní údaje? | ano, potenciálně: adresa odesílatele a obsah e-mailu. **V testech jen vlastní adresy a syntetické dokumenty** (conformance fixtures). Adresa `apf-intake@` se nezveřejňuje. |
| Riziková kategorie (AI Act) | minimální (klasifikace vlastních testovacích dokumentů, žádné rozhodnutí o člověku) |
| Retence — co se maže a kdy | originály v R2 30 dní (lifecycle rule), journal DO 30 dní od terminálního stavu (alarm), audit D1 90 dní, KV chaos bez retence, logy Workers podle platformy (≤ 7 dní) |
| Kde data fyzicky leží | Cloudflare, účet bass443, R2 bucket bez location hint (EU jurisdikce nastavit při založení: `--jurisdiction eu`) |
| Retence per datová třída | originál (R2, 30 d, vlastník Milan) · odvozenina = razítko (R2, 30 d) · provozní log (Workers Logs, platforma) · audit (D1, 90 d) · AI trace (jen `modelId`, `promptVersion`, hash výstupu v provenance; prompty se neukládají) |
| Originál vs. odvozenina | originál = raw mail nebo dokument v R2 pod `sha256`, immutable (R2 objekt se nepřepisuje, klíč = hash); odvozenina = razítko s `derivedFrom` v metadatech objektu |

### Přísnost — osa systému

| Otázka | Odpověď | Vlevo? |
|---|---|---|
| Kdo je předmětem rozhodnutí? | jen já (testovací dokumenty) | ☐ |
| Co rozhodnutí ovlivní? | pohodlí (testovací notifikace do vlastní schránky) | ☐ |
| S jakými daty? | syntetická a vlastní; potenciálně cizí e-mail, pokud adresa unikne | ☐ (☑ při úniku adresy) |
| V jakém rozsahu? | jednotky až desítky denně | ☐ |
| Pozná se chyba včas? | hned (testy, audit) | ☐ |

**Přísnost:** ☑ N — normální. **Co z toho plyne:** předpis se nezkracuje kvůli riziku, ale kvůli účelu: je to testbed. Přesto platí F1–F7 v plné síle, protože právě ty se měří. Kdyby na adresu začala chodit cizí pošta, přepnout na Z: přidat allowlist odesílatelů do Email Routing.

---

## Scénáře

| Kód | Spouštěč | Kroky | Konec |
|---|---|---|---|
| S1 | HTTPS start `document-intake` s artefaktem | classify (Workers AI) → validate (fakes registr + druhý signál) → stamp (fakes DMS, R2) | SUCCEEDED / WAITING(REVIEW) / FAILED, vždy v journalu DO a auditu D1 |
| S2 | e-mail na `apf-intake@maxferit.cz` | ingest (R2) → S1 nad tělem → notify (Email Sending na `ops-mailbox`) | jako S1, plus doručená notifikace nebo `UNKNOWN_OUTCOME` s reconciliací |
| S3 | chaos přepínač v KV (503, timeout, unknown, nesmysl, plné úložiště) + S1/S2 | stejné kroky, jiná odpověď fakes | přesně konec předepsaný golden masterem |
| S4 | harness pošle stejný command dvakrát přes frontu / restartuje DO uprostřed kroku | dedup v hostu a u providera; recover po evikci | jeden side effect, `RES-CRASH-001` |
| S5 | review rozhodnutí přes `/review` (Access) | resumeAfterReview | pokračování nebo FAILED |
| — | cokoli jiného | neimprovizuje | `SCHEMA_VALIDATION_FAILED` / `CAPABILITY_NOT_ALLOWED` a audit |

---

## Dělba práce

**Model dělá:**
- [x] rozpoznání záměru: `document.classify` (Workers AI `@cf/meta/llama-3.1-8b-instruct` jako první `LlmAdapter`, později Claude přes klíč)
- [ ] extrakci struktury: ne (zatím)
- [ ] syntézu textu: ne (šablony e-mailu jsou pevné)

**Kód dělá:** vše ostatní: parsování hlaviček, hash, allowlist enum, druhý signál, registr, razítko, výběr příjemce z policy, deadline, idempotence, reconciliace, review, audit, retence.

---

## Brány

| Akce | Když se splete | Jak dlouho trvá to vrátit | Režim |
|---|---|---|---|
| `document.stamp` (R2 odvozenina, fakes DMS) | vznikne špatně orazítkovaná odvozenina | sekundy (smazat objekt), originál nedotčen | auto |
| `document.archive` | zbytečný objekt v R2 | sekundy | auto |
| `mail.ingest` | uloží se spam / cizí data | sekundy až po lifecycle | auto, limit počtu mailů/den |
| `email.send` | odejde notifikace do allowlistované schránky | nejde vrátit, ale škoda = jeden e-mail vlastníkovi | auto s allowlistem; při chybě fakes `UNKNOWN_OUTCOME` → review |

**Write akce**

| Akce | sideEffects | Vratnost | Idempotence (klíč, retence) | riskClass |
|---|---|---|---|---|
| `mail.ingest` | internal-write | REVERSIBLE | `idempotencyKey`, DO store 30 d | LOW |
| `document.stamp` | internal-write | REVERSIBLE | `idempotencyKey` = `clientRef` v fakes DMS, 30 d | LOW |
| `document.archive` | internal-write | REVERSIBLE | `idempotencyKey`, 30 d | LOW |
| `email.send` | external-write | IRREVERSIBLE | `idempotencyKey` jako `Message-ID`/klientská reference; dedup v hostu + u providera | MEDIUM (PRINCIPAL = vlastní Worker) |

---

## Křížová kontrola

| Krok | Zdroj A | Zdroj B | Co se porovnává | Při neshodě |
|---|---|---|---|---|
| validate | výstup modelu (`documentType.value`) | pravidla nad textem bez instrukčních řádků | enum hodnota | `CLASSIFICATION_DISPUTED` → review (W4) |
| stamp | hash z předchozího kroku | hash originálu v R2 | sha256 | `ARTIFACT_HASH_MISMATCH` (SEC-ART-001) |
| reconcile | dedup záznam hostu | stav u fakes DMS / Email Sending podle `clientRef` | proběhl side effect? | podle výsledku SUCCEEDED / re-issue / review |

---

## Limity

| Veličina | Strop | Co při překročení |
|---|---|---|
| volání Workers AI | 200 / den (zdarma 10 000 neuronů/den) | `MODEL_UNAVAILABLE` retryable, tok čeká |
| příchozích mailů | 50 / den | Email Routing rule drop + audit |
| odchozích notifikací | 50 / den | `RECIPIENT_NOT_ALLOWED`? ne: `SMTP_REJECTED` retryable a alert |
| velikost originálu | 1 MB | `MAIL_MALFORMED` / `SCHEMA_VALIDATION_FAILED` |
| instancí workflow v RUNNING | 100 | odmítnout start (backpressure, `RES-QUEUE-001` později) |

---

## Paměť

| Vrstva | Obsah | Kde |
|---|---|---|
| Trvalá | descriptory, policy (allowlist příjemců, granty), workflow definice, veřejné klíče | repo, verzované; do Workerů jako `vars` / bundlované JSON |
| Faktická | journal instancí, review tasky, idempotency záznamy | Durable Object per instance (SQLite), audit v D1 |
| Pracovní | jeden dispatch | kontext requestu |
| **Neukládá se** | prompty, odpovědi modelu v plném znění, privátní klíč mimo Secret gateway | — |

---

## Proaktivita

- [x] časově: DO alarm hlídá deadline review a retenci journalu
- [ ] z mezery: ne
- [x] z prahu: `WF-UNK-002` po vyčerpání reconciliation budgetu → review task + notifikace na `ops-mailbox`
- [ ] z okolí: ne

---

## Selhání

| Situace | Kdo se dozví | Jak |
|---|---|---|
| Worker spadl uprostřed kroku | vlastník | journal DO zůstane RUNNING → `recover()` při dalším alarmu označí UNKNOWN_OUTCOME; audit; Workers Logs |
| Durable Object evikován a reaktivován (posudek 3) | nikdo, je to normální stav | stav instance žije jen v SQLite storage DO, nikdy jen v paměti; při reaktivaci (konstruktor v `blockConcurrencyWhile`, nebo alarm) běží `recover()`: RUNNING čtecí krok se spustí znovu, RUNNING write krok se označí UNKNOWN_OUTCOME a jde do reconciliace podle `clientRef` (lokálně `RES-CRASH-001`); audit v D1 je append-only a evikci nevnímá |
| Workers AI nedostupné | tok | `MODEL_UNAVAILABLE` retryable, po vyčerpání FAILED s auditem |
| review bez odpovědi do 3 dnů | supervisor role | escalate podle `expiryPolicy`, po max hloubce FAILED + notifikace |
| plné úložiště / limit | tok | `STORAGE_FULL` retryable (backpressure), alert e-mailem na `ops-mailbox` (W10) |

**Vypínač:** `wrangler deploy` gateway s `vars.KILL_SWITCH=true` (router odmítne vše `CAPABILITY_NOT_ALLOWED` s auditem), nebo Email Routing rule na drop. Jeden úkon, vyzkoušený před prvním ostrým mailem.

---

## Stavy a přechody

Beze změny proti řezu: `PENDING → RUNNING → SUCCEEDED | FAILED | WAITING(REVIEW) | UNKNOWN_OUTCOME → reconcile`. Nevratná akce (`email.send`) leží na přechodu `notify: RUNNING → SUCCEEDED`, s `UNKNOWN_OUTCOME` jako výslovným stavem mezi „zapsáno" a „potvrzeno".

| Otázka | Odpověď |
|---|---|
| Kde leží stav mezi „zapsáno" a „odesláno"? | v DO journalu jako krok RUNNING s `write-intent` v auditu; po odpovědi providera SUCCEEDED nebo UNKNOWN_OUTCOME |
| Kdo vlastní běh a co smí druhý běh? | DO instance vlastní běh (jedno vlákno); druhý požadavek na stejný `workflowId` čeká nebo dostane stav |
| Které stavy jsou terminální? | SUCCEEDED, FAILED, CANCELLED |
| Co se stane s neznámým výsledkem vzdáleného volání? | UNKNOWN_OUTCOME, reconciliace podle `clientRef` s budgetem 3, pak review; nikdy resend |

---

## Moduly (deployables)

| ID | Deployable | Capability (poskytuje) | Smí navrhovat (allowlist) | Kontrakt | Závisí na | Verifikační profily / izolace |
|---|---|---|---|---|---|---|
| D1 | `apf-gateway` | gateway, router, orchestrátor (DO `WorkflowInstance`), `document.classify`, `document.validate`, `/review` | — (žádný zápis mimo journal/audit) | dispatch envelope in → result envelope out | Workers AI, D1 audit, R2 (read), service bindings na D2–D5 | PROVIDER, AI_CAPABILITY, MODULE_DEPENDENCY, DURABLE_WORKFLOW |
| D2 | `apf-document-host` | `document.stamp`, `document.archive` | — | jako řez | R2 (derive), D5 fakes DMS/archiv | WRITE_EXECUTOR, EVIDENCE · **LOGICAL** (dva handlery, dva secrets v jednom Workeru) |
| D3 | `apf-email-executor` | `email.send` | — | jako řez | Email Sending binding, R2 (read) | WRITE_EXECUTOR, EVIDENCE · **PRINCIPAL** (vlastní Worker, jediný binding = odesílání) |
| D4 | `apf-mail-ingest` | `mail.ingest` + `email()` handler | — | raw mail → artefakt | R2 (put), service binding na D1 (start workflow) | WRITE_EXECUTOR, EVIDENCE · LOGICAL, bez credentialů |
| D5 | `apf-fakes` | fake DMS, registr, archiv s chaos přepínači | — | adapter kontrakty z `src/adapters` přes HTTP | KV `apf-chaos`, R2 | testovací dvojník, ne komponenta normy |

Kontrakty jsou už zafixované (schémata, descriptory, policy). Žádný Worker nesahá do cizí DB: journal má jen D1 (DO), audit píše každý host přes service binding na gateway `/audit` (append-only), artefakty jsou v R2 s klíčem = hash.

---

## Instalační profil (pravidlo vlastníka, 6. 9. 2026)

Kód je pro každou instalaci stejný. Vše, co je vázané na zákazníka nebo prostředí, žije mimo kód, ve třech vrstvách:

| Vrstva | Co obsahuje | Kde žije | Kdo mění |
|---|---|---|---|
| **Kód** (stabilní) | platforma, komponenty, descriptory (claim), schémata, workflow definice, šablony e-mailů | `src/`, `contracts/*.schema.json`, `workflows/` | vývoj, přes CI |
| **Instalační profil** (per zákazník / prostředí) | identity a jejich scopes, tenanty, platform policy (granty, allowlisty příjemců, limity), domény a adresy kanálů (`apf.maxferit.cz`, `apf-intake@`, `apf-notify@`), retence, chaos přepínače pro testy | `config/<instalace>/profile.json` + `config/<instalace>/policy/*.json`, výběr přes `INSTALLATION`; testy používají profil `local-fakes`, farma `farm-bass443` | vlastník instalace, bez zásahu do kódu |
| **Secrets** | podpisový klíč, DMS / archiv / API klíče | nikdy v souborech: `wrangler secret`, Secrets Store, lokálně `.dev.vars`; profil nese jen **jména** referencí (`cred:dms-stamp`), ne hodnoty | vlastník instalace |

Pravidla: profil má JSON schéma a načítá se **fail-closed** (chybějící nebo neplatný profil = nic nestartuje); v `src/` a `deploy/*/src` nesmí být doména, e-mailová adresa, tenant id ani actor id (lint jako rozšíření `arch-dep`, CI padne); test hotovosti = nová instalace znamená nový adresář v `config/` plus secrets a **nula změn v `src/`**.

Co dnes pravidlo porušuje (audit 6. 9. 2026) a přesune se v kroku 1: konstanty tenantů a identit v `src/slice.ts`; granty a `recipientAllowlist` v `contracts/policy/*.json` (soubor policy je autorita instalace, ne kontrakt normy; do `contracts/` patří jen schéma policy); doména, route a `EMAIL_FROM` ve `wrangler.jsonc` (přes `env.<instalace>` bloky nebo `vars` odvozené z profilu).

## Pořadí stavby

1. **Portabilita platformy a instalační profil** (bez cloudu, jde ověřit testy): `src/platform/schemas.ts` a `policy.ts` přestanou číst disk při importu, kontrakty se importují staticky jako JSON; identity, tenanty a policy se načítají z `config/<instalace>/` přes schéma, `src/slice.ts` dostane profil jako parametr. Lint na instalační hodnoty v `src/`. Testy zůstanou zelené s profilem `local-fakes`. Pak `DispatchTransport` rozhraní: `in-process` (dnešní) a `http` (Worker klient).
2. **D1 gateway + D2 document-host + D5 fakes** na `wrangler dev` lokálně (miniflare umí DO, R2, KV, service bindings), harness proti `http://localhost`. Tady se ukáže první rozdíl mezi „funguje v procesu" a „funguje přes hranici".
3. **Nasazení D1, D2, D5** na bass443 za Access, custom doména `apf.maxferit.cz`. Golden mastery `document-intake` proti farmě.
4. **D3 email-executor** s Email Sending, **D4 mail-ingest** s Email Routing na `apf-intake@maxferit.cz`. Golden mastery `mail-intake`.
5. **Fronta** (Queues, Workers Paid) mezi gateway a hosty pro skutečné at-least-once; `RES-CRASH-001` přes evikci DO; měření hodin mezi Workery.
6. **Pentest izolace podle ADR-017** nad D2 vs. D3 a zápis M4b do MEASUREMENT s cenou. Akceptační kritéria (posudek 1, doporučení 8), očekávaná odpověď u všech tří **NE**: (a) může `apf-document-host` získat SMTP oprávnění? (b) může `apf-email-executor` získat `DMS_SECRET` nebo `ARCHIVE_SECRET`? (c) může kterýkoli Worker mimo gateway vytvořit platnou podepsanou dispatch obálku? (d) **eskalace práv** (posudek 3): dostane se handler k cizím bindingům nebo k podpisovému klíči nepřímo, přes chybové hlášky, výpis prostředí, metadata objektů v R2, zneužití service bindingu na gateway (`/audit`, `/dispatch`) nebo přes chaos přepínače v `apf-fakes`? Každá odpověď s důkazem (pokus, odmítnutí, audit).
7. **Reálný model za `document.classify`** (posudek 2, podmínka v1.0): Workers AI jako `LlmAdapter`, minimální golden set 10 faktur + 3 injection s ownerem labelů, `criticalFields: [documentType]`, `AI-EVAL-REG-001` a `AI-EVAL-ADV-001` nad ním; druhý signál validátoru měřen na skutečném modelu.

**Svislé řezy po dokončení modulů:**

| # | Řez | Moduly |
|---|---|---|
| I1 | document-intake na farmě | D1, D2, D5 |
| I2 | mail-intake na farmě | D1–D5 |
| I3 | totéž přes frontu a s pádem DO | D1–D5 + Queues |

---

## Náklady

| Položka | Měsíčně |
|---|---|
| volání modelů | 0 Kč (Workers AI free tier stačí na stovky klasifikací denně); Claude až s klíčem |
| infrastruktura | Workers Paid 5 USD (kvůli Queues a klidnému limitu CPU); R2, D1, DO, KV v free tieru; Email Sending podle ceníku (ověřit, jednotky Kč při desítkách mailů) |
| **čas na stavbu** | odhad 2 session AI wall-clock po ~2 h (kroky 1–4), krok 5–6 další session; čas vlastníka: wrangler login, Access, DNS, e-mailová adresa, review ≈ 2 h |
| **čas na údržbu** | ≈ 1 h měsíčně (compat date, retence, kontrola nákladů) |

---

## Otevřené otázky pro vlastníka (blokovaly krok 3, ne krok 1–2)

Rozhodnuto 6. 9. 2026 asistentem na pokyn vlastníka („up to you"), zapsáno v `config/farm-bass443/`:

1. Účet: **bass443** (zóna maxferit.cz je tam; `wrangler whoami` ověřeno).
2. Plán: **Workers Free** až do kroku 5; Durable Objects a Email Sending na Free jsou, Queues až podle skutečného počtu požadavků z kroku 4.
3. Adresy: `apf.maxferit.cz` (API za Access), `apf-intake@maxferit.cz` (příjem), `apf-notify@maxferit.cz` (odesílání, jméno „agent-platform-farm"). Schránky v allowlistu jsou **aliasy Email Routing** na téže zóně: `apf-ops@`, `apf-supervisor@` (tenant-42) a `apf-ops-t7@maxferit.cz` (tenant-7); kam se přeposílají, nastaví vlastník jednou v účtu, repo skutečnou schránku nikdy nevidí. Otevřené jen: zda všechny tři míří do jedné schránky (nastaví se v kroku 4).
