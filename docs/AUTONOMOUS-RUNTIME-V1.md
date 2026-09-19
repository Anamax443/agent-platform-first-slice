# AUTONOMOUS RUNTIME v1 — cílový kontrakt architektury (18. 9. 2026)

**Stav: NÁVRH, vlastníkovo explicitní rozhodnutí 18. 9. 2026 — zastavit přidávání funkcí, uzamknout tenhle
dokument PŘED jakoukoli změnou veřejného `/intake` kontraktu.** Vznikl po sérii živých auditů `80b6a8d` →
`8131e5e` → `e127987` (viz `HANDOFF.md` #178–181), kde opakovaná otázka "stavíme autonomní Farmu, nebo velmi
dobrý n8n?" pokaždé narazila na tutéž mezeru: runtime dnes pořád začíná volbou workflow, ne interpretací
impulsu. Tenhle dokument fixuje CÍLOVÝ tvar dřív, než se `NormalizedImpulse`/`Case` zapojí do veřejného vstupu
podruhé — **why:** první zapojení (Commit 3, mail-only) už jednou ukázalo skrytou závislost (Case ↔ Evidence
↔ FactAddress scope), kterou jsme neviděli, dokud jsme nezačali stavět. Opravit kontrakt na papíře je
levnější než přepisovat veřejné API podruhé.

Vztah k ostatním dokumentům: `docs/M0-FACT-CONTRACT-V1.md` zůstává platný a nemění se (FactAddress/EntityHash/
AuthorityGrant/durabilní Žlab jsou hotové primitivy) — tenhle dokument na něj navazuje a rozhoduje o tom, co
M0 nechalo otevřené (Evidence ↔ Case scope, viz část 2). `docs/SEVERKA.md` zůstává živý deník dlouhodobé vize
a roadmapy (M0–M8) — tenhle dokument je jednorázový checkpoint/ADR, ne náhrada SEVERKY; po schválení se jeho
rozhodnutí promítnou zpět do SEVERKA jako doplněk, ne přepis.

---

## 1. Řetězec, který se nemění — a proč

Nejcennější část projektu není žádná jednotlivá kráva ani workflow. Je to tenhle řetězec (SEVERKA ho už
popisuje, tady ho jen fixujeme jako neměnný):

```
AI / interpretace
      ↓ navrhne ZÁMĚR (ref, nikdy hodnota)
deterministický Planner
      ↓ určí dosažitelné capability z FactCatalog (goal/available → steps, nebo CAPABILITY_GAP)
Policy / Registry / Router
      ↓ ověří scope/grant/lifecycle — checkGrant()
úzká COW
      ↓ provede jeden konkrétní úkon, nezná workflow ani volajícího
Žlab / Artifact / Audit
      ↓ hash + uzavřený výsledek + odkaz na artefakt — nikdy hodnota
```

### Tvrdé invarianty (AR-1 … AR-8)

Číslováno nezávisle na M0's R1–R7 (jiná vrstva rozhodnutí — runtime tvar, ne fakt/evidence tvar).

- **AR-1 — Farmář/Planner nesmí nosit business hodnoty.** Smí říct "ověř `supplier.companyId` z artefaktu
  `A17`", nikdy "ověř IČO 12345678". Vynuceno schématem (výstupní kontrakt Farmáře nesmí mít pole jako
  `amount`/`bankAccount`/`ico` vůbec existovat), ne jen code review. Už dnes živě dodrženo: `plan()` je
  key-only (`PLAN-005`), `attachment-fanout.ts`'s driver čte jen existenci evidence záznamu, nikdy hodnotu.
- **AR-2 — Channel ≠ intent ≠ content ≠ goal.** Ingress adaptér smí jen normalizovat tvar (mail → text +
  attachments, Telegram → text + media, folder → N souborů), nikdy rozhodnout workflow/goal/intent.
  `NormalizedImpulse` to má strukturálně vynucené (žádné takové pole neexistuje — `case.ts`). **Dnes
  porušeno**: `POST /intake`'s `workflow: string` pole a `mailIntake()`'s natvrdo `workflowDef("mail-intake")`
  jsou přesně ten starý model — zůstávají beze změny, dokud neexistuje náhrada (část 5).
- **AR-3 — Běžící `WorkflowInstance` se nikdy nemutuje.** Replanning existuje jen MEZI samostatnými immutable
  instancemi, nikdy uvnitř jedné. `orchestrator.ts` se kvůli tomuhle dokumentu nemění.
- **AR-4 — Nová Kráva nesmí vyžadovat změnu centrální orchestrace.** Přidání capability = capability +
  `facts.json` + policy + (později) goal-mapping konfigurace. Pokud si nová agenda žádá vlastní `*-driver.ts`
  nebo `*-workflow.ts` v `src/platform/`, návrh je špatně — to je test na "sklouzáváme k n8n". Ekvivalent
  SEVERKA's M8 (druhá doména beze změny Farmáře/Argose/Žlabu/Dojičky/Konve).
- **AR-5 — Case je reasoning boundary, tenant je storage/reuse boundary.** Fakt z Case A nesmí tiše splnit
  podmínku Case B jen proto, že je stejný tenant — pokud to má být sdílené (např. ARES existence firmy), musí
  to být explicitní `reusePolicy`, ne implicitní `forTenant()` scan. Rozvedeno v části 2.
- **AR-6 — Evidence nikdy nenese hodnotu.** Jen hash + uzavřený slovník výsledků + odkazy. Už hotovo a
  testováno (D6, `evidence.ts`) — tady se jen znovu potvrzuje jako neměnné i po rozšíření o `originCaseId`/
  `subject`/`reusePolicy` (část 2) — žádné z nových polí nesmí nést hodnotu.
- **AR-7 — Import Gate (nebo jakýkoli finální zápis) čte ze Žlabu, nikdy z tvrzení Farmáře.** Beze změny.
- **AR-8 — Workflow engine se neruší, mění se jeho role.** Dnes: člověk píše `WorkflowDef` ručně pro každý
  případ. Cíl: `Planner` + `CurrentCaseProjection` + `goal` → compiler → immutable `WorkflowDef` → stejný
  `Orchestrator`/`Router`/`Policy` řetězec jako dnes. Orchestrator, Router, Policy Engine se v tomhle
  přechodu neruší ani nepřepisují — mění se jen to, KDO `WorkflowDef` autoruje.

