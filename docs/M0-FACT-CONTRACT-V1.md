# M0 — Fact Contract v1: návrh (15. 9. 2026)

**Stav: NÁVRH SCHVÁLEN vlastníkem 15. 9. 2026 — všechny čtyři krůčky uzavřeny (R1–R7 rozhodnuto).
Implementace v pořadí D → C → A → B, každá část po malých commitech s vlastními Test ID; D navíc live
verification.** Postup po krůčcích: **krůček 1 FactAddress — UZAVŘENO** (část A, R1) · **krůček 2
EntityHash — UZAVŘENO** (část B) · **krůček 3 AuthorityGrant — UZAVŘENO** (část C, R2 + R6) · **krůček 4
DurableFactStore — UZAVŘENO** (část D, R3 + R4 + R5) · **krůček 5 Impuls a Case — UZAVŘENO 16. 9. 2026** (část 0; zavádí
část E Case). **Část C implementačně hotová 16. 9. 2026** (C-1 živě ověřeno, C-2 AUTH-004/005 hotovo, AUTH-007
vědomě odloženo do M4/M5 — viz část C níže). Implementace pokračuje: **A → B → E**.
Roadmapa: `SEVERKA.md ## Roadmapa M0–M8`. Vychází z Posudku 17 (`POSUDKY.md`, kola 4–5) a z dnešního
kódu — každý datový tvar níže je navázaný na existující typ, ne vymyšlený od nuly.

**Exit M0 (vlastníkova formulace):** umíme jednoznačně říct, jak se **adresuje, hashuje, eviduje a
invaliduje** libovolný fakt včetně `invoice.lines`. Teprve potom se vyrábějí další krávy.

**Tři povinné exit vrstvy:** functional (Test ID níže) · adversarial (scénáře níže jako testy, ne
poznámky) · live farm verification (nasazeno, `gitSha` potvrzen, reálná evidence přežije evikci DO).

Co dnes existuje a na co se navazuje:

| Dnes | Kde | Co z toho M0 mění |
|---|---|---|
| `Evidence` { recordId, tenantId, workflowId?, operationId?, producerId, capabilityVersion, buildHash, schemaVersion, inputField, inputValueHash, result, parentRefs, parentHashes, observedAt, expiresAt?, recordHash, keyId, platformSignature } | `src/platform/evidence.ts:19` | + `authorityDomain?`, `inputField` = kanonická `FactAddress`, `schemaVersion: "2"` |
| `EvidenceClaim` { inputField, inputValueHash, result, parentRefs?, parentHashes?, expiresAt? } — kráva nemá jak podvrhnout identitu | `src/platform/evidence-writer.ts:5` | beze změny tvaru; `expiresAt` se ořezává grantem |
| `RequiredEvidence` { field, producerId, acceptableResults? } | `src/platform/aggregator.ts:41` | `producerId` → `authorityDomain` (producer jen jako výjimka) |
| `CertifiedBusinessObject` + `AggregateResult.fieldHashes` (Posudek 15/16) | `src/platform/konev.ts`, `aggregator.ts:38` | klíče `fieldHashes` = kanonická `FactAddress` (i s entitou) |
| `EvidenceLedger` = in-memory `Map`, jediná write cesta `append()`, `verify()`, `verifyLineage()` | `src/platform/evidence.ts:69` | stejné API, nový storage backend (DO SQLite + D1 zrcadlo) |
| DO per `workflowId` (`WORKFLOW.idFromName`), SQLite journal/audit/artifacts/review, audit zrcadlené do D1 insert-only s `mirrored` flagem | `apf-gateway/src/index.ts:548`, `store.ts:16-26` | Žlab dostane stejný vzor |
| `newId(prefix)` časově řaditelné id bez business obsahu | `src/platform/ids.ts` | `entityId = newId("ent")` |
| `canonicalize()` + `sha256()` | `src/platform/canonical.ts`, `artifacts.ts` | `entityHash` |
| policy grant per capability { actorId, actorType, scopes, tenants, rateLimit } (ADR-016) | `config/farm-bass443/policy/*.policy.json` | vzor pro `authorities.json` |
| `buildHash` = placeholder `"slice-dev"`; živý `/version` už nese `gitSha` | `src/slice.ts:112` | `buildHash := gitSha` (rozhodnutí R5) |

---

## 0. Impuls a Case — vstup je neomezený, kanál nikdy neurčuje význam (krůček 5, 16. 9. 2026)

Stav: **UZAVŘENO 16. 9. 2026** — vlastník potvrdil beze změn. Z Posudku 17 kola 6 (`SEVERKA.md ## Impuls, Case a
neomezený vstup`). Revize návrhu **před** dalšími kravami: Farma musí umět začít z úplně neznámého impulsu, a dnešní model to
neumí (ověřeno v kódu, viz níže). Jen rozhodnutí, žádný kód.

### Datový tvar

```
NormalizedImpulse = { impulseId, tenantId, channel, sender?, receivedAt, text?, artifacts: ArtifactRef[],
                      thread?, metadata: Record<string, string> }
   — jediný tvar pro všechny kanály; ingress adapter jen převádí (Slack: channel=slack, sender, text,
     attachments, thread, timestamp → totéž co e-mail nebo upload). Strukturálně NEMÁ pole workflow/goal/intent.

Case = { caseId, tenantId, impulse: NormalizedImpulse, ledger: Žlab, instances: WorkflowInstance[], status }
   — jeden impuls · jeden Žlab · N workflow instancí v čase (discovery, pak zpracování, případně přeléčení).
```

Klíče slovníku (aditivně, nahrazují dnešní `mail.*`): `impulse.raw` (artifact), `impulse.channel` (fact, source),
`impulse.sender`, `impulse.subject`, `impulse.text` (facts, source), `impulse.attachment` (**entita**,
`multiplicity: many`, `identityFields`: `impulse.attachment.sha256`, `impulse.attachment.name` — první reálné
použití části A), `impulse.intent` (fact, derived — výstup `intent.resolve`; slovník hodnot uzavřený, včetně
`UNKNOWN`), `impulse.intent.resolved` (evidence, `for: impulse.intent`).

