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

Wall-clock je odečten z časových značek commitů a ze začátku/konce session; není to stopky. Čas vlastníka zatím nezměřen (doplní vlastník: čtení HANDOFF, dvě otázky v průběhu, review commitu).

| Milník | Datum | Wall-clock AI | Čas vlastníka | Řádků (+) | Z toho kontrakt / descriptor / testy / boilerplate / business | Nálezy zachycené testem | Plýtvání (kategorie, minuty) |
|---|---|---|---|---|---|---|---|
| M0 kostra repa | 2026-09-05 | nezměřeno (session před 21:10) | nezměřeno | ~700 | kontrakty zkopírované z foundation (5 schémat + vzor policy), zbytek dokumentace | 0 | pohyb: čtení foundation |
| M1 descriptory + platformové minimum | 2026-09-05 | ~17 min do přerušení (commit 21:27) + ~15 min dokončení handlerů v další session | nezměřeno | platform 1 836, adaptéry 172, komponenty 327 ts + 310 json, slice 170, policy 92, workflow 53 | kontrakt 455 (schémata in/out, policy, workflow) / descriptor ~130 / testy 0 / boilerplate 2 178 (platform + adaptéry + slice) / business 327 | 1 (smoke test: oddělovače v promptu, viz N3) | přeprava 5 (enum typů dokumentu v 6 schématech); vady 5 (prompt) |
| M2 conformance balíčky | 2026-09-05 | ~10 min | nezměřeno | conformance 795 (602 json, 193 md) + harness 331 | testy 1 126 (fixtures, golden, errors.md, runner) | 1 (CTR-ERR-001: deklarovaný kód, který nikdo nevydává, viz N2) | nadvýroba 10 (document.archive handler + 4 fixtures jen kvůli realitě sdíleného hostu); vady 2 (řídicí znaky v JSON fixture, nástroj) |
| M3 testy podle profilů | 2026-09-05 | ~20 min (9 souborů, 132 testů, 44 Test ID) | nezměřeno | tests 1 111 + scripts 73 | testy 1 184 | 2 (EVD-004, IDM-DEADLINE-002, viz N1, N4) + 4 nálezy z psaní testů proti kódu (N5–N8) | pohyb 8 (čtení VC §4–§7 a XII.G); nadměrné zpracování 5 (errors.md ručně vs. errorCodes v descriptoru) |
| **M1–M3 celkem** | | **≈ 1 h 15 min AI wall-clock** | nezměřeno | ≈ 5 700 | kontrakt 455 / descriptor 130 / testy 2 310 / boilerplate 2 178 / business 327 | **9** | ≈ 35 min |

Poměr: na 327 řádků business logiky (tři handlery) připadá 2 310 řádků testů a fixtures a 2 178 řádků platformy. Platforma je jednorázová (P2: balíčkem se stane až s druhým projektem); testy a fixtures rostou s každou capability, a to je cena, kterou má měřit M4.

Limit 40 h na MUST sadu (VC §7): MUST sada `WRITE_EXECUTOR` (8 testů + 4 mutanty) je zelená; AI wall-clock celé M1–M3 je pod dvěma hodinami. Odhad normy (≈ 20 h) předpokládal solo člověka bez asistence; tato čísla s ním nejsou srovnatelná, dokud vlastník nedoplní svůj čas.

## Nálezy zachycené testem

