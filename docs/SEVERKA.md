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
| **Admission Gate (module lifecycle)** | **první krok hotový a plošně zapojený (9. 9. 2026)** — `LifecycleRegistry` (`src/platform/lifecycle.ts`), `Router` ho vynucuje před `checkGrant()` (`MODULE_QUARANTINED`), volitelný `config/<installation>/lifecycle.json`, zapojeno na **všech** Routerech farmy (`apf-document-host`, `apf-email-executor`, gateway in-process pro classify/validate/mail.ingest — `apf-mail-ingest` vlastní Router nemá) (`docs/POSUDKY.md` Posudek 7, rozhovor o "koupi nových krav" 9. 9. 2026) | ruční block-list (`ACTIVE`/`QUARANTINED` per modul), ne mandatorní allow-list — chybějící záznam = `ACTIVE`, nemění chování dnešních běžících komponent | nízké dnes (ruční). Zbývá: `NEW`/`TESTING`/`DEGRADED` stavy, automatický verification runner nad `verificationProfiles` z `module-descriptor.v1.schema.json` (ten už dnes deklaruje `riskClass`→`isolationClass` pravidla a `buildCommit`, jen je nic nevynucuje běhu), auto-quarantine na živém selhání |
| **Planner** | chybí | z požadavku (přirozený jazyk) sestaví plán z dostupných capabilities | **vysoké, pokud plán rovnou vykonává.** Musí místo toho **vyprodukovat `WorkflowDef`**, který projde stejnou fail-closed bránou (schema, Policy Engine, Human Review) jako dnešní ručně psaný workflow — generátor vstupu do přísného pipeline, ne nová cesta kolem něj |
| **Policy Engine + risk scoring** | částečně — `policy.ts` (`policyFor(installation.policies, capability, "1")`) existuje per-capability | rozšířit o rizikovou úroveň požadavku (nízké/střední/vysoké → auto/potvrzení/nikdy) | střední — navazuje na existující Human Review, není nová vrstva vedle ní |
| **Execution Engine** | existuje (`Router`, `ExecutorHost`, retry/review/journal) | — | **Opraveno 8. 9. 2026 (`b5b8be8`/`f29eb6f`), tenhle řádek byl zastaralý.** Hlubší identita `tenantId + handlerId + idempotencyKey` + fingerprint (`sha256(canonicalize(payload))`) → `IDEMPOTENCY_CONFLICT` je univerzální (`src/platform/executor-host.ts`, každý `ExecutorHost`). Durable effect ledger (`IdempotencyLedger` Durable Object, atomická `reserveOrGet`/`resolve`/`release`) ale zatím jen na `apf-document-host` — `apf-email-executor`'s `/dispatch` staví `ExecutorHost` bez `idempotency` volby, tedy s výchozím `InMemoryIdempotencyStore`, který se zahazuje s každým požadavkem (fresh `ExecutorHost` per `/dispatch`, žádná deduplikace napříč požadavky). Pro `SEND_MODE: "sandbox"` neškodí; **před `"live"` stojí za zvážení, jestli `email.send` (IRREVERSIBLE) nemá dostat stejnou durable ledger jako `document.stamp`, ne jen composite klíč** — otevřené, nezařazené do pořadí |
| **Human Review** | rozhodovací cesta existuje a je živě ověřená; časové expirace nasazené, alarm mechanismus živě ověřen | — | **Opraveno 8. 9. 2026 (`6dea224`, HANDOFF 50–52) a 9. 9. 2026 (`165fe38`, HANDOFF 66–67).** `SqliteReviewTaskStore` (Durable Object SQLite) drží úkoly durabilně, `POST /workflow/:id/review/decide` → `decideReview()` je nasazený a živě ověřený (`WAITING(REVIEW)` → decide → dokončená instance). WF-REV-003 (`orchestrator.applyReviewExpiries()`, `EXPIRE_TO_FAILED`/`EXPIRE_TO_CANCELLED`/`ESCALATE`/`CREATE_NEW_REVIEW`) je nasazené: každá `WorkflowInstance` si sama nastaví `ctx.storage.setAlarm()` na deadline vlastního otevřeného review úkolu (`rearmReviewAlarm()`). **Živě ověřeno (HANDOFF 67):** dočasnou izolovanou diagnostikou (mimo real journal/reviewStore) potvrzeno, že CF Durable Object alarm na `farm-bass443` skutečně vystřelí přesně v čas — kód pak vrácen, `git diff` prázdný. **Zbývá:** živé potvrzení celé byznys transakce (skutečný review úkol, co přirozeně expiruje a projde `applyReviewExpiries()`) — ověřená je zatím jen infrastrukturní vrstva (alarm → hook), ne plný běh přes reálnou `WorkflowDef` |
| **Tenant Layer** | koncepčně navrženo, nasazení záměrně single-tenant | `farm-bass443` je `CLOUD_SINGLE_TENANT` (viz `NAVRHOVY-LIST-farma.md`); `tenant-7` je jen protistrana bezpečnostních testů, ne živý zákazník. Foundation nese `tenants: string[]` + policy semantiku, ale skutečné tenant resolution (`TenantConfig { tenantId, assistant.displayName, orchestration.actorId }` místo jediného globálního `roles.orchestrator`) je budoucí capability, ne dnešní bug | nízké dnes (nic naostro na tom neběží) — vysoké, jakmile přibude druhý reálný tenant a nikdo tenant resolution nedodělal předem |
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