**Implementace (A-2, jen slovník) HOTOVO 16. 9. 2026, HANDOFF 171** — `contracts/facts.v1.json` dostal všech osm
klíčů výše + entitu `impulse.attachment` aditivně, `mail.raw`/`mail.sender`/`mail.subject` **beze změny** (rename
a `mail-ingest` → `ingress.email` je samostatný krok, viz níže, ne dnešní). `FACT-005` ověřuje živou entitu
(`entityOf("impulse.attachment")`, `scopeOf()`), `FACT-006` má reálný round-trip
`impulse.attachment.sha256@ent-…`. 529/529, typecheck, arch, farm:check zelené — čistě dictionary, `mail-ingest`
dál produkuje `mail.*`, žádná runtime změna. **A-3 (sidecar rename) HOTOVO 16. 9. 2026, HANDOFF 173** — `mail-ingest/facts.json` teď konzumuje `impulse.raw` a
produkuje `impulse.sender`/`impulse.subject` místo `mail.*` (kapabilita zůstává `mail.ingest` — jméno kapability
se nepřejmenovává, to je `ingress.email`, samostatný, výrazně větší krok, viz níže). Zjištěno při prozkoumání:
`workflows/*.json` a `handler.ts` fakt-slovníkové klíče vůbec nepoužívají (pracují na JSON Schema
`input`/`output` polích typu `rawMail`/`sender`/`subject`), takže tahle vrstva je od runtime kódu úplně
oddělená — sidecar mění jen to, co `FactCatalog`/`plan()` vidí, žádný Worker se nemění. Jediné, co s renamem
souviselo, byl `tests/plan.test.ts`'s PLAN-002 („hard gate" reprodukce `mail-intake.v2.json`), který `mail.raw`
používal jako `available` vstup — přepsáno na `impulse.raw`. Staré `mail.raw`/`mail.sender`/`mail.subject`
záznamy zůstávají ve slovníku (append-only, „superseded", ne smazané). 529/529, typecheck, arch, farm:check
zelené, žádná runtime změna.

**Zbývá:** přejmenovat samotnou kapabilitu `mail.ingest` → `ingress.email` (`descriptor.json`, `handler.ts`,
`workflows/mail-intake.v*.json` odkazují na `"capability": "mail.ingest"`, `config/*/lifecycle.json`/policy
granty na jméno kapability) — o řád větší zásah (immutable versioned workflows, Router registrace ve dvou
instalacích), věcně patří spíš k M2 ingress adaptérům než k dnešnímu M0 A. Nerozhodnuto, čeká na vlastníka.

### Rozhodovací tabulka — Impuls a Case

| Otázka | Rozhodnutí |
|---|---|
| Co je Case? | **Kontejner nad impulsem**: jeden impuls, jeden Žlab, N workflow instancí v čase. Objekt = Case, ne instance. Dnešní objekt (= přesně jedno workflow, `index.ts:612/670`) je zjednodušení; migrace: každá dnešní instance = Case s jedním workflow. |
| Smí ingress adapter zvolit workflow, goal nebo intent? | **Nikdy.** `NormalizedImpulse` taková pole strukturálně nemá (stejný princip jako `EvidenceClaim` bez `tenantId`). Dnešní `index.ts:672/1317/1746` (kanál → workflow) je přesně to, co končí. |
| Odkud vzniká workflow? | Z goalu (compile krok, M3); goal z intentu (**deterministická mapa instalace** `intent → goal template`); intent z krávy `intent.resolve`. Kanál do řetězu nevstupuje. |
| Dva druhy goal? | **Explicitní** (cíl je v impulsu) a **discovery** („co to je a vyžaduje to akci?"). Discovery = `plan({ goal: ["impulse.intent"], available: ["impulse.raw", "impulse.channel", …] })` → `content.classify` / `intent.resolve`; z intentu druhý plán. **`plan()` to unese beze změny** — dvě volání, žádný nový mechanismus. |
| Kde je LLM? | Jen **uvnitř** krávy `intent.resolve`, po žebříku vlastníka: pravidla → free Workers AI → Haiku → silnější; nikdy ve Farmáři jako plánovači. Deterministický `plan()` = 0 tokenů. |
| „Nevíme, co to je" | **Validní stav, ne chyba.** `impulse.intent = UNKNOWN` (nebo bez evidence) → Ohrada / Human Review, ne tichý pokus o „nejbližší" workflow (`### Capability gap`). |
| Co znamená nový kanál? | **Jen adapter + jeho `facts.json`** (produces `impulse.*`). Nula změn ve slovníku, kravách, planneru, Dojičce. |
| Kde vzniká tenant? | Z ověřené identity kanálu v instalaci (mapa kanál/identita → tenant), **nikdy z obsahu impulsu** (`### Multi-tenant izolace`). |
| Co s dnešními `mail.raw/sender/subject`? | Přejmenovat na `impulse.*` (část A, slovník aditivní); `mail.ingest` se stává ingress adapterem `ingress.email` (produces `impulse.*` + `document.original`). |
| Co s dnešními `workflows/*.json`? | Zůstávají jako **explicitní goal templates** (`document-intake` = goal `document.stamped`, `mail-intake` = goal `notification.sent`), dokud nevznikne compile (M3). |

### Co dnešní model unese a co ne (revize požadovaná vlastníkem)

| Komponenta | Unese? | Co je třeba |
|---|---|---|
| `contracts/facts.v1.json` | ano, aditivně | `impulse.*` klíče, `entities: impulse.attachment` (A, multiplicity many), deprecate `mail.*` |
| `src/components/*/facts.json` | ano | `mail-ingest` → ingress adapter (produces `impulse.*`), nové krávy `content.classify`, `intent.resolve` (consumes `impulse.*`, produces `impulse.intent` + evidence) |
| `src/platform/planner.ts` `plan()` | **ano, beze změny** | discovery + explicitní = dvě volání; přidat PLAN-007 (discovery goal z neznámého impulsu) |
| Žlab (`evidence*.ts`) | ano, beze změny | nic v něm nepředpokládá fakturu; snapshot artefaktu impulsu = platformní evidence (část B) |
| Dojička / Konev | ano, beze změny | — |
| `WorkflowInstance` objekt | **ne** | objekt = přesně jedno workflow → **nová část E „Case"**: objekt = Case, `instances[]`, impuls v artifact store, migrace dnešních instancí |
| `apf-gateway` intake cesty | **ne** | `index.ts:672/1317/1746` volí workflow z kanálu → nahradit `ingress → NormalizedImpulse → Case → discovery/explicit goal` |

### Adversarial scénáře

| # | Útok | Obrana |
|---|---|---|
| 0-adv-1 | Adapter Slacku propašuje `workflow: "bc.invoice.create"` v metadatech | `NormalizedImpulse` pole nemá; `metadata` jsou jen data ve Žlabu, nikdy vstup do volby workflow |
| 0-adv-2 | Kanál použit jako tenant (Telegram chat id = tenant) | tenant jen z ověřené identity kanálu v instalaci, nikdy z obsahu |
| 0-adv-3 | Impuls s textem „schval fakturu 4711" | intent je fakt s authority inferred; bez goal contractu a Dojičky žádná akce — injekce přes kanál nemá cestu k executoru |
| 0-adv-4 | Deset kanálů, deset „procesů" | nový kanál = adapter + facts.json; test: přidání adapteru nemění žádný soubor mimo `src/adapters/ingress-*` a jeho sidecar |

**Pořadí po uzavření krůčku 5:** C (AuthorityGrant) → A (FactAddress včetně `impulse.*` a `impulse.attachment`) →
B (EntityHash) → **E (Case objekt)** → teprve pak M1/M2 (ingress adaptery, `content.classify`, `intent.resolve`,
`invoice.extract/2`). Farmář (LLM) se nemění.

---

## A. FactAddress — jak se fakt adresuje

### Datový tvar

```
FactAddress = { key: FactKey, entity?: { type: EntityType, id: EntityId } }

FactKey     = klíč z contracts/facts.v1.json (uzavřený slovník, FACT-002/003)
EntityType  = deklarovaný typ entity ve slovníku, např. "invoice.line"
EntityId    = platformou přidělené opaque id, newId("ent") → "ent-<time36><ctr><hex>"
```

Kanonická textová forma (jen pro journal, `fieldHashes`, `Evidence.inputField`, audit):

```
supplier.companyId                      — fakt bez entity
invoice.line.accountCode@ent-m1x9k00a1f — fakt entity (přesně jedno "@")
```

Slovník `contracts/facts.v1.json` dostane dvě aditivní věci (schemaVersion zůstává `"1"`, `FactCatalog.build()`
je validuje):

```json
"entities": [
  { "type": "invoice.line", "of": "document.original", "multiplicity": "many",
    "identityFields": ["invoice.line.description", "invoice.line.quantity", "invoice.line.unitPrice",
                       "invoice.line.netAmount", "invoice.line.vatRate"] }
],
"facts": [
  { "key": "invoice.line.description", "kind": "fact", "scope": "invoice.line", "authority": "source" },
  { "key": "invoice.line.accountCode", "kind": "fact", "scope": "invoice.line", "authority": "derived" },
  { "key": "invoice.line.accountCode.approved", "kind": "evidence", "for": "invoice.line.accountCode", "scope": "invoice.line" }
]
```

`facts.json` krav se **nemění**: `accounting.account.candidates` deklaruje `consumes.facts:
["invoice.line.description", …]`, `produces.evidence: ["invoice.line.accountCode.candidates"]` — binduje se na
**typ entity + typ faktu**, nikdy na JSON cestu. Planner z `scope` pozná, že jde o fakt per entita, a hlásí
chybějící fakty per `entityId`, ne `invoice.lines[]`.

### Rozhodovací tabulka R1 — FactAddress (krůček 1, 15. 9. 2026)

Návrh reviewera (Posudek 17, kolo 6): projít M0 po malých auditovatelných rozhodnutích, první =
uzavřít, co přesně je adresa jednoho faktu. Tabulka převzata; asistent doplnil tři řádky a dvě úpravy.
Stav: **UZAVŘENO 15. 9. 2026** — vlastník potvrdil obě úpravy. Další krůček je jen canonical entity hash
(část B, rozhodovací tabulka níže), nic jiného.

**Implementace (A-1) HOTOVO 16. 9. 2026, HANDOFF 171** — obecný mechanismus, zatím bez skutečné entity
(`invoice.line` je jen ilustrace v M2, ne dnešní slovník): `contracts/facts.v1.json`'s `FactNamespace` dostal
volitelné `entities[]` (`EntityDecl { type, of?, multiplicity, identityFields }`), `FactEntry` volitelné `scope`
(chybí = `CASE_SCOPE`, reservováno, nikdy nedeklarované), `FactCatalog.build()` validuje scope⇔entity a
identityFields⇔source fakt téhož scope. Nový `fact-address.ts`: `FactAddress { key, scope, entityId? }`,
`parseFactAddress`/`formatFactAddress` nad kanonickou textovou formou, `newEntityId()` (stejná `newId()` rodina).
Testy **FACT-005/006/007** + A-adv-3 (neplatný tvar id). **A-adv-1/2/4 vědomě neotestováno** — potřebují
skutečnou entity-vydávající kapabilitu (platforma přiděluje `EntityId` při uložení výstupu), která dnes
neexistuje (přijde s M2 `invoice.line`); testovat je dřív by bylo o neexistujícím volajícím.

| Otázka | Rozhodnutí |
|---|---|
| Je `entityId` součástí `factKey`? | **Ne.** Slovník zůstává uzavřený a stabilní (FACT-002/003). |
| Je `entityId` samostatná souřadnice adresy? | **Ano.** `FactAddress = { key, scope, entityId? }`. |
| Je `scope` povinný? | **Ano, po normalizaci.** Ve slovníku smí chybět — pak je to `case` (singleton kořen instance workflow). Kanonická adresa scope vždy nese. *(úprava 1: dnešních 23 klíčů zůstává platných bez úpravy souboru; `invoice`/`document` jako pojmenované singleton scope lze deklarovat později)* |
| Může fakt existovat bez `entityId`? | **Ano** — právě když jeho scope má `multiplicity: "one"` (`case`, dnes i případné `document`/`invoice`). Scope s `multiplicity: "many"` (`invoice.line`) `entityId` **vyžaduje**; scope `"one"` ho **zakazuje**. Přepnutí `one → many` (např. dvě faktury v jednom mailu) nemění klíče, jen adresy. |
| Musí být `entityId` stabilní po dobu Case? | **Ano.** Jednou vydané id se nikdy nepřepisuje ani nerecykluje. |
| Smí capability `entityId` sama zvolit? | **Ne.** Přiděluje platforma při uložení výstupu krávy (journal / artifact store), stejně jako `tenantId`. Kráva id jen vrací zpět, cizí id = `UNKNOWN_ENTITY`. |
| Je pořadí řádku identita? | **Ne.** Indexová forma neexistuje. |
| Kdy zůstává `entityId` při re-extrakci stejné? | **Právě tehdy, když se `entityHash` nezměnil** (párování podle hashe; u shodných hashů podle pořadí výskytu). Změněný obsah = **nová entita** s novým id, stará je `SUPERSEDED` s `supersededBy` (append-only). *(úprava 2: reviewerovo „entityId může zůstat" → přesné pravidlo. Žádné párování podle pozice ani fuzzy shody — to by pořadí vrátilo jako identitu zadními vrátky.)* |
| Kanonická textová forma? | `key` pro singleton scope, `key@entityId` pro `many` — jen serializace pro journal, `fieldHashes`, `Evidence.inputField`, audit. Parser nikdy nečte z id hodnotu. |

Tři adversarial příklady (stanou se testy FACT-006 / ENT-004 / ENT-005):

1. **Dva řádky se stejným `description`** (i zcela identické) → dvě entity, dvě id. Evidence je per
   `key@entityId`, schválení jednoho se nepřenese na druhý.
2. **Řádky se přehodí** → `entityHash` stejný → `entityId` stejné → evidence platí dál.
3. **Re-extrakce změní obsah řádku** → jiný `entityHash` → nová entita s novým id, stará `SUPERSEDED`.
   Evidence staré entity je pro novou `not_bound`. Lidské rozhodnutí o starém řádku se **nepřenáší** —
   bylo o jiném obsahu.

### Invarianty

- **A1** `key` je vždy ze slovníku; adresa s neznámým klíčem neexistuje (dnešní FACT-002/003).
- **A2** `scope` je po normalizaci vždy definován (chybí-li ve slovníku, je to `case`); `entityId` je
  povinné právě pro scope s `multiplicity: "many"` a zakázané pro `"one"` — viz rozhodovací tabulka R1.
- **A3** `entityId` nenese žádnou business hodnotu — přiděluje ho platforma (artifact store / EvidenceWriter),
  kráva ho může jen **vrátit zpět**, nikdy vymyslet (stejně jako `tenantId`).
- **A4** index v poli **není** adresa. Forma `invoice.lines[3]` v platformě neexistuje — ne zákaz, ale
  neexistence tvaru.
- **A5** Farmář/Planner pracuje s `key` + `scope` + počtem/`entityId` (opaque), nikdy s hodnotami (PLAN-005
  zůstává v platnosti — `entityId` je stavový token, ne data).

### Validace

- Parser kanonické formy: přesně 0 nebo 1 `@`; část před `@` = klíč ze slovníku; část za `@` = `^ent-[a-z0-9]+$`.
- `FactCatalog.build()`: každý `scope` odkazuje na deklarovaný `entities[].type`; každé `identityFields` je fakt
  s tímto `scope` a `authority: "source"`; entita bez `identityFields` = chyba.
- Test ID: **FACT-005** scope ⇔ entity deklarována · **FACT-006** round-trip parse/serialize + odmítnutí
  `a@b@c`, `@ent-1`, `supplier.companyId@ent-1` (fakt bez scope s entitou) · **FACT-007** `identityFields`
  jen zdrojové fakty téhož scope.

### Adversarial scénáře

| # | Útok | Obrana |
|---|---|---|
| A-adv-1 | Kráva vrátí řádky s vlastními id, která kolidují s id jiného případu / tenanta | id přiděluje platforma při uložení výstupu; id od krávy se ignorují jako dnes `tenantId` v `EvidenceClaim` |
| A-adv-2 | Kráva přeuspořádá řádky, aby odpojila evidenci | žádná indexová adresa neexistuje; vazba je přes `entityHash` (část B) |
| A-adv-3 | Klíč propašuje hodnotu: `supplier.companyId@ent-12345678` nebo `entityId = "L-12345678"` | `entityId` pattern = jen platformní prefix + časově-náhodná část; platforma navíc porovná s vydanými id — cizí id = `UNKNOWN_ENTITY` |
| A-adv-4 | Fakt bez scope dostane entitu (`supplier.companyId@ent-…`), aby vznikla „druhá" identita dodavatele | A2 — odmítnuto při parse i při `build()` |

---

## B. EntityHash — jak se entita hashuje a jak se invaliduje evidence

### Datový tvar

```
entityHash = sha256(canonicalize({ type, fields: { <identityField>: <hodnota>, … } }))
```

- jen `identityFields` (zdrojové fakty z dokumentu); **odvozené** fakty (`accountCode`, `dimensionCode`)
  do hashe **nevstupují** — jinak by vyřešení účtu změnilo hash a zneplatnilo evidenci, která ho vyrobila.
- hodnoty už normalizované krávou (F2 strukturální kontrola: čísla jako čísla, ne `"15 000"`), `canonicalize`
  řadí klíče, takže pořadí polí nehraje roli.

**Snapshot entity jako platformní záznam v Žlabu** (žádný nový mechanismus):

```
Evidence { producerId: "platform.entity", authorityDomain: "platform",
           inputField: "invoice.line@ent-…", inputValueHash: <entityHash>, result: "OBSERVED",
           parentRefs: [<artifact evidence>], … }
```

Každá evidence o řádku (`invoice.line.accountCode.candidates@ent-…`, `…approved@ent-…`) má `parentRefs` →
snapshot řádku a `parentHashes` → jeho `recordHash`. Dnešní `verifyLineage()` pak beze změny prokáže:
evidence platí jen pro řádek s tímto obsahem. Dojička navíc (stejně jako Posudek 15 P0-2 `fieldHashes`)
porovná `entityHash` snapshotu s **aktuálním** obsahem entity → `not_bound`, pokud se řádek mezitím změnil.

**Kontinuita id podle obsahu (re-extrakce, „přeléčení", CORRECT retry):** nová extrakce vrátí řádky bez id.
Platforma pro každý nový řádek spočítá `entityHash`; existuje-li v témže případu entita se **stejným hashem**,
nový řádek **zdědí její id** (stabilní přiřazení: stejné hashe párované v pořadí výskytu). Řádek s novým hashem
dostane nové id; stará entita bez protějšku je `SUPERSEDED` (append-only záznam, ne smazání). Důsledek:
evidence pro nezměněné řádky přežije re-extrakci, evidence pro změněné řádky správně osiří. Přeuspořádání
nemá vliv (hash, ne pozice). Dva obsahově identické řádky = dvě entity, dvě id, stejný hash — evidence je
vázaná na `key@entityId`, takže schválení L1 se nepřenese na L2 (viz B-adv-3).

### Rozhodovací tabulka — EntityHash (krůček 2, 15. 9. 2026)

Stav: **UZAVŘENO 15. 9. 2026** — vlastník potvrdil beze změn. Další krůček: AuthorityGrant (část C).

**Implementace (B-1, mechanismus) HOTOVO 16. 9. 2026, HANDOFF 174** — `src/platform/entity-continuity.ts`:
`computeEntityHash(type, fields)` (`sha256(canonicalize({type, fields}))`, jen `identityFields`), `reconcileEntities()`
(kontinuita id: stejný hash → zděděné id, párováno v pořadí výskytu i pro duplicitní hashe, nespárovaný živý
záznam → superseded), `entitySnapshotCandidate()` (Evidence tvar `producerId: platform.entity`, `authorityDomain:
platform`, `inputField: <type>@<entityId>` — záměrně mimo `fact-address.ts`, protože entity `type` není fakt ve
slovníku, jen podobně vypadající tvar). Testy **ENT-001..006** (pořadí polí, změna identityField, odvozený fakt
mimo hash, duplicitní řádky, re-extrakce se supersede, `not_bound` přes **existující** Dojička mechanismus beze
změny). 537/537, typecheck, arch, farm:check zelené. **Žádná živá entita zatím `entitySnapshotCandidate()`
nevolá** (žádná "many" kapabilita neexistuje — `invoice.line` je M2) — stejný vzor jako A-1 před `impulse.attachment`.

| Otázka | Rozhodnutí |
|---|---|
| Z čeho se `entityHash` počítá? | **Jen z `identityFields`** entity deklarovaných ve slovníku (zdrojová pole z dokumentu), přes `canonicalize()` + `sha256()`. Pořadí polí nehraje roli. |
| Vstupují odvozené fakty (účet, dimenze, `bcNumber`)? | **Ne.** Jinak by vyřešení účtu změnilo hash a zneplatnilo evidenci, která ho vyrobila. |
| Kdo hash počítá? | **Platforma** při uložení výstupu krávy. Kráva nikdy; hodnota od krávy se ignoruje. |
| Kde je hash uložen? | Jako **platformní snapshot v Žlabu**: `producerId: platform.entity`, `inputField: <type>@<entityId>`, `inputValueHash = entityHash`, `result: OBSERVED`. Append-only, podepsaný jako každá evidence. |
| Jak se na entitu váže evidence o ní? | `parentRefs` → snapshot, `parentHashes` → jeho `recordHash`. Lineage ověřuje **dnešní `verifyLineage()` beze změny**; vazbu na aktuální obsah kontroluje Dojička jako dnes `fieldHashes` (`not_bound`). |
| Co znamená změna `identityField`? | Nový hash = **nová entita** (podle R1), stará `SUPERSEDED` + `supersededBy`. Evidence staré entity je pro novou `not_bound`. |
| Normalizace hodnot (`15 000` vs `15000.00`)? | **Normalizuje kráva** ve strukturální kontrole (F2) před výstupem; hash bere už kanonickou hodnotu. Dvě různé normalizace = dvě entity, záměrně fail-closed, žádná fuzzy shoda. |
| Dva obsahově identické řádky? | **Stejný hash, různá id.** Evidence je per `key@entityId` (R1). |
| Je `entityHash` identita napříč případy? | **Ne.** Je to vazba evidence uvnitř případu. Cross-case reuse jde přes hash hodnoty pole (`inputValueHash`, část D), ne přes `entityHash`. |

Tři adversarial příklady (stanou se testy ENT-001 / ENT-003 / KONEV-009 rozšíření):

1. **Kráva přeuspořádá pole ve výstupu řádku** → stejný hash, nic se nemění.
2. **Kráva změní odvozené pole** (účet), aby vynutila nové řešení → hash beze změny, evidence zdrojových
   faktů i lidské rozhodnutí platí dál.
3. **Někdo změní částku řádku po schválení** → hash nesedí → Konev odmítne
   (`BUSINESS_OBJECT_CHANGED_AFTER_AGGREGATION`), review task vázaný na hash Konve je neplatný (M6).

### Invarianty

- **B1** `entityHash` počítá platforma z kanonického obsahu; kráva ho nikdy nedodává.
- **B2** změna kteréhokoli `identityField` ⇒ nový hash ⇒ nová entita ⇒ veškerá evidence staré entity je pro
  nový obsah `not_bound` (přes existující lineage/fieldHashes kontrolu, ne novou logiku).
- **B3** změna odvozeného faktu ⇒ hash beze změny ⇒ evidence zdrojových faktů platí dál.
- **B4** kontinuita id je deterministická funkce (obsah, pořadí výskytu) — stejný vstup dvakrát = stejné id.
- **B5** snapshot i `SUPERSEDED` jsou append-only záznamy v Žlabu — historie řádků je auditovatelná.

### Validace

**ENT-001** stejný obsah, jiné pořadí polí → stejný hash · **ENT-002** změna `identityField` → jiný hash ·
**ENT-003** změna odvozeného faktu → stejný hash · **ENT-004** dva identické řádky → dvě id, stejný hash,
stabilní párování · **ENT-005** re-extrakce: nezměněný řádek zdědí id, změněný dostane nové, chybějící je
`SUPERSEDED` · **ENT-006** lineage řádkové evidence přes snapshot prochází `verifyLineage()`; po změně řádku
Dojička hlásí `not_bound`.

### Adversarial scénáře

| # | Útok | Obrana |
|---|---|---|
| B-adv-1 | Kompromitovaná kráva přeuspořádá řádky, aby schválený účet „přeskočil" na jiný řádek | vazba přes hash + `key@entityId`; pořadí nehraje roli |
| B-adv-2 | Kráva změní odvozené pole (účet), aby vynutila re-resolution a obešla lidské rozhodnutí | odvozené pole není v hashi; lidské rozhodnutí je evidence domény `tenant.human-review` vázaná na entitu — přebije kandidáty (část C) |
| B-adv-3 | Kráva zduplikuje řádek s identickým obsahem, aby schválení jednoho pokrylo dva | evidence je per `entityId`; Dojička požaduje evidenci pro **každou** entitu; stejný hash ≠ stejná entita |
| B-adv-4 | Po schválení někdo změní částku řádku (journal/D1) | hash nesedí → Konev odmítne (`BUSINESS_OBJECT_CHANGED_AFTER_AGGREGATION`, KONEV-009), review task vázaný na hash Konve je neplatný (M6) |
| B-adv-5 | Kráva vrátí 10 000 řádků (DoS na hashování / Dojičku) | `outputSchema` `maxItems` (bounded, `### Bounded looping`), `forEach` v M2 dědí limit |

---

## C. AuthorityGrant — kdo smí tvrdit který fakt

### Datový tvar

Nový instalační soubor `config/<installation>/authorities.json` (povinný, fail-closed jako `lifecycle.json`;
vzor = policy granty ADR-016):

```json
{
  "schemaVersion": "1",
  "domains": {
    "cz.company.registry":  { "producers": ["cz.company.verify"], "facts": ["supplier.companyId", "supplier.officialName"], "maxEvidenceTtl": "P30D" },
    "cz.vat.registry":      { "producers": ["cz.vat.verify"],     "facts": ["supplier.vatId", "supplier.publishedBankAccounts"], "maxEvidenceTtl": "P1D" },
    "tenant.businessCentral": { "producers": [], "facts": ["vendor.bcNumber"], "maxEvidenceTtl": "P7D" },
    "tenant.human-review":  { "producers": ["platform.review"],   "facts": ["*"], "maxEvidenceTtl": "P365D" },
    "platform":             { "producers": ["platform.entity"],   "facts": ["*"], "maxEvidenceTtl": null }
  },
  "tenants": { }
}
```

- `producers` = capability id (dnes `Evidence.producerId`); `tenants` = volitelné per-tenant přepsání
  (stejný vzor jako `grants[].tenants`), M0 nechává prázdné.
- `Evidence` získá `authorityDomain?: string` — **razítkuje ho `EvidenceWriter` z grantu při konstrukci**
  (wiring zná `producerId` → dohledá doménu); `EvidenceClaim` pole nemá, kráva ho strukturálně nemůže dodat.
- Producer bez grantu → evidence **bez** domény (= „inferred"). Producer s grantem, ale fakt mimo `facts`
  domény → `write()` odmítne `AUTHORITY_SCOPE` (stejně jako `Router` odmítá scope mimo grant).
- TTL: `expiresAt = min(claim.expiresAt ?? ∞, observedAt + maxEvidenceTtl)`; `null` = bez expirace (jen
  `platform`). Řeší Posudek 16 P1-10 („kráva si určuje `expiresAt`").
- `RequiredEvidence` → `{ field, authorityDomain, acceptableResults? }`; `producerId` zůstává jen jako
  explicitní výjimka pro testy/diagnostiku. Lidské rozhodnutí (`Decision` CORRECT/APPROVE v Review Service)
  vytvoří evidenci `producerId: "platform.review"`, doména `tenant.human-review`, `parentRefs` → audit záznam
  `review-decision`, `result` = rozhodnutí — takhle vstupuje „approved" do Žlabu.
- Dojička kontroluje doménu **a** že producer je v grantu **teď** (revokace — rozhodnutí R2 níže).
- `FieldValue.trustLevel` zůstává jen jako platformou **odvozený** souhrn na faktu (`untrusted-derived` bez
  domény, `validated` s doménou, `human-corrected` = `tenant.human-review`); kráva smí nastavit jen nejnižší.

### Rozhodovací tabulka — AuthorityGrant (krůček 3, 15. 9. 2026)

Stav: **UZAVŘENO 15. 9. 2026** — vlastník potvrdil beze změn; R2 (revokace) a R6 (výchozí TTL) tím
uzavřeny. Implementace C: **(C-1) HOTOVO A ŽIVĚ OVĚŘENO 16. 9. 2026, HANDOFF 169** — `authorities.ts`,
`authorities.json` v obou instalacích, writer razítkuje doménu / odmítá fakt mimo rozsah / ořezává TTL, `zlab.json`
`byDomain` ukazuje `cz.company.registry` a `cz.vat.registry` → **(C-2) HOTOVO 16. 9. 2026, HANDOFF 170/171** —
`EvidenceAggregator` (Dojička) požaduje `authorityDomain` místo `producerId` (swap producenta požadavek nerozbije,
AUTH-004), revokace kontroluje aktuální `AuthorityRegistry` + `LifecycleRegistry` (`revoked` → REVIEW, fail-closed,
AUTH-005); Dojička dosud nikde živě zapojená, takže bez farm verification (nic runtime se nemění). **AUTH-007
(lidské rozhodnutí jako evidence `tenant.human-review`) vědomě odloženo do M4/M5** — dnešní `ReviewTask` je vázaný
na krok workflow (`stepId`), ne na fakt (`FactAddress`), takže by šlo o spekulativní schéma bez skutečného
volajícího; M4 (BC Read World) a M5 (Readiness & Composition Safety) samy v `SEVERKA.md`'s roadmapě říkají, že tam
lidské rozhodnutí jako `tenant.human-review` evidence přirozeně patří — tam se AUTH-007 doimplementuje s reálným
voláním po ruce, ne dřív. Část C tímto uzavřena celá, pokračuje A.

| Otázka | Rozhodnutí |
|---|---|
| Kdo rozhoduje, že producent je autorita pro fakt? | **Instalace** (`config/<installation>/authorities.json`, vzor = policy granty ADR-016). Nikdy kráva, nikdy runtime. Změna = commit + nasazení. |
| Co je klíčem autority? | **`authorityDomain`** — odpověď na „kdo smí tvrdit tento fakt": `cz.company.registry`, `cz.vat.registry`, `tenant.businessCentral`, `tenant.human-review`, `platform`. **Ne** jedna globální osa trustu: ARES je autorita pro název a stav firmy, ne pro `vendor.bcNumber`; BC naopak. |
| Kdo razítkuje doménu na evidenci? | **`EvidenceWriter`** z grantu při konstrukci (wiring zná `producerId` → doménu). `EvidenceClaim` pole nemá, kráva ho nemůže dodat ani přes cast. |
| Producent bez grantu? | Evidence **bez domény** = inferred. Nikdy „authoritative" ze sebeoznačení. |
| Producent s grantem, ale fakt mimo `facts` domény? | `write()` odmítne **`AUTHORITY_SCOPE`**, nic se nezapíše (stejně jako `Router` odmítá scope mimo grant). |
| Co požaduje Dojička? | **Doménu** (`requiredAuthority`), ne `producerId`. Výměna ARES adaptéru za jiný registr téže domény kontrakt nerozbije. `producerId` zůstává jen jako explicitní výjimka pro testy/diagnostiku. |
| Revokace (R2)? | Dojička kontroluje **aktuální** grant a `LifecycleRegistry`, ne stav v době zápisu. Producent odebraný nebo v karanténě → finding `revoked` → REVIEW, i když podpis i lineage sedí. Fail-closed. |
| TTL? | `expiresAt = min(claim.expiresAt, observedAt + maxEvidenceTtl domény)` — kráva může TTL jen **zkrátit**. `null` jen pro doménu `platform`. Výchozí hodnoty (R6): ARES `P30D`, VAT spolehlivost `P1D`, BC `P7D`, human `P365D` — čísla k ladění, ne dogma. |
| Jak vstupuje lidské rozhodnutí do Žlabu? | Jako evidence `producerId: platform.review`, doména `tenant.human-review`, `parentRefs` → audit záznam `review-decision`, `result` = rozhodnutí. Tak vzniká „approved". |
| Samostatný `trustLevel` na evidenci? | **Ne.** Doména ho subsumuje. `FieldValue.trustLevel` zůstává jako platformou **odvozený** souhrn na faktu; kráva smí nastavit jen nejnižší. |
| Per-tenant přepsání domén? | Připraveno (`tenants: {}`), v M0 prázdné. Řeší se s druhým reálným tenantem. |
| Dvě autority téže domény s rozporným výsledkem? | Existující finding `conflict` → REVIEW. Nikdy tichý výběr. |

Tři adversarial příklady (stanou se testy AUTH-001 / AUTH-003 / AUTH-005):

1. **Kráva tvrdí doménu v claimu**, i přes cast → strukturálně nemožné, `write()` čte jen šest pojmenovaných polí.
2. **Kompromitovaná ARES kráva zapíše `supplier.vatId.verified`** → fakt mimo `facts` domény → `AUTHORITY_SCOPE`.
3. **Producent odebraný z grantu po zápisu** → stará evidence stále podepsaná, Dojička přesto `revoked`.

### Invarianty

- **C1** doménu razítkuje výhradně platforma z instalační konfigurace; neexistuje per-call cesta ji nastavit.
- **C2** bez grantu žádná autorita — nikdy ne „authoritative" ze sebeoznačení.
- **C3** Dojička požaduje doménu, ne konkrétní krávu; výměna adaptéru za jiný registr téže domény
  kontrakt nerozbije.
- **C4** TTL má horní mez z grantu; kráva ho může jen zkrátit.
- **C5** granty se mění jen konfigurací + nasazením (git-auditovatelné), nikdy za běhu, nikdy krávou.
- **C6** jedna doména, jedna otázka: „kdo je oprávněn tvrdit **tento** fakt?" — ARES není autorita pro
  `vendor.bcNumber`, BC není autorita pro `supplier.officialName`.

### Validace

**AUTH-001** producer bez grantu → evidence bez domény; Dojička s `authorityDomain` ji nepřijme (`missing`) ·
**AUTH-002** `claim.expiresAt` za mezí → ořezáno na `observedAt + maxEvidenceTtl` · **AUTH-003** evidence pro
fakt mimo `facts` domény → `AUTHORITY_SCOPE`, nic se nezapíše · **AUTH-004** dva producenti téže domény →
READY s kterýmkoli, výměna nemění kontrakt · **AUTH-005** producer odebraný z grantu po zápisu → Dojička
`REVIEW` (`revoked`), i když podpis a lineage sedí · **AUTH-006** `facts.json`/`authorities.json` konzistence:
každý `producers[]` existuje jako capability, každý `facts[]` je klíč slovníku (nebo `*`) · **AUTH-007**
lidské rozhodnutí vytvoří evidenci domény `tenant.human-review` s lineage na audit `review-decision`.

### Adversarial scénáře

| # | Útok | Obrana |
|---|---|---|
| C-adv-1 | Kráva tvrdí doménu v claimu (i přes cast) | `EvidenceClaim` pole nemá, `write()` čte jen 6 pojmenovaných polí (dnešní obrana, EW-001..004) |
| C-adv-2 | Kompromitovaná ARES kráva zapíše `supplier.vatId.verified` | fakt mimo `facts` domény → `AUTHORITY_SCOPE` |
| C-adv-3 | `expiresAt: 2099` | ořez grantem (AUTH-002) |
| C-adv-4 | Producer byl v grantu, po nálezu kompromitace je odebrán / v karanténě; stará evidence stále podepsaná | Dojička kontroluje aktuální grant + `LifecycleRegistry` → `revoked` (AUTH-005) |
| C-adv-5 | Dva registry téže domény dají rozporné výsledky (ACTIVE vs CEASED) | existující `conflict` finding → REVIEW, nikdy tichý výběr |
| C-adv-6 | Útočník upraví `authorities.json` v repu | změna prochází commitem, `farm:check` (AUTH-006) a nasazením — stejná hranice jako u policy grantů; runtime cesta neexistuje |

---

## D. DurableFactStore — durable Žlab

### Datový tvar

Dvě vrstvy, **stejný vzor jako dnešní audit** (`store.ts`: DO SQLite = zdroj pravdy, D1 = insert-only kopie
s `mirrored` flagem):

```
DO SQLite (objekt instance workflowId), synchronně, před publikací výsledku kroku (RES-CRASH-001):
  evidence(record_id TEXT PK, tenant_id, workflow_id, input_field, input_value_hash, authority_domain,
           producer_id, expires_at, json TEXT, mirrored INTEGER DEFAULT 0)
  — jen INSERT; jediný UPDATE = mirrored flag (jako audit)

D1 (sdílené, per instalace), insert-only:
  evidence(record_id TEXT PK UNIQUE, tenant_id, input_field, input_value_hash, authority_domain,
           expires_at, json)
  index (tenant_id, input_field, input_value_hash, authority_domain, expires_at)
```

- `EvidenceLedger` API zůstává (`append`/`get`/`forTenant`/`verify`/`verifyLineage`); přibude backend
  `SqliteEvidenceStore` vedle in-memory (testy) — jako `SqliteJournal` vedle in-memory journalu.
- **Cross-case lookup** („známý dodavatel"): gateway se ptá D1 `(tenant_id, input_field, input_value_hash,
  authority_domain, expires_at > now)` → vrací **jen reference** (recordId, hash, doména, expirace) — z toho se
  skládá `available` pro `plan()` (M3). Žádná hodnota se nečte ani nevrací.
- **Import do nového případu:** použitá cizí evidence se **zkopíruje** (celý podepsaný záznam) do ledgeru
  nového případu jako `IMPORTED` záznam s `parentRefs` → původní `recordId`, `parentHashes` → jeho
  `recordHash`. Lineage se pak ověřuje lokálně, i když původní DO byl purgnutý; import je auditovatelný.
- Důvěra je **jen z podpisu** (`verify()`), nikdy z toho, že řádek v D1 existuje.
- Podpis s domain separation (Posudek 16 P1-12): `sign("EVIDENCE:v2:" + recordHash)`, `schemaVersion: "2"`;
  `keyId` v záznamu zůstává, keyring (P1-11) je mimo M0.
- `buildHash := gitSha` z nasazení (živý `/version` ho už má) — rozhodnutí R5.

### Rozhodovací tabulka — DurableFactStore (krůček 4, 15. 9. 2026)

Stav: **UZAVŘENO 15. 9. 2026** — vlastník potvrdil beze změn; R3 (retence), R4 (podpis v2) a R5
(`buildHash`) tím uzavřeny. Implementace D: **(D-1) HOTOVO 15. 9. 2026, HANDOFF 162** — tvar záznamu v2 + podpis s prefixem
`EVIDENCE:v2:` + `authorityDomain` pole + v1 odmítnuto (ZLAB-DUR-007, EW-005) → **(D-2) HOTOVO 15. 9. 2026,
HANDOFF 163** — `EvidenceStore` rozhraní, `MemoryEvidenceStore`, `SqliteEvidenceStore` v `src/platform/evidence-sqlite.ts`
(bez Cloudflare importu, testováno nad `node:sqlite`; ZLAB-DUR-001..003), DDL v DO → **(D-3) HOTOVO 15. 9. 2026,
HANDOFF 164** — `src/platform/evidence-mirror.ts` (`AsyncSql`, `SqliteEvidenceMirror`, `mirrorEvidence()`, `EvidenceRef`
bez hodnot; ZLAB-DUR-004/005), `d1Sql()`/`evidenceMirrorOf()` v deploy store.ts → **(D-4) HOTOVO 15. 9. 2026,
HANDOFF 165** — `EvidenceLedger.importSealed()`, `src/platform/evidence-import.ts` (`importEvidence()`: ancestry ze
zrcadla, tenant → integrita → expirace → id konflikt, marker `IMPORTED`; ZLAB-DUR-006) → **(D-5) HOTOVO A ŽIVĚ
OVĚŘENO 15. 9. 2026, HANDOFF 166** — `EvidenceWriter` pro `cz.*` v živém wiringu, ledger nad stejným klíčem jako
dispatch (domain separation), `buildHash = gitSha`, `copyOut` → D1, `/farm/zlab.json` (+ `?verify=1` — ověření každého řádku D1 kopie jen veřejným klíčem, živě
předvedeno přepisem jednoho řádku, HANDOFF 167), `/farm/zlab/mirror`, Přehled;
živě: záznamy přežily restart objektu, D1 se dorovná samo, `buildHash` = nasazení, které pečetilo. Dvě chyby nalezené
jen živě (souběžné DDL + cachovaná rejection; `waitUntil` po RPC nedoběhl). **Část D je kompletní.**

| Otázka | Rozhodnutí |
|---|---|
| Kde je zdroj pravdy Žlabu? | **DO SQLite objektu instance** (`workflowId`), zápis **synchronní před publikací výsledku kroku** (RES-CRASH-001). Stejný vzor jako journal/audit/artifacts dnes. |
| Co je D1? | **Insert-only kopie** s `mirrored` flagem, pro cross-case lookup. Ztráta D1 = ztráta lookupu, **ne** integrity. |
| Odkud plyne důvěra v záznam? | **Jen z podpisu** (`verify()`), nikdy z toho, že řádek v tabulce existuje. |
| Co se smí v uložených záznamech měnit? | **Nic kromě `mirrored`.** Žádný `UPDATE`/`DELETE` nad `json` — ZLAB-005 rozšířeno na SQL text (ZLAB-DUR-002). |
| Jak se čte napříč případy? | D1 dotaz `(tenant_id, input_field, input_value_hash, authority_domain, expires_at > now)` → **jen reference** (recordId, hash, doména, expirace). Žádná hodnota; z toho vzniká `available` pro `plan()` (M3). |
| Jak cizí evidence vstoupí do nového případu? | **Explicitním importem**: kopie celého podepsaného záznamu do ledgeru případu jako `IMPORTED`, `parentRefs`/`parentHashes` → originál. Lineage se ověřuje lokálně i po purge původního DO. Auditovatelné, nikdy implicitní. |
| Retence po purge případu (R3)? | Purge maže DO instance; **D1 kopie zůstává** podle `retentionDays` instalace. Obsahuje jen hashe, výsledky a reference (hash IČO = pseudonym), žádnou hodnotu. |
| Podpis (R4)? | **v2 s domain-separation prefixem** `EVIDENCE:v2:` + `schemaVersion: "2"`; v1 záznam (bez prefixu) v2 ledger **odmítne**, nikdy tiše nepřijme. `keyId` zůstává; keyring/rotace mimo M0. |
| `buildHash` (R5)? | **`:= gitSha` z nasazení** (živý `/version` ho už nese). Cloudflare Version Metadata binding ověřit v M1, ne teď. |
| Tenant izolace čtení? | **Vždy tenant-scoped** (`forTenant`, každý D1 dotaz s `tenant_id`). Cross-tenant dotaz vrací nic. |
| Co ukazuje `/farm`? | Počet záznamů, čas posledního, domény — **nikdy hodnotu**. |
| Live verification M0? | Self-test `cz.company.verify` zapíše reálnou evidenci (doména `cz.company.registry`, `buildHash = gitSha`); vynutit restart/evikci objektu; záznam existuje v DO i D1 a `verify()` projde. |

Tři adversarial příklady (stanou se testy ZLAB-DUR-004 / D-adv-2 / ZLAB-DUR-007):

1. **Přístup k D1 a editace `result`** → podpis nesedí, záznam neplatný.
2. **Padělaný řádek s korektně spočítaným `recordHash`, ale bez privátního klíče** → `platformSignature`
   chybí nebo nesedí → odmítnuto.
3. **Záznam v1 bez prefixu podstrčený jako platný** → `schemaVersion` je součást podepsaného obsahu, v2 ledger
   ho odmítne.

### Invarianty

- **D1** append-only v obou vrstvách; jediná mutace je `mirrored` (ZLAB-005 reflexe rozšířená na SQL text:
  žádný `UPDATE`/`DELETE` nad `json`).
- **D2** zápis do DO SQLite je synchronní a předchází publikaci výsledku kroku — evikce DO nic neztratí.
- **D3** D1 je kopie; ztráta D1 = ztráta cross-case lookupu, ne integrity.
- **D4** čtení je vždy tenant-scoped (`forTenant`, D1 dotaz vždy s `tenant_id`).
- **D5** Dojička čte jen ledger svého případu; cizí evidence vstupuje jen explicitním importem s lineage.
- **D6** v Žlabu nikdy není hodnota — jen hashe, výsledky, reference (platí už dnes; D1 to nemění).

### Validace

**ZLAB-DUR-001** restart/evikce DO zachová záznamy (vzor `tests/res.test.ts`) · **ZLAB-DUR-002** žádný
UPDATE/DELETE nad evidence json (reflexe SQL) · **ZLAB-DUR-003** zrcadlení idempotentní (opakování
neduplikuje, `record_id` UNIQUE) · **ZLAB-DUR-004** upravený řádek v D1 neprojde `verify()` · **ZLAB-DUR-005**
cross-tenant lookup vrátí nic · **ZLAB-DUR-006** importovaná evidence: lineage k originálu sedí, po purge
původního DO se ověří z lokální kopie · **ZLAB-DUR-007** podpis v2 s prefixem: záznam v1 (bez prefixu)
`verify()` odmítne jako `unknown schemaVersion`, ne tiše přijme.

**Live farm verification M0:** nasadit; self-test `cz.company.verify` zapíše reálnou evidenci (doména
`cz.company.registry`, `gitSha` jako `buildHash`); vynutit evikci/restart objektu; záznam existuje v DO i D1,
`verify()` OK; `/farm` ukáže „evidence: N záznamů, poslední …" (žádná hodnota, jen hash a doména).

### Adversarial scénáře

| # | Útok | Obrana |
|---|---|---|
| D-adv-1 | Přístup k D1 → editace `result` | podpis nesedí (ZLAB-DUR-004) |
| D-adv-2 | Vložení padělaného řádku s korektním `recordHash` | bez privátního klíče není `platformSignature` → odmítnuto |
| D-adv-3 | Replay evidence tenanta A do případu tenanta B | `tenant_mismatch` (existující finding), D1 dotaz tenant-scoped |
| D-adv-4 | Prošlá evidence | `expired` (existující finding) + `expires_at` v indexu |
| D-adv-5 | Evikce DO mezi `append` a zrcadlením | DO SQLite je durable; `mirrored=0` se dozrcadlí později |
| D-adv-6 | Purge případu a pak reuse jeho evidence | kopie v D1 zůstává, importem vzniká lokální podepsaná kopie s lineage (ZLAB-DUR-006); retence = rozhodnutí R3 |
| D-adv-7 | Downgrade: záznam v1 bez domain prefixu podstrčený jako platný | `schemaVersion` je součást podepsaného obsahu; v2 ledger v1 nepřijímá (ZLAB-DUR-007) |

---

## Otevřená rozhodnutí pro vlastníka (R1–R7)

| # | Otázka | Doporučení |
|---|---|---|
| R1 | FactAddress + kontinuita id podle obsahu při re-extrakci — ano/ne? | **ano** — bez ní každé „přeléčení" zahodí všechna lidská rozhodnutí o řádcích. **UZAVŘENO 15. 9. 2026 (krůček 1): rozhodovací tabulka v části A, úpravy 1–2 potvrzeny vlastníkem.** |
| R2 | Revokace: Dojička kontroluje grant **aktuální**, nebo **v době zápisu**? | **aktuální** (fail-closed) — producer odhalený jako kompromitovaný nesmí mít doživotní evidenci. **UZAVŘENO 15. 9. 2026 (krůček 3).** |
| R3 | Retence evidence po purge případu | D1 kopie zůstává podle `retentionDays` instalace (hash IČO je pseudonym, ne hodnota); purge maže DO, ne D1. **UZAVŘENO 15. 9. 2026 (krůček 4).** |
| R4 | Domain separation + `schemaVersion: "2"` už v M0? | **ano** — tvar záznamu se stejně mění (doména), levné teď, drahé později. **UZAVŘENO 15. 9. 2026 (krůček 4).** |
| R5 | `buildHash := gitSha` z nasazení místo Version Metadata bindingu | **ano** pro M0; binding ověřit v M1. **UZAVŘENO 15. 9. 2026 (krůček 4).** |
| R6 | Výchozí TTL per doména | ARES `P30D`, VAT spolehlivost `P1D` (mění se denně), BC `P7D`, human `P365D` — čísla k ladění, ne dogma. **UZAVŘENO 15. 9. 2026 (krůček 3) jako výchozí hodnoty k ladění.** |
| R7 | Rozšíření slovníku (`entities[]`, `scope`, `identityFields`) jako aditivní změna v `"1"`, nebo `"2"`? | **`"1"` aditivně** — dnešní soubory zůstávají platné, `FactCatalog.build()` validuje nová pole |

**Mimo M0 (vědomě):** `forEach` krok (M2), keyring/rotace klíče (Posudek 16 P1-11), per-tenant přepsání
domén (`tenants: {}` je připravené, prázdné), Model Gateway (M1), pět otázek + naming test do Kravské dílny
(malý samostatný commit, může jít paralelně).

**Pořadí implementace po schválení:** D (durable Žlab — všechno ostatní na něm stojí) → C (granty, razítko,
Dojička podle domény) → A (adresa, slovník) → B (entity hash, kontinuita, snapshot). Každá část = vlastní
commit, vlastní Test ID, `typecheck`/`test`/`arch`/`farm:check` zelené; D navíc live verification.