---

## 2. Evidence ↔ Case ↔ FactAddress — rozhodnutí (nahrazuje otevřenou otázku z M0)

### Co ověření 18. 9. 2026 potvrdilo jako reálný rozpor

`FactAddress` (`fact-address.ts`, M0 část A, uzavřeno) definuje `scope`, který je **vždy přítomný po
normalizaci** — `CASE_SCOPE`, když fakt nedeklaruje vlastní (`fact-catalog.ts`'s `CASE_SCOPE = "case"`,
"reserved singleton scope every fact has by default"). Case-scoping je tedy už dnes DEFAULT v modelu faktů.

`Evidence` (`evidence.ts`) je ale **tenant-scoped** (`forTenant(tenantId)`), s `inputField: string`, který M0
sám plánoval jako "kanonická `FactAddress`" (textová forma, `parseFactAddress()`/`formatFactAddress()`), ale
nikdy nezavedl `scope` ani `caseId` jako vlastní strukturovaná pole. Není to tedy totální roztržka — textová
konvence existuje — ale **scope se dnes dá zjistit jen zpětným parsováním `inputField` proti živému
`FactCatalog`, a i pak nevede k žádnému konkrétnímu Case** (Evidence nemá `caseId`, jen volitelné
`workflowId`, a vazba `workflowId → caseId` dnes žije jen v `CaseStore` v `apf-gateway`, ne v Žlabu samotném).

### Rozhodnutí

Evidence se rozšiřuje (aditivně, `schemaVersion` postoupí — stejná disciplína jako M0's v1→v2 krok, D6
zůstává beze změny):

```
Evidence {
  recordId, tenantId,                    // beze změny
  originCaseId?: string,                 // NOVÉ — Case, ve kterém evidence vznikla; VOLITELNÉ (viz níže proč)
  subject: FactAddress,                  // NOVÉ — nahrazuje inputField jako strukturovaný typ
                                          //   (inputField zůstává jako odvozený formatFactAddress(subject)
                                          //    string pro zpětnou kompatibilitu čtenářů, ne druhý zdroj pravdy)
  workflowId?, operationId?,             // beze změny
  producerId, capabilityVersion, buildHash, schemaVersion,  // beze změny
  authorityDomain?,                      // beze změny
  inputValueHash, result,                // beze změny — POŘÁD jen hash a uzavřený slovník (AR-6)
  reusePolicy: "CASE_ONLY" | "TENANT_WIDE",  // NOVÉ — výchozí CASE_ONLY
  parentRefs, parentHashes, observedAt, expiresAt?,  // beze změny
  recordHash, keyId, platformSignature   // beze změny
}
```

**Výchozí `reusePolicy` je `CASE_ONLY`.** `Dojička`/`Planner`, když hledá dostupnou evidenci pro Case B, smí
bez dalšího podat jen evidenci s `originCaseId === caseB` NEBO `reusePolicy === "TENANT_WIDE"`. Nikdy prostý
`forTenant(tenantId)` scan bez tohohle filtru — to by přesně obnovilo riziko "fakt z cizího Case tiše splní
podmínku".

**Proč je `originCaseId` VOLITELNÉ, ne povinné (ověřeno v kódu 18. 9. 2026 — důležitý nález, který mění
tvar oproti prvnímu návrhu výš v diskuzi):** `createCaseForMailIntake()` (Commit 3) vytváří Case AŽ PO
`await orchestrator.run(inst.workflowId)`, protože potřebuje `mail.ingest`'s hotový výstup (`attachments[]`).
Ale `document.classify`'s krok, který volá `EvidenceWriter.write()` pro `document.type.invoiceConfirmed`, běží
UVNITŘ toho samého `orchestrator.run()` volání — tedy DŘÍV, než Case vůbec existuje. `EvidenceWriter` je navíc
navázaný na `producerId`/autoritu při konstrukci `wirePlatform()` (jednou za Durable Object, ne per-request) —
nemůže tedy mít `caseId` zadrátovaný v konstruktoru, a `HandlerInput`/`MessageEnvelope`/`TrustedContext` dnes
`caseId` vůbec nenesou (přidat ho tam by byl mnohem větší zásah, než "oprav Evidence tvar" — zasahuje do
dispatch typů použitých všude). Řešení: `originCaseId` se vyplní jen tam, kde je Case v okamžiku zapečetění
už prokazatelně známý (typicky fan-out sub-instance, které `fanOutAttachmentsIfAny()` spouští AŽ PO
`createCaseForMailIntake()` — tam už Case existuje). Kde není, zůstává `undefined` — a Case-scoped filtr
(část 2 výš) takovou evidenci prostě nikdy nenabídne jako reusable pro žádný Case (bezpečný default, ne
díra). Plné řešení ("Case vzniká dřív, než první krok, co zapisuje evidenci") patří k části 3/6 kroku 9, kdy
se stejně mění POŘADÍ vzniku Case vůči execution (Case vzniká z impulsu PŘED plánováním, ne po prvním kroku)
— tady se to neopravuje předčasně jako vedlejší efekt schématu.

**`TENANT_WIDE` je explicitní opt-in, per `authorityDomain`.** Např. `cz.company.verify`/`cz.vat.verify`
(existence firmy, platnost DIČ) dává smysl sdílet napříč Cases stejného tenanta — firma existuje nezávisle na
tom, která faktura ji zrovna zmiňuje. `document.classify` (je TENHLE konkrétní dokument faktura) nikdy nemá
smysl sdílet mimo svůj Case. Kde přesně se `reusePolicy` nastavuje (per producer v `authorities.json`, per
`facts.v1.json` klíč, nebo per capabilita v policy) je implementační detail dalšího kroku (část 6, krok 2) —
tenhle dokument fixuje jen princip a výchozí hodnotu, ne mechanismus.

**Co se NEMĚNÍ:** `EvidenceLedger` zůstává tenant-scoped storage (fyzická partice) — `AR-5` říká "tenant je
storage boundary", ne že se musí stavět per-Case DB. `forTenant()` zůstává, jen `Dojička`/budoucí
`CurrentCaseProjection` nad ním musí filtrovat podle `originCaseId`/`reusePolicy`, ne číst naslepo.

### Status

