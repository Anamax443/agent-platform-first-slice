# Podklad pro oponenturu — bezpečnost a stabilita

**Vznikl:** 2026-09-08, sestaven čtením aktuálního kódu (ne opsáním starší dokumentace). Každé
tvrzení níže je vázané na konkrétní `soubor:řádek` a bylo ověřeno k tomuto datu — kde se to liší
od toho, co říká `HANDOFF.md`/`SEVERKA.md`/`MEASUREMENT.md`, je to vyznačené.

**Rozsah:** jen bezpečnost a stabilita provozu. Nejde o celkové skóre projektu (to dává
`POSUDKY.md` po skutečné oponentuře) — je to briefing pro toho, kdo oponenturu dělá, aby věděl,
kam se dívat a co je už ověřené.

**Baseline k 2026-09-08:** `npm test` 232/232 zelených, `npm run arch` OK, `npm run farm:check`
(10 configů: `farm-bass443` + `local-fakes` × 5 deployables) OK. Nasazeno živě na
`farm-bass443` (`apf.maxferit.cz`), včetně cronu pro dávkový příjem z R2 inboxu.

---

## 1. Nejzávažnější zjištění: na živé farmě dnes neexistuje funkční cesta k rozhodnutí o Human Review

Tohle je přísnější zjištění, než co dnes tvrdí `SEVERKA.md` a `HANDOFF.md` — oba popisují riziko
jako „`ReviewService.tasks` je jen paměťová `Map`, po evikci hrozí `APPROVAL_MISMATCH`". Realita
po přečtení `deploy/cloudflare/apf-gateway/src/index.ts` je horší:

- `ReviewService` (`src/platform/review.ts:58`, `private readonly tasks = new Map(...)`) se na
  farmě vytváří **znovu, s prázdnou mapou, při každém volání `orchestratorFor()`**
  (`apf-gateway/src/index.ts:316-326`, `review: new ReviewService(this.clock, this.audit)`).
- `orchestratorFor()` má **jediné volací místo** v celém `apf-gateway/src/index.ts` — řádek 236,
  uvnitř spuštění nového workflow (`startIntake`). Žádné jiné místo v nasazeném kódu si na tu
  instanci `ReviewService` nesahá.
- V celém `deploy/cloudflare/` **neexistuje žádný `/review` HTTP handler ani jediné volání
  `.decide(`** (ověřeno gruntem přes `grep -rn "\.decide(\|/review" deploy/cloudflare/**/*.ts`
  — jediný zásah je import na řádku 23 a instanciace na řádku 321). Stránka `/farm` a
  `/workflow/:id` (`page.ts:410`) review task jen **zobrazí** (`čeká: … <reviewTaskId>`), nedá se
  přes ně rozhodnout.
- V testech (`tests/wf.test.ts`, `tests/mail.test.ts`) `slice.review.decide(...)` funguje
  spolehlivě — ale tam `createSlice()` (`src/slice.ts:165`) vytvoří **jeden** `ReviewService` pro
  celou dobu života slice/testu, takže `create()` a `decide()` v jednom testu sdílí stejnou mapu.
  Testovací prostředí tedy tuhle mezeru nemůže odhalit — je to rozdíl mezi topologií testu a
  topologií nasazeného Workeru, ne rozdíl v logice `ReviewService`.

**Praktický důsledek:** jakákoli instance na farmě, která dnes doběhne do `WAITING(REVIEW)`,
zůstane takhle **natrvalo** — není cesta, jak ji přes běžící systém posunout dál. Jediná dostupná
akce je `/workflow/:id/purge` (smazat instanci). Human Review je dnes na farmě efektivně
**write-only přes journal, read-only přes stránku, bez decision cesty** — ne „durabilita, co
selže při evikci", ale „decision cesta, která na nasazeném Workeru neexistuje vůbec".

