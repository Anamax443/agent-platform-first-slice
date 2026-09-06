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
- Otevřené položky pro vlastníka: čas vlastníka za M1–M4, adresy pro farmu (`apf.maxferit.cz`, `apf-intake@`, `apf-notify@`), skutečná schránka za `ops-mailbox`.

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

## Souhrn po čtyřech posudcích

Shoda všech čtyř: norma nevyvrácena, testy chytají konstrukční chyby, reuse doložen. Jediný MAJOR (fyzická izolace) je plánovaný na M4b. Tři MINOR (AI-EVAL, čas vlastníka, provozní realita) jsou důsledkem lokální první iterace. Nic z posudků nevede k otevření rc3 normy; vše jde do části XVII jako evidence.