**LIVE WIRED, LIVE VERIFIED** (część 6, krok 2) — `Evidence` má `originCaseId?`/`subject: FactAddress`/
`reusePolicy` přesně podle tvaru výš, `EVIDENCE_SCHEMA_VERSION` postoupilo 2→3 se stejnou fail-closed disciplínou
(v1 i v2 záznamy `verify()` odmítá, nikdy tiše nepřijme). Commitnuto `7971ede`, nasazeno na `farm-bass443` a
vlastníkem živě potvrzeno (18.9.2026) — status níže byl původně "žádný commit/push/deploy"; to už neplatí, viz
část 11 pro to, co se stalo od tohodle bodu dál.

**Kde se implementace odchýlila od téhle skici (aby ADR zůstal pravdivý, ne jen "co bylo navrženo"):**
- `inputField: string` na `Evidence` **zůstal** jako reálné, uložené pole (ne odstraněný) — ale je teď ODVOZENÉ:
  `EvidenceLedger.append()` ho sám dopočítá jako `formatFactAddress(subject)`, žádný caller ho už nemůže zadat
  (`EvidenceCandidate` pole `inputField` nemá). Důvod: `evidence-sqlite.ts`'s SQL index, `evidence-mirror.ts`'s
  lookup a `aggregator.ts`'s `byField` seskupování všechny čtou `record.inputField` jako obyčejný string — nechat
  ho existovat (jen posunout, kdo ho píše) bylo levnější než přepisovat tři nezávislé čtenáře kvůli jednomu
  schématovému kroku.
- `reusePolicy` **není** pole na `EvidenceClaim` (co kráva per-volání tvrdí) — je to pole na `EvidenceWriter`'s
  `WriterIdentity`, svázané při konstrukci (`platform-wiring.ts`/`slice.ts`), stejně jako `authorityDomain`. Stejný
  princip jako "kráva si nemůže sama přiřadit vlastní autoritu" (M0 część C) — kráva by si jinak mohla nastavit
  `TENANT_WIDE` pro vlastní Case-specifickou evidenci.
- `originCaseId` teče do `EvidenceWriter.write()` jako třetí, volitelný parametr (`opts?: {originCaseId}`), ne
  jako pole `EvidenceClaim`u — a do handleru (document-classifier) teče přes capability-specifický payload
  (`caseId?` v `document.classify`'s `input.schema.json`, threaded skrz `attachment-classify.v1.json`'s step
  `inputs`), nikdy přes `HandlerInput`/`MessageEnvelope`/`TrustedContext` (mimo rozsah, jak tenhle dokument sám
  žádá). `AttachmentFanoutInput` dostalo nové POVINNÉ pole `caseId: string` (ne volitelné) — `fanOutAttachments()`
  je voláno jen z míst, kde Case už prokazatelně existuje (index.ts's `fanOutAttachmentsIfAny()` běží striktně po
  `createCaseForMailIntake()`), takže vynutit ho na typové úrovni bylo čistší než nechat volající tiše zapomenout.

---

## 3. Cílový pipeline

```
CHANNEL (mail, Telegram, folder, API, …)
   ↓ normalize() — jen tvar, nikdy význam
NormalizedImpulse                         ⟵ AR-2: žádné workflow/goal/intent pole
   ↓ newCase()
CASE                                      ⟵ AR-5: reasoning boundary
   ↓
CURRENT CASE PROJECTION                   ⟵ deterministická, TARGET (část 4)
   ↓ jen refy: artefakty, FactAddresses, evidence (s reusePolicy filtrem), efekty — ŽÁDNÉ hodnoty
INTENT (přes intent.resolve COW)          ⟵ TARGET (část 5), normální kráva, ne privilegovaný Farmář
   ↓ impulse.intent = INVOICE_RECEIVED | CALENDAR_QUERY | DOCUMENT_BUNDLE | GENERAL_QUESTION | UNKNOWN | …
GOAL (přes intent→goal mapping)           ⟵ TARGET, konfigurace, NE `if (intent === …)` v kódu
   ↓
PLANNER (goal + projection + catalog)     ⟵ existuje, dnes jen v testech (plan())
   ↓ PlanResult (PLANNED steps / CAPABILITY_GAP / CYCLE)
COMPILER (plan → immutable WorkflowDef)   ⟵ TARGET, SEVERKA's M3 "No-n8n Gate"
   ↓
ROUTER / POLICY                           ⟵ beze změny, stejný admission chain jako dnes
   ↓
COW execution                             ⟵ beze změny
   ↓
nový Artifact / Evidence                  ⟵ beze změny (+ originCaseId/reusePolicy, část 2)
   ↓
CASE PROJECTION znovu
   ↓ goal satisfied?
   ├─ ANO → Case.goalStatus = SATISFIED
   └─ NE  → další plán (nová immutable instance) / NEEDS_HUMAN / CAPABILITY_GAP
```

Tohle NENÍ mutace běžící instance (AR-3 zůstává) — je to smyčka MEZI samostatnými immutable
`WorkflowInstance`, řízená na úrovni Case. `docs/SEVERKA.md`'s formulace "runtime replanning po každém kroku
se nedělá" (řádek ~622) zůstává platná přesně v tomhle smyslu (žádná mutace běžící instance) — dokument
samotný to už implicitně otevírá ("případně později jako nová verze/pokračování"), tenhle ADR to jen
pojmenovává explicitně jako Case-level smyčku, aby to příští čtenář nemohl přečíst jako blanketní zákaz.

---

## 4. `CurrentCaseProjection` — kontrakt

**Status: HOTOVO jako čistý modul, bez runtime zapojení** (18. 9. 2026, `src/platform/case-projection.ts`,
`tests/case-projection.test.ts`) — přesně tak, jak vlastník žádal: "mergnul bych ji bez runtime wiring...
Čistý modul + testy + ADR je ideální první krok." Nic v `apf-gateway`/`planner.ts` ji zatím nevolá.

Deterministická funkce (žádné AI, žádné I/O mimo čtení), analogická k `fact-catalog.ts`'s vlastnímu pravidlu
"platforma nikdy nečte soubory" — čte `Case` + Žlab (přes `EvidenceLedger.forCase()`, część 2's
`originCaseId`/`reusePolicy` filtr — **jediné** místo, kudy se case-scoping aplikuje, nikdy `forTenant()`
napřímo) + `ArtifactReader` (přijímá se pro úplnost kontraktu, tenhle řez z něj zatím nic nečte — jen
`impulse`-level `ArtifactRef`, nikdy bajty) a vrací:

