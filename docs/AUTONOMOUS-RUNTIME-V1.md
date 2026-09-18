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
díra). Plné řešení ("Case vzniká dřív, než první krok, co zapisuje evidenci") patří k části 3/6 kroku 8, kdy
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

**IMPLEMENTOVÁNO lokálně 18.9.2026** (část 6, krok 2, přímo navazující krok po tomhle dokumentu) — `Evidence` má
`originCaseId?`/`subject: FactAddress`/`reusePolicy` přesně podle tvaru výš, `EVIDENCE_SCHEMA_VERSION` postoupilo
2→3 se stejnou fail-closed disciplínou (v1 i v2 záznamy `verify()` odmítá, nikdy tiše nepřijme). **Žádný commit,
push ani deploy** — jen lokální change set + testy (viz `HANDOFF.md`, nejnovější záznam).

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

Deterministická funkce (žádné AI, žádné I/O mimo čtení), analogická k `fact-catalog.ts`'s vlastnímu pravidlu
"platforma nikdy nečte soubory" — čte Case + Žlab (s `reusePolicy` filtrem, část 2) + Artifact store a vrací:

```
CurrentCaseProjection {
  caseId
  availableArtifacts: ArtifactRef[]        // co Case má k dispozici
  availableFacts: FactAddress[]            // jaké FactAddresses jsou doložené (jen adresy, ne hodnoty)
  availableEvidence: FactAddress[]         // jaká evidence je platná (nevypršela, správný reusePolicy)
  pendingCapabilities: string[]?           // volitelně: co ještě běží / na co se čeká
}
```

Vstup pro `plan({goal, available: <projection's availableFacts+availableEvidence keys>}, catalog)` — Planner
se nemění, jen dostává `available` z projekce místo z ručně sepsaného seznamu (jak to fan-out driver dělá
dnes, viz část 7). **AR-1 platí i tady: projekce nikdy nevrací hodnotu, jen adresy/refy.**

Status: **TARGET**, nic z tohohle dnes neexistuje jako pojmenovaná funkce (existují jen stavební kameny:
`Case`, `EvidenceLedger.forTenant()`, `ArtifactReader`).

---

## 5. Vstupní kontrakt — aditivní, ne destruktivní

**Rozhodnutí: `/intake` se nemění.** Zůstává jako legacy adaptér (`workflow` pole, `startIntake()`) do doby,
než je nová cesta hotová a živě ověřená na všech třech scénářích (část 8) — pak se `/intake` buď přepne na
interní použití nové cesty, nebo formálně označí jako deprecated. Tenhle dokument NEIMPLEMENTUJE nic z týhle
části — je to specifikace pro pozdější krok (část 6, krok 4).

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

---

## 6. Pořadí implementace (vlastníkovo rozhodnutí 18. 9. 2026)

1. **Tenhle dokument** — bez zásahu do runtime. ✅ (tenhle commit)
2. **Evidence/Case hranice** (část 2) — `originCaseId`/`subject`/`reusePolicy` na Evidence, `Dojička`/každý
   čtenář evidence přepnutý na filtrovaný přístup. Přímo navazující krok.
3. **`CurrentCaseProjection`** (část 4) — teprve TEĎ, na opravené hranici.
4. **Nový vstupní kontrakt** (část 5) — aditivně, `/intake` zůstává jako legacy adaptér.
5. **`intent.resolve`** — normální COW, ne privilegovaný Farmář. Vstup: impulse/artifact refy. Výstup:
   `impulse.intent` hodnota (do Artifactu, ne do Žlabu přímo — stejný vzor jako `invoice.extract`), evidence
   `impulse.intent.resolved` (uzavřený slovník, AR-6).
6. **Intent → Goal mapping** — konfigurace (JSON/policy vrstva), nikdy `if` v orchestration kódu. Tohle je
   přesně ten bod, kde se láme n8n vs. Farma (AR-4).
7. **`plan → WorkflowDef` compiler** — SEVERKA's M3 "No-n8n Gate". Planner beze změny, jen nový spotřebitel
   jeho výstupu.
8. **Case-level replanning loop** (část 3) — observe → plan → immutable execution → nový stav → observe.
9. Teprve **potom** další invoice-specific práce (2. faktura entity, `invoice.line`, M2).

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
  (část 7's dočasný kompromis) — po kroku 8 poběží přes obecnou smyčku beze změny výsledku.
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
| `NormalizedImpulse` | LIVE WIRED, LIVE VERIFIED | jen mail kanál (`createCaseForMailIntake()`), živě ověřeno dnešním testem |
| `Case` + `aggregateCaseStatus()` | LIVE WIRED, LIVE VERIFIED | Commit 3, `e127987`; execution-status only (část 7) |
| `GET /case/:id.json` | LIVE WIRED, LIVE VERIFIED | řeší sub-instance lookup mezeru z živého testu 18.9. |
| `FactAddress` | PRIMITIVE EXISTS | `fact-address.ts`, používá se v `entity-continuity.ts` i teď strukturálně na `Evidence.subject` (část 2) |
| `EvidenceLedger` (D6, v3) | LIVE WIRED, LIVE VERIFIED (tenant-scoped) / PRIMITIVE EXISTS (case-scoped) | `forTenant()` beze změny živě ověřené; nové `forCase()` (část 2) implementováno + testováno lokálně 18.9.2026, zatím NEnasazeno (žádný commit/push/deploy v tomhle kroku) |
| `Evidence.originCaseId`/`subject`/`reusePolicy` | PRIMITIVE EXISTS | implementováno + testováno lokálně 18.9.2026 (část 2, tenhle krok); NENÍ LIVE WIRED/VERIFIED — žádný commit/push/deploy proběhl, farm-bass443 dál běží na schema v2 |
| `FactCatalog` / `plan()` | PRIMITIVE EXISTS | volané jen z testů a `attachment-fanout.ts` (úzký `goal`, část 7) |
| `CurrentCaseProjection` | TARGET | část 4, nic neexistuje |
| `impulse.intent` / `impulse.intent.resolved` | PRIMITIVE EXISTS (jen slovník) | `facts.v1.json`, žádný producent |
| `intent.resolve` COW | TARGET | část 5 |
| Intent → Goal mapping | TARGET | část 6 krok 6 |
| `plan → WorkflowDef` compiler | TARGET | SEVERKA M3, část 6 krok 7 |
| Case-level replanning loop | TARGET | část 3, 6 krok 8 |
| `/impulse` vstupní kontrakt | TARGET | část 5, aditivní, `/intake` zůstává |
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
