# SEVERKA — dlouhodobá vize centrálního bloku

Na rozdíl od `HANDOFF.md` (append-only technický deník, co se skutečně stalo) a
`NAVRHOVY-LIST-farma.md` (uzavíratelný plán pro konkrétní M4b řez) je tohle **živý dokument**:
kam centrální blok míří dlouhodobě, aktualizuje se přepisem, ne přidáváním záznamů. Účel: aby
se aspirační nápady nezaváděly rovnou do backlogu (a nebobtnal) ani neztrácely v historii
konverzací.

Vznikl z diskuze vlastníka s týmem 2026-09-07. Nejde o rozhodnuté zadání — je to sdílený obraz
cíle, proti kterému se dá poměřit každý další krok.

---

## Cílový tvar

```
Inputs → Core Orchestrator → Planner → Registry → Policy/Risk → Agents → Review → Audit/Memory/Scheduler → Output
```

Definice „hotovo": nový agent jde přidat stylem **manifest + connector + testy + aktivace**, a
centrální blok ho začne používat **bez zásahu do core**. Počet agentů může růst donekonečna, aniž
se přepisuje orchestrátor.

---

## Vrstvy

| Vrstva | Stav dnes | Co to vlastně je | Riziko |
|---|---|---|---|
| **Agent Registry** | **oba kroky hotové (9. 9. 2026):** `src/platform/registry.ts` (`capabilityNamesOf()`, `catalogEntry()`, `catalogOf()`) + `Router.catalog()` — `platform-wiring.ts`'s dřív ručně duplikovaná pole (`GATEWAY_CAPABILITIES`/`DOCUMENT_HOST_CAPABILITIES`/`EMAIL_EXECUTOR_CAPABILITIES`) odvozená přímo z `descriptor.json`; `GET /capabilities` teď na všech třech providerech (`apf-gateway`/`apf-document-host`/`apf-email-executor`) — descriptor's vlastní deklarovaný `endpoints.capabilities`, dřív nikde neimplementovaný (`tests/reg.test.ts`, REG-001..005). Chybí: napojení do `/farm`'s Kravičky panelu (dnes pořád čte `/version`'s prostý seznam, ne bohatý `/capabilities` katalog), health/cena/`lifecycleStatus` pole (vyžaduje rozšíření zmrazeného `module-descriptor.v1.schema.json`, mimo proces) | formalizace toho, co už komponenty nesou v `descriptor.json` (capabilities, vstup/výstup schema) + health/verze/cena | nízké — je to datová nadstavba nad existujícím vzorem |
| **Admission Gate (module lifecycle)** | **první krok hotový (9. 9. 2026), block-list → mandatorní allow-list (10. 9. 2026)** — `LifecycleRegistry` (`src/platform/lifecycle.ts`), `Router` ho vynucuje před `checkGrant()` (`MODULE_QUARANTINED`), **povinný** `config/<installation>/lifecycle.json` (`farm-bass443`/`local-fakes` mají explicitní `ACTIVE` pro všech 5 modulů), zapojeno na **všech** Routerech farmy (`apf-document-host`, `apf-email-executor`, gateway in-process pro classify/validate/mail.ingest — `apf-mail-ingest` vlastní Router nemá) (`docs/POSUDKY.md` Posudek 7, rozhovor o "koupi nových krav" 9. 9. 2026; externí oponentura 10. 9. 2026 označila `unknown → ACTIVE` za P0) | chybějící záznam v allow-listu = `QUARANTINED` (SEC-LCY-003), stejně jako explicitní karanténa — pořád jen dva stavy (`ACTIVE`/`QUARANTINED`), žádný automatický verification runner před prvním přidáním | nízké dnes (ruční, ale fail-closed). Zbývá: `NEW`/`TESTING`/`DEGRADED` stavy, automatický verification runner nad `verificationProfiles` z `module-descriptor.v1.schema.json` (ten už dnes deklaruje `riskClass`→`isolationClass` pravidla a `buildCommit`, jen je nic nevynucuje běhu), auto-quarantine na živém selhání |
| **Planner** | chybí | z požadavku (přirozený jazyk) sestaví plán z dostupných capabilities | **vysoké, pokud plán rovnou vykonává.** Musí místo toho **vyprodukovat `WorkflowDef`**, který projde stejnou fail-closed bránou (schema, Policy Engine, Human Review) jako dnešní ručně psaný workflow — generátor vstupu do přísného pipeline, ne nová cesta kolem něj |
| **Policy Engine + risk scoring** | částečně — `policy.ts` (`policyFor(installation.policies, capability, "1")`) existuje per-capability | rozšířit o rizikovou úroveň požadavku (nízké/střední/vysoké → auto/potvrzení/nikdy) | střední — navazuje na existující Human Review, není nová vrstva vedle ní |
| **Execution Engine** | existuje (`Router`, `ExecutorHost`, retry/review/journal) | — | **Opraveno 8. 9. 2026 (`b5b8be8`/`f29eb6f`), tenhle řádek byl zastaralý.** Hlubší identita `tenantId + handlerId + idempotencyKey` + fingerprint (`sha256(canonicalize(payload))`) → `IDEMPOTENCY_CONFLICT` je univerzální (`src/platform/executor-host.ts`, každý `ExecutorHost`). Durable effect ledger (`IdempotencyLedger` Durable Object, atomická `reserveOrGet`/`resolve`/`release`) ale zatím jen na `apf-document-host` — `apf-email-executor`'s `/dispatch` staví `ExecutorHost` bez `idempotency` volby, tedy s výchozím `InMemoryIdempotencyStore`, který se zahazuje s každým požadavkem (fresh `ExecutorHost` per `/dispatch`, žádná deduplikace napříč požadavky). Pro `SEND_MODE: "sandbox"` neškodí; **před `"live"` stojí za zvážení, jestli `email.send` (IRREVERSIBLE) nemá dostat stejnou durable ledger jako `document.stamp`, ne jen composite klíč** — otevřené, nezařazené do pořadí |
| **Human Review** | rozhodovací cesta existuje a je živě ověřená; časové expirace nasazené, alarm mechanismus živě ověřen | — | **Opraveno 8. 9. 2026 (`6dea224`, HANDOFF 50–52) a 9. 9. 2026 (`165fe38`, HANDOFF 66–67).** `SqliteReviewTaskStore` (Durable Object SQLite) drží úkoly durabilně, `POST /workflow/:id/review/decide` → `decideReview()` je nasazený a živě ověřený (`WAITING(REVIEW)` → decide → dokončená instance). WF-REV-003 (`orchestrator.applyReviewExpiries()`, `EXPIRE_TO_FAILED`/`EXPIRE_TO_CANCELLED`/`ESCALATE`/`CREATE_NEW_REVIEW`) je nasazené: každá `WorkflowInstance` si sama nastaví `ctx.storage.setAlarm()` na deadline vlastního otevřeného review úkolu (`rearmReviewAlarm()`). **Živě ověřeno (HANDOFF 67):** dočasnou izolovanou diagnostikou (mimo real journal/reviewStore) potvrzeno, že CF Durable Object alarm na `farm-bass443` skutečně vystřelí přesně v čas — kód pak vrácen, `git diff` prázdný. **Zbývá:** živé potvrzení celé byznys transakce (skutečný review úkol, co přirozeně expiruje a projde `applyReviewExpiries()`) — ověřená je zatím jen infrastrukturní vrstva (alarm → hook), ne plný běh přes reálnou `WorkflowDef` |
| **Tenant Layer** | koncepčně navrženo, nasazení záměrně single-tenant | `farm-bass443` je `CLOUD_SINGLE_TENANT` (viz `NAVRHOVY-LIST-farma.md`); `tenant-7` je jen protistrana bezpečnostních testů, ne živý zákazník. Foundation nese `tenants: string[]` + policy semantiku, ale skutečné tenant resolution (`TenantConfig { tenantId, assistant.displayName, orchestration.actorId }` místo jediného globálního `roles.orchestrator`) je budoucí capability, ne dnešní bug. **Vlastníkův nápad 2026-09-09:** zadavatel požadavku (dnes: "Zadání požadavku" na `/farm`) by se měl na začátku identifikovat — token vázaný na e-mail, ověřovací e-mail (magic-link styl), ne jen spoléhat na jediné CF Access přihlášení vlastníka. Navazuje přímo na MAJOR 2 (Posudek 7: Access identita se dnes jen věří z hlavičky, kryptograficky se neověřuje) — stejná mezera, dva úhly pohledu | nízké dnes (nic naostro na tom neběží) — vysoké, jakmile přibude druhý reálný tenant nebo veřejné zadávání požadavků a nikdo tenant/requester resolution nedodělal předem |
| **Connector Layer** | 1 z N hotový | `document-host` běží na farmě; `apf-mail-ingest` a `apf-email-executor` jsou na farmě doslova skeleton (`501 NOT_WIRED`, `email()` handler dělá `setReject`) | dokončení = zároveň první reálný **event-driven** case (mail přijde → spustí workflow), ne samostatná vzdálená vrstva |
| **Audit provenance (COW zero-trust)** | nalezeno externím posudkem 9. 9. 2026 (`docs/POSUDKY.md` Posudek 7, MAJOR 5), ověřeno v kódu, neopraveno | `POST /audit` (`apf-gateway/src/index.ts`) zapíše skoro celý `Partial<AuditRecord>` z requestu (jen `auditId`/`at` přepíše); `RelayAudit.append()` (`apf-document-host`/`apf-email-executor`) posílá kompletní záznam přes service binding, nic ho neváže na skutečný podepsaný dispatch. Audit musí být důvěryhodnější než komponenta, kterou audituje — dnes to platí jen proto, že žádný Worker v účtu není třetí strana | **nízké dnes** (jediné volající Workery jsou first-slice vlastní kód) — **vysoké před první třetí-stranovou COW** (Capability Marketplace), protože kompromitovaná COW by mohla vyrábět libovolné falešné audit záznamy pro cizí tenant/actor/capability. Řešení pravděpodobně: vázat `/audit` zápis na stejný Ed25519 dispatch podpis jako capability volání, ne na holou service-binding důvěru |
| **Event-driven provoz** | rozpracováno (`apf-mail-ingest` k tomu existuje) | „něco se stalo" spouští workflow samo, ne jen dotaz uživatele | — |
| **Scheduling / condition engine** | chybí | „zkontroluj za 3 dny", „každé ráno", „až přijde odpověď" | nižší riziko, přirozeně navazuje na event-driven |
| **Capability Marketplace** | chybí | Registry + samopopis (vstupy/výstupy/oprávnění/cena/limity/verze/health) tak, aby centrální blok neměl ručně zadrátované znalosti o agentovi | až bude reálně víc než 2–3 typy agentů — dřív to jen předbíhá potřebu |
| **Memory/context vrstva** | chybí | tenant preference, dlouhodobý kontext, návaznost na předchozí úkol | **nejcitlivější nová vrstva na seznamu.** Platforma razítkuje dokumenty a archivuje do DMS — paměť ovlivňující chování agenta potřebuje stejnou fail-closed disciplínu jako dnešní signing key. Tvrdé pravidlo: **paměť nikdy není totéž co oprávnění** — nesmí se stát vstupem do policy rozhodnutí |
| **Agent lifecycle management** | koncepčně zapsáno (HANDOFF first-slice #26 — admin konzole) | instalace, connector test jako gate, sandbox, schválení, aktivace, verze, rollback, deaktivace | — |
| **Observability/Audit** | existuje (D1 audit, append-only) | — | — |
| **Admin Console** | koncepčně zapsáno (HANDOFF #26), 0 % kódu | — | — |

---

## Positioning — co na tom projektu chránit

Nejcennější architektonická myšlenka není Erwin, není to konkrétní LLM a není to ani vlastní
Planner. Je to řetězec **AI navrhuje → deterministická vrstva autorizuje → úzký COW vykonává**:

```
LLM (návrh záměru) → Planner (WorkflowDef) → schema/Policy/Registry validace → Router
  → signed dispatch → COW s minimálním credential → side effect → Audit
```

Proti obecným agentním frameworkům (LangGraph, OpenAI Agents SDK, CrewAI, Microsoft Agent
Framework, Dify) prohráváme na durable workflow engine, HITL tooling, dynamický planner, agent
discovery a hlavně GUI/ekosystém — tam mají roky náskok a nemá smysl to dohánět stavbou
vlastního orchestration enginu. Vyhráváme tam, kde to většina z nich neřeší vůbec: **AI nemá
write credentials.** Positioning tedy není „další agent framework", ale **security-first
execution platform for enterprise AI agents** — a klidně jednou použít LangGraph/OpenAI SDK/jiný
framework *uvnitř* Planneru, nikdy jako náhradu security boundary kolem něj.

**COW = Capability-Oriented Worker** (ne „AI osobnost s kravičím jménem"): malý izolovaný
pracovní blok poskytující jednu nebo víc úzce souvisejících capabilities pod přesně definovaným
security kontraktem. Jeden deployable smí nést víc capabilities, pokud sdílí bezpečnostní hranici
(`apf-document-host` dnes právem nese `document.stamp` i `document.archive`) — Registry má tedy
registrovat capabilities *a jejich hostitele*, ne plochý seznam agentů.

**Cena je z principu nízká pro ne-AI capability.** Doménová verifikace proti registru (ARES,
Finanční správa), kalendář, e-mail, ERP zápis — nic z toho nepotřebuje LLM. Pravidlo: *AI jen
tam, kde deterministické zpracování nestačí.* Až přibude Agent Registry, patří do něj i
`provider`/`model`/`estimatedCost`/`maxCost`/`latencyClass`/`riskClass`/`requiresAI` — Planner pak
nerozhoduje jen „kdo to umí", ale „kdo to umí bezpečně, dostatečně kvalitně a nejlevněji"
(levný model pro většinu, silný model jen na nejasné případy, confidence-based eskalace na
human review — ne „pošli všechno nejdražšímu modelu").

---

## Připravované doménové COW (invoice.extract → cz.company.verify → cz.vat.verify → cz.insolvency.check)

Vzor „extrahuj → ověř proti autoritě → rozhodni" se má opakovat napříč doménami (faktura dnes,
kalendář/počasí/ERP později) — vždycky jako řetěz samostatných capabilities, nikdy jako jeden
agent, co dělá všechno:

- **`invoice.extract`** (AI) — z faktury vytáhne IČO, DIČ, bankovní účet, částku, měnu, položky.
  Zůstává čistě extrakce, žádné rozhodování o důvěryhodnosti protistrany. **Hotovo 11. 9. 2026**
  (HANDOFF 109) — pole podle VC §5: `companyId`, `bankAccount`, `totalWithVat`, `invoiceNumber`;
  DIČ/měna/položky vědomě mimo rozsah v1.
- **`cz.company.verify`** (deterministický, žádné AI) — IČO a základní údaje proti ARES.
  API zdroj ověřen 11. 9. 2026: `EkonomickeSubjektySluzba` (`GET
  https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}`) — bezplatné,
  oficiální (MF ČR). `Ico_T` je pevných 8 číslic, shoduje se s `invoice.extract`'s `companyId`
  validací beze změny. Klíčová pole: 404/`VYSTUP_SUBJEKT_NENALEZEN` = IČO neexistuje (business
  výsledek, ne technická chyba — stejně jako `OTHER` u `document.classify`), `datumZaniku` =
  subjekt zanikl i když "existuje", `seznamRegistraci.stavZdrojeRes`/`stavZdrojeVr` = per-registr
  aktivní/neaktivní stav.
- **`cz.vat.verify`** (deterministický, žádné AI) — stav plátce DPH a **zveřejněný bankovní účet
  u Finanční správy**. API zdroj ověřen 11. 9. 2026: SOAP webová služba MOJE daně
  (`https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP`, operace
  `getStatusNespolehlivySubjektRozsirenyV2` — nejúplnější, jediná neuzavřená verze), bezplatné,
  oficiální. **`zverejneneUcty` (zveřejněné bankovní účty) je přímý zdroj dat pro Import Gate's
  ACCOUNT_VERIFICATION** (viz `### Kontrola musí být svázaná s konkrétní hodnotou` níže) — účet na
  faktuře se ověřuje proti tomuhle, ne proti tvrzení dokumentu samotného. Tři stavy
  (`ANO`/`NE`/`NENALEZEN`), dávka až 100 DIČ (ale `statusCode 1` = tiše ořízne na prvních 100 —
  musí se hlídat), rate limity (10k/24h, 2k/hod, max 4 paralelně), předvídatelná okna nedostupnosti
  (denně 0:00–0:10, neděle 3:00–4:00) → `DEPENDENCY_UNAVAILABLE`/retryable. SOAP/XML, ne REST/JSON.
- **`cz.insolvency.check`** (deterministický, žádné AI) — insolvence subjektu (IČO) i fyzické
  osoby (RČ, pro OSVČ/statutáry bez IČO). **Zdroj zatím neurčen** — `isir.info` (Prowia system) je
  placený third-party wrapper, vlastník 11. 9. 2026 explicitně odmítl platit třetím stranám
  ([[agent-platform-no-paid-third-parties]]); jeho vlastní XML odkazuje na oficiální bezplatnou
  službu `isir.justice.cz:8443/isir_public_ws/...` — tu je potřeba dohledat a ověřit, než se tahle
  capabilita začne stavět.

Tohle se **nesmí míchat do OCR/extraction agenta** — je to ověření proti autoritativním
registrům, jiná bezpečnostní a spolehlivostní kategorie než čtení textu z PDF.

Žádný z těchto tří ověřovacích zdrojů (ARES, MOJE daně, budoucí ISIR) není JSON — REST/JSON,
SOAP/XML a REST/XML jsou tři různé protokoly, tři různé adaptéry, ne jedna sdílená kostra.

**Referenční zdroj pro budoucí BC krávy (11. 9. 2026):** oficiální, prvostranné BC API v2.0 —
`https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/`,
entity `company` (`.../resources/dynamics_company`) má přes 80 navigačních zdrojů (`customers`,
`vendors`, `salesInvoices`, `purchaseInvoices`, `purchaseOrders`, `journals`,
`generalLedgerEntries`, ...). Zapnuté defaultně pro BC online, žádná extra licence, MS APIs Terms
of Use. **Vědomě zde neenumerujeme jako budoucí krávy** — stejný princip jako u
`cow-catalog.json` (žádný seznam se nesmí tvářit hotověji, než je) — je to jen ukazatel, kam sáhnout,
až se pro konkrétní entitu najde skutečný spotřebitel ve farmě. Ostré rozlišení až se bude stavět:
**read-only entity** (nízké riziko, `sideEffects: none`, levné přidat) vs. **write-capable entity**
(`salesInvoices`/`purchaseInvoices`/`journals`/platby — teritorium budoucího BC Executoru, plný
Admission Gate + vyhrazený credential + COMPROMISED-ORCHESTRATOR test, ne příležitostné přidání).
Jediná entita s dnes už identifikovaným spotřebitelem: `customers` (pro krávu "načti seznam
zákazníků z BC" z `## Dávkové úlohy...` výše).

Generický "obecný OData čtecí hack" (AL tabulka/stránka konfigurovatelná na libovolné pole,
zdrojový blog Josh Anglesea, GitHub `JAng13sea/Blogs`) zvažován a zamítnut jako výchozí volba —
jde proti principu úzkých jednoúčelových krav a navíc vyžaduje bespoke AL vývoj uvnitř BC tenanta;
ponechán jako záložní technika pro nestandardní pole bez oficiálního pokrytí, ne jako vzor.

---

## Farmář jako honák, ne autorita — kompromitovaný orchestrátor musí zůstat neškodný (11. 9. 2026)

Vznikl z diskuze vlastníka 11. 9. 2026, nad konkrétním případem faktura → BC import. Stejná výhrada
jako u zbytku dokumentu: cílový obraz, ne rozhodnuté zadání. Rozšiřuje a zpřesňuje `## Positioning`
(řetěz LLM → Planner → schema/Policy/Registry → Router → signed dispatch → COW → Audit) a
`### Zero-trust model`'s „AI výstup nikdy není příkaz" o třetí roli a o to, co přesně smí orchestrátor
(Farmář) dělat s daty, která mezi COW předává.

### Tři role, ne dvě

- **Farmář** (orchestrátor) — jen hrubé rozpoznání záměru a routing. „Tohle vypadá jako faktura, cíl:
  připravit k importu do BC." Nic víc. Nečte a neskládá business data, jen rozhoduje, která COW má
  přijít na řadu.
- **Krávy** (COW) — jednoúčelové, úzké. Každá dělá jeden konkrétní úkon (přečti dokument do MD,
  vytáhni pole faktury, ověř IČO proti ARES, ověř DIČ, ověř bankovní účet, ověř součty/DPH/data).
- **Dojičky** — nová role vedle COW. Na rozdíl od COW (jednoúčelová) je dojička **jednoduchá
  kumulativní**: deterministicky sesbírá výsledky víc krav (extrahovaná data, PASS/FAIL, evidence) do
  jednoho dalšího balíku/stavu podle pevného kontraktu. Nic nevymýšlí, nic neopravuje, nic
  nepřepisuje — jen skládá.

```
faktura → Farmář (rozpozná: "faktura, cíl BC import")
        → Kráva: Document Reader (MD)
        → Kráva: Invoice Extractor (pole faktury)
        → Krávy: ARES / VAT / Bank Account / Math validation (paralelně, jednoúčelově)
        → Dojička: složí Invoice Package (Extraction/ARES/VAT/Účet/Math/Duplicita → Overall)
        → Import Gate (deterministický, viz níže)
        → Kráva: BC Import COW (zapíše, nebo NE)
```

Tenhle vzorec je konkrétní instance `## Připravované doménové COW`'s řetězu `invoice.extract →
cz.company.verify → cz.vat.verify` — dojička je chybějící dílek mezi „samostatné capabilities" a
„jeden agent, co dělá všechno", co ta sekce výslovně zakazuje.

### Hlavní invariant: farmář nesmí nosit hodnoty

I plně **kompromitovaný nebo podplacený** Farmář nesmí být schopný změnit obsah faktury cestou z
kontrol do BC. Konkrétní útok: Farmář přečte `bankAccount=111111/0100`, všechny krávy potvrdí PASS pro
tuhle hodnotu, ale při sestavování balíku pro BC Farmář pošle jinou hodnotu
(`bankAccount=999999/0100`, `amount=185000` místo `18500`). Pokud BC krávě věří Farmářovu obsahu,
celý bezpečnostní model je obejitý — přesně ten typ mezery, co `### Zero-trust model` už řeší pro AI
výstup obecně, tady zpřesněný pro orchestrátora samotného.

**Řešení: Farmář nesmí nosit obsah, jen odkazy.** Po přečtení faktury vznikne artefakt (např.
`INVOICE-4711`) uvnitř zabezpečeného úložiště platformy (`Artifact`/`IncomingArtifact`, viz
`### Canonical vstup/výstup`), který nese pole jako `supplierIco`/`vatId`/`bankAccount`/`amount`.
Farmář neříká krávě „ARES, ověř 12345678" — říká „ARES, ověř `supplierIco` z artefaktu `INVOICE-4711`".
Platformа sama vytáhne hodnotu ze skladu a předá ji kravě. Stejně tak Farmář nesmí BC krávě říct
„založ fakturu: částka=185000, účet=999999/0100" — smí jen požádat „importuj `INVOICE-4711`".

**Tvrdé pravidlo:** *Farmář může organizovat práci (kam mají data putovat), ale nikdy nesmí vytvářet
nebo měnit autoritativní business data ani získat oprávnění k jejich zápisu.* BC credential nemá
Farmář nikdy — jen BC Executor COW.

### Import Gate — deterministický, čte ze skladu, ne od Farmáře

```
FARMÁŘ → "import INVOICE-4711"
            ↓
      IMPORT GATE (deterministický, žádné AI)
            ↓ načte ZE SKLADU (ne od Farmáře)
   IČO, ÚČET, ČÁSTKA + evidence každé kontroly
            ↓
   všechny důkazy patří INVOICE-4711 a sedí na AKTUÁLNÍ obsah?
            ↓ ANO
        BC EXECUTOR → Business Central
```

Finální balík pro BC skládá **Import Gate**, ne Farmář — přesně stejný princip jako dojička
(deterministické skládání z ověřených dat), jen jako poslední, bezpečnostně kritická brána před
zápisem. Farmář smí rozhodovat „teď potřebuju ARES", „teď zkus import", „teď pošli člověku do
REVIEW" — nikdy „do BC pošli tuhle částku/tenhle účet".

### Kontrola musí být svázaná s konkrétní hodnotou, ne jen s výsledkem

Nestačí uložit `bankAccount: PASS` — to samo o sobě nechrání proti tomu, že se hodnota mezi kontrolou
a zápisem změní. Každá verifikace nese hash konkrétní ověřené hodnoty:

```
ACCOUNT_VERIFICATION
  invoiceId:  INVOICE-4711
  field:      bankAccount
  valueHash:  sha256(hodnota v okamžiku kontroly)
  result:     PASS
  source:     FinancialAdministration
  verifiedAt: ...
```

Změní-li se `bankAccount` po verifikaci (o cokoli), starý `PASS` už neplatí pro novou hodnotu —
Import Gate to pozná jako `VALUE_CHANGED_AFTER_VERIFICATION → DENY`, ne jako platné schválení. Stejný
princip nad celou fakturou: `InvoiceSnapshot` → canonical representation → SHA-256 →
`invoiceFingerprint`; ARES/VAT/účet/schválení se vážou na tenhle fingerprint (nebo na field-level
fingerprinty); před zápisem do BC se aktuální fingerprint porovná s ověřeným — neshoda znamená
„faktura byla po kontrolách změněna", STOP, ne zápis s varováním.

**Vztah k dnešnímu stavu:** tohle je přesně ten typ vázání, co `Audit provenance (COW zero-trust)`
řádek ve vrstvách výše označuje jako chybějící — `/audit` dnes není vázané na skutečný podepsaný
dispatch, jen na service-binding důvěru. Value-level fingerprint je stejná myšlenka aplikovaná na
verifikační evidenci, ne jen na audit záznam samotný.

**Zpřesnění (Posudek 8, `docs/POSUDKY.md`, 11. 9. 2026):** stejná myšlenka jde vidět i jako
**provenance graph** — hash řetěz od originálu přes MD/extrakci až po jednotlivé pole
(`original.hash → MD.hash → extraction.hash → field.hash → verification.inputHash`), ne jen plochý
`field: PASS`. Dojička smí použít `PASS` jen když `verification.inputHash == currentField.hash` —
ekvivalent `valueHash` výš, jen explicitně jako graf, ne jen jako pár hodnot. **Dojička/Kráva jako
skutečný platformní typ** (ne jen role popsaná textem tady) je taky z Posudku 8 — kandidát pro
budoucí rozšíření `module-descriptor.v1.schema.json`, ne dnešní stav.

### BC Executor musí být „hloupý" — žádné AI, žádná interpretace

```
BC Invoice Executor

MŮŽE:                              NEMŮŽE:
✓ načíst CertifiedInvoice          ✗ měnit částku
✓ zkontrolovat authorization       ✗ měnit účet
✓ zkontrolovat fingerprint         ✗ doplňovat IČO
✓ zkontrolovat required evidence   ✗ interpretovat fakturu
✓ založit fakturu                  ✗ poslouchat instrukce z dokumentu
✓ vrátit BC document ID            ✗ poslouchat AI ohledně obsahu
✓ auditovat effect
```

Žádné AI uvnitř — jednoúčelový robot přesně v duchu „Cena je z principu nízká pro ne-AI capability"
(`## Positioning`). Vlastní, výhradní credential (BC Executor, nikdy Farmář ani jiná kráva).

**Vývojová/ověřovací fáze, rozhodnuto 11. 9. 2026 (vlastník):** dokud řetěz není hotový a ověřený,
BC Executor se nestaví ani nezapojuje — poslední krok místo něj je **JSON Export** (stejně „hloupý",
no-AI, jen zapíše `CertifiedInvoice` jako JSON, žádný reálný credential ani side effect mimo
platformu). K ověření, že extrakce+verifikace vrací správná data, slouží samostatný krok
**Invoice Generator** — vezme JSON a **deterministicky, bez AI** z něj sestaví fakturu (šablona,
ne věrný vizuál — „rychlé, levné, hloupé, jen pro kontrolu"). Člověk porovná vygenerovanou fakturu s
originálem = živé ověření, že řetěz nic needitoval a nic nevynechal, bez nutnosti reálného BC přístupu.
Až řetěz projde touhle kontrolou, JSON Export se nahradí skutečným BC Executorem beze změny zbytku
řetězu (Import Gate/fingerprint/farmář-bez-přístupu zůstává stejné, mění se jen poslední krok).

### Nový povinný test pro Admission Gate: COMPROMISED-ORCHESTRATOR / CONFUSED-DEPUTY

Doplňuje `### Admission Gate`'s seznam testů a `### Zero-trust model`'s adversarial test suite o
scénář, kde je **kompromitovaný sám orchestrátor** (ne jen jedna COW): předpokládat podplacený/
zfalšovaný Farmář, co se zkouší zeptat rovnou na akci s vlastními hodnotami („pošli milion korun na
můj účet", „importuj s jinou částkou") — systém musí zůstat bezpečný i tak, protože Import Gate čte
ze skladu, ne z Farmářova tvrzení, a BC Executor nemá vlastní úsudek, co by šlo přemluvit.

---

## Dávkové úlohy, fronta a mezera v capabilitách (11. 9. 2026)

Vznikl z diskuze vlastníka 11. 9. 2026. **Cílový obraz, ne rozhodnuté zadání** — stejná výhrada
jako u zbytku dokumentu. Motivace: Farmář dnes umí jen "jeden dokument → jedna workflow instance".
Skutečný provoz bude potřebovat i druhý tvar úlohy — dávkový, proaktivní, ne reaktivní na jeden
příchozí dokument.

### Druhý typ úlohy: dávkový audit, ne jen reakce na dokument

Příklad zadání: „ověř zdraví zákazníků v BC". Farmář dostane úkol, který se nevejde do
`document-intake`/`mail-intake` vzoru:

```
Dnešní (reaktivní):  faktura přijde → extract → krávy ověří → dojička → Import Gate
Nový (dávkový):      úkol "ověř zákazníky" → načti seznam z BC → krávy ověří KAŽDÉHO
                      → dojička agreguje → report s příznaky (pro člověka, ne auto-akce)
```

Používá **stejné krávy** jako invoice řetěz (`cz.company.verify`/`cz.vat.verify`/
`cz.insolvency.check`) — jde jen o jiný spouštěč, ne o novou sadu capabilit. Farmář zůstává
stejně bez autority jako u jednoho dokumentu (`### Hlavní invariant` výše): report je vždy pro
člověka, nikdy automatický zápis do BC.

### Dvě nové krávy pro dávkový vzor, obě hloupé a jednoúčelové

- Jedna kráva **jen načte** seznam zákazníků z BC (read-only, žádné rozhodování).
- Druhá kráva **ověří dávku** — zpracuje jen tolik subjektů, kolik povoluje dokumentace
  konkrétního externího zdroje (viz rate limity u `cz.vat.verify`/`cz.insolvency.check` výše), a
  vrátí se. **"Počkej a udělej další kolo" nesmí být uvnitř jednoho volání kráv** — synchronní
  capability kontrakt (deadline/`notValidAfter`, executor timeouty) neumožňuje handleru spát
  minuty. Kráva zůstává čistě "ověř N položek, vrať se"; pauzu mezi koly řídí workflow vrstva,
  stejný vzor jako dnešní `WAITING(EXTERNAL)`/naplánovaný resume — ne nový mechanismus.

### Fronta pro sdílené omezené zdroje — Total Commander F5 vzor

Procesy přes farmu běží defaultně **paralelně**. Výjimka: operace sahající na **stejný omezený
externí zdroj** (rate limit u MOJE daně/ARES/ISIR) se musí serializovat, jinak si dvě paralelní
workflow instance vzájemně vyčerpají limit nebo se překročí. Řešení: sdílená fronta per externí
systém — stejný obrázek jako kopírování přes frontu v Total Commanderu (F5), ne globální
zámek přes celou farmu.

Tohle už vlastník jednou řešil jinde ([[itdashboard-host-lock]] — těžké per-PC operace
serializované přes `pc:id`) — stejný tvar, jiný klíč fronty (`moje-dane:queue`, `isir:queue`,
`ares:queue` místo `pc:id`). Přirozená hranice pro frontu je **stejná jako dnešní credential
doména** (SMTP, DMS, budoucí BC Executor mají každý svůj vyhrazený credential resolver) — rate
limit je vlastnost téhož externího systému, takže tempo/fronta patří do stejné hranice jako jeho
credential, ne jako samostatný farm-wide mechanismus.

### Bounded looping — žádná nová smyčka nesmí být nekonečná

„Looping" se v dávkovém vzoru objevuje na třech různých místech, co se nesmí splynout do jednoho
univerzálního mechanismu:

1. **Retry v rámci dávky** — položka #47 selže (rate limit/timeout), zkusí se znovu později,
   zbytek dávky pokračuje.
2. **Opravné kolečko Farmáře** — když Farmář dostane jen kusé informace a rozřadí špatně, korekce
   ho vrátí zpátky na rozhodnutí (ne že se chyba tiše opraví o úroveň níž).
3. **Periodické opakování celé dávky** — plánovaný běh nanovo, stejný vzor jako dnešní self-test
   rotace na cronu (`selfTestCapabilityForTick()`), ne opravný mechanismus, jen rozvrh.

Pro všechny tři platí existující norma (VC `WF-UNK-002`, reconciliation bez konce): smyčka má
vlastní **`reconciliationBudget`** — po X pokusech přechod do `WAITING(REVIEW)` s deadline,
**nikdy nekonečná smyčka**. Žádný z těch tří typů výše nesmí být výjimkou.

### Capability gap — Farmář nesmí improvizovat náhradou, musí eskalovat

Přímé rozšíření `### Hlavní invariant: farmář nesmí nosit hodnoty` výše: když Farmář/Planner
narazí na úkol, pro který **v Agent Registry není žádná odpovídající kráva**, nesmí zkusit
nejbližší přibližnou náhradu (např. použít `cz.company.verify` na otázku, co patří insolvenci,
"protože je to podobné") — to by bylo nebezpečnější než čestné přiznání mezery.

Navrhovaný nový strukturovaný výstup — pracovní název **`CAPABILITY_GAP`** — analogický
dnešnímu `WAITING(REVIEW)`: eskalace na člověka/produktové rozhodnutí ("požadavek na nákup nové
krávy"), ne tichá degradace ani pokus o řešení s tím, co je po ruce. Přímo navazuje na budoucí
**Planner jako generátor `WorkflowDef`** (`## Pořadí` bod 8) — plánovač skládající workflow z
dostupných capabilit musí mít tuhle únikovou cestu vestavěnou od začátku, ne jako dodatečnou
záplatu.

---

## Cílová architektura pro standardizované přidávání COW (8. 9. 2026)

Vznikl z rozsáhlé diskuze vlastníka (+ externí AI konzultace) 8. 9. 2026. **Cílový obraz, ne
rozhodnuté zadání** — stejná výhrada jako u zbytku dokumentu. Motivace: než přibude další COW,
má být zmapované veškeré propojení (vstupy, výstupy, testy, bezpečnost) tak, aby nová COW šla
jen „zasunout do slotu", ne stavět znovu vlastní bezpečnost, konektory a testy.

**Vztah k dnešnímu first-slice:** foundation je zmrazená (1.0-rc2.1, mění se jen s evidencí z
kódu, část XVII — žádné další posudky na papíře). Tahle sekce je přesně takový papírový posudek,
proto žije tady jako cíl, ne jako okamžitá změna kontraktů. Rozhodnuto 8. 9. 2026 (vlastník):
**blízký plán (krok 8 → 8b → e-mail → fronta → pentest → reálný model) pokračuje beze změny
pořadí**; z týhle sekce se čerpá až bude evidence (druhá reálná write-capabilita, druhý reálný
tenant), ne teď dopředu.

### Canonical vstup/výstup — COW nesmí vědět, odkud data přišla ani kam jdou

```
VSTUPY (web upload, e-mail+příloha, Telegram+soubor, API, scheduler, webhook)
        ↓ vždy převedeno na stejný tvar
   IncomingArtifact { artifactId, tenantId, source, mimeType, contentRef, hash, receivedAt, metadata }
        ↓
   COW (capability, input/output schema, vlastní credential, úzký účel)
        ↓ vrací vlastní typovaný výsledek (např. InvoiceExtractionResult)
   VÝSTUPY (ERP/DMS, e-mail, Telegram, API, DB, webhook, další COW)
```

**Dnešní částečná shoda:** `Artifact` (`src/platform/artifacts.ts`) už nese `sha256`,
`contentType`, `receivedFrom`, `location` — je to zárodek `IncomingArtifact`, jen zatím jen pro
dokumentové vstupy (`/intake`, `/farm/inbox`), ne pro Telegram/webhook/scheduler. Rozšíření na
další vstupní adaptéry je čistě přidávání, ne přepis — pokud si nový vstupní adaptér udrží
stejný tvar artefaktu, žádná COW se o něm nemusí dozvědět.

### COW technický pas (rozšíření dnešního `descriptor.json`)

Dnešní `module-descriptor.v1.schema.json` (zmrazený) už nese: `capabilities`, `inputSchema`/
`outputSchema`, `riskClass`, `sideEffects`, `requiredScopes`, `tenantMode`, `isolationClass`,
`idempotency`+`idempotencyRetention`, `deadlinePolicy`, `reconciliationBudget`, `humanApproval`,
`errorCodes`, `conformanceTier`. Chybí (kandidáti pro rozšíření, ne pro dnešní kontrakt):
`allowedNetworkDestinations` (egress firewall — COW deklaruje, kam smí volat, cokoli mimo seznam
je `DENY + SECURITY EVENT`), explicitní `rateLimit`, `healthCheck`/`connectorTests` reference.
**COW sama nemůže tvrdit „jsem bezpečná" — platforma její deklaraci porovná s vlastní policy,**
stejně jako dnes `Router` porovnává `requiredScopes` s granty, ne s tvrzením handleru.

### Admission Gate — nasazení COW jako homologace

```
NEW → manifest validation → schema testy → security testy → tenant isolation test
  → credential isolation test → connectivity test → negative testy → timeout/retry test
  → replay/idempotency test → failure/recovery test → audit test → output contract test
  → APPROVED → ACTIVE
```

Jakýkoli FAIL → `QUARANTINED`, Planner tu COW ani neuvidí. **Dnešní stav: conformance suite
existuje (`conformance/`, `npm test`), ale nic nezablokuje nasazení, když je červená** — brána je
dnes lidská disciplína (`npm run typecheck/test/arch/farm:check` před každým nasazením), ne
automatizovaný gate. To je největší mezera mezi dneškem a týhle vizí.

**Konektivita jako součást certifikace, ne jen funkční test:** DNS, TLS, HTTP, autentizace, tvar
odpovědi, latence, testovací dotaz, neočekávaná odpověď, timeout, rate limit — pro `cz.company.
verify` např. proti ARES/Finanční správě, dřív než se capabilita aktivuje. Živý stav pak `ACTIVE`
→ `DEGRADED` → `QUARANTINED` podle **běžícího** zdraví konektoru (externí API změní formát →
capabilita se přestane používat samo, ne až uživateli něco pokazí) — to je nad rámec dnešního
statického `wired: true/false`.

### Risk profily řídí povinné testy, ne autor COW

`riskClass` v dnešním descriptoru (`LOW`/`MEDIUM` v repu) by se rozšířil na explicitní úroveň
(R0 read-public → R1 tenant-read → R2 external-write → R3 business-critical-write → R4
financial/high-impact), která **sama určuje** povinnou sadu testů a kontrol (R4 = durable
idempotency + reconciliation + human approval + amount limity + kompletní audit navíc). Autor
COW nemůže napsat nižší riziko, než jaké capabilita fakticky má — platforma ho odvodí ze
`sideEffect`/`capability` deklarace, ne z tvrzení.

### Multi-tenant izolace: shared compute, isolated context/data/credentials/policy/audit

Princip: **sdílená výpočetní infrastruktura, ale každý požadavek nese od vstupu po výstup
důvěryhodný tenant kontext, který COW nesmí odhadovat ani dopočítávat z payloadu.**

- **Isolated context** — tenant vzniká z ověřené identity/intake adresy/API credential, nikdy
  z `tenantId` v těle požadavku (to by šlo zfalšovat). Dnešní `intakeTenant()` čte identitu z
  profilu, ne z uživatelského vstupu — správný směr, jen zatím jen pro jednoho tenanta.
- **Isolated data** — objekt pevně svázaný s tenantem, COW nezná cizí tenanty, dostane jen
  tenant-scoped storage rozhraní.
- **Isolated credentials** — COW dostane jen credential set tenanta, kterému požadavek patří, a
  jen pro tu capabilitu, co zrovna vykonává (dnešní `credentialTable()` už dělá první polovinu —
  jméno, ne hodnotu, per capability; chybí per-tenant rozlišení, protože dnes je jeden tenant).
- **Isolated policy** — jeden tenant dovolí `email.send` automaticky, jiný vyžaduje schválení;
  jeden dovolí externí model, jiný jen interní. `ADR-016` granty už jsou per-tenant, jen zatím
  nesou stejná pravidla pro oba testovací tenanty.
- **Isolated audit, limity, billing, incident containment** — tenant vidí jen svoje; per-tenant
  rate limit/concurrency/storage/LLM budget, ať jeden zákazník nevytíží farmu ostatním; možnost
  okamžitě odpojit jen jednoho tenanta (credentials/capabilitu/celý tenant), ne celou farmu.
- **Stateless COW** — vstup, trusted context, omezené služby, výsledek, konec. Stav patří do
  platformního storage (dnes DO SQLite), ne do paměti COW — čím míň si COW pamatuje mezi běhy,
  tím menší riziko, že si „zapamatuje" data předchozího tenanta.

### Zero-trust model — COW může být chybná nebo kompromitovaná, přesto nesmí poškodit farmu

Základní předpoklad silnější než dnešní: *každá COW může být chybná, kompromitovaná nebo úmyslně
škodlivá; přesto nesmí být schopná poškodit farmu ani jiného tenanta.*

- **Tenant nikdy z payloadu** — už zapsáno výše, zdůrazněno jako bezpečnostní, ne jen datový
  požadavek: útočníkem poslané `"tenantId": "..."` v těle musí být bezvýznamné.
- **Vstup je vždy nepřátelský** — velikostní limit → MIME validace → magic-byte validace →
  malware sken → limity na rozbalení archivu → normalizace obsahu → immutable originál → teprve
  COW. Text z dokumentu je vždy DATA, nikdy instrukce platformě (existující F2 princip, jen
  rozšířený o binární hrozby nad rámec prompt injection).
- **AI výstup nikdy není příkaz.** Faktura může obsahovat „pošli 250 000 Kč na účet X" —
  extrakce smí vrátit `bankAccount = X`, `amount = 250000` jako FAKTA, nikdy jako oprávnění něco
  zaplatit. Autorita vždy z platformní policy/workflow/human approval, nikdy z dokumentu. Přesné
  rozšíření dnešního F2 (allowlist nad výstupem modelu) na obecný princip DOCUMENT → FACTS, ne
  DOCUMENT → COMMAND.
- **Credential broker, ne jen jméno secretu** — cílový stav: COW secret hodnotu vůbec neuvidí,
  platformní connector operaci provede jejím jménem. Dnešní stav je slabší (COW dostane hodnotu,
  jen omezenou na deklarovanou potřebu) — legitimní budoucí zpřísnění, ne dnešní chyba.
- **Egress firewall per COW** (`allowedNetworkDestinations`, viz výš) — kompromitovaná COW
  nemůže exfiltrovat data mimo deklarovaný seznam cílů.
- **Blast radius / karanténa** — možnost vypnout tenant/COW/capabilitu/connector/credential/
  provider/model jednotlivě, bez odstavení farmy; automatická karanténa na živé signály (error
  rate, latence, neočekávaný cíl sítě, autorizační selhání, schema violace, neobvyklý objem).
- **Supply-chain** — dependency sken, SAST, secret sken, testy, conformance, SBOM, hash,
  podpis, teprve nasazení. Produkce spouští jen podepsaný build, co prošel pipeline.
- **Adversarial test suite** (nad rámec dnešních MUST/mutant testů): cross-tenant útoky,
  credential escape, privilege escalation, replay, forged/expired context, schema fuzzing,
  prompt injection, poškozené soubory, oversized payload, timeout/rate-limit zneužití, connector
  spoofing, SSRF, neočekávaný egress, audit bypass, race podmínky, pád během zápisu, ztráta
  odpovědi po zápisu (musí reconcilovat, nesmí zopakovat efekt).

**Hlavní bezpečnostní invariant, navrhovaný jako architektonický požadavek (ne dnešní
kontrakt):** *kompromitace jedné COW nesmí znamenat kompromitaci jiné COW, jiného tenanta,
control plane ani farmy jako celku.*

---

## Pořadí (co je skutečně příští, ne všech vrstev najednou)

1. **Durable Review + skutečná decision cesta** — `ReviewService` na farmě dnes nemá vůbec žádnou
   cestu k rozhodnutí (viz tabulka výše, zpřesněno 8. 9. 2026), ne jen „nepřežije evikci". To je
   existující runtime chyba, ne aspirace. Řeší se dřív než cokoli nového.
2. **Durable idempotency/effect ledger** pro write executory — `tenantId + handlerId +
   requestFingerprint` (Posudek 5/6), než přibude druhý typ write COW.
3. **Dokončit `mail.ingest`/`email.send` skeleton** — druhý reálný typ COW, důkaz že
   `document-host` nebyl jednorázová výjimka; zároveň první event-driven case.
4. **Agent Registry** — zatím čistě deterministický katalog capabilities (formalizace
   `descriptor.json` + `router.register()`), žádné AI v rozhodování.
5. **`invoice.extract`** — první krok hotový (11. 9. 2026, HANDOFF 109): komponenta, wiring, conformance
   (12 fixtures) a testy lokálně zelené, **nenasazeno**. Pole podle normy (VC §5): `companyId`,
   `bankAccount`, `totalWithVat`, `invoiceNumber`; DIČ/měna/položky vědomě mimo rozsah v1. Deterministická
   cross-check validace (classify→validate vzor pro tenhle řetěz), dojička, Import Gate a BC Executor
   ještě nejsou postavené.
6. **`cz.company.verify`** — API zdroj ověřen 11. 9. 2026 (ARES, bezplatné, viz
   `## Připravované doménové COW` výše), zatím nepostaveno.
7. **`cz.vat.verify`** — API zdroj ověřen 11. 9. 2026 (MOJE daně SOAP, bezplatné, zveřejněné účty
   = zdroj pro Import Gate ACCOUNT_VERIFICATION), zatím nepostaveno.
7b. **`cz.insolvency.check`** — zdroj zatím neurčen (placený `isir.info` vlastník odmítl, hledá se
   oficiální bezplatná `isir.justice.cz` alternativa) — vloženo do pořadí až po nalezení zdroje.
8. **Planner jako generátor `WorkflowDef`** (nikdy přímý executor) — teprve teď plánuje nad
   reálnou farmou (`document.*`, `mail.ingest`, `email.send`, `invoice.extract`, `cz.*.verify`),
   ne nad dvěma umělými capabilities — proto až poslední, ne proto, že by byl málo důležitý.

Tenant resolution zůstává mimo tohle pořadí — dnes to není bug (`CLOUD_SINGLE_TENANT`), je to
budoucí capability; řešit se má, až bude existovat druhý reálný tenant, ne preventivně.

**Why:** foundation je zmrazený přesně kvůli deterministické, auditovatelné povaze platformy
(4 kola oponentury, 80 nálezů). Každá nová vrstva, která zavádí nedeterminismus (Planner,
Memory), musí zůstat *uvnitř* stejné fail-closed brány, ne vedle ní. A vrstvy, co dnes reálně
můžou ztratit stav (Review, idempotency), mají přednost před vrstvami, co teprve mají přibýt.
