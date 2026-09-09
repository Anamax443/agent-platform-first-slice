# POSUDKY — protokol posudků nad implementací

Pokračování protokolů XIII–XVI z `agent-platform-foundation`, ale tady se posuzuje **kód a měření**, ne text normy. Každé doporučení má dispozici: **P** přijato · **PÚ** přijato s úpravou · **O** odmítnuto s důvodem · **Z** na vědomí. Zmrazené dokumenty normy se mění jen s evidencí odsud (XVI).

## Posudek 1 — nad STATUS po M4 (6. 9. 2026)

**Zdroj:** externí posudek, který vlastník poslal po přečtení `STATUS.html` (stav: M1–M4 hotové, M4b zahájeno). Celkové skóre **9,1 / 10**, s poznámkou, že to není pokles proti 9,5 normy, ale první hodnocení skutečného systému.

**Hlavní závěr posudku:** první implementace normu nevyvrátila; testy našly konstrukční chyby (audit nebyl immutable, klíč při technickém retry, nepodepsaná obálka, obnova cizí instance, oddělovač v promptu) a druhý tok prokázal znovupoužití kostek s přírůstkem 45 řádků platformy. „První consumer existuje a druhý consumer prokázal reuse kontraktu."

| Oblast | Skóre |
|---|---|
| Foundation / návrh | 9,5 |
| Verification Contract | 9,7 |
| LEGO kontrakty | 9,7 |
| První implementace modularity | 9,4 |
| Testovací disciplína | 9,6 |
| Bezpečnostní model v lokálním harnessu | 9,5 |
| Skutečná runtime izolace | 7,0 (nenasazeno) |
| Reálná robustnost AI | 6,5 (fake model) |
| Ekonomika dlouhodobého provozu | 8,5 |
| Produkční důkaz | 7,5 |

### Doporučení a dispozice