```
CurrentCaseProjection {
  projectionSchemaVersion: 1               // NOVÉ oproti původní skice, vlastníkův požadavek 18.9.2026
  caseId
  tenantId
  availableArtifacts: ArtifactRef[]        // impulse.artifacts (+ impulse.content, pokud existuje)
  availableFacts: FactAddress[]            // jen AVAILABLE adresy, deduplikované — vstup pro plan()
  facts: ProjectedFact[]                   // KAŽDÁ adresa, ve VŠECH kategoriích (diagnostika)
  pendingCapabilities: string[]            // TARGET, dnes vždy [] — viz "Vědomé zjednodušení" níže
}

ProjectedFact {
  address: FactAddress
  availability: "AVAILABLE" | "EXPIRED" | "INVALID_EVIDENCE" | "BLOCKED"
  recordId, producerId, observedAt         // provenance/reference — handle na dohledání, nikdy hodnota
  reason?: string                          // jen když availability != AVAILABLE, stavěno jen z id/timestampů/domén
}
```

**Rozhodnutí učiněná při implementaci (oproti původní skici výš, sloučeno na žádost vlastníka 18.9.2026):**

- **`availableFacts`/`availableEvidence` sloučeny do jednoho `availableFacts`.** V dnešním kódu je *každý*
  fakt evidence-backed (i `document.classify`'s výstup jde přes `EvidenceWriter`) — rozdíl mezi "fakt je
  doložený" a "evidence je platná" tedy dnes nemá samostatný smysl. Pokud v budoucnu vznikne fakt bez
  evidence (jiný zdroj pravdy), tenhle sloučený tvar se rozdělí zpět — revidovatelné, ne uzamčené.
- **Čtyři kategorie místo dvou (available/expired/invalidEvidence/blocked), `pending` vynechán na úrovni
  faktu.** Vlastníkův požadavek 18.9.2026: "implementace musí vědět rozdíl mezi *fakt neexistuje* a *fakt
  existuje, ale evidence je expired/wrong hash/wrong scope/untrusted*." `BLOCKED` pokrývá jak odvolanou/
  nekonfigurovanou autoritu (stejná kontrola jako Dojička's `revoked`), tak **nový nález cestou** — viz
  další bod. `pending` (běžící capability) je stavem *Case*, ne faktu (`Case.instances` nese jen
  workflowId, ne per-instance stav) — zůstává mimo `ProjectedFact`, viz "Vědomé zjednodušení" níže.
- **Nový, v původní skice nezmíněný invariant: konflikt = `BLOCKED`, nikdy "poslední vyhrává".** Když dvě
  nebo víc jinak platných (`AVAILABLE`-way) evidencí na STEJNÉ adrese nesouhlasí v `inputValueHash`, jsou
  **všechny** degradovány na `BLOCKED` s vysvětlujícím `reason` — žádná heuristika podle času/počtu/
  `reusePolicy` nevybírá vítěze. Vlastníkův požadavek 18.9.2026, přesná citace: *"Ambiguity = unavailable,
  ne heuristika."* Týká se hlavně `TENANT_WIDE` evidence sdílené napříč Case — pokud dvě Case nezávisle
  ověřily stejnou adresu s různým výsledkem, projekce to nikdy tiše nevyřeší.
- **Adresy se seskupují podle CELÉ trojice `(scope, key, entityId)`, nikdy podle `formatFactAddress()`**
  (ten `scope` do textové podoby nedává — dvě adresy se stejným `key`+`entityId`, ale jiným `scope`, by se
  jím tiše slily). Přesně to hlídá `tests/case-projection.test.ts`'s `PROJ-001`/`PROJ-002`/`PROJ-005`.
- **Determinismus nezávislý na pořadí Žlabu vynucen explicitním řazením** (`facts.sort()` podle adresy pak
  `recordId`) — bez toho by výstup závisel na tom, jestli `EvidenceLedger`'s backing store (paměť vs.
  SQLite) vrací záznamy ve stejném pořadí, což SQL bez `ORDER BY` negarantuje. `PROJ-010`.

**Vědomé zjednodušení, ne mezera:** `pendingCapabilities` je dnes vždy `[]`. `Case.instances` (case.ts) nese
jen pole `workflowId[]`, ne stav jednotlivé instance ani to, který capability krok zrovna běží — spočítat
tohle doopravdy vyžaduje přístup k journalu (`Instance`/`StepRecord`), který tahle funkce ve svém vstupním
kontraktu (Case + Žlab + Artifact store) záměrně nemá. Pole zůstává v kontraktu (jako v původní skice,
"volitelně") pro budoucí rozšíření bez breaking change — až bude naplněné, `projectionSchemaVersion` postoupí.

Vstup pro `plan({goal, available: <projection's availableFacts>}, catalog)` (`planner.ts`) — Planner se
nemění, jen dostává `available` (pole formátovaných adres) z projekce místo z ručně sepsaného seznamu (jak to
fan-out driver dělá dnes, viz część 7). **AR-1 platí i tady: projekce nikdy nevrací hodnotu, jen adresy/refy**
— žádné pole nikdy nenese `result`ani `inputValueHash`u; `tests/case-projection.test.ts`'s `PROJ-008` to
dokazuje i pro `reason` řetězce (poison-value test).

**Testy** (`tests/case-projection.test.ts`, 18 testů, `PROJ-000`…`PROJ-014`): schema version + prázdný Case;
dva dokumenty/dvě faktury v jednom Case se neslijí; konflikt na stejné adrese blokuje obě strany, shoda ne;
expirace; cizí entita nikdy nesplní dotaz; `CASE_ONLY` z jiného Case nikdy neprosákne (`forCase()`'s vlastní
hranice, jen ověřeno, ne znovu implementováno); poškozená/zfalšovaná evidence; workflow `SUCCEEDED` samo o
sobě netvoří fakt; determinismus nezávislý na pořadí Žlabu; byte-for-byte stejný výstup na stejný vstup;
žádná hodnota v žádném poli/reason (poison-value test); žádný network/model/I/O (synchronní, non-Promise);
žádný zápis nikam (Žlab/Case/Artifact store beze změny po zavolání); odvolaná/nenakonfigurovaná autorita
blokuje stejně jako u Dojičky.

**Convergence guard (vlastníkova poznámka 18.9.2026, k budoucímu kroku 9, część 6):** než vznikne Case-level
observe/plan/execute smyčka, ADR musí dostat explicitní guard proti nekonečnému přeplánování —
`projectionHash`/`planHash` (žádná změna mezi dvěma koly = konverguj/zastav), počet iterací, budget. **Zatím
NEIMPLEMENTOVÁNO** — zapsáno jako požadavek na krok 9 (część 6), ne jako dnešní práce.

---

## 5. Vstupní kontrakt — aditivní, ne destruktivní

**Rozhodnutí: `/intake` se nemění.** Zůstává jako legacy adaptér (`workflow` pole, `startIntake()`) do doby,
než je nová cesta hotová a živě ověřená na všech třech scénářích (část 8) — pak se `/intake` buď přepne na
interní použití nové cesty, nebo formálně označí jako deprecated. Tenhle dokument NEIMPLEMENTUJE nic z týhle
části — je to specifikace pro pozdější krok (část 6, krok 5).

Nová cesta (pracovní název `/impulse`, může se změnit):

```
POST /impulse
{
  channel: string,      // "mail" | "telegram" | "api" | "folder" | …
  content: …,           // kanálově specifický payload
  attachments?: …,
  metadata?: Record<string,string>
}
   ↓ normalize(channel-specific) → NormalizedImpulse
   ↓ newCase()
→ { caseId }            // A NIC VÍC — žádné workflow, goal, intent v requestu ani v odpovědi
```

Co se PO tomhle požadavku stane (intent.resolve → goal → plan → execution) je vnitřní věc Case-level smyčky
(část 3), ne vstupního kontraktu.

**Status: HOTOVO jako mechanismus, žádný živý kanál na něj zatím neukazuje** (19. 9. 2026,
`deploy/cloudflare/apf-gateway/src/index.ts`'s `POST /impulse` route + `WorkflowInstance`'s nové
`createCase()`/`caseByCaseId()` DO metody, `src/platform/impulse.ts`'s `normalizeImpulse()`). `/intake` a
`/mail-intake` zůstávají beze změny (ověřeno diffem i testy) — přesně jak tahle část žádá. Žádný ingress
kanál `/impulse` zatím nevolá; mail pořád běží přes svou vlastní `createCaseForMailIntake()` (část 7's
dočasný kompromis, nedotčeno). Scénář B (část 8) proto zůstává neověřený a `/intake`'s přepnutí/deprecation
čeká přesně na to, co tahle část sama žádá — živé ověření na všech třech scénářích, ne jen na tenhle commit.

**Rozhodnutí učiněná při implementaci** (vlastník řekl "up to you" na rozsah, 19. 9. 2026):

- **`content` zúženo na `text?` + `attachments?: string[]` (existující ArtifactRef id), žádné syrové bajty.**
  `normalizeImpulse()` (`src/platform/impulse.ts`) nikdy nečte bajty, nedělá extrakci, nesahá na R2/AI —
  stejná disciplína jako `fact-catalog.ts`'s "platforma nikdy nečte soubory". Kanál, který má jen syrové
  bajty (upload, binární příloha), je musí napřed proměnit v Artifact jinudy (přesně jak to dnes dělá mail
  přes `mail.ingest`) — teprve pak zavolat `/impulse`. Vědomé zjednodušení, ne mezera (stejný tvar jako
  `case-projection.ts`'s `pendingCapabilities`): binary/extrakce zůstává příští, kanál-specifickou prací,
  ne něco, co má sdílený normalizer řešit už teď.
- **Case storage adresování: nové DO pojmenované přímo `caseId`.** `caseView()`'s vlastní doc comment (Commit
  3) tohle výslovně označil za mezeru — "no external caseId -> Durable Object index... out of scope here".
  Řešení: `/impulse` mintuje `caseId` PŘED adresováním DO (`env.WORKFLOW.idFromName(caseId)`), stejný vzor
  jaký `startIntake()`/`startMailIntake()` už používají pro `workflowId` — žádný extra index není potřeba,
  protože jméno DO JE `caseId`. `GET /case/(case-…).json` (nová `caseByIdRoute`) čte zpátky přes stejné
  jméno; `GET /case/(wf-…).json` (`caseView()`) zůstává nedotčené pro Case s ≥1 instancí.
- **Odpověď přesně `{ caseId }`, 201.** Žádné pole navíc — ani `impulseId`, ani echo vstupu.

**Testy:** `tests/impulse.test.ts` (`IMP-000`…`IMP-010`, čistá funkce `normalizeImpulse()` — text/attachments/
metadata pass-through, prázdný/whitespace impuls odmítnut, žádné workflow/goal/intent pole strukturálně,
synchronní/no I/O, `newCase()` bez instance dá `UNSTARTED`/`instances: []`). Následováno adversariální
verifikací (5 nezávislých agentů, jeden na invariant, stejná metodika jako část 4): žádný z pěti napaden
neuspěl — AR-2 (žádné workflow/goal/intent), no-instance-created, `/intake`+`/mail-intake` nedotčené,
tenant server-side + fail-closed na prázdný/malformed vstup, caseId/workflowId adresování bez kolize. Dva
nezávislé agenty stejně upozornily na jednu nebugovou mezeru (metadata nebyla hluboce validovaná na
`Record<string,string>`, jen `typeof === "object"`) — opraveno týž den.

---

## 6. Pořadí implementace (vlastníkovo rozhodnutí 18. 9. 2026, upraveno stejného dne — viz část 11)

1. **Tenhle dokument** — bez zásahu do runtime. ✅ (tenhle commit, `7971ede`)
2. **Evidence/Case hranice** (část 2) — `originCaseId`/`subject`/`reusePolicy` na Evidence, `Dojička`/každý
   čtenář evidence přepnutý na filtrovaný přístup. ✅ (`7971ede`, živě nasazeno a potvrzeno)
3. **Tři P0 opravy primitiv** (část 11, vloženo 18.9.2026 týž den po externím auditu tohohle dokumentu) — Case
   bez instance, NormalizedImpulse bez těla mailu, fact scope pro >1 dokument v Case. **Vloženo PŘED
   `CurrentCaseProjection` právě proto, že by je Projection jinak zabetonovala jako implicitní předpoklad.** ✅
   (`db5bc8b`, živě nasazeno)
4. **`CurrentCaseProjection`** (část 4) — teprve TEĎ, na opravené hranici A opravených primitivech. ✅
   (`2a688c8`, 18.9.2026, adversariálně ověřeno 19.9.2026 — viz část 4)
5. **Nový vstupní kontrakt** (část 5) — aditivně, `/intake` zůstává jako legacy adaptér. ✅ mechanismus hotový
   19.9.2026, adversariálně ověřeno — viz část 5. Žádný živý kanál ho zatím nepoužívá.
6. **`intent.resolve`** — normální COW, ne privilegovaný Farmář. Vstup: impulse/artifact refy. Výstup:
   `impulse.intent` hodnota (do Artifactu, ne do Žlabu přímo — stejný vzor jako `invoice.extract`), evidence
   `impulse.intent.resolved` (uzavřený slovník, AR-6). ✅ mechanismus hotový 19.9.2026
   (`src/components/intent-resolver/`), adversariálně ověřeno (5/5 REFUTED). Registrováno v obou kompozičních
   kořenech (`src/slice.ts`, `platform-wiring.ts`) a v obou instalacích (policy/profile/lifecycle), ale zatím
   volané jen z testů — žádný workflow krok, žádný živý producent. Zúženo oproti skice: `artifactId` povinné
   (žádný inline text), stejná disciplína jako `document.classify`/`invoice.extract`.
7. **Intent → Goal mapping** — konfigurace (JSON/policy vrstva), nikdy `if` v orchestration kódu. Tohle je
   přesně ten bod, kde se láme n8n vs. Farma (AR-4).
8. **`plan → WorkflowDef` compiler** — SEVERKA's M3 "No-n8n Gate". Planner beze změny, jen nový spotřebitel
   jeho výstupu.
9. **Case-level replanning loop** (část 3) — observe → plan → immutable execution → nový stav → observe.
10. Teprve **potom** další invoice-specific práce (2. faktura entity, `invoice.line`, M2) — **s výjimkou fact
    scope pro >1 dokument v Case, které krok 3 (část 11) už řeší teď, ne tady** (to je přesně to, co externí
    audit 18.9.2026 rozporoval: tenhle bod v původním pořadí odsouval fact-scope opravu až sem, za
    `CurrentCaseProjection` — viz část 11).

Žádný krok se nezačíná bez živého ověření kroku předchozího (stejná disciplína jako M0 D→C→A→B→E).

---

## 7. Co zůstává jako vědomě dočasný kompromis

`attachment-fanout.ts` (Commit 1–3) je **záměrně přechodový**, ne vzor pro další agendy. Má natvrdo:
`CLASSIFY_PRODUCER_ID`, `CLASSIFY_INPUT_FIELD`, `CLASSIFY_INVOICE_RESULT`, `INVOICE_CONFIRMED_EVIDENCE_KEY`, a
hlavně `goal = catalog.flowOf("invoice.extract")?.produces` — tedy "zkus dosáhnout `invoice.extract`", ne
"zjisti, co se má udělat". To je přesně to, co část 3–6 nahradí `CurrentCaseProjection`/`intent.resolve`/
goal-mapping smyčkou. **Nesmí se replikovat** (`contract-fanout.ts`, `order-fanout.ts`, …) — další agenda
čeká na kroky 3–8 výše, ne na kopii `attachment-fanout.ts` s jiným `goal`.

`Case.status` (Commit 3) je dnes čistě **execution health** (`RUNNING/WAITING/SUCCEEDED/PARTIAL/FAILED/
CANCELLED`, `aggregateCaseStatus()`) — potvrzeno, žádný goal-satisfaction koncept v kódu neexistuje. Cílově se
rozděluje na:

```
Case.executionStatus:  RUNNING | WAITING | SUCCEEDED | PARTIAL | FAILED | CANCELLED   // dnešní aggregateCaseStatus()
Case.goalStatus:        UNRESOLVED | PLANNABLE | SATISFIED | CAPABILITY_GAP
                         | NEEDS_INPUT | NEEDS_APPROVAL                                 // TARGET, čeká na část 6 kroky 3+6+7
```

Přesné jméno pole/hodnot se může při implementaci ještě upřesnit — princip (dva nezávislé stavy, "všechno
doběhlo zeleně" ≠ "business cíl splněn") je to, co se tímhle dokumentem fixuje.

---

## 8. Akceptační scénáře — anti-n8n test

Všechny tři musí projít **stejným core runtime** (část 3). Lišit se smí jen capabilities, fakta a
konfigurace cílů — nikdy centrální orchestrace.

- **A — mail + faktura.** Živě ověřeno opakovaně (`80b6a8d`…`e127987`, `HANDOFF` #172–181): mail.ingest →
  fan-out → classify → (jen pro fakturu) extract → derived Artifact. Dnes běží přes `attachment-fanout.ts`
  (část 7's dočasný kompromis) — po kroku 9 poběží přes obecnou smyčku beze změny výsledku.
- **B — Telegram: "jaké bude zítra počasí?"** Kanál (Telegram) ani doména (weather) dnes neexistují.
  **Nesmí vyžadovat `weather-driver.ts` ani `telegram-workflow.ts`.** Musí jít přidat jako: nový channel
  adapter (normalize() pro Telegram tvar), nová capability `weather.forecast` + `facts.json`, nový
  intent→goal mapping záznam (`WEATHER_QUERY → weather.answerReady`). Nic v `src/platform/*` se nesmí měnit.
- **C — mail + smlouva + faktura + obyčejná fotka.** Částečně živě ověřeno (`e127987`, dnešní test):
  fan-out správně rozliší CONTRACT/INVOICE/OTHER a extrahuje jen fakturu. Chybí ještě: totéž musí platit i
  přes obecnou `CurrentCaseProjection`/Planner smyčku, ne jen přes mail-specifický driver.

**Test selhání:** pokud scénář B vyžaduje nový soubor v `src/platform/`, návrh je špatně. Pokud přidání
`weather.forecast` capability vyžaduje úpravu `Orchestrator`/`Router`/`Case`/Plannera, návrh je špatně.
Ekvivalent SEVERKA's M8.

---

## 9. Stav konceptů dnes (TARGET / PRIMITIVE EXISTS / LIVE WIRED / LIVE VERIFIED)

| Koncept | Stav | Poznámka |
|---|---|---|
| `NormalizedImpulse` | LIVE WIRED, LIVE VERIFIED | jen mail kanál (`createCaseForMailIntake()`); od `db5bc8b` (část 11) i `content?: ArtifactRef` — mail body konečně dosažitelné z Case, ne jen z journalu |
| `Case` + `aggregateCaseStatus()` | LIVE WIRED, LIVE VERIFIED (execution-status, N≥1 cesta) / PRIMITIVE EXISTS (N=0) | Commit 3, `e127987`; execution-status only (část 7). Od `db5bc8b` (část 11) `newCase()`/`aggregateCaseStatus()` strukturálně zvládají i 0 instancí (`CaseStatus`'s nové `UNSTARTED`) — primitivum existuje, ale žádný živý producent ještě Case s 0 instancemi nevytváří (čeká na `/impulse`, část 5, pořád TARGET) |
| `GET /case/:id.json` | LIVE WIRED, LIVE VERIFIED | řeší sub-instance lookup mezeru z živého testu 18.9. |
| `FactAddress` | PRIMITIVE EXISTS (obecně) / LIVE WIRED, LIVE VERIFIED (`document.type.invoiceConfirmed`) | `fact-address.ts`, používá se v `entity-continuity.ts` i strukturálně na `Evidence.subject` (část 2). Od `db5bc8b` (část 11) `document.type.invoiceConfirmed` skutečně používá `scope: "impulse.attachment"` + `entityId` živě — první reálný spotřebitel entity-scoped adresy mimo testy |
| `EvidenceLedger` (D6, v3) | LIVE WIRED, LIVE VERIFIED | `forTenant()` beze změny živě ověřené; `forCase()` (část 2) nasazeno a vlastníkem potvrzeno `7971ede`; `attachment-fanout.ts`'s `classifiedAsInvoice()` od `db5bc8b` (část 11) čte přes `subject.scope`/`subject.entityId`, ne přes `workflowId`-koincidenci |
| `Evidence.originCaseId`/`subject`/`reusePolicy` | LIVE WIRED, LIVE VERIFIED | nasazeno `7971ede`, vlastníkem potvrzeno živě 18.9.2026 (farm-bass443 běží na schema v3) |
| `FactCatalog` / `plan()` | PRIMITIVE EXISTS | volané jen z testů a `attachment-fanout.ts` (úzký `goal`, část 7) |
| `CurrentCaseProjection` | PRIMITIVE EXISTS | część 4 — `case-projection.ts`, 18 testů (`PROJ-000`…`PROJ-014`), 18.9.2026. Čistý modul, žádné runtime zapojení (žádný caller v `apf-gateway`/`planner.ts` zatím) |
| `impulse.intent` / `impulse.intent.resolved` | PRIMITIVE EXISTS | `facts.v1.json`, producent existuje (`intent.resolve`, 19.9.2026) — registrovaný, ale zatím žádný živý caller |
| `intent.resolve` COW | PRIMITIVE EXISTS | část 6 krok 6 — `src/components/intent-resolver/`, 19.9.2026. Adversariálně ověřeno (5/5), žádné workflow zapojení zatím |
| Intent → Goal mapping | TARGET | část 6 krok 7 |
| `plan → WorkflowDef` compiler | TARGET | SEVERKA M3, část 6 krok 8 |
| Case-level replanning loop | TARGET | část 3, 6 krok 9 |
| `/impulse` vstupní kontrakt | PRIMITIVE EXISTS | část 5 — `POST /impulse`, `src/platform/impulse.ts`, 19.9.2026. Mechanismus + testy + adversariální verifikace hotové; žádný živý kanál ho zatím nevolá (mail pořád jde přes `createCaseForMailIntake()`), `/intake` beze změny |
| `attachment-fanout.ts` | LIVE WIRED, LIVE VERIFIED | vědomě dočasný (část 7), nekopírovat |

---

## 10. Co se tímto dokumentem NEMĚNÍ (rejected / explicitně mimo rozsah)

- **Neruší se Orchestrator, WorkflowDef, ani dnešní `mail-intake.v3`/`attachment-classify`/`attachment-
  extract` workflow definice.** Zůstávají execution-layer primitivem (AR-8).
- **Nestaví se `weather.forecast` ani žádná Telegram/folder ingest kapacita teď.** Scénář B (část 8) je
  akceptační test pro BUDOUCÍ ověření, ne úkol k implementaci.
- **Nemění se `/intake` ani `startIntake()`.** Zůstává beze změny, dokud část 5 není hotová a ověřená.
- **Nestaví se per-Case fyzická databáze.** Žlab zůstává tenant-partitioned storage (AR-5); mění se jen
  logická projekce nad ním.
- **Nerozhoduje se dnes přesný název/tvar `/impulse` endpointu ani finální `reusePolicy` konfigurační
  mechanismus** — jen princip a výchozí hodnota (`CASE_ONLY`). Detaily patří do implementačního kroku, ne
  do tohoto ADR.

---

## 11. Tři P0 opravy primitiv před `CurrentCaseProjection` (externí audit, 18. 9. 2026, týž den jako commit
`7971ede`)

### Co audit zjistil

Hned po `7971ede` (tenhle dokument + část 2) prošel projekt nezávislým, důkladným auditem, který proti živému
`main` ověřil tři konkrétní tvrzení — všechna se potvrdila přesně tak, jak je audit formuloval, čtením
skutečného kódu (ne jen GitHub diffů), a to i s upřesněními, která audit sám neměl k dispozici (viz níže u P0
č. 3). Společný nález: ADR's vlastní **část 6** (Pořadí implementace) odsouvala opravu fact-scope pro >1
dokument v Case až na úplný konec (dřívější krok 9, teď krok 10) — ZA `CurrentCaseProjection` (dřívější krok 3,
teď krok 4). Kdyby se Projection postavila jako první, zabetonovala by implicitní předpoklad "jeden Case = jeden
`document.type` = jedna faktura", který ADR's vlastní akceptační scénář C (část 8) už porušuje (mail s
CONTRACT + INVOICE + OTHER v jednom impulsu). **Rozhodnutí: vložit tyhle tři opravy jako nový krok 3 (część 6),
PŘED `CurrentCaseProjection` (teď krok 4), ne za ni.**

### P0 č. 1 — `Case` nemohl existovat s 0 instancemi

`newCase()` (`case.ts`) vždy vyžadoval `instance` a okamžitě naplnil `Case.instances`; `aggregateCaseStatus([])`
házel `CaseError`. Skutečná závislost tak byla `WorkflowInstance → Case`, ne `Case → WorkflowInstance`, jak
popisuje část 3's cílový pipeline. **Oprava:** `CaseStatus` má nový stav `UNSTARTED`; `aggregateCaseStatus([])`
teď vrací `UNSTARTED` místo throw; `newCase()`'s `instance` je volitelný (chybí-li, `tenantId`/`createdAt`/
`updatedAt` se berou z impulsu samotného — funkce zůstává pure, žádné I/O). **Vědomě NEřešeno tímhle krokem**
(mimo scope, viz ADR's vlastní zámek na `/intake` v úvodu dokumentu): žádný živý producent Case s 0 instancemi
ještě nevytváří — to je práce `/impulse` (část 5, pořád TARGET). Tenhle krok jen dělá primitivum SCHOPNÉ tenhle
stav reprezentovat, až `/impulse` přijde.

### P0 č. 2 — `NormalizedImpulse` ztrácel tělo mailu

`createCaseForMailIntake()` (`apf-gateway/src/index.ts`) stavěl `impulse.artifacts` jen z `mail.ingest`'s
`attachments[]` — nikdy z `mail.ingest`'s vlastního combined-text artefaktu (tělo + text každé přílohy
dohromady, přesně to, co `document.classify` reálně čte). Existující komentář v kódu tvrdil, že "tělo mailu už
žije jako svůj artefakt" — pravda, ale nikde v `Case`/`NormalizedImpulse` na něj nebyl odkaz, takže prostý mail
bez přílohy ("Jaké bude zítra počasí v Brně?") stavěl Case s prázdnými `artifacts`, nedefinovaným `text` a jen
`metadata.subject` — samotná otázka byla z Case nedosažitelná. **Oprava:** nové volitelné pole
`NormalizedImpulse.content?: ArtifactRef`, naplněné v `createCaseForMailIntake()` z `mail.ingest`'s
`payload.artifactId`. Teď-nepravdivý komentář opraven, aby popisoval skutečný stav.

### P0 č. 3 — fact/evidence kontrakt neuměl >1 dokument v jednom Case

`contracts/facts.v1.json` deklarovalo `document.type`/`document.type.validated`/`document.type.invoiceConfirmed`
bez `scope` → `fact-catalog.ts`'s výchozí `CASE_SCOPE` je udělal per-Case singletony.
`document-classifier/handler.ts`'s `seal()` natvrdo psal `scope: CASE_SCOPE`. `attachment-fanout.ts`'s
`classifiedAsInvoice()` tohle maskoval dodatečným filtrem `e.workflowId === classifyWorkflowId` — přesně to,
co część 7 tohohle dokumentu označuje jako "vědomě dočasný kompromis... NESMÍ se replikovat".

**Co audit sám nevěděl** (četl jen GitHub, ne živý entity mechanismus): `fact-address.ts`/`fact-catalog.ts` už
dnes podporují "many"-multiplicity entity s `entityId` a `contracts/facts.v1.json` už jednu takovou entitu
deklaruje — `impulse.attachment` (identityFields sha256+name). Oprava tedy nebyla "postav multi-document podporu
od nuly", ale menší: přeskopovat `document.type.invoiceConfirmed` na existující `impulse.attachment` entitu.
**Oprava (záměrně úzká, jen tenhle jeden fact):** `document.type.invoiceConfirmed`'s evidence `subject` teď nese
`scope: "impulse.attachment"` + `entityId`, mintovaný jednou za přílohu v `mail.ingest`'s handleru
(`newEntityId()`), protažený přes `attachment-classify.v1.json`'s step inputs do `document-classifier`'s handleru.
`attachment-fanout.ts`'s `classifiedAsInvoice()` teď čte `subject.scope`/`subject.entityId` místo
`workflowId`-koincidence. **Nový test FANOUT-003** živě dokazuje akceptační scénář C: dvě faktury v jednom Case,
každá se klasifikuje a extrahuje nezávisle, dvě odlišné zapečetěné evidence, žádné křížení.

`document.type` a `document.type.validated` **zůstaly záměrně CASE_SCOPE** — mají živé konzumenty v
whole-mail stamp/archive/notify pipeline (`document-validator`, `document-executor-host`, `email-executor`,
`mail-intake.v3.json`'s netknutý top-level flow), které by přeskopování rozbilo, a scénář C je přes ně
nevyžaduje (jen přes `document.type.invoiceConfirmed`, fan-out cestou). `invoice.number`/`invoice.totalGross`/
`supplier.*` zůstávají CASE_SCOPE taky — vědomě odloženo jako samostatný budoucí krok (stejný gap o úroveň výš,
menší, čeká až bude potřeba, "jeden krůček" princip).

**Vedlejší, výslovně nahlášená změna chování:** top-level `classify` krok v `mail-intake.v3.json` (klasifikace
CELÉHO mailu, ne jedné přílohy) už nezapečeťuje `document.type.invoiceConfirmed` vůbec (dřív ano, CASE_SCOPE) —
ověřeno, že tuhle evidenci nic živé nečetlo (`invoice.extract` se váže jen na `attachment-classify` sub-instanci).

### Status

**LIVE WIRED, LIVE VERIFIED**, všechny tři. Implementováno v izolovaných git worktree (jeden branch na opravu),
každý nezávisle otestován (`npm test`/`typecheck`/`arch` skutečně spuštěné, ne jen dry-run), pak mergnuto
sekvenčně do `main` (`6ffe3f4` → `bc18955` → `db5bc8b`, bez konfliktů), znovu 687/687 testů + `npm run
farm:check` na `main`, pushnuto a nasazeno na `farm-bass443` (`node scripts/farm-deploy.mjs farm-bass443`, všech
6 workerů). Živé potvrzení gitSha přes `/farm/zlab.json` čeká na vlastníkovo přihlášení (endpoint je za
Cloudflare Access).
