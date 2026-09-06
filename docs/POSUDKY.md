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