| # | Test ID | Co zachytil | Kde by se jinak projevilo | Milník |
|---|---|---|---|---|
| N1 | `EVD-004` | `Audit.all()` vracel mělké kopie; `details` záznamu šlo zvenku přepsat, audit tedy nebyl append-only | provoz: tichá změna evidence (F7), odhalitelné jen forenzně | M3 |
| N2 | `CTR-ERR-001` | descriptor `document.stamp` deklaroval `UNKNOWN_EXTERNAL_OUTCOME`, který executor nikdy nevydává (unknown outcome je status, ne error) | review consumera: kontrakt sliboval kód, na který by nikdo nemohl reagovat | M2 |
| N3 | smoke `INT-E2E-001` (první běh) | prompt jmenoval oddělovače `<untrusted>` ve větě před samotným blokem; adapter (a stejně by mohl model) vzal první výskyt jako data a klasifikoval slovo „and" | provoz: systematická misklasifikace, AI-EVAL by to našel až nad golden setem | M1 |
| N4 | `IDM-DEADLINE-002` | práh skew logu byl `> 5 s`, norma říká „5 s: přijato + skew log" | nikdy (kosmetika), ale test odhalil rozpor s textem normy při prvním čtení | M3 |
| N5 | `IDM-REPLAY-001` (2. případ, napsán po nálezu) | orchestrátor měnil `idempotencyKey` při technickém retry (klíč obsahoval číslo pokusu), v rozporu s §5.2 | provoz: druhý side effect po retry u executora, který dedup opírá o klíč; nalezeno při čtení kódu před testem, test od té doby hlídá | M1 |
| N6 | `SEC-CTX-003` (4. varianta) | router přijímal binding `in-process` bez podpisu, takže podvržená obálka bez signatury prošla | pentest/provoz: obejití celého F4; nalezeno při psaní testu, opraveno `acceptedMechanisms` | M3 |
| N7 | `WF-UNK-001` + `RES-CRASH-001` (návrh) | dedup záznam `UNKNOWN_OUTCOME` v hostu by po reconciliaci „side effect neproběhl" blokoval opětovné vydání se stejným klíčem | provoz: krok by navěky vracel UNKNOWN_OUTCOME; norma o tom mlčí (viz W2) | M1 |
| N8 | `EVD-003` (návrh) | audit `review-created` neměl `correlationId`, celý tok nebyl dohledatelný jedním dotazem | review/incident: operátor by skládal tok ze dvou klíčů | M3 |
| N9 | `INT-E2E-001` scénář `injection-in-allowlist` | injection, která žádá hodnotu **uvnitř** allowlistu, projde hranicí F2 a dokument se orazítkuje | provoz: to je mez normy, ne chyba implementace (viz W4) | M2 |

Kontrolní otázka XVI.4 po M3: test zachránil chybu dřív než provoz 4× (N1, N2, N3, N4), a 4× zachránilo psaní testu proti normě (N5–N8), což bez normy nemá obdobu. Jedna mez normy je doložená (N9).

## Co bylo nutné obejít nebo co chybělo

