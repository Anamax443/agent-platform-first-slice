# MEASUREMENT — co norma stála a co zachytila

Jediná metrika, která rozhodne o hodnotě normy (`agent-platform-foundation`, část XVI.4):

> Kolik práce navíc norma vytvořila, a kolikrát test zachránil chybu dřív, než by ji našel provoz.

K tomu lean pohled (dotaz vlastníka 6. 9. 2026): rozlišovat čas přidávající hodnotu od plýtvání, a plýtvání pojmenovat kategorií, ne pocitem.

## Pravidla měření

- Zapisuje se po každém milníku XII.G (M1 descriptor a kontrakty, M2 conformance balíček, M3 testy podle profilů, M4 druhý tok, M5 evidence, M6 balíček kontraktů).
- **Čas je AI-asistovaný wall-clock**, ne hodiny solo operátora. Limit 40 hodin na MUST sadu (VC §7) je limit na lidskou práci; proto se zvlášť zapisuje **čas vlastníka** (čtení, review, rozhodnutí). Bez toho by měření lhalo.
- Každý nález zachycený testem se zapíše s Test ID a s tím, kde by se jinak projevil (provoz, review, nikdy).
- WIP limit: **jeden řez najednou.** Druhý tok začne až po uzavření M3 prvního.

## Lean kategorie plýtvání (muda), jak je tu chápeme

| Kategorie | Co to tady znamená |
|---|---|
| nadvýroba | kód nebo test, který žádný scénář ani Test ID nevyžaduje |
| zásoba | dokumentace a fixtures, které nikdo nečte ani nespouští |
| čekání | blokováno na rozhodnutí vlastníka nebo na externí systém |
| nadměrné zpracování | boilerplate, který norma vyžaduje bez doložené hodnoty (kandidát na generátor) |
| vady | chyba nalezená později, než mohla být (test existoval, ale neběžel; test chyběl) |
| pohyb | přepínání kontextu mezi repozitáři a dokumenty |
| přeprava | ruční kopírování dat mezi kontrakty, descriptory a testy (kandidát na generování) |

## Záznamy

| Milník | Datum | Wall-clock AI | Čas vlastníka | Řádků (+) | Z toho kontrakt / descriptor / testy / boilerplate / business | Nálezy zachycené testem | Plýtvání (kategorie, minuty) |
|---|---|---|---|---|---|---|---|
| M0 kostra repa | 2026-09-06 | | | | | | |

## Nálezy zachycené testem

| # | Test ID | Co zachytil | Kde by se jinak projevilo | Milník |
|---|---|---|---|---|
| | | | | |

## Co bylo nutné obejít nebo co chybělo

| # | Co | Norma říká | Realita | Návrh pro normu (jen s evidencí odsud) |
|---|---|---|---|---|
| | | | | |
