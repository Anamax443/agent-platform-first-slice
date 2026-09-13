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

## Posudek 8 — externí oponentura nad `main` po SEVERKA (102), farmář/kráva/dojička (11. 9. 2026)

**Zdroj:** externí čtenář, poslaný vlastníkem jako zpráva v chatu, tentokrát výslovně nad **aktuálním
`main`** (repo, README, `HANDOFF.md`), ne jen dřívějším shrnutím — reakce na dnešní SEVERKA.md (102)
farmář/kráva/dojička diskuzi. Skóre podle čtenáře: celková kvalita **8,8/10** (architektura 9,3,
separation of concerns 9,5, Router/Executor boundary 9,5, tenant isolation 9,2, idempotency 9,3,
Human Review 8,8, Registry 9,1, lifecycle 8,5, audit/observability 8,8, **Policy enforcement 6,5**,
**identity/authentication 6,5**, COW admission/certifikace 7,5, připravenost na BC financial write
~7). Verdikt: „velmi dobrý základ, ale nechci z 8.8 udělat 9.5 jen proto, že se mi líbí koncept."

**Metodologická poznámka:** oba body, co čtenář označuje jako P0, jsem dnes nezávisle ověřil přímo v
kódu (soubor:řádek), stejnou disciplínou jako Posudek 7 MAJOR 1. **Žádný z nich není nový nález** —
jsou to doslova **Posudek 7's MAJOR 2 a MAJOR 3** (9. 9. 2026), tehdy taky ověřené v kódu a vědomě
odložené na rozhodnutí vlastníka. Dnešní oponentura je má znovu nezávisle potvrdila nad aktuálním
kódem (dobré znamení — pořád platí, nezmizely omylem) a přidává konkrétní důvod, proč na ně teď
skutečně dojde: chystaný farmář/kráva/dojička řetěz pro BC import na nich přímo staví.

### Dispozice

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| P0-1 | Access identita není kryptograficky ověřená (`accessJwtVerified: false`) | **Z, znovu potvrzeno v kódu — totožné s Posudek 7 MAJOR 2** | `deploy/cloudflare/apf-gateway/src/index.ts:121` (řádek se posunul, hodnota stejná); `page.ts:198` to pořád sama přiznává v UI. Nic se od 9. 9. nezměnilo — vlastník dosud nerozhodl, kdy na to dojde |
| P0-2 | Policy Engine vynucuje jen actorId/scope/tenant, ne `approval`/`effectFieldValidators`/`isolation`/`rateLimit` | **Z, znovu potvrzeno v kódu — totožné s Posudek 7 MAJOR 3** | `src/platform/policy.ts` `checkGrant()` (46–51) beze změny od 9. 9. — čte jen `actorId`/`scopes`/`tenants`. **Upřesnění nad rámec posudku:** `recipientAllowlist` (jedno z polí `Policy`) se enforce ale **jinou cestou** — `src/slice.ts:113` ho čte přímo do `email.RecipientDirectory`, mimo `checkGrant()`. Zbylá pole (`approval`/`effectFieldValidators`/`isolation`/`grant.rateLimit`) nejsou čtená nikde v `src/`. Dnešní blast radius nízký — **všechny `config/farm-bass443/policy/*.json` mají `approval.required: false`**, takže nic dnes netvrdí ochranu, co by fakticky nedostalo. Farmář/dojička plán ze SEVERKA (102) na `effectFieldValidators`-styl vynucení ale přímo staví (value-bound verifikace) — proto teď P0, ne jen Z |
| — | Dojička jako platformní typ, ne jen přezdívka (formální rozlišení od COW, např. v `module-descriptor`) | **PÚ, zpřesňuje SEVERKA (102)** | (102) zapsala roli konceptuálně (Farmář/Kráva/Dojička v `docs/`); formalizace jako skutečný platformní typ (schema pole, ne jen textový popis) je budoucí implementační krok, ne dnešní stav — SEVERKA aktualizována poznámkou níže |
| — | Provenance graph — hash řetěz original→MD→extrakce→pole→verifikace, ne jen `field: PASS` | **P, zpřesňuje SEVERKA (102)** | (102) už zapsala `valueHash`/`invoiceFingerprint`; dnešní „provenance graph" framing (`inputHash` verifikace == `currentField.hash`) je stejná myšlenka, konkrétnější tvar — přidáno jako poznámka do (102) |
| — | Lifecycle `NEW→TESTING→CERTIFIED→ACTIVE→DEGRADED→QUARANTINED` | **Z, potvrzuje už zapsanou mezeru** | `SEVERKA.md` vrstvy-tabulka, řádek „Admission Gate", už dnes říká „Zbývá: `NEW`/`TESTING`/`DEGRADED` stavy" — posudek dává konkrétní pořadí stavů, ne nové zjištění |
| — | Doporučené pořadí: `invoice.extract`→ARES/VAT/ACCOUNT→dojička→`CertifiedInvoice` **teď**, BC zápis jako `DRY_RUN`, ostrý zápis až po uzavření P0-1/P0-2/evidence-fingerprint | **Otevřené, vlastník rozhodne** | shoduje se s `SEVERKA.md` `## Pořadí` body 5–7 (`invoice.extract`/`cz.company.verify`/`cz.vat.verify` — body 1–4 před nimi už hotové), jen navíc přidává explicitní `DRY_RUN` gate na BC krok a váže „ostrý BC write" na uzavření obou P0 + fingerprint binding. Nezapsáno do `## Pořadí` bez vlastníkova rozhodnutí |
| — | Test počet „246" v posudku | **drobná nepřesnost** | aktuální `main` má **298/298** (HANDOFF 97+); 246 je starší číslo, čtenář pravděpodobně citoval starší HANDOFF záznam — nemění žádnou dispozici výš |

### Co posudek nezměnil

Pořadí `SEVERKA.md` `## Pořadí` beze změny (nezapsán `DRY_RUN` gate ani závaznost P0-1/P0-2 před BC
write, dokud to vlastník nerozhodne). Skóre tabulka je čtenářova, ne nezávisle přepočítaná zdejším
posudkem — na rozdíl od P0-1/P0-2 se jednotlivé číselné hodnoty (9.3/9.5/6.5/...) neověřovaly proti
kódu bod po bodu.