**Pro oponenturu:** je tohle blokující pro cokoli, co má na farmě reálně skončit v review (dnes
nic — žádná capability na farmě review nevyžaduje), nebo je to čistě dluh, který se musí dořešit
**předtím**, než se review na farmě poprvé použije? `SEVERKA.md` ho už řadí jako položku #1
(„Durable Review") přesně proto, že jde o existující chybu, ne aspiraci — tohle zjištění jen
zpřesňuje, o jak vážnou chybu jde.

---

## 2. Druhý signál klasifikace (W4) — částečně opraveno 7. 9. 2026, zbytek mezery bez testu

`MEASUREMENT.md` W4 popisuje `crossCheck` (`document-validator/handler.ts:64-69`,
implementace `classifyByRules` v `src/adapters/llm.ts:11-18`) jako druhý, deterministický signál
proti tomu, že LLM klasifikaci ovlivní injected instrukce. W4 sám přiznává mez: „signál je
heuristika a sdílí vstupní text s modelem; instrukce, která nevypadá jako instrukce, projde
oběma."

**Aktualizace k 8. 9. 2026:** commit `0fd3361` (7. 9. 2026 23:19) tohle už částečně opravil.
Předchozí verze tohohle dokumentu popisovala substring bug jako dosud neopravený — v mezidobí
(mezi tím, co jsem to psal, a touhle kontrolou) přibyl na jiném stroji fix přesně na tenhle nález:

- `llm.ts:15` je teď `/(faktura|invoice|iban|dič|\bdph\b|variabilní symbol)/` — jen `dph` dostalo
  hranici slova. Ověřeno v Node: `celkembezdph: 1200` už nesouhlasí, `sazba dph 21%` pořád ano —
  fix funguje a nekolidoval s diakritikou, protože `dph` je čistě ASCII (na rozdíl od `dič`, kde
  by naivní `\b` selhalo — `/\bdič\b/.test("dič: 12345")` vrací `false`, protože JS `\w`/`\b` je
  jen ASCII a `č` se pro hranici slova nepočítá; **tenhle problém pro zbylá slova pořád existuje,
  proto commit dal `\b` jen ke `dph`, ne plošně**).
- **Zbytek keywordů (`faktura`, `invoice`, `iban`, `dič`, `variabilní symbol`, a v CONTRACT větvi
  `smlouva`/`contract`/`smluvní strany`/`agreement`) zůstává substring match bez hranice.** Pole
  jako `dičSubjektu` nebo `ibanPrijemce` by dnes pořád nechtěně spustilo klasifikaci.
- **Pořád nula testů** na `classifyByRules`/`crossCheck`/`CLASSIFICATION_DISPUTED`
  (`grep -rn "classifyByRules\|CLASSIFICATION_DISPUTED\|crossCheck" tests/` nic nenajde) — commit
  `0fd3361` opravil kód, ale nepřidal regresní test (ani unit, ani conformance fixture), takže
  se to samé může vrátit příští úpravou beze zjištění.

**Pro oponenturu:** (a) stojí zbylých šest keywordů za plošnou Unicode-aware opravu (viz bod výš
— prostý `\b` na `dič`/`smluvní strany` by je naopak přestal detekovat vůbec), a (b) přidat aspoň
jeden regresní test/fixture, ať se stejná třída chyby nevrátí tiše.

*(Poznámka k procesu: dvě nezávislé externí AI recenze nad touto oblastí dřív tvrdily, že celá
mezera je už opravená přes `\bdph\b` — v okamžiku, kdy to psaly, to nepravda byla (ověřeno
v kódu); commit, který `dph` skutečně opravil, přišel až později týž den. Ukazuje to, že i
„recenze nad dokumentací" dokáže trefit správný směr a přitom si datum/stav vymyslet — pro
oponenturu je směrodatný kód a jeho historie, ne cizí shrnutí.)*

---

## 3. Idempotence a durabilita write executorů (W19, W20 v MEASUREMENT.md)

- `ExecutorHost.idempotency` je jen `Map` v paměti procesu (`executor-host.ts:50`).
  Interní klíč je dnes správně `capability + idempotencyKey` — ověřeno přímo: metoda
  `dedupKey(capability, idempotencyKey)` na řádku 56, použitá při čtení i zápisu (řádky 82, 99,
  156–159, 188–189) — W19 vyřešeno 6. 9. 2026, test `IDM-HOST-SCOPE-001`. (Oprava k předchozí
  verzi tohohle dokumentu: citace `executor-host.ts:48,148` z `MEASUREMENT.md` je zastaralá,
  řádek 148 dnes patří ke `COMMAND_EXPIRED`, ne k idempotenci — kód se od zápisu v MEASUREMENT
  posunul.) To ale řeší jen kolizi mezi capabilitami sdílejícími hosta, ne
  hlubší identitu `tenantId + handlerId + requestFingerprint` + `IDEMPOTENCY_CONFLICT`, která
  zůstává otevřená (Posudek 5/6 v `POSUDKY.md`).
- Na farmě je `apf-document-host` samostatný Worker; mezi dvěma požadavky téměř jistě běží jiný
  isolát, takže ta paměťová mapa **prakticky nededukuje nic** (W20). Jediná skutečná durabilita
  je `reconcile()`, který se ptá vnějšího systému (DMS) — ověřeno jen na `FakeDmsAdapter`
  (`RES-CRASH-001`), ne na skutečném DMS.
- Dnešní stav je pro `document.stamp`/`document.archive` snesitelný (idempotentní zápis, DMS
  dedupuje podle `clientRef`). Přestává být snesitelný v okamžiku, kdy přibude cokoli jako
  `ERP.write` nebo `bank.payment.prepare` — tam „doufáme, že provider deduplikuje" nestačí.

**Pro oponenturu:** priorita durable effect ledgeru vzhledem k tomu, co se plánuje přidat příští
(`SEVERKA.md` řadí ho jako #2, hned po Human Review).

---

## 4. Podpisový klíč a jeho rotace (SEC-CRED) — funkční, ověřené testy

`KeyRegistry`/`verifyBinding` (`src/platform/signing.ts`) implementuje grace period správně:
klíč retirovaný v `validUntil` je akceptovaný ještě `graceMs` (výchozí 30 min, `PT30M` podle
nejdelšího `deadlinePolicy` capability za příjemcem) po skončení platnosti, pak odmítnut
(`SEC-CRED-002`, `SEC-CRED-003`, oba v `tests/sec.test.ts`, zelené). `W5` v MEASUREMENT
upozorňuje, že tohle maximum určuje policy příjemce, ne descriptor — správně zdokumentováno,
žádná nová mezera nenalezena.

Neověřeno v týhle revizi: jestli `KeyRegistry` na farmě žije v paměti Durable Objectu stejným
způsobem jako `ReviewService` (bod 1) — pokud ano, rotace klíče by po evikci mohla zapomenout
retired klíč uvnitř grace okna. Nižší riziko než bod 1 (rotace je řídká, manuální operace, ne
něco, na čem visí každý dokument), ale stojí za rychlou kontrolu.

---

## 5. Tenant izolace — oprava rámce, ne bezpečnostní mezera

`SEVERKA.md` až donedávna popisovala „živý bug": `tenant-7` se prý nedostane do intake kvůli
jedinému globálnímu `roles.orchestrator`. `NAVRHOVY-LIST-farma.md` ale říká, že `farm-bass443` je
záměrně `CLOUD_SINGLE_TENANT` a `tenant-7` je jen protistrana bezpečnostních testů
(`SEC-CTX-002` atd.), ne živý zákazník — potvrzeno i v `HANDOFF.md:168`. Opravil jsem tenhle
rámec přímo v `SEVERKA.md` (dnešní úprava). Pro oponenturu: nejde o bezpečnostní riziko dnes,
ale o mezeru, která se stane rizikem v okamžiku, kdy přibude druhý reálný tenant bez toho, aby
předtím vzniklo skutečné tenant resolution.

---

## 6. Mail/Email COW — skeleton, dopad na stabilitu je „neúplnost", ne „chyba"

Ověřeno přímo: `apf-email-executor` (`index.ts:18-20`) a `apf-mail-ingest` (`index.ts:17-22`) na
`/version` hlásí `wired: false` a na jakýkoli jiný požadavek `501 NOT_WIRED`; příchozí mail
`apf-mail-ingest` explicitně odmítá (`setReject("apf-mail-ingest is not wired yet")`). Nejde o
runtime chybu — je to nedokončená větev, farma to sama transparentně hlásí (i na stránce `/farm`,
`workerStateLabel()` v `page.ts:182-186` to ukáže jako „NEZAPOJENO", ne jako „OK"). Riziko je
čistě v tom, že dokud tahle větev neproběhne živě, `document-host` zůstává jediným důkazem, že
vzdálený COW-přes-Worker vzor vůbec funguje za reálného provozu (evikce, síť, retry).

---

## 7. Audit relay mezi Workery (W23) — nalezeno živě, opraveno a otestováno

Pro kontrast s bodem 1: tohle je příklad, jak má vypadat nález → oprava → test. 7. 9. 2026 na
`farm-bass443` tři audit eventy pro `document.stamp` doběhly lokálně na `apf-document-host`, ale
`POST .../audit` na gateway skončil `Canceled` — `ctx.waitUntil` bez čekání na výsledek, isolát
recyklovaný dřív, než HTTP volání doběhlo (ověřeno `wrangler tail` na obou Workerech současně,
skutečná JSON instance s prázdným `audit[]`, ne odvozeno). Oprava: `RelayAudit.flush()`
(`apf-document-host/src/relay-audit.ts`) eviduje pending relaye a `/dispatch` handler na ně čeká
(`await audit.flush()`) těsně před vrácením odpovědi, v obou větvích. Test `DH-AUDIT-RELAY-001`
(`tests/dh.test.ts`) dokazuje na fake `Fetcher`, že `flush()` skutečně nevrátí řízení, dokud
relaye nedoběhnou.

---

## 8. Testovací pokrytí — co neběží a proč (W9)

Zaregistrované, ale neběžící Test ID: `EVD-006`, `AI-EVAL-*`, `SEC-CRED-001`, `SEC-TOOL-001`,
`TEN-*`, `CDC-*`, `WF-VER-002..004`, `WF-COMP-001`, `RES-STOR-002`, `RES-QUEUE-001`,
`COMP-DOWN-001`, `SEC-SEM-001`. Důvody jsou různé a zdokumentované (profil je neaktivuje, řez
nemá mechanismus — migrace, fronta, credential expiry — nebo je potřeba reálný model). Není tu
žádná automatická kontrola `derivedProfiles == executedProfiles`; seznam je dnes ručně udržovaný.
Pro bezpečnost/stabilitu nejrelevantnější mezery z týhle skupiny: `AI-EVAL-*` (žádná golden sada
pro kontinuální měření kvality modelu) a `SEC-CRED-001`.

---

## 9. Prioritizovaná doporučení pro tuhle oponenturu

1. **Bod 1 (Human Review decision cesta na farmě)** — potvrdit/vyvrátit závažnost, rozhodnout,
   jestli je to blokující pro cokoli plánované příště, nebo počká na `SEVERKA.md` pořadí (#1).
2. **Bod 2 (crossCheck substring bez hranice slova)** — `dph` opraveno 7. 9. 2026, zbylých šest
   keywordů ne; potvrdit prioritu plošné opravy + přidat aspoň jeden regresní test (dnes žádný).
3. **Bod 3 (idempotency ledger)** — souhlas s pořadím „vyřešit před první write capability mimo
   document/mail rodinu" (ERP, platby apod.).
4. **Bod 4 (KeyRegistry durabilita na DO)** — rychlá kontrola, jestli sdílí stejný vzor jako bod 1.
5. Zbytek (body 5–8) je spíš kontext než otevřené riziko — stačí potvrdit, že rámec sedí.

---

*Tenhle dokument je snímek k 2026-09-08, ne živý dokument — na rozdíl od `SEVERKA.md` se
nepřepisuje. Až oponentura proběhne, její verdikt a dispozice patří jako nový záznam do
`POSUDKY.md`, ne sem.*