| # | Doporučení | Dispozice | Kde se to projeví |
|---|---|---|---|
| 1 | W4 zavést jako **CONDITIONAL** pravidlo („pokud AI výstup přímo ovlivňuje state-changing krok s `riskClass ≥ MEDIUM`, workflow musí obsahovat nezávislý validační signál nebo human gate odpovídající riziku"), ne jako univerzální invariant; univerzální by vedl k umělé redundanci u LOW | **P** | `MEASUREMENT.md` W4 (rozhodnuto), návrh pro foundation část XVII; v řezu zůstává druhý signál u `document.validate`, protože vede k razítku a e-mailu (MEDIUM) |
| 2 | `PRINCIPAL` u `email.send` je „design proven, physical isolation not yet proven"; nepřeceňovat, dokud neběží jako vlastní deployable | **P** | formulace ve `STATUS`, W11 v MEASUREMENT; M4b je proto před M5/M6 |
| 3 | Nepublikovat `src/platform` jako balíček po prvním úspěchu; M6 = kontrakty, schémata, fixtures, conformance runner; orchestrátor, repository abstrakce a „universal executor framework" nechat déle duplikované | **P** | plán M6 v HANDOFF; P2 ve foundation platí |
| 4 | Sledovat **mezní cenu třetí domény**: pokud platforma poroste o stovky řádků abstrakcí s každým tokem, LEGO hypotéza slábne | **P** | nová metrika v MEASUREMENT: „platforma +řádků na novou doménu" (M4 = 45); třetí doména zařazena před M5 |
| 5 | Měřit **owner attention time** zvlášť od AI wall-clock a členit ho (architektura a rozhodování / review / ladění / provoz) | **PÚ** | pravidla měření v MEASUREMENT doplněna o členění; hodnoty doplní vlastník, asistent je nemůže vymyslet |
| 6 | Instalační profil je klíčový předpoklad multi-customer provozu („customer B ≠ fork repa") | **Z** | už rozhodnuto vlastníkem 6. 9. 2026, krok 1 M4b |
| 7 | Pořadí: **M4b farma → pentest credential izolace → reálný LLM + AI-EVAL → třetí doména → M5 `EXISTS × 2`** | **P** | HANDOFF plán, STATUS |
| 8 | Pentest jako tři otázky s očekávanou odpovědí NE: může document worker získat SMTP secret? může email executor získat DMS secret? může kterýkoli worker podepsat dispatch? | **P** | akceptační kritéria kroku 6 v `NAVRHOVY-LIST-farma.md` |
| 9 | Nález „klíč při technickém retry" je u `document.stamp` neškodný, u `payment.execute` by znamenal druhý side effect; VC tím „reálně vydělal část své ceny" | **Z** | potvrzuje N5 v MEASUREMENT; argument pro část XVII |
| 10 | Poměr business 7 % vs. infrastruktura a testy 93 % je u prvního řezu očekávatelný; rozhoduje mezní cena, ne absolutní číslo | **Z** | MEASUREMENT už tak argumentuje (poměr po M4) |

### Co posudek nezměnil

- Rozhodnutí vlastníka o instalačním profilu, o M4b v tomto repu a o Free plánu Cloudflare (fronty jsou dostupné i na Free).
- Otevřené položky pro vlastníka, **uzavřeno 6. 9. 2026 odpoledne:** čas vlastníka doplněn odhadem 4,25 h za M0–M4b (MEASUREMENT, limit 40 h vyhodnocen); adresy pro farmu potvrzeny a schránky v allowlistu řešeny aliasy Email Routing (rozhodnutí „up to you", `config/farm-bass443/`).

### Co z toho jde do foundation (část XVII)

W4 jako CONDITIONAL pravidlo, W12 instalační profil, evidence N1–N12, metrika mezní ceny domény. Do zmrazených dokumentů až s dalšími dvěma body evidence: farma (fyzická izolace) a třetí doména (mezní cena).

## Posudek 2 — formální oponentura implementace proti normě (6. 9. 2026)

**Zdroj:** oponent, který dělal tři kola nad normou; posuzoval `STATUS.html` a `VYVOJOVY-DIAGRAM.html`. Skóre **9,2 / 10**. Verdikt: „Implementace potvrzuje normu. Pokračovat podle plánu."

| Oblast | Skóre |
|---|---|
| Shoda implementace s normou | 9,5 |
| Důkaz LEGO principu | 9,5 |
| Testovací disciplína | 9,0 |
| Pokrytí izolačních tříd | 7,5 |
| Pokrytí AI-EVAL | 5,0 |
| Provozní realita | 7,0 |
| Dokumentace a předatelnost | 9,5 |

Hodnoticí list: **0 BLOCKER · 1 MAJOR** (PRINCIPAL je simulace, pentest neproběhl) **· 3 MINOR** (AI-EVAL nepokryto, čas vlastníka nezměřen, bez cloudu a fronty) **· 1 NOTE** (injection uvnitř allowlistu = mez F2).

| # | Doporučení | Dispozice | Kde se to projeví |
|---|---|---|---|
| 1 | Pentest ADR-017 rozšířit o tři scénáře s očekávaným NE (SMTP z document hostu, DMS z email executoru, podpis obálky mimo gateway); jsou to `SEC-HOST-001` a `SEC-HOST-002` | **P** | totéž jako posudek 1 #8, kritéria kroku 6 v návrhovém listu |
| 2 | **AI-EVAL jako podmínka v1.0:** po M4b reálný model za `document.classify` s minimálním golden setem (10 faktur, 3 injection, `criticalFields: [documentType]`) pro `AI-EVAL-REG-001`; XII.D normy doplnit o podmínku „a po AI-EVAL s reálným modelem" | **P** | krok „reálný model" v plánu má teď konkrétní minimum; návrh pro foundation XII.D |
| 3 | Čas vlastníka členit: architektura a rozhodování / implementace handlerů / testy a fixtures / ladění nálezů / dokumentace; součet nad 100 h za M1–M4 = přehodnotit III §7 (XII.G) | **PÚ** | kategorie sjednoceny s posudkem 1 (přidán „provoz"), MEASUREMENT pravidla; hodnoty doplní vlastník |
| 4 | 46 z 53+ Test ID: chybějící jsou vysvětlené (TEN, AI-EVAL, WF-VER-002..004, RES-QUEUE-001, SEC-CRED-001), nic tiše; plné pokrytí = M4b + reálný model + multi-tenant projekt, realisticky 6–12 měsíců | **Z** | W9 v MEASUREMENT |
| 5 | Odpověď na X-8: VC je pro jednoho člověka vymahatelný s podmínkami (MUST sada zvládnutelná, generovaná infrastruktura funguje, cena testů klesá, mutanty nejsou teorie) | **Z** | předběžné; definitivní až s časem vlastníka |
| 6 | Diagram splňuje cíl normy „čitelný do třiceti minut"; druhý pohled je F5 v praxi | **Z** | — |

## Posudek 3 — konverzační posudek s otázkami tvůrci (6. 9. 2026)

**Zdroj:** třetí čtenář STATUS a diagramu, bez skóre, „velmi působivý dokument". Otázky a odpovědi:

| # | Otázka / postřeh | Odpověď / dispozice |
|---|---|---|
| 1 | Jaký je reálný lidský čas? Je blízko 40 h? | **Otevřené, vlastník.** Asistent ho nemůže odhadnout; kategorie v MEASUREMENT jsou připravené. |
| 2 | W4 CONDITIONAL je rozumné, jen dobře definovat, kdy platí | Rozhodnuto: AI výstup → state-changing krok s `riskClass ≥ MEDIUM` (posudek 1 #1). |
| 3 | Pentest má zahrnovat i **eskalaci práv**, ne jen tři otázky | **P** — do kroku 6 přidán scénář (d): pokus dostat se k cizím bindingům a k podpisovému klíči přes service binding, chybové hlášky, výpis prostředí, metadata R2. |
| 4 | Jak bude journal a audit řešen na Durable Objects vzhledem k evikci a reaktivaci? | Journal = SQLite storage jednoho DO per instance, stav nikdy jen v paměti; při reaktivaci DO (konstruktor nebo alarm) běží `recover()`, který RUNNING write krok označí `UNKNOWN_OUTCOME` a spustí reconciliaci (dnes testováno lokálně jako `RES-CRASH-001`); audit je append-only tabulka v D1 zapisovaná přes gateway. **P** — doplněno do návrhového listu (Selhání). |
| 5 | Je quality retry ošetřen proti nekonečné smyčce? | Ano, každá smyčka má strop v definici workflow: 2 strategie × `qualityBudget` 2, `technicalRetries` 2 (max 3 pokusy na strategii), `reconciliationBudget` 3, hloubka eskalace review 2, `notValidAfter` 30 min (notify 10 min). **P** — řádek „Meze smyček" ve STATUS. |
| 6 | Prioritizovat položky „Zbývá" ve STATUS | **P** — seznam je číslovaný podle priority. |
| 7 | Co bylo nejtěžší a co bys udělal jinak? | Z pohledu implementace: nejtěžší bylo **vlastnictví reconciliace** mezi orchestrátorem a executorem (norma říká, že orchestrátor do executora nevidí, ale dedup záznam žije v executoru; N7/W2) a **udržet fixtures pravdivé**, když každá další capability mění, co je „správně" (N12). Jinak od začátku: instalační profil a statické importy kontraktů (portabilita) hned v M0, a druhý signál jako součást návrhu, ne jako oprava po nálezu. Odpověď vlastníka může být jiná. |

## Posudek 4 — krátké hodnocení s nabídkou dalších směrů (6. 9. 2026)

**Zdroj:** čtvrtý čtenář, bez skóre. Potvrzuje: LEGO doložen 45 řádky, 12 nálezů má reálnou hodnotu, defenzivní přístup k LLM, transparentnost STATUS a diagramu. Nabízí čtyři směry (M4b nasazení, dopad na normu, pentest, čas vlastníka).

**Dispozice: Z.** Pořadí je rozhodnuté posudkem 1 a potvrzené posudkem 2: M4b → pentest → reálný model → třetí doména → M5/M6. Dopad na normu (část XVII) se píše průběžně do MEASUREMENT a sem; do zmrazených dokumentů až s evidencí z farmy.

## Posudek 5 — čtvrtý čtenář, tentokrát nad skutečným kódem, ne jen STATUS (6. 9. 2026 pozdní večer)

**Zdroj:** externí posudek nad `agent-platform-first-slice`, výslovně nad TypeScript kódem (platform core, executory, workflow engine, security testy, mutation testy) a nad CI během `a5310fc` (`GET /actions/runs/34052742804`), ne jen nad `STATUS.html`. Celkové skóre **8,8 / 10**; deset dílčích skóre od architektury (9,2) po aktuální farm runtime (6,8).

**Důležité upřesnění, které posudek nemohl vědět:** `a5310fc` je commit **před** HANDOFF (19) a před celkem C. V okamžiku posudku byl lokální `main` už 2 commity napřed (`80b2f32` HANDOFF (19), `0979b97` celek C), oba jen commitnuté, ne pushnuté — GitHub je zdroj pravdy jen pro to, co tam skutečně je. Dva z deseti bodů posudku jsou proto na `a5310fc` pravdivé, ale na `HEAD` už vyřešené (viz body 9 a 10 níže).

Každé tvrzení bylo ověřeno přímo v aktuálním kódu (čtení konkrétních souborů), ne jen převzato z textu posudku.

| Oblast | Skóre posudku | Poznámka |
|---|---:|---|
| Architektura | 9,2 | — |
| Security design | 9,1 | — |
| Security enforcement v kódu | 8,8 | — |
| Tenant isolation | 8,4 | shoduje se s bodem 7 (jeden globální tenant na intake) |
| AI → deterministic → executor separation | 9,6 | — |
| Idempotence / retry / crash recovery | 8,1 | shoduje se s body 1–2 |
| Testovací strategie | 9,4 | — |
| Produkční připravenost core | 8,5 | — |
| Aktuální Cloudflare farm runtime | 6,8 | na `a5310fc`; po celku C (registr přes skutečnou síť) by bylo vyšší |

### Doporučení a dispozice (ověřeno v kódu, ne jen v textu posudku)

| # | Doporučení posudku | Ověření v kódu | Dispozice | Kde se to projeví |
|---|---|---|---|---|
| 1 | **P0.** `ExecutorHost.idempotency` je jedna `Map<string, HandlerOutcome>` klíčovaná jen `idempotencyKey`, bez tenant/handler/capability. Napříč capabilities sdílejícími host (`document.stamp` + `document.archive` v `documentHost`) může stejný klíč vrátit výsledek jiné capability. | **POTVRZENO.** `src/platform/executor-host.ts:48,148` — jedna mapa pro celý host; `execute()` na řádku 148 hledá jen podle `key`, ne podle `capability`. `src/slice.ts:94-97` registruje `document.stamp` i `document.archive` do téhož `documentHost`. Orchestrátor dnes generuje klíč `workflowId:stepId:strategy:logicalAttempt` (`orchestrator.ts:245`), takže `stepId` (ne capability) kolizi v běžném toku brání — ale `ExecutorHost` jako znovupoužitelné primitivum to nezaručuje sám; test na tento konkrétní scénář (dvě capability, stejný klíč) neexistuje. | **P, VYŘEŠENO** — vlastník „up to you"; `ExecutorHost.dedupKey(capability, idempotencyKey)` skládá interní klíč z obou (kontrakt na drátě beze změny, jde jen o interní klíč mapy hostu), test `IDM-HOST-SCOPE-001` dokazuje, že bez opravy padá. `IDEMPOTENCY_CONFLICT` při stejném klíči a jiném fingerprintu payloadu zůstává otevřené jako samostatná, oddělitelná změna (fingerprint payloadu je nový návrh, ne oprava tohoto nálezu). | `src/platform/executor-host.ts`, `tests/idm.test.ts` (`IDM-HOST-SCOPE-001`), `docs/MEASUREMENT.md` W19 |
| 2 | **P0/P1.** Idempotency store hostu je jen `Map` v paměti procesu, po restartu prázdná; pro produkci chybí durable ledger. | **ČÁSTEČNĚ POTVRZENO, s upřesněním.** Norma i tento řez už mají durable recovery cestu: `reconcile()` (§3.3 krok 10) se ptá **vnějšího systému** (`dms.status(clientRef)`), ne lokální mapy — to je přesně `RES-CRASH-001` (`tests/res.test.ts:12`, ověřeno: pád po zápisu → `UNKNOWN_OUTCOME` → reconciliace → `dms.stampCalls` zůstává 1). Na farmě je ale `apf-document-host` samostatný Worker: mezi dvěma požadavky téměř jistě běží jiný isolát, takže lokální `Map` tam prakticky nikdy nededupuje — durabilita dnes stojí **celá** na `reconcile()` a na tom, že DMS/archiv umí `status(clientRef)`. To ještě nikde neověřeno na skutečném DMS (jen fake). | **PÚ** — durable ledger navíc není nutný, pokud `reconcile()` bude opravdu zapojený a testovaný pro **oba** handlery (stamp i archive) na farmě v celku D; bez toho je „exactly-once" na farmě jen teoretické. Zapsat jako podmínku celku D, ne jako samostatný úkol. | nový W-nález, `docs/NAVRHOVY-LIST-farma.md` krok D akceptační kritéria |
| 3 | **P1.** `resourceTenant()` vracející `undefined` znamená „kontrola přeskočena" — nebezpečný vzor pro nové executory. | **POTVRZENO jako design smell, dnes NEEXPLOATOVATELNÉ.** `stamp-handler.ts:35`, `archive-handler.ts:22`, `email-executor/handler.ts:44` vrací `artifacts.get(id)?.tenantId` — `undefined` nastane jen když artefakt neexistuje, a `run()` v tom případě sám vrátí `ARTIFACT_NOT_FOUND` dřív, než by na chybějící kontrolu záleželo. Skutečné riziko je v **budoucích** executorech (`invoice.normalize`, `erp.post` z kroku 8), ne v dnešních třech handlerech. | **P** — přijato jako debt pro nové executory, ne jako oprava dnešního kódu. Explicitní `{status: "FOUND"|"NOT_FOUND"|"GLOBAL_RESOURCE"}` až při psaní první nové write capability po D. | `PLATFORM-NOTES` / část XVII; připomenout u kroku 8 |
| 4 | **P1.** `ReviewService.decide()` bere `role`/`tenantId` z argumentu volajícího, ne z `TrustedContext`; nebezpečné, pokud se obalí HTTP endpointem. | **POTVRZENO, dnes BEZ ŽIVÉHO ENDPOINTU.** `src/platform/review.ts:107` — `by: {actorId, role, tenantId, ...}` jsou prostá tvrzení volajícího. Gateway na farmě dnes **nemá** `/review` vůbec (jen `/`, `/intake`, `/workflow/*`, `/audit.json`, `/chaos`, `/dispatch` 501) — posudek to sám správně odhaduje jako „netvrdím, že je dnes exploitable". | **P** — přijato jako tvrdá podmínka **před** implementací `/review` na farmě: rozhodnutí musí jít přes `IdentityProvider(actor)` → tenant/role z profilu, nikdy z těla requestu. | `docs/NAVRHOVY-LIST-farma.md`, precondition pro budoucí `/review` |
| 5 | **P1.** Dokončit skutečné remote executor hosty + `/dispatch`. | Beze změny od HANDOFF (17)/(19): `hosts: false`, `/dispatch` stále 501. | **Z** — už je to plán (celek D a dál), nic nového. | HANDOFF, `NAVRHOVY-LIST-farma.md` |
| 6 | **P1.** Access JWT verifikace před produkčním `/review`, `/purge`, API. | `accessJwtVerified: false` potvrzeno beze změny; `/purge` dnes existuje a je za Access politikou „Jen Ja" (jediný lidský účet), takže riziko okna je dnes malé, ale roste s každým dalším lidským identity. | **P** — potvrzuje mezeru 3 v `docs/SHODA-NIS2-ISO27001.md` (beze změny priority); tvrdý blok před druhou lidskou identitou nebo `/review`. | `SHODA-NIS2-ISO27001.md` mezera 3 |
| 7 | **P2.** Tenant má jít z authenticated principal / membership, ne z form pole nebo globálního tenanta orchestrátoru. | **POTVRZENO.** `intakeTenant()` v gateway vrací vždy tenant identity `installation.profile.roles.orchestrator` — každý upload dnes patří jednomu tenantovi bez ohledu na to, kdo se přihlásil přes Access. | **Z** pro první instalaci jednoho zákazníka (`farm-bass443` = provozovatel sám); **P** jako tvrdý předpoklad, než tento řez poslouží druhému zákazníkovi — navazuje na W12 (instalační profil), potřebuje navíc mapování Access identity → tenant. | rozšíření W12 v MEASUREMENT, až bude druhý zákazník na obzoru |
| 8 | **P2.** Vlastní minimalistická JCS implementace bez oficiálních RFC 8785 test vektorů. | **POTVRZENO.** `src/platform/canonical.ts` — vlastní rekurzivní `canonicalize()`, žádné testy proti oficiálním test vektorům. Dnes podepisuje a ověřuje jen tento repo sám sobě (žádný cizí jazyk na druhé straně). | **Z** — reálné riziko vzniká, až bude ověřovat podpis systém mimo tento TypeScript kód (např. pentest tooling, nebo hostitel v jiném jazyce). | poznámka do PLATFORM-NOTES, revisit před tím |
| 9 | **P2.** Reálný registry adapter místo fake. | **JIŽ HOTOVO** — vyřešeno **stejný den** celkem C (commit `0979b97`, po `a5310fc`, který posudek viděl). `document.validate` dnes volá `HttpRegistryAdapter` přes service binding na `apf-fakes`. | **Vyřešeno** | HANDOFF (20) |
| 10 | **P2.** Chaos/conformance testy přes skutečné Worker service boundaries. | **ČÁSTEČNĚ HOTOVO.** Celek C ověřil `wrangler dev` se dvěma Workery najednou (service binding `[connected]`, ruční ověření mimo CI); automatizované testy (`tests/fakes.test.ts`, `INT-HTTP-001..008`) volají `handleFakes()` přímo (in-process), ne přes skutečnou síťovou hranici v CI. | **PÚ** — ruční ověření splňuje bránu celku C; automatizovaný test přes skutečnou hranici zůstává otevřený, spadá pod již plánovaný „harness proti farmě přes `HttpDispatchTransport`". | HANDOFF, beze změny pořadí |

### Co posudek nezměnil

Pořadí celků (D dál, pak retence, krok 8, krok 4, harness proti farmě) zůstává. Žádný z nálezů nevede k otevření rc3 normy — body 1–4 jsou vlastnosti tohoto řezu (`ExecutorHost`, `ReviewService`), ne normy samotné; norma o nich mlčí stejně jako mlčela o instalačním profilu (W12), než ho řez vyřešil.

### Co z toho jde do MEASUREMENT jako nové nálezy

**W19** (idempotency store bez scope na capability — bod 1) a **W20** (durable dedup na farmě stojí celá na `reconcile()`, ne na lokální mapě — bod 2) zapsány do `docs/MEASUREMENT.md`. Zůstává otevřené, kdy se bod 1 opraví (samostatný celek, nebo součást D) — to rozhodne vlastník.

## Souhrn po pěti posudcích

Shoda všech pěti: norma nevyvrácena, testy chytají konstrukční chyby, reuse doložen. Posudek 5 je první, který četl skutečný kód místo STATUS, a našel jednu skutečnou konstrukční mezeru (idempotency scope, bod 1) — cenu si tedy definitivně vydělal (srov. posudek 1, bod 9). Jediný MAJOR ze všech posudků dohromady zůstává fyzická izolace (plánováno na M4b, teď za D). Nic nevede k otevření rc3 normy; vše jde do části XVII jako evidence.

## Posudek 6 — druhé kolo od stejného čtenáře, jeden bod na zastaralém snapshotu (6. 9. 2026 pozdní večer)

**Zdroj:** stejný externí čtenář jako Posudek 5, druhé kolo „nad aktuálním `main`" po oznámení, že W19 je opravené a pushnuté (commit `50c2cc0`). Nová srovnávací tabulka (12 řádků, minulý stav vs. teď) a přehodnocení skóre na **8,9/10** (+0,1 proti 8,8).

**Klíčové zjištění před dispozicemi: bod 1 posudku cituje kód, který na `main` neexistuje.** Posudek tvrdí „🔴 Neopraveno — stále `Map<string, HandlerOutcome>`" a cituje přesně předopravný tvar `execute()` (`const key = message.idempotencyKey; if (key && this.idempotency.has(key))`). Ověřeno přímo: `git cat-file -p origin/main:src/platform/executor-host.ts` (dotaz na objekt, který GitHub skutečně drží pro `main`, ne na lokální soubor) obsahuje `dedupKey(capability, idempotencyKey)` a `execute()` používá `dedupKey`, ne holý `key` — přesně oprava z commitu `0c65fb9`, pushnutého jako součást `50c2cc0` (22:48 SELČ). Posudek tedy pracoval se snapshotem starším než tato oprava — nejpravděpodobněji CDN/cache zpoždění GitHubu těsně po pushi (oprava i posudek padly do stejného okna ~20 minut), ne chyba v kódu. Scénář, který posudek popisuje jako stále platný (`document.stamp` klíč `abc` → `document.archive` stejný klíč `abc` dostane výsledek stampu), je přesně scénář, který dokazuje test `IDM-HOST-SCOPE-001` (Posudek 5) — a ten dokázatelně bez opravy padá (ověřeno `git stash`), se opravou prochází.

**Co v posudku zůstává platné i po opravě tohoto nedorozumění:** posudek chtěl víc než minimální opravu — `tenantId + capability + handlerId + idempotencyKey` a `requestFingerprint = SHA256(canonical payload)` s `IDEMPOTENCY_CONFLICT` při shodě klíče a jiném payloadu. To je přesně to, co Posudek 5 v dispozici bodu 1 označil jako „druhou, oddělitelnou změnu" a nechal otevřené. Bod 2 (durable ledger) je přesně W20, dosud beze změny (podmínka celku D). Body 3–9 (`resourceTenant` fail-open, `ReviewService` bez trusted principal, `/dispatch` 501, hosty připravené v `Env` ale `hosts:false`, Access JWT, multi-tenant intake) jsou beze změny přesně to, co zapsal Posudek 5 — žádné nové zjištění, jen potvrzení, že dispozice (P/PÚ/Z, většinou „před celkem D" nebo „precondition") pořád platí.

**Jedna skutečně nová a užitečná poznámka (bod 8):** posudek rozlišil `/review` (zatím neexistuje, nulové riziko) od `/purge` (**existuje a běží na farmě už od kroku 2 celku A**), a upozornil, že `/purge` čeká na Access JWT verifikaci se stejnou naléhavostí jako budoucí `/review`, ne až s ním. Posudek 5 měl Access JWT jen jako obecnou mezeru 3 v `docs/SHODA-NIS2-ISO27001.md` bez rozlišení which endpoint. Přijato jako upřesnění.

### Dispozice

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Idempotency „stále neopraveno" | **O, na základě chybného snímku** | ověřeno `git cat-file -p origin/main`; oprava (W19, commit `0c65fb9`) je na `main` od 22:37 SELČ, pushnutá v `50c2cc0`; posudek pravděpodobně narazil na krátké CDN zpoždění GitHubu po pushi |
| 1b | Rozšíření na `tenantId + handlerId + requestFingerprint` + `IDEMPOTENCY_CONFLICT` | **Z, zůstává otevřené** | přesně „druhá, oddělitelná změna" z Posudku 5; kandidát na příští celek, ne oprava dnešního kódu |
| 2 | Durable executor effect ledger | **Z** | = W20, beze změny, podmínka celku D |
| 3 | `resourceTenant()` fail-open | **Z** | beze změny, debt pro budoucí executory (Posudek 5, bod 3) |
| 4 | `ReviewService` bez trusted principal | **Z** | beze změny, precondition pro `/review` (Posudek 5, bod 4) |
| 5–7 | `/dispatch` 501, hosty připravené v `Env` ale nezapojené | **Z** | plán celku D beze změny |
| 8 | `/purge` by měl mít Access JWT se stejnou prioritou jako budoucí `/review`, protože už běží na farmě | **P** — upřesnění přijato | `docs/SHODA-NIS2-ISO27001.md` mezera 3 rozšířena o explicitní zmínku `/purge` |
| 9 | Multi-tenant intake beze změny | **Z** | potvrzeno jako známé omezení first slice, ne chyba (Posudek 5, bod 7) |

**Přehodnocené skóre posudku (8,9/10, +0,1):** stojí na chybné premise u bodu 1 („žádná ze čtyř základních slabin nebyla řešena"), protože jedna z nich (přesně demonstrovaný scénář stamp/archive kolize) řešená byla. Nový verdikt by měl vzejít z opětovného čtení `main` po tomto vyjasnění, ne z asistentova přepočtu — asistent svoje vlastní skóre nenabízí.

### Co posudek nezměnil

Pořadí (D dál, W20 jako jeho podmínka) zůstává. Doplněno: `docs/SHODA-NIS2-ISO27001.md` mezera 3 teď jmenuje `/purge` vedle budoucího `/review`.

## Posudek 7 — externí „hlídací pes" nad `main` po WF-REV-003 (9. 9. 2026)

**Zdroj:** externí čtenář, poslaný vlastníkem jako zpráva v chatu (ne přes GitHub), nad commitem
`95de85d`. Skóre podle čtenáře: celková kvalita kódu **9,1/10**, doporučení „pokračovat,
nepřepisovat". Detailní tabulka skóre po oblastech (Router/security pipeline 9,3, ExecutorHost
tenant enforcement 9,5, Human Review mechanismus 8,3, Policy enforcement 7,2, COW
Admission/Certification 5,0, Multi-tenant readiness 6,5, Audit trustworthiness 7,5, atd.) — viz
zpráva samotná, sem se nekopíruje celá.

**Metodologická poznámka, než dispozice:** vlastník zvolil (`AskUserQuestion`) nejdřív ověřit a
opravit jen bod MAJOR 1, ne projít nezávisle celý posudek proti kódu jako Posudek 6 udělal se svým
zdrojem. **MAJOR 1 je proto jediný bod z tohoto posudku dnes nezávisle ověřený přímo v kódu** —
zbytek (MAJOR 2–5, MEDIUM) je zapsaný tak, jak přišel, nepotvrzený ani nevyvrácený proti aktuálnímu
`main`. Posudek 6 je varování, proč to takhle rozlišovat: tenkrát citovaný kód na `main` už
neexistoval (stale snapshot) — důvěra „posudek zní věrohodně" bez čtení souboru:řádku dřív vedla
ke špatné dispozici.

**MAJOR 1 (Human Review autorizace) — potvrzeno a opraveno dnes.** Nález byl přesný:
`decideReview()` (`deploy/cloudflare/apf-gateway/src/index.ts`, tehdy řádek 490) posílalo
`role: task.requiredRole` do `ReviewService.decide()`, jejíž vlastní kontrola
`task.requiredRole !== by.role` tím porovnávala hodnotu se sebou samou — nikdy nemohla selhat.
Souvisí s [[verify-core-before-building]] stylem ověření (přečtení skutečného kódu, ne převzetí
tvrzení) a navazuje přímo na **Posudek 6, bod 4** („`ReviewService` bez trusted principal — Z,
precondition pro `/review`") — tehdy `/review` ještě neexistovalo, takže šlo o poznámku na
budoucnost; dnes `/review/decide` na farmě běží od (50)–(52), takže mezera byla živá.

**Oprava (HANDOFF 68):** `IdentityProvider.authorizeRole(actorId, tenantId, requiredScope)` (nová
metoda, `src/platform/gateway.ts`) rozhoduje výhradně z identity samotné (tenant + přiřazené
scopes), nikdy z hodnoty, kterou nese request/task. `decideReview()` ji zavolá dřív, než cokoli
předá `review.decide()`; při zamítnutí zapíše `kind: "security"` audit
(`REVIEW_ROLE_NOT_AUTHORIZED`) a vyhodí chybu. `installation.profile.identities` na farmě dřív
neměla **žádnou** lidskou identitu (jen `svc-orchestrator`/`svc-orchestrator-t7`/`ai-doc-classifier`)
— doplněna `access:bass443@gmail.com` (`actorType: "human"`, `tenantId: "tenant-42"`, scopes
`["document.reviewer", "document.supervisor"]`) — přesný string ověřený ne odhadem, ale z reálného
`/audit.json` záznamu živého rozhodnutí z (50)–(52). **Vědomé omezení:** identita je vázaná jen na
`tenant-42` (jediný reálný tenant); `tenant-7` je čistě protistrana bezpečnostních testů (SEVERKA.md
Tenant Layer), takže review úkol tam by dnešní jediný lidský reviewer rozhodnout nemohl — přijato
jako správný default, ne přehlédnutí. 4 nové testy (`tests/sec.test.ts`, `SEC-REV-001..004`):
autorizovaná identita projde, neznámý actor nikdy neprojde bez ohledu na požadovanou roli,
cross-tenant zamítnuto, role mimo přiřazené scopes zamítnuta. 246/246 testů, typecheck, arch,
farm:check zelené; nasazeno na `farm-bass443`.

### Dispozice

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| MAJOR 1 | Human Review role-check je tautologie (`by.role` odvozené z `task.requiredRole`) | **P, opraveno** | `authorizeRole()` + human identita v `config/farm-bass443/profile.json` + `SEC-REV-001..004`; nasazeno (HANDOFF 68) |
| MAJOR 2 | Access identita není kryptograficky ověřená (`accessJwtVerified: false`) | **Z, potvrzeno v kódu** | `deploy/cloudflare/apf-gateway/src/index.ts:90` má `accessJwtVerified: false` doslova; `/farm` stránka (`page.ts:141`) to sama přiznává v UI. Shoduje se s Posudek 6 bod 8 / `docs/SHODA-NIS2-ISO27001.md` mezera 3 — už dřív známá, čestně vlastní appkou přiznaná mezera, ne nové zjištění. Oprava (JWKS fetch + signature verify) architektonicky větší než dnešní rozsah, ponecháno na rozhodnutí vlastníka |
| MAJOR 3 | Policy Engine vynucuje jen actorId/scope/tenant, ne `approval`/`rateLimit`/`isolation` z popisu Policy | **Z, potvrzeno v kódu** | `src/platform/policy.ts` `checkGrant()` (řádek 46–51) čte jen `grant.actorId`/`grant.scopes`/`grant.tenants`; `policy.approval`, `policy.effectFieldValidators`, `policy.isolation`, `grant.rateLimit` existují na typu `Policy`/`Grant`, ale `checkGrant()` je nikdy nečte. Descriptor/policy soubor tedy může deklarovat `approval.required: true` a Router to fakticky nevynutí. Shoduje se s `SEVERKA.md` Policy Engine řádkem (č. 32) — už dřív zapsaný směr, dnes jen doloženo přesným `soubor:řádek`. Oprava = architektonické rozhodnutí (jak má schvalování/rate limit synchronně zapadnout do Routeru), ne rychlá záplata |
| MAJOR 4 | `email.send` executor nemá durable idempotency (fresh `ExecutorHost` na `/dispatch`) | **P, opraveno dnes** | potvrzeno: `executor-host.ts` `this.idempotency = opts.idempotency ?? new InMemoryIdempotencyStore()`, `apf-email-executor/src/index.ts:148` volalo `new ExecutorHost(...)` bez `idempotency` klíče. Nejmenší a nejlíp definovaný ze zbylých bodů — `apf-document-host` má stejný problém už vyřešený (`IdempotencyLedger` Durable Object), stačilo vzor zkopírovat. Viz HANDOFF 69 |
| MAJOR 5 | `/audit` přijímá `tenantId`/`actorId`/`capability`/detaily skoro beze změny od volající COW — kompromitovaná COW může vyrábět falešné audit záznamy | **Z, potvrzeno v kódu, oprava odložena** | ověřeno: `deploy/cloudflare/apf-gateway/src/index.ts` `POST /audit` handler jen doplní `auditId`/`at`, zbytek `Partial<AuditRecord>` z requestu beze validace; `apf-document-host/src/relay-audit.ts` `RelayAudit.append()` posílá kompletní záznam přes service binding fetch, nic ho kryptograficky neváže na skutečný podepsaný dispatch. Dnešní blast radius nízký (jediné volající Workery jsou first-slice vlastní kód, ne třetí strana) — proto oprava (vázat audit na Ed25519 signed dispatch context, ne slepě věřit volajícímu) odložena na rozhodnutí vlastníka, ne provedena bez domluvy; zapsáno jako nový řádek `SEVERKA.md` „Audit provenance" |
| MEDIUM | interní endpointy (`/mail-intake`, `/audit`, artefakty) nekontrolují volajícího, spoléhají na CF topologii | **Z, potvrzeno v kódu (stejný nález jako MAJOR 5)** | ověřeno při MAJOR 5: `POST /audit` handler nekontroluje callera vůbec; vědomá volba dneška (perimeter trust); budoucí service identity je součást stejného zero-trust kontraktu jako MAJOR 5, zapsáno tam společně |
| — | Multi-tenant readiness, Admission Gate stav | **Z, potvrzuje známý stav** | odpovídá `SEVERKA.md` Tenant Layer / Capability Marketplace řádkům, žádné nové zjištění |
| — | WF-REV-003 alarm živě ověřen, business transakce ne | **Z, potvrzuje HANDOFF 67** | zapsáno už tam, posudek to jen nezávisle potvrzuje ze stejného commitu |

### Co posudek nezměnil

Pořadí `SEVERKA.md` (Registry hotové → Policy/Risk → Admission Gate → ...) beze změny. MAJOR 2–5 a
MEDIUM čekají na stejnou disciplínu ověření jako MAJOR 1 (přečíst kód, ne převzít tvrzení), než
dostanou vlastní opravu — vlastník rozhodne, kdy na ně dojde.
