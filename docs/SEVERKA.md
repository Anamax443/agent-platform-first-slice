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
| **Agent Registry** | chybí; dnes ruční `router.register()` v `platform-wiring.ts` | formalizace toho, co už komponenty nesou v `descriptor.json` (capabilities, vstup/výstup schema) + health/verze/cena | nízké — je to datová nadstavba nad existujícím vzorem |
| **Planner** | chybí | z požadavku (přirozený jazyk) sestaví plán z dostupných capabilities | **vysoké, pokud plán rovnou vykonává.** Musí místo toho **vyprodukovat `WorkflowDef`**, který projde stejnou fail-closed bránou (schema, Policy Engine, Human Review) jako dnešní ručně psaný workflow — generátor vstupu do přísného pipeline, ne nová cesta kolem něj |
| **Policy Engine + risk scoring** | částečně — `policy.ts` (`policyFor(installation.policies, capability, "1")`) existuje per-capability | rozšířit o rizikovou úroveň požadavku (nízké/střední/vysoké → auto/potvrzení/nikdy) | střední — navazuje na existující Human Review, není nová vrstva vedle ní |
| **Execution Engine** | existuje (`Router`, `ExecutorHost`, retry/review/journal) | — | idempotency dnes řeší jen `capability + idempotencyKey`; hlubší identita `tenantId + handlerId + requestFingerprint` + `IDEMPOTENCY_CONFLICT` zůstává otevřená (Posudek 5/6). Dokud farma přidává jen čtecí/testovací COW, snesitelné; jakmile přibude `ERP.write`/`bank.payment.prepare`, „doufáme, že provider deduplikuje" nestačí — chce to durable effect ledger |
| **Human Review** | existuje (`WAITING(REVIEW)`, `/review`) | — | `ReviewService.tasks` je dnes jen paměťová `Map` v Durable Objectu — po evikci objektu může rozhodnutí skončit `APPROVAL_MISMATCH`. Než se `/review` používá jako skutečná funkce (ne jen demo), review task musí přežít restart/evikci (SQLite, ne Map) |
| **Tenant Layer** | koncepčně navrženo, nasazení záměrně single-tenant | `farm-bass443` je `CLOUD_SINGLE_TENANT` (viz `NAVRHOVY-LIST-farma.md`); `tenant-7` je jen protistrana bezpečnostních testů, ne živý zákazník. Foundation nese `tenants: string[]` + policy semantiku, ale skutečné tenant resolution (`TenantConfig { tenantId, assistant.displayName, orchestration.actorId }` místo jediného globálního `roles.orchestrator`) je budoucí capability, ne dnešní bug | nízké dnes (nic naostro na tom neběží) — vysoké, jakmile přibude druhý reálný tenant a nikdo tenant resolution nedodělal předem |
| **Connector Layer** | 1 z N hotový | `document-host` běží na farmě; `apf-mail-ingest` a `apf-email-executor` jsou na farmě doslova skeleton (`501 NOT_WIRED`, `email()` handler dělá `setReject`) | dokončení = zároveň první reálný **event-driven** case (mail přijde → spustí workflow), ne samostatná vzdálená vrstva |
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

## Připravované doménové COW (invoice.extract → cz.company.verify → cz.vat.verify)

Vzor „extrahuj → ověř proti autoritě → rozhodni" se má opakovat napříč doménami (faktura dnes,
kalendář/počasí/ERP později) — vždycky jako řetěz samostatných capabilities, nikdy jako jeden
agent, co dělá všechno:

- **`invoice.extract`** (AI) — z faktury vytáhne IČO, DIČ, bankovní účet, částku, měnu, položky.
  Zůstává čistě extrakce, žádné rozhodování o důvěryhodnosti protistrany.
- **`cz.company.verify`** (deterministický, žádné AI) — IČO a základní údaje proti ARES, shoda
  názvu subjektu, nespolehlivý plátce.
- **`cz.vat.verify`** (deterministický, žádné AI) — stav plátce DPH a **zveřejněný bankovní účet
  u Finanční správy** (webová služba FS pro SW třetích stran) — u tuzemských faktur vysoce
  hodnotná kontrola, přesně ten typ věci, co má být deterministický kontrolní krok, ne volná
  úvaha AI.

Tohle se **nesmí míchat do OCR/extraction agenta** — je to ověření proti autoritativním
registrům, jiná bezpečnostní a spolehlivostní kategorie než čtení textu z PDF.

---

## Pořadí (co je skutečně příští, ne všech vrstev najednou)

1. **Durable Review** — `ReviewService.tasks` je dnes jen paměťová `Map`; to je existující runtime
   chyba (evikce → `APPROVAL_MISMATCH`), ne aspirace. Řeší se dřív než cokoli nového.
2. **Durable idempotency/effect ledger** pro write executory — `tenantId + handlerId +
   requestFingerprint` (Posudek 5/6), než přibude druhý typ write COW.
3. **Dokončit `mail.ingest`/`email.send` skeleton** — druhý reálný typ COW, důkaz že
   `document-host` nebyl jednorázová výjimka; zároveň první event-driven case.
4. **Agent Registry** — zatím čistě deterministický katalog capabilities (formalizace
   `descriptor.json` + `router.register()`), žádné AI v rozhodování.
5. **`invoice.extract`**
6. **`cz.company.verify`**
7. **`cz.vat.verify`**
8. **Planner jako generátor `WorkflowDef`** (nikdy přímý executor) — teprve teď plánuje nad
   reálnou farmou (`document.*`, `mail.ingest`, `email.send`, `invoice.extract`, `cz.*.verify`),
   ne nad dvěma umělými capabilities — proto až poslední, ne proto, že by byl málo důležitý.

Tenant resolution zůstává mimo tohle pořadí — dnes to není bug (`CLOUD_SINGLE_TENANT`), je to
budoucí capability; řešit se má, až bude existovat druhý reálný tenant, ne preventivně.

**Why:** foundation je zmrazený přesně kvůli deterministické, auditovatelné povaze platformy
(4 kola oponentury, 80 nálezů). Každá nová vrstva, která zavádí nedeterminismus (Planner,
Memory), musí zůstat *uvnitř* stejné fail-closed brány, ne vedle ní. A vrstvy, co dnes reálně
můžou ztratit stav (Review, idempotency), mají přednost před vrstvami, co teprve mají přibýt.