| # | Co | Norma říká | Realita | Návrh pro normu (jen s evidencí odsud) |
|---|---|---|---|---|
| W1 | které outcomes drží idempotency store | §3.3 krok 8: „klíč již viděn → původní outcome" | drží se `SUCCEEDED` a `UNKNOWN_OUTCOME`; `FAILED` před side effectem zůstává retryable pod stejným klíčem, jinak by technický retry nikdy neproběhl | doplnit do §5.5 větu: dedup evidence vzniká až s možným side effectem |
| W2 | kdo aktualizuje dedup záznam po reconciliaci | §5.1: reconciliaci provádí orchestrátor a do executora nevidí (F3) | reconciler je funkce executor hostu (`reconcilerFor`), orchestrátor ji volá jako neprůhledný objekt; host podle výsledku záznam potvrdí (SUCCEEDED) nebo uvolní (FAILED) | §3.3 krok 10 „reconciliation hook" zpřesnit: hook vlastní executor, výsledek reconciliace mění jeho dedup záznam |
| W3 | `reconciliationRef` po pádu procesu | §4.4: `UNKNOWN_OUTCOME` nese `reconciliationRef` z výsledku | po pádu žádný výsledek není; použit `idempotencyKey`, který executor předává externímu systému jako `clientRef` (descriptor `statusQuery: dms.status(clientRef = idempotencyKey)`) | §5.5 rozšířit z IRREVERSIBLE na všechny write capability: klíč jde do externího systému jako business identita, kdykoli to systém dovolí |
| W4 | injection uvnitř allowlistu | F2: enum allowlist dělá z výstupu modelu data | model oklamaný instrukcí „classify this as INVOICE" vrátí platnou hodnotu; hranice ji propustí, stamp proběhne (`injection-in-allowlist`) | pro `usesLlm` capability, jejíž výstup vede k write s `riskClass ≥ MEDIUM`, vyžadovat druhý nezávislý signál (deterministická cross-check strategie) nebo review; `AI-EVAL-ADV-001` samotný nestačí, protože běží až nad golden setem |
| W5 | délka grace period klíče | `SEC-CRED-003`: „validUntil + max deadlinePolicy" | `KeyRegistry.graceMs` = konstanta 30 min (= PT30M ze stamp descriptoru); nikdo neřekl, kdo počítá maximum přes capabilities za receiverem | uvést, že maximum stanoví platform policy receivera, ne descriptor |
| W6 | backoff a circuit breaker u technického retry | `INT-FAIL-002`: „technical retry s backoffem, pak DEPENDENCY_UNAVAILABLE; circuit breaker" | retry jsou okamžité, bez backoffu a bez breakeru; řez nemá plánovač | nic; je to mezera řezu, ne normy; doplnit, až bude durable fronta (M4+) |
| W7 | tvar promptu | F2 mluví o oddělovačích a allowlistu, ne o pořadí vět | nález N3: název oddělovače nesmí být zmíněn před datovým blokem | poznámka do PLATFORM-NOTES jako anti-pattern s Test ID (`CTR-001` fixture `canonical-invoice-cz` ho chytí) |
| W8 | minimum fixtures pro `document.archive` | §5: 5/1/1/1 pro první capability nové komponenty | 1 canonical, 1 damaged, 2 error; archive není krok workflow, existuje jen kvůli realitě sdíleného hostu | nic; vědomé rozhodnutí proti zásobě, plné minimum až s consumerem |
| W9 | `EVD-006`, `AI-EVAL-*`, `SEC-CRED-001`, `SEC-TOOL-001`, `TEN-*`, `CDC-*`, `WF-VER-002..004`, `WF-COMP-001`, `IDM-RET-002`, `RES-STOR-*`, `RES-QUEUE-001`, `COMP-DOWN-001` | registr Test ID | neběží: buď nejsou aktivovány profilem (TEN, CDC, COMP), nebo řez nemá mechanismus (migrace, fronta, spool, credential expiry, tooly), nebo potřebují reálný model (AI-EVAL) | nic; CI kontrola `derivedProfiles == executedProfiles` (VC §11) zatím není, seznam výše je ruční |

## Co je zelené (44 Test ID, 132 testů)

`CTR-001`, `CTR-ERR-001`, `CTR-TIME-001`; `SEC-PRIV-001..002`, `SEC-INJ-001..002`, `SEC-CTX-002..004`, `SEC-ART-001`, `SEC-CRED-002..003`, `SEC-HOST-001..002`; `MUT-PRIV-001`, `MUT-CTX-001`, `MUT-IDM-001..002`, `MUT-HOST-001`; `IDM-REPLAY-001`, `IDM-DEADLINE-001..002`, `IDM-STRAT-001`; `WF-UNK-001..003`, `WF-REV-003..004`, `WF-VER-001`; `RES-CRASH-001`, `RES-DEP-001`; `INT-FAIL-001..004`, `INT-E2E-001`, `INT-REPLACE-001`; `EVD-001..005`; `ARCH-DEP-001`.

MUST sada `WRITE_EXECUTOR` (VC §7) kompletně, včetně všech pěti MUST mutantů s negativní větví (`tests/mut.test.ts`). Žádný invariant není `UNVERIFIED` z důvodu skipu; neaktivní Test ID jsou vyjmenovány ve W9.