## Posudek 9 — externí oponentura nad Argos acknowledge mechanismem po (104)–(106) (11. 9. 2026)

**Zdroj:** externí čtenář, reakce na `a4b16cf` (HANDOFF 106, banner INCIDENT → HEALTHY). Skóre podle
čtenáře: Farmář+Argos celkově **8.8/10** (Farmář 9.2, Argos detection 9.0, incident management 8.7,
alerting 8.5, dead-man/self-monitoring 8.2, security telemetry 8.0, detail kontrol 7.5, Admission
fail-closed 9.5). Hlavní teze: `HEALTHY` dnes znamená "Argos podle svých pravidel nevidí žádný
neakceptovaný problém", ne "farma je bez závad" — rozdíl, co má zůstat viditelný, ne se ztratit za
zelenou barvou.

**4 body, ověřeny v kódu před zápisem dispozice:**

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Riziko, že se `HEALTHY` dá "dosáhnout" jen acknowledgementem bez rozlišení od skutečně nulového dluhu — navrhuje vždy zobrazovat "0 aktivních / N známé" | **O, už takhle funguje** | `watchdogBanner()` (`page.ts`) ukazuje `stateBadge(level)` VŽDY spolu s `<span class="meta">` textem "N otevřené nálezy, M potvrzeno jako známé" ve stejném řádku — banner nikdy neukazuje holé "HEALTHY" bez rozpisu. Čtenář posuzoval z HANDOFF textu, ne z živého renderu; zamítnuto jako už vyřešené, ne jako špatný nápad |
| 2 | Self-test má jen jednu osu PASS/FAIL — injection nález je bezpečnostně v pořádku, kvalitativně špatně, a to se dnes neumí rozlišit strukturovaně (jen ručně v HANDOFF textu) | **PÚ, reálná mezera** | `SelfTestRow` (`page.ts:1119`) má jediné `ok: boolean` — `kind: "injection"` samo o sobě neříká, jestli šlo o průlom hranice, nebo jen o zmatenou-ale-bezpečnou odpověď (přesně (106)'s případ). Přijato jako budoucí rozšíření (golden by nesl dvě očekávání, ne jedno) — dnešní rozsah je jen "vysvětlit v textu", ne strukturovaně rozlišit; vlastník rozhodne, kdy na to dojde |
| 3 | `why`/`onFailure` v `SelfTestRow` jsou `?` (optional) — navrhuje povinná pole (`why`/`expected`/`failureImpact`/`onFailure`/`category`/`severity`) vynucená schématem | **PÚ, částečně** | `why?`/`onFailure?` jsou skutečně optional (`page.ts:1124-1129`, komentář to přiznává: "not every one earns it") — po (100) je ale fakticky **82/82 fixtures pokrytých**, takže mezera dnes neexistuje v datech, jen v typu (nová fixture by mohla proklouznout bez why/onFailure a nic by to nechytilo). `category`/`severity`/`expected`/`failureImpact` jako NOVÁ pole nad rámec dnešního `kind`/`why`/`onFailure` — širší návrh, netříděno dnes, jen zapsáno jako kandidát |
| 4 | Argos heartbeat je jen `selfTestAt` — nerozlišuje "cron neběží" od "cron běží, self-test/reconcile uvnitř padá" — navrhuje `lastWatchdogTickAt`/`lastSelfTestAt`/`lastIncidentReconcileAt`/`lastAlertAttemptAt` | **PÚ, částečná mezera** | `lastAlertAttemptAt` už fakticky existuje (`ArgosAlertHealth.lastAttemptAt`, HANDOFF 92). Chybí: samostatný `lastWatchdogTickAt` nezávislý na tom, jestli self-test uvnitř tiku uspěl — dnes `scheduled()` aktualizuje `selfTestAt` jen když self-test krok doběhne, takže "cron žije, self-test uvnitř padá" a "cron vůbec neběží" vypadají dnes stejně (oba = stárnoucí `selfTestAt`). Reálné zjemnění diagnostiky, ne kosmetika |

**Co posudek nezměnil:** žádný kód dnes — čeká na vlastníkovo rozhodnutí, který z bodů 2–4 (pokud
vůbec) je další krok, stejně jako Posudek 8's P0-1/P0-2.

## Posudek 10 — externí oponentura nad `09e0835`, zastaralá vůči skutečnému `main` (11. 9. 2026)

**Zdroj:** externí čtenář, reakce na `09e0835` (HANDOFF 102, "Farmář jako honák, ne autorita")
jako na "nejnovější" commit. Skóre podle čtenáře: Farmář+Argos celkově **~9,0/10** (Farmář UI 9,2,
vysvětlení kontrol 9,0, Argos detection 9,0, incident management 8,7, dead-man 8,2, alerting 8,5,
authoritative backlog 9,2, trusted telemetry 8,4, Admission fail-closed 9,5, zero-trust COW model
9,3 návrh, compromised-farmer protection 9,5 návrh/0 implementace).

**Zásadní zjištění před zápisem dispozice:** posudek pracuje s `09e0835` jako aktuální hlavou, ale
skutečný `main` je od té doby o **11 commitů dál** (`ee6e483`) — `invoice.extract` (109), rozhodnutí
o JSON Export mezifázi místo BC Executoru (110), bezplatné API zdroje pro `cz.company.verify`/
`cz.vat.verify` (111), BC API v2.0 reference (112), `bc.customers`/`bc.vendors` potvrzeny jako
skutečné krávy (113). Posudek o žádném z těchto pěti kroků neví — jeho "aktuální stav" tabulka je
tedy zastaralá o celý dnešní produkční přírůstek, ne jen kosmeticky.

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Tvrdí `09e0835` jako nejnovější commit, hodnotí "aktuální stav" k tomuto bodu | **Z, zastaralé** | Ověřeno `git log`: `09e0835` je HANDOFF 102, `main` je dnes u HANDOFF 113 (`ee6e483`). Není to chyba posudku samotného (dělal ho na tom, co viděl), ale jeho "current state" rámování se nesmí brát jako platné bez týhle výhrady |
| 2 | `why`/`onFailure` na 19 (`27e29b6`) + 59 (`b26d06a`) fixtures, živě ověřeno (`6a287a4`) | **P, ověřeno přesně** | Všechny tři commity existují, obsah odpovídá popisu (`git show --stat` proti skutečným hashům) |
| 3 | Trusted telemetry — `/audit` odmítá rozporný tenant claim, živě ověřeno legitimní i spoofing (`d0cc252`/`d6591fd`) | **P, ověřeno přesně** | Oba commity existují, obsah odpovídá popisu |
| 4 | Tři role (Farmář/Krávy/Dojička), Import Gate čte ze skladu, value-binding (`valueHash`/`ACCOUNT_VERIFICATION`) — prezentováno jako doporučení k zachování | **PÚ, už existovalo v recenzovaném commitu** | `git show 09e0835:docs/SEVERKA.md` obsahuje `ACCOUNT_VERIFICATION`/`valueHash` sekci (řádky 176–185) **už v tom samém commitu, co posudek recenzuje** — čtenář přesně převyprávěl, co tam už bylo napsané, ne navrhl nové. Hodnotný jako nezávislé potvrzení kvality návrhu, ne jako nový vstup |
| 5 | Argos by měl hlídat nejen komponenty, ale **invarianty** — nové rozdělení na System Health / Security Invariants / Business Integrity / Delivery-Effects | **PÚ, reálný a nový nápad** | V SEVERKA dnes není — a je to fakticky zobecnění Posudku 9 bodu 2 (self-test potřebuje bezpečnostní/kvalitativní osu navíc k PASS/FAIL), jen z jiného úhlu (invarianty napříč celou linkou, ne jen self-test jednotlivé capability). Stejná otevřená mezera, širší formulace — čeká na stejné vlastníkovo rozhodnutí jako Posudek 9 bod 2 |

**Co posudek nezměnil:** žádný kód dnes. Bod 5 rozšiřuje otevřenou otázku z Posudku 9 (bod 2), ne
novou — obě čekají na společné rozhodnutí, ne na dvě oddělené.

## Posudek 11 — externí oponentura nad `8de8e09`, doporučuje začít stavět krávy (11. 9. 2026)

**Zdroj:** externí čtenář, reakce na `8de8e09` (Posudek 10 zalogován). Skóre: platform/security core
9,3, připravenost na read-only COW 9,4, na validační COW 9,2, na dojičky 8,5, na ostrý BC write
7,5, farma jako rozšiřitelná platforma ~9,0. Hlavní teze: **"teď už bych je dělal"** — read-only a
validační krávy jsou připravené se stavět, jen write krávy (`bc.purchase-invoice.create`) mají
počkat na dotažený policy enforcement.

| # | Bod posudku | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Router drží fail-closed pipeline (envelope, podpis, expirace, scope, capability/version, lifecycle, policy, input schema); neznámý/quarantined modul se nepustí | **P, ověřeno v kódu** | `src/platform/router.ts`: `validateContract("dispatch-envelope", ...)` → target resolution → `MODULE_QUARANTINED` check → `checkGrant()` → `validateInput()` před handlerem — pořadí odpovídá popisu |
| 2 | Registry je read-only katalog, není druhá autorizační autorita — authorization zůstává v Routeru | **P, ověřeno v kódu** | `src/platform/registry.ts`'s vlastní hlavičkový komentář: *"Read-only introspection... never a second source of authorization — Router.route() alone decides what may execute"* — doslovná shoda |
| 3 | `cz.company.verify`/`bc.vendors` správně odděluje vnější (ARES) a vnitřní (BC Vendor No.) autoritu | **P, přesně tak** | Napsáno v HANDOFF 113/SEVERKA vlastníkovým pokynem dnes, posudek to přesně reprodukuje |
| 4 | `checkGrant()` kontroluje jen actor/scope/tenant, ne `approval`/`effectFieldValidators`/`isolation`/`rateLimit` — musí být vynuceno před ostrým BC zápisem | **P, ale NENÍ nové zjištění** | Ověřeno v `src/platform/policy.ts:46-51` — přesně tak. Ale tohle je **doslovně stejná mezera jako Posudek 7 MAJOR 3 / Posudek 8 P0-2**, jen znovu formulovaná — hodnotné jako nezávislé potvrzení priority, ne jako nový nález |
| 5 | Lifecycle má jen `ACTIVE`/`QUARANTINED`, chybí `NEW/TESTING/CERTIFIED/DEGRADED` + automatický verification runner | **P, ale NENÍ nové zjištění** | Přesně to, co SEVERKA's vlastní `## Vrstvy` tabulka (Admission Gate řádek) už dlouho říká jako "Zbývá" — restatement, ne objev |
| 6 | Navrhuje `cz.bank-account.verify` jako samostatnou 3. CZ-registry krávu vedle `cz.company.verify`/`cz.vat.verify` | **O, neodpovídá ověřenému API** | SEVERKA (řádky 101–105, ověřeno dnes) už zapsala, že zveřejněné bankovní účty (`zverejneneUcty`) jsou součástí **téhož** `getStatusNespolehlivySubjektRozsirenyV2` volání jako `cz.vat.verify` — MOJE daně nemá samostatný endpoint jen na účty. Rozdělit by znamenalo buď zdvojený dotaz na rate-limitovanou službu, nebo umělou vnitřní sub-capabilitu bez vlastního externího volání — proti principu jedné krávy = jedno smysluplné volání. Bankovní účet zůstává výstupní pole `cz.vat.verify`, ne vlastní kráva |
| 7 | Návrh dojičky `invoice.aggregate`/`invoice.certify` — deterministická, bez LLM, kontroluje úplnost výsledků, shodu `valueHash`, žádný konflikt, výstup `READY/REVIEW/REJECT` | **Z, dobrý návrh k budoucímu rozhodnutí** | Konzistentní s dnes již zapsaným Import Gate/`valueHash` konceptem v SEVERKA — solidní konkrétní tvar první dojičky, nevyžaduje korekci, čeká na vlastníkovo "teď" |
| 8 | Doporučuje začít stavět: `cz.company.verify`, `cz.vat.verify`, `bc.vendors`, `bc.customers` (+ opravený seznam bez bodu 6) a dojičku, write krávy až po dotaženém policy enforcement | **Z, shoduje se s dnešním doporučením** | Odpovídá tomu, co bylo dnes už nabídnuto k rozhodnutí (přechod do Plan Mode) — posudek jen nezávisle potvrzuje stejný závěr |

**Co posudek nezměnil:** žádný kód dnes. Body 4–5 jsou restatement, ne nový vstup do pořadí. Bod 6
je korigován (bankovní účet zůstává v `cz.vat.verify`, ne vlastní kráva). Zbytek souhlasí s tím, kam
projekt dnes už míří.

## Posudek 12 — vlastníkova protioponentura nad Posudkem 11, s konceptem Office (12. 9. 2026)

**Zdroj:** vlastník (Milan) sám, ne externí čtenář — druhé, kritičtější kolo nad `5af3f26`
(Posudek 11 zalogován) a nad aktuálním jádrem po `fc76849` (Policy Enforcement v2 checkpoint).
Vlastní skóre: platform core 9,4, Router/security boundary 9,5, ExecutorHost 9,4, idempotence/
replay 9,3, tenant isolation primitives 9,3, Registry/discovery 9,0, lifecycle/kill switch 8,5,
audit/observability 8,8, **Policy enforcement 6,5**, Admission/certifikace 7,0, připravenost na
read-only COW 9,4, na write COW 7,5, **celkově 9,0/10**. Hlavní teze: Posudek 11 je v hlavním
směru správný, ale spíš potvrzovací než útočný (sám přiznává, že 2 z jeho 8 bodů jsou restatement) —
projekt je připraven na první read-only/validační krávu, ale ne na "sériovou homologaci krav".

| # | Bod | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Router pořadí (envelope → binding → podpis → expirace → scope → provider/verze → lifecycle → policy → payload schema → handler) je fail-closed, neznámý/quarantined modul neprojde | **Z, potvrzeno** | Totéž co Posudek 11 bod 1, nezávisle znovu potvrzeno |
| 2 | ExecutorHost je dnes kvalitní: idempotency `tenantId+handlerId+idempotencyKey` + SHA-256 fingerprint payloadu → `IDEMPOTENCY_CONFLICT`/`IDEMPOTENCY_IN_FLIGHT`; `resourceTenant()` má 4 explicitní stavy (`FOUND`/`GLOBAL_RESOURCE`/`NOT_FOUND`/`UNRESOLVED`), fail-closed | **Z, potvrzeno** | `executor-host.ts` (`dedupKey`, fingerprint) — beze změny od Posudku 5/6 (W19/W20) |
| 3 | Policy enforcement je největší strukturální dluh: `checkGrant()` dřív kontroloval jen actor/scope/tenant, zatímco `approval`/`effectFieldValidators`/`isolation`/`rateLimit` byly jen deklarované, nikdy vynucené — navrhuje samostatný Policy Evaluation engine (grant → approval → effect validators → isolation → rate limits → risk controls → tenant constraints → `ALLOW`/`DENY`/`REVIEW`) jako P0 před ostrým BC zápisem | **P, mezitím už rozestavěno a dnes dotaženo do zelena** | Totožná mezera jako Posudek 7 MAJOR 3 / Posudek 8 P0-2 / Posudek 11 bod 4. Mezi Posudkem 11 a touhle reflexí vlastník sám tenhle engine začal stavět (`fc76849`, 11. 9. večer) jako `checkEffectFieldValidators()`/`checkApproval()` v `executor-host.ts` — FOUNDATION-core §3.3 kroky 5–6, norma's vlastní umístění do executoru, ne nový Router-level engine (ověřeno proti zmrazené normě před návrhem). Checkpoint měl 14/15 testů červených ("fix understood, not yet applied"); dotaženo dnes do 15/15 + 348/348 celkem (HANDOFF 116) — root cause byla chybějící `idempotencyKey` v testovací fixture, ne chyba v samotné logice. **`approval`/`effectFieldValidators`/`isolation` (registrační cross-check) jsou tedy dnes reálně vynucené, ne jen deklarované.** `rateLimit` a explicitní třetí výsledek `REVIEW` (na rozdíl od binárního povolit/zamítnout) zůstávají nepokryté — dnešní `checkApproval()` řeší schvalování jako podmínku úspěchu (`APPROVAL_REQUIRED`/`APPROVAL_MISMATCH`), funkčně rovnocenné, jen jinak pojmenované než Milanův `REVIEW` návratový stav |
| 4 | Registry správně jen katalog, ne autorita; rozlišuje "kráva tvrdí, že umí X" vs. "platforma ověřila, že build prošel testy A–N" — druhé není kompletní | **Z, potvrzuje známou mezeru** | `registry.ts` beze změny (Posudek 11 bod 2); druhá polovina patří k bodu 6 níže |
| 5 | Lifecycle příliš hrubý (jen `ACTIVE`/`QUARANTINED`); navrhuje `NEW → TESTING → CERTIFIED → ACTIVE → DEGRADED → QUARANTINED`, `ACTIVE` nesmí být ručně udělené bez certifikační evidence | **Z, potvrzuje už zapsanou mezeru** | `SEVERKA.md` Admission Gate řádek to dlouho říká jako "Zbývá" (Posudek 8/9/10/11 nezávisle potvrdily); dnešní přínos je konkrétní vazba na bod 6 |
| 6 | Self-test infrastruktura (D1, historie per capabilita) je dobrý základ, ale není plná certifikace — chybí `CertificationRecord{gitSha/buildHash, module, capability, riskProfile, requiredTests, actualResults}`; `ACTIVE` smí platit jen když `CertificationRecord.PASS && certifiedBuildHash == runningBuildHash` | **P, přijato jako konkrétní tvar bodu 5** | Nové oproti dřívějším posudkům — dřív šlo jen o "chybí `NEW/TESTING/CERTIFIED`", dnes konkrétní vazba na buildHash. Zapsáno do `docs/SEVERKA.md` Admission Gate sekce, implementace zatím 0 % |
| 7 | `accessJwtVerified: false` je P0 před druhou lidskou identitou/tenantem, ne katastrofa, dokud je vlastník jediný uživatel | **Z, potvrzuje známou mezeru** | Totožné s Posudek 7 MAJOR 2 / Posudek 8 P0-1 — beze změny, čeká na druhou identitu jako spouštěč; navazuje na koncept Office (viz níže) |
| 8 | Souhlasí s korekcí Posudku 11 — žádná samostatná `bank-account` kráva, bankovní účet zůstává pole `cz.vat.verify` | **Z, potvrzeno beze změny** | Přesně Posudek 11 bod 6 |
| 9 | První dojička by měla být `invoice.verification.aggregate` — jednoduchá, deterministická, bez LLM: kontroluje úplnost, shodu `valueHash`, žádný konflikt, žádnou expirovanou evidenci → `READY/REVIEW/REJECT` | **P, konkretizuje už zapsaný návrh** | Shoduje se s Posudek 11 bod 7 a se SEVERKA `Dojičky`/Import Gate sekcí; jméno `invoice.verification.aggregate` přijato jako pracovní název |
| 10 | Farmář/dojička kontrakty by měly být vynucené schématem, ne jen dokumentované — farmářovo I/O schéma nesmí vůbec připustit `amount`/`bankAccount`/`ICO`/`VAT`/`supplier` jako výstup; dojička nesmí mít API `setAmount()`/`setBankAccount()` | **P, konkretizuje existující princip** | `SEVERKA.md`'s `### Hlavní invariant: farmář nesmí nosit hodnoty` to už říká slovně; tohle je návrh, jak to vynutit strojově (schema-level zákaz polí) — zapsáno tamtéž jako implementační poznámka |
| 11 | Nová platformní primitiva `Evidence{evidenceId, tenantId, capability, provider, inputField, inputValueHash, result, observedAt, expiresAt?, buildHash}` — dojička nečte holé `PASS`, ale "`PASS` pro hash X, od providera Y, build Z" | **P, formalizuje existující myšlenku** | `SEVERKA.md`'s `### Kontrola musí být svázaná s konkrétní hodnotou` (`valueHash`/provenance graph, Posudek 8) to už řeší koncepčně; Milanův konkrétní schema tvar přijat a zapsán tamtéž jako explicitní pole |
| 12 | Composition je nové těžiště rizika, ne jednotlivé krávy — konkrétní scénáře: evidence pro fakturu X použita pro Y, zastaralá ARES evidence, evidence patřící jinému tenantovi, platná certifikace po upgradu COW, expirovaná evidence pořád použitá, dvě krávy vrátí konfliktní fakta, nereagující kráva a Planner přesto dokončí import | **P, nová sada testů** | Žádný z těchto scénářů dnes není v `### Adversarial test suite` (Zero-trust model) — ta řeší útoky na jednu COW (cross-tenant, credential escape, replay...), ne kompozici napříč víc kravami. Zapsáno jako nová podsekce SEVERKA |

**Verdikt vlastníka:** Posudek 11 8,5/10 jako oponentura — přesný, ale spíš potvrzovací než útočný
(2 z 8 bodů restatement, jak Posudek 11 sám přiznává v `Co posudek nezměnil`). Projekt 9,0/10.
Vlastní citace: *"Už se nebojím jednotlivých krav tolik jako dřív. Teď se začínám víc bát toho, jak
budeme bezpečně skládat výsledky mnoha krav dohromady."* — těžiště rizika se přesouvá z jednotlivé
COW na řetěz evidence → dojička → certified business object → write executor.

**Vlastníkovo pořadí příštích kroků** (nahrazuje `SEVERKA.md`'s starší `## Pořadí`, viz tamní
přepis): Policy Enforcement v2 (**dotaženo dnes, HANDOFF 116**) → Evidence/Provenance Contract →
build-bound CertificationRecord → Lifecycle `NEW→TESTING→CERTIFIED→ACTIVE` → `cz.company.verify` →
`cz.vat.verify` → `bc.vendors` → první deterministická dojička (`invoice.verification.aggregate`) →
compromised-farmer/composition attack suite → až pak BC write `DRY_RUN` → live. Planner zůstává až
za tím vším.

### Vedlejší téma: Office (tenant/identity/access) — nový blok farmy

Stejná diskuze otevřela samostatný koncept, dosud v SEVERKA nepojmenovaný: **Office** = recepce +
matrika farmy — kde vzniká tenant, uživatelé, role a napojení na identity providera. Tři oddělené
věci s různou expirací (tenant jako stav ACTIVE/SUSPENDED/CLOSED, session token s krátkou
expirací, service/connector token s vlastní rotací) a konfigurovatelné MFA
(`OPTIONAL`/`REQUIRED`/`REQUIRED_FOR_PRIVILEGED`, plus step-up MFA na kritické operace). Office
samo neověřuje heslo/e-mail — deleguje na skutečný identity provider (Cloudflare Access/Entra
ID/Google) a jen mapuje ověřenou identitu na `tenantId`+role. Zapsáno jako nová vrstva do
`docs/SEVERKA.md` (viz `## Vrstvy`, řádek Office) — **cílový obraz, ne rozhodnuté zadání**, stejná
výhrada jako u zbytku SEVERKA; přímo navazuje na bod 7 výše a na `SEVERKA.md`'s starší Tenant
Layer poznámku z 2026-09-09.

### Co posudek nezměnil

Kód dnes změněn jen v bodě 3 — dokončení už rozjetého checkpointu (`fc76849` → HANDOFF 116), časová
shoda s touhle reflexí, ne reakce na ni. Zbytek (body 2, 4–12, Office) je dokumentační: zapsáno do
`docs/SEVERKA.md`, čeká na vlastníkovo rozhodnutí o pořadí implementace bodů 4 (Evidence),
6 (CertificationRecord), 5 (Lifecycle stavy) a Office samotného.

## Posudek 13 — vlastníkovo shrnutí po Žlab/Dojička commitech, zastaralý na runtime stav, přesná korekce Ponocného (13. 9. 2026)

**Zdroj:** vlastník (Milan), reakce na aktuální `main` po formalizaci Žlab/Konev/Mlékárna/Průsvitná
stáj/Ponocný do SEVERKA (HANDOFF 119) — číslo commitů v posudku (147) neodpovídá tomu, co bylo
skutečně na `main` v okamžiku psaní posudku.

**Zastaralost, ověřená stejnou disciplínou jako Posudek 6/10 (přečten `git log`/`git ls-tree`, ne
převzato z tvrzení):** posudek hodnotí "Žlab runtime 0–10 %", "Evidence runtime 10–20 %", "Dojička
0 % runtime", "Konev 0 % runtime" a doporučuje "už nepřidávat další koncepty, dokud nezačne vznikat
Žlab + Evidence v kódu". V okamžiku psaní posudku ale **`main` už měl 149 commitů**, a `src/
platform/evidence.ts` (`EvidenceLedger`, `tests/zlab.test.ts`, 7 testů ZLAB-001..007, HANDOFF 121)
i `src/platform/aggregator.ts` (`EvidenceAggregator`/Dojička, `tests/dojicka.test.ts`, 9 testů
DOJ-001..009, HANDOFF 123) byly na `main` už od dvou commitů před touhle reflexí (`b1a49ec`,
`38a85a1`) — potvrzeno `git ls-tree -r origin/main --name-only`. Nejpravděpodobnější důvod: posudek
pracoval s prohlížečovým/cache snímkem GitHubu z okna před pushem, stejný jev jako Posudek 6's CDN
zpoždění 9. 9. 2026 — ne chyba v kódu ani ignorování doporučení.

| # | Bod | Dispozice | Poznámka |
|---|---|---|---|
| 1 | "Evidence/Žlab/Dojička/Konev jsou 0–20 % runtime, ne stavět další koncepty, dokud tohle nevznikne v kódu" | **O, na základě zastaralého snímku** | `EvidenceLedger` a `EvidenceAggregator` existují jako testovaný kód (16 testů) od `b1a49ec`/`38a85a1`, dva commity před touhle reflexí. Konev (zapečetěný `CertifiedBusinessObject`) je skutečně 0 % — správně, ale posudek to nerozlišil od Žlabu/Dojičky, které už jsou hotové |
| 2 | Ponocný by neměl být enforcement arm Argose; přesná definice: "Argos hlídá farmu, Ponocný nezávisle hlídá, že Argos skutečně hlídá" — malý, nezávislý heartbeat/canary/dead-man's-switch; enforcement (quarantine/kill switch/emergency READ_ONLY) patří do samostatného konceptu | **P, přijato — moje vlastní interpretace z 12. 9. byla nepřesná** | `docs/SEVERKA.md` `## Vrstvy` řádek "Argos + Ponocný" (zapsaný 12. 9. 2026, HANDOFF 119, výslovně jako "nejlepší dostupná interpretace... neověřeno přímo s vlastníkem") mylně sloučil detekci hlídání s enforcementem. Opraveno: Ponocný je teď definován jako nezávislý heartbeat/canary nad Argosem samotným (chrání proti scénáři "Argos/cron spadne a nikdo si nevšimne"), enforcement přesunut do nového, oddělného řádku **Safety Executor** |
| 3 | DRY_RUN zobecnění (schema→policy→validators→approval→idempotency, ale bez side effectu a bez write credentialu vůbec, ne jen `if dryRun return`) je správně zapsáno | **Z, potvrzeno** | Odpovídá `### DRY_RUN jako obecný princip pro write capability` (HANDOFF 118), beze změny |
| 4 | Evidence kontrakt (`evidenceId`/`tenantId`/`capability`/`provider`/`inputField`/`inputValueHash`/`result`/`observedAt`/`expiresAt`/`buildHash`) + build-bound `CertificationRecord` jsou správný základ pro composition scénáře (změna IČO/účtu/buildu/tenanta invaliduje starou evidenci) | **Z, potvrzeno a už implementováno** | Přesně tvar `Evidence` v `src/platform/evidence.ts` (`b1a49ec`) — `CertificationRecord` sám zůstává nepostavený (SEVERKA `## Pořadí` bod 3) |
| 5 | Office koncepčně hotové, chybí implementace | **Z, potvrzeno** | Beze změny od (117); implementace 0 % |

**Verdikt vlastníka (jeho vlastní skóre, přepočítané s korekcí bodu 1 výš):** implementované jádro
~9,1/10, cílová architektura ~9,6/10, realizace celé dnešní vize odhadem 65–70 % — tahle poslední
míra je teď o dva testované primitivy vyšší, než posudek počítal, protože Žlab a Dojička nejsou
0 %, ale hotové jako testovaný kód (Konev/Mlékárna/Office/Průsvitná stáj/Safety Executor zůstávají
0 % beze změny).

### Co posudek nezměnil

Kód dnes: jen `docs/SEVERKA.md` (Ponocný/Safety Executor split, viz bod 2). Pořadí `## Pořadí`
beze změny — Konev a napojení první reálné krávy (`cz.company.verify`/`cz.vat.verify`) zůstávají
příští, ne composition attack suite (ta stojí až za nimi, jak `## Pořadí` bod 9 už řadí).

## Posudek 14 — vlastník znovu nad `main` na GitHubu, oprava vlastního skóre, Konev jako doporučený příští krok (13. 9. 2026)

**Zdroj:** vlastník (Milan), třetí kolo nad `main` po Posudku 13 — tentokrát čtené přímo na GitHubu
včetně `evidence.ts`/`aggregator.ts`/testů, ne ze zastaralého snímku. Sám opravuje vlastní
předchozí skóre: **implementovaný projekt 9,25/10** (z chybného odhadu v Posudku 13's zdrojovém
materiálu), **cílová koncepce 9,65/10**. Router 9,6, ExecutorHost 9,5, Policy 9,3, Žlab/Evidence
primitivum 9,2, Dojička primitivum 9,1, Argos 9,0, Lifecycle/certifikace 7,5, Office 4,0, **Konev
~3** (v okamžiku psaní ještě nepostavený), Průsvitná stáj ~2, Ponocný ~1.

| # | Bod | Dispozice | Poznámka |
|---|---|---|---|
| 1 | Žlab je dnes "platformní primitivum", ne "produkční durable evidence infrastructure" — chybí durable storage, transaction semantics, concurrent append, crash recovery, key rotation, backup/retention | **Z, přesně tak** | `EvidenceLedger` (`src/platform/evidence.ts`) drží stav v `Map`, ne v D1/Durable Object — správné odlišení "kryptograficky dobře navržená datová struktura" od "přežije 5 let provozu a obnovu ze zálohy". Durabilita je stejná kategorie práce jako `IdempotencyLedger` u `document-host`/`email-executor` (Durable Object), zatím neudělaná pro Žlab — nezařazeno do `## Pořadí`, čeká na první reálnou krávu, co by na tom stála |
| 2 | Dojička je primitivum 9,1/10, ale "ještě nedojí nic reálného" — testováno jen na uměle vytvořené Evidenci, ne na výstupu skutečných `cz.company.verify`/`cz.vat.verify`/`bc.vendors` | **Z, potvrzeno, SEVERKA to už takhle říká** | `## Pořadí` bod 8 vlastní poznámka ("Zatím nenapojeno na skutečnou capabilitu") — žádné nové zjištění, jen důraz na to, že 9,5+ přijde až po reálném napojení |
| 3 | Router/ExecutorHost zůstávají nejsilnější části, nic zásadního nepřestavovat | **Z, potvrzeno** | Beze změny od předchozích posudků |
| 4 | Idempotency fingerprint (`stejný key + jiný payload` = `IDEMPOTENCY_CONFLICT`, ne duplicate) je "enterprise-grade" | **Z, potvrzeno** | Beze změny, Posudek 5/6 |
| 5 | **P0 před BC live write:** `checkEffectFieldValidators()` čte `validation.status:"passed"` uvnitř business payloadu — budoucí Mlékárna nesmí BC zápis autorizovat na tomhle tvrzení, musí ověřit celý Konev (`rootHash`+podpis+živý stav evidence) | **P, přijato jako architektonické pravidlo** | Reálná, dosud nezapsaná mezera mezi dnešním obecným policy mechanismem (`policy.ts`, funguje správně pro to, k čemu je) a novou Evidence/Žlab architekturou. Zapsáno jako P0 poznámka do `### BC Executor musí být „hloupý"` — `checkEffectFieldValidators()` zůstává legitimní pro capability, které Evidence/Žlab nepotřebují; R3+/Mlékárna třída musí vždy ověřit Konev, nikdy tohle substituovat |
| 6 | **Konev je teď nejvyšší priorita projektu** — bez zapečetěného `CertifiedBusinessObject` nemá smysl pokračovat na dalších konceptech; "jediný následující commit" by měl být Konev | **P, provedeno ve stejný den** | `src/platform/konev.ts`'s `BusinessObjectSealer` — `seal()` přijme jen `decision:"READY"` strukturálně, znovu ověří evidenci proti Žlabu při zapečetění (ne jen důvěra ve starší `AggregateResult`), `verify()` odděleně kontroluje obsah Konve a živý stav evidence. `tests/konev.test.ts`, 8 testů (KONEV-001..008), všechny zelené na první běh. Zapsáno do `docs/SEVERKA.md` (`### Tři role, ne dvě` Konev bullet, `## Pořadí` bod 8b) |
| 7 | Composition attack suite (`COMPROMISED FARMER` end-to-end: vyměnit tenant/evidenceRef, replay expirované evidence, vyrobit vlastní evidence/podpis, přikázat BC Executor libovolný JSON) by měla přijít brzy, ne čekat dlouho | **Z, potvrzuje už zapsané pořadí** | `## Pořadí` bod 9, beze změny; několik scénářů (cizí tenant, tamper, konflikt, expirace) už dnes pokrývá `tests/dojicka.test.ts`/`tests/konev.test.ts` jako součást DOJ/KONEV rodin, ne jako samostatná "composition" sada — širší end-to-end suite (Farmář s plnou možností generovat dispatch) zůstává otevřená |
| 8 | Ponocný split (Argos detekuje / Safety Executor jedná / Ponocný nezávisle hlídá Argose) je "mnohem lepší architektura" | **Z, potvrzuje Posudek 13** | Beze změny |
| 9 | Doporučení: přestat vymýšlet další koncepty, postavit jeden vertikální řetěz (reálné PDF → invoice.extract → Žlab → ARES → Žlab → VAT → Žlab → BC Vendor READ → Žlab → Dojička → CertifiedInvoice → BC Executor → OUTPUT_TO_JSON) a rozbíjet ho útoky | **Z, shoduje se s `## Pořadí`** | Přesně řazení bodů 5–10 (`cz.company.verify`→`cz.vat.verify`→`bc.vendors`→attack suite→DRY_RUN); žádný nový koncept dnes nepřibyl mimo dokončení Konve (bod 6), který sám vlastník žádal |
| 10 | `/status.json` generovaný CI (gitSha/testCount/testResult/capabilities/certificationStatus) by byl lepší než ruční README | **Z, dobrý nápad, nezařazeno** | Navazuje na (122)'s README/STATUS oprava; automatizace zdroje pravdy je logický další krok, ale samostatný od dnešního Konev commitu — čeká na vlastníkovo rozhodnutí, kdy na to dojde |

**Verdikt vlastníka:** implementovaný projekt 9,25/10, cílová koncepce 9,65/10, čtyři největší
překážky ke zbylým ~0,4 bodu: Konev (**hotovo dnes**) → build-bound `CertificationRecord` →
skutečné krávy zapisující do Žlabu → compromised-farmer end-to-end test.

### Co posudek nezměnil

Kód dnes: `src/platform/konev.ts` + `tests/konev.test.ts` (bod 6, na vlastníkovu explicitní
žádost "jediný následující commit"). `## Pořadí` pořadí bodů beze změny — Konev byl už zapsaný
jako bod 8b, jen "nepostaveno" → "hotovo". Bod 5 (Konev vs. `checkEffectFieldValidators()`) je nové
architektonické pravidlo, ne oprava dnešního kódu — žádná reálná policy dnes na tomhle nestojí.

## Posudek 15 — nepřátelský adversarial review nad Žlab/Dojička/ExecutorHost/Router, 2 potvrzené P0 (13. 9. 2026)

**Zdroj:** vlastník (Milan), tentokrát výslovně "jako nepřátelský code review", ne kontrola shody se
SEVERKA. Skóre: implementovaný projekt **8,9/10** (pokles z 9,25 — ne proto, že by se projekt
zhoršil, ale proto, že nové vrstvy (Žlab/Dojička) teď poprvé daly co kontrolovat), security core
samotný 9,4, cílová architektura 9,6–9,7.

**Oba P0 nálezy ověřeny přímo v kódu a opraveny ve stejný den:**

| # | Bod | Dispozice | Poznámka |
|---|---|---|---|
| P0-1 | `EvidenceAggregator`'s `required` kontrola ověřovala jen `producerId` shodu, ne `result` — jediná evidence s `result: "FAIL"` splňovala požadavek a `READY` mohlo vzniknout i s explicitním FAIL | **P, potvrzeno a opraveno** | Ověřeno přímo: `(byField.get(req.field) ?? []).some((r) => r.producerId === req.producerId)` v `aggregator.ts` (řádek 87 před opravou) skutečně nekontrolovalo `r.result`, a konflikt-detekce nechytí jediný záznam (potřebuje ≥2 rozdílné hodnoty). Opraveno: `RequiredEvidence.acceptableResults` (default `["PASS"]`), nový `FindingKind: "rejected"` (HARD_FAILURE → REJECT). Nové testy `DOJ-010` (explicitní FAIL → REJECT, přesně nález popsaný v posudku; + druhý test na `acceptableResults` s doménovým tokenem jiným než PASS) |
| P0-2 | Dojička nedostává autoritativní aktuální hodnotu certifikovaného objektu (`fieldHashes`) ani `workflowId` k porovnání — interně konzistentní evidence z **jiné** faktury/workflow stejného tenanta by prošla | **P, potvrzeno a opraveno** | `aggregate()` bralo jen `{tenantId, required, evidenceRefs}` — žádné pole pro "hodnota, kterou fakticky certifikujeme právě teď". Opraveno: `aggregate()` teď vyžaduje `fieldHashes: Record<string,string>` (povinné, ne optional — strukturálně vynucuje binding) porovnané s `Evidence.inputValueHash` pro každé pole s dochovanou evidencí (`not_bound`, HARD_FAILURE), plus volitelné `workflowId` porovnané s `Evidence.workflowId`, když ho evidence deklaruje (`workflow_mismatch`, HARD_FAILURE). Nové testy `DOJ-011` (jiná faktura stejného tenanta, chybějící fieldHashes) a `DOJ-012` (jiný workflow, evidence bez workflowId neblokovaná) |

**P1 nálezy, ověřeny, vědomě odloženy (nejsou v žádném rozporu s dnešní opravou, ale vyžadují buď
větší designové rozhodnutí, nebo sahají do živého kódu farmy):**

| # | Bod | Stav | Poznámka |
|---|---|---|---|
| P1-1 | `EvidenceLedger` je `Map` v paměti, ne durable storage — restart Žlab smaže | **Potvrzeno, odloženo** | Stejná kategorie práce jako `IdempotencyLedger` (Durable Object) u `document-host`/`email-executor` — čeká na první reálnou krávu, co by na tom stála, ne na dnešní rozhodnutí |
| P1-2 | `EvidenceCandidate` je caller-supplied (`tenantId`/`producerId`/`buildHash` atd.) — komentář v `evidence.ts` to přiznává, ale žádný `TrustedContext`-vázaný `EvidenceWriter` mezi COW a `EvidenceLedger.append()` ještě neexistuje | **Potvrzeno, odloženo** | Přesně dnešní hranice důvěry (stejná jako `Audit.append()`) — potřebuje reálnou COW, co by na tom stála, k návrhu `EvidenceWriter` rozhraní, ne teoretický návrh předem |
| P1-3 | `verify()` má jediný `publicKey`/`keyId` — rotace platformního klíče by odmítla starou evidenci | **Potvrzeno, odloženo** | Návrh `EvidenceKeyRing` (aktivní klíč + historie ověřovacích klíčů) — čeká na první skutečnou rotaci, ne na spekulativní implementaci |
| P1-4 | `checkEffectFieldValidators()` důvěřuje `validation.status` v payloadu — po Žlabu je to "starý trust model" | **Z, už zapsáno** | Přesně Posudek 14 bod 5 / dnešní `### BC Executor musí být „hloupý"` P0 poznámka — beze změny, potvrzuje už rozhodnuté |
| P1-5 | `ExecutorHost`'s `policyFor`/durable `idempotency` jsou optional — chybějící constructor parametr znamená tichý no-op, ne startup fail | **Potvrzeno, NEOPRAVENO dnes** | Sahá do `ExecutorHost`'s konstruktoru, který používají **živé** `apf-document-host`/`apf-email-executor` — změna na "startup fail bez policy" by mohla shodit farmu, pokud by nějaké volací místo na `policyFor` zapomnělo. Vyžaduje audit všech volajících míst před změnou, ne jednostrannou úpravu — vlastníkovo rozhodnutí, kdy na to dojde |
| P1-6 | `Router.register()` nehlásí explicitní fail na duplicitní `(capability, version)` registraci — `route()` vezme první nalezenou | **Potvrzeno, NEOPRAVENO dnes** | Stejný důvod jako P1-5 — `Router.ts` je živý kód, změna chování při registraci by se měla nejdřív ověřit proti `farm:check`/skutečným instalacím, ne slepě přidat |
| P1-7 | `Router.seen` (nezakryté pole se všemi `DispatchEnvelope`) roste bez limitu v dlouho běžícím procesu | **Potvrzeno, NEOPRAVENO dnes** | Používá ho víc testů (`SEC-INJ-001` aj.) jako testovací instrumentace — přesun do samostatného test adapteru je větší refaktor, ne bodová oprava |

**Verdikt vlastníka:** 8,9/10 dnes, ~9,15–9,25 po opravě obou P0 (**hotovo ve stejný den**),
~9,4–9,5 po Žlab durabilitě + `EvidenceWriter` + zbytku P1, ~9,6–9,7 po Office/Ponocném/
compromised-farmer E2E. Žádné skóre 10/10 ani pak — "u systému, který jednou může zapisovat účetní
data několika nezávislým firmám, je zdravější předpokládat, že další chyba ještě existuje."

### Co posudek nezměnil

Kód dnes: `src/platform/aggregator.ts` (oba P0), `tests/dojicka.test.ts` (+6 testů: DOJ-010/011/012,
každý se dvěma variantami), `tests/konev.test.ts` (aktualizováno na nové povinné `fieldHashes`).
386/386 testů, typecheck, arch, farm:check zelené. P1-5/6/7 vědomě neopraveny — sahají do živého
`ExecutorHost`/`Router`, čekají na vlastníkovo rozhodnutí, ne na dnešní jednostrannou úpravu.
