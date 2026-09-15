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
| **Planner** | **deterministický základ hotov 15. 9. 2026 (Posudek 17, HANDOFF 154):** `contracts/facts.v1.json` (sémantický slovník faktů), `src/components/*/facts.json` (`consumes`/`produces` sidecar), `src/platform/fact-catalog.ts` + `src/platform/planner.ts` (`plan({goal, available}) → PLANNED \| CAPABILITY_GAP \| CYCLE`, jen klíče, nikdy hodnoty). PLAN-001/002: reprodukuje přesně dnešní `document-intake`/`mail-intake` řetězce. **Chybí:** compile krok `plan → WorkflowDef`, AI část (záměr → `goal`), runtime zapojení, identita entit v kolekcích, authority domain — viz `### Slovník faktů a deterministické skládání` | z požadavku (přirozený jazyk) sestaví plán z dostupných capabilities | **vysoké, pokud plán rovnou vykonává.** Musí místo toho **vyprodukovat `WorkflowDef`**, který projde stejnou fail-closed bránou (schema, Policy Engine, Human Review) jako dnešní ručně psaný workflow — generátor vstupu do přísného pipeline, ne nová cesta kolem něj |
| **Policy Engine + risk scoring** | částečně — `policy.ts` (`policyFor(installation.policies, capability, "1")`) existuje per-capability | rozšířit o rizikovou úroveň požadavku (nízké/střední/vysoké → auto/potvrzení/nikdy) | střední — navazuje na existující Human Review, není nová vrstva vedle ní |
| **Execution Engine** | existuje (`Router`, `ExecutorHost`, retry/review/journal) | — | **Opraveno 8. 9. 2026 (`b5b8be8`/`f29eb6f`) a 9. 9. 2026 (HANDOFF 69) — tenhle řádek byl dvakrát zastaralý, opraven znovu 13. 9. 2026.** Hlubší identita `tenantId + handlerId + idempotencyKey` + fingerprint (`sha256(canonicalize(payload))`) → `IDEMPOTENCY_CONFLICT` je univerzální (`src/platform/executor-host.ts`, každý `ExecutorHost`). Durable effect ledger (`IdempotencyLedger` Durable Object, atomická `reserveOrGet`/`resolve`/`release`) běží dnes na **obou** hostech: `apf-document-host` (8. 9.) i `apf-email-executor` (`deploy/cloudflare/apf-email-executor/src/idempotency-ledger.ts` + `DurableIdempotencyStore` v `index.ts`, HANDOFF 69) — ověřeno přímo v kódu 13. 9. 2026, ne převzato z předchozího zápisu. Tahle mezera je uzavřená, ne otevřená |
| **Human Review** | rozhodovací cesta existuje a je živě ověřená; časové expirace nasazené, alarm mechanismus živě ověřen | — | **Opraveno 8. 9. 2026 (`6dea224`, HANDOFF 50–52) a 9. 9. 2026 (`165fe38`, HANDOFF 66–67).** `SqliteReviewTaskStore` (Durable Object SQLite) drží úkoly durabilně, `POST /workflow/:id/review/decide` → `decideReview()` je nasazený a živě ověřený (`WAITING(REVIEW)` → decide → dokončená instance). WF-REV-003 (`orchestrator.applyReviewExpiries()`, `EXPIRE_TO_FAILED`/`EXPIRE_TO_CANCELLED`/`ESCALATE`/`CREATE_NEW_REVIEW`) je nasazené: každá `WorkflowInstance` si sama nastaví `ctx.storage.setAlarm()` na deadline vlastního otevřeného review úkolu (`rearmReviewAlarm()`). **Živě ověřeno (HANDOFF 67):** dočasnou izolovanou diagnostikou (mimo real journal/reviewStore) potvrzeno, že CF Durable Object alarm na `farm-bass443` skutečně vystřelí přesně v čas — kód pak vrácen, `git diff` prázdný. **Zbývá:** živé potvrzení celé byznys transakce (skutečný review úkol, co přirozeně expiruje a projde `applyReviewExpiries()`) — ověřená je zatím jen infrastrukturní vrstva (alarm → hook), ne plný běh přes reálnou `WorkflowDef` |
| **Průsvitná stáj (execution transparency)** | **Vizuální/IA rebuild hotov 13. 9. 2026** (HANDOFF 129) — operátorská stránka na `/farm` (`deploy/cloudflare/apf-gateway/src/page.ts`) kompletně přepsána: nová IA (Přehled/Podatelna/Ohrada/Stáj/Argos/Výsledek/Deník), vlastní CSS (žádný vendor design systém), `/` teď jen redirect na `/farm`. Cílový popis níže (`STEP`/`BREAKPOINT`/`REPLAY`/`DRY_RUN`/`OUTPUT_TO_JSON`/`SHADOW`) je **stále 0 %** — tohle je nová "přístrojová deska", ne ještě "audit debugger" | Cílově: pozorovatelný, krokovatelný a přehratelný běh workflow instance pro člověka — `STEP`/`BREAKPOINT`/`REPLAY` nad existujícím journalem (`Instance`/`StepRecord`, viz `### Execution Engine`), plus `DRY_RUN`/`OUTPUT_TO_JSON` (simulace bez side effectu, `WOULD_SUCCEED`/`WOULD_FAIL`/`NOT_FULLY_VERIFIABLE`, nikdy obecné „PASS") a `SHADOW` (nová verze capability běží paralelně, nikdy neovlivní proces, jen se porovná výstup — ideální před upgradem AI COW). Inspirace: LangGraph umí durable execution + inspekci/modifikaci stavu velmi dobře; **rozdíl, který chceme zachovat:** člověk smí *pozorovat* a *řídit průchod* (kdy krok proběhne, kdy se zastavit), ale pozorovací kanál sám nesmí být cestou, jak obejít tenant/policy/integrity pravidla — `STEP`/`REPLAY` nikdy nesmí obejít `Router`/`ExecutorHost`'s rozhodovací řetěz, jen ho zpomalit/zviditelnit. Journal (`Instance`/`StepRecord`) už dnes nese potřebná data pro replay čtení; chybí `STEP`/`BREAKPOINT` řídicí mechanismus samotný. **Zpřesnění 14. 9. 2026 (diskuze s vlastníkem):** `BREAKPOINT` nemá být obecné zastavení po každém kroku, ale konkrétně **po kroku, co zapisuje do Žlabu** (`cz.company.verify`/`cz.vat.verify`/`bc.vendors`/dojička/Konev) — dřív, než jeho výstup spotřebuje další krok, ne až poté. Důvod: Žlab je čistě append-only (`evidence.ts:79`, ZLAB-005 — žádná update/delete metoda existuje), takže „přeléčit krávu" nikdy neznamená opravit záznam v Žlabu, jen **znovu spustit tu krávu** — a to je doslova dnešní `resumeAfterReview()`'s `CORRECT` větev (`orchestrator.ts:199-207`), jen spuštěná ručně na breakpointu místo automaticky po selhání (nový spouštěč, žádný nový mechanismus). Zastavit se *před* spotřebováním výstupu, ne po, se vyhýbá mnohem těžšímu problému — invalidovat a znovu spustit celý zbytek řetězu za pozdě opraveným krokem. **Tvrdá závislost, blokuje jakoukoli implementaci debuggeru:** Žlab dnes není zapojený do žádné capability (`## Pořadí` bod 2 výš — „samostatný primitiv, ne live cesta zápisu evidence") — než bude na breakpointu co zobrazit, `cz.company.verify`/`cz.vat.verify`/budoucí `bc.vendors` musí nejdřív reálně volat `ledger.append()`; to je nezávislý, dřívější krok, ne součást debuggeru samotného | **střední, pokud se udělá špatně** — debug/observability kanál, který by uměl obejít policy, by byl přesně ten typ zadních vrátek, co `### Zero-trust model` má bránit. Implementace zatím 0 % |
| **Argos (watchdog) + Ponocný (heartbeat/canary)** | Argos existuje a je nasazený (HANDOFF 92–106): self-test rotace přes D1, banner `HEALTHY`/`DEGRADED`/`INCIDENT`, acknowledge/known-issue mechanismus, e-mail alerting živě ověřený až do schránky. **Ponocný jako pojmenovaný, oddělený mechanismus chybí** | **Oprava 13. 9. 2026 (vlastník):** Ponocný **není** enforcement arm — to bylo mylné zjednodušení z 12. 9. Správně: **Argos hlídá farmu. Ponocný nezávisle hlídá, že Argos skutečně hlídá.** Vědomě malý a nezávislý heartbeat/canary/dead-man's-switch — pokud `computeWatchdog()`/scheduled handler přestane běžet (gateway spadne, cron se zastaví), Argos samotný o tom nemůže vědět; Ponocný je oddělený, nezávislý proces/kontrola, co si všimne, že Argos přestal tikat, a **jen** to nahlásí. Ponocný nikdy nespouští quarantine/kill switch sám — to by ho udělalo druhým Argosem se stejnými failure modes, přesně čemu se má vyhnout. Enforcement patří do samostatného konceptu, viz řádek `Safety Executor` níže | **nízké dnes** — dnešní Argos je jediná linka obrany; pokud sám ztichne (proces spadne, cron se nespustí), nic to nezachytí. Ponocný jako *druhá*, nezávislá kontrola je přesně obrana proti tomuhle jednomu selhání, ne proti čemukoli širšímu |
| **Safety Executor (enforcement)** | chybí, koncept zapsán 13. 9. 2026 (dřív mylně slit s Ponocným) | Automaticky jedná na základě toho, co Argos nahlásí — `quarantine`/`capability kill switch`/`tenant kill switch`/emergency `READ_ONLY` — bez čekání na ruční zásah. Dnešní `LifecycleRegistry`'s `QUARANTINED` (`### Admission Gate (module lifecycle)` výš) je jediný kus týhle reakce, co už existuje — je ruční (`config/<installation>/lifecycle.json`), ne automatický na živý signál z Argose | **roste s každým dalším tenantem/COW**, protože ruční reakce (vlastník čte banner, rozhoduje) se neškáluje; automatický Safety Executor je předpoklad pro to, aby `### Blast radius / karanténa` (Zero-trust model) fungovalo i když se nikdo zrovna nedívá na dashboard |
| **Tenant Layer** | koncepčně navrženo, nasazení záměrně single-tenant | `farm-bass443` je `CLOUD_SINGLE_TENANT` (viz `NAVRHOVY-LIST-farma.md`); `tenant-7` je jen protistrana bezpečnostních testů, ne živý zákazník. Foundation nese `tenants: string[]` + policy semantiku, ale skutečné tenant resolution (`TenantConfig { tenantId, assistant.displayName, orchestration.actorId }` místo jediného globálního `roles.orchestrator`) je budoucí capability, ne dnešní bug. **Vlastníkův nápad 2026-09-09:** zadavatel požadavku (dnes: "Zadání požadavku" na `/farm`) by se měl na začátku identifikovat — token vázaný na e-mail, ověřovací e-mail (magic-link styl), ne jen spoléhat na jediné CF Access přihlášení vlastníka. Navazuje přímo na MAJOR 2 (Posudek 7: Access identita se dnes jen věří z hlavičky, kryptograficky se neověřuje) — stejná mezera, dva úhly pohledu. **Formalizováno 12. 9. 2026 jako samostatná vrstva `Office`, viz řádek níže** | nízké dnes (nic naostro na tom neběží) — vysoké, jakmile přibude druhý reálný tenant nebo veřejné zadávání požadavků a nikdo tenant/requester resolution nedodělal předem |
| **Office (tenant/identity/access)** | chybí, koncept zapsán 12. 9. 2026 | Recepce + matrika farmy — kde vzniká tenant a jeho lidé, ne kde se rozhoduje o business datech. Tři oddělené věci: **(1) Tenant** — `tenantId`, název, stav `ACTIVE`/`SUSPENDED`/`CLOSED` (smluvní/licenční, ne bezpečnostní expirace). **(2) Uživatelé a role** — e-mail identita, role (`admin`/`accountant`/`reviewer`/...), vazba na tenant; Office samo **neověřuje** heslo/e-mail/MFA — deleguje na skutečný identity provider (Cloudflare Access, Entra ID, Google) a jen mapuje jeho kryptograficky ověřenou identitu na `tenantId`+role (`ověřená identita X patří tenantovi Y, má role Z`). **(3) Tokeny** — session token (krátká expirace, desítky minut až hodiny, refresh přes IdP), service/connector token (vlastní expirace/rotace, žádné věčné tokeny), oba nesou `issuedAt`/`expiresAt`/`notBefore`/`revokedAt`/`tokenId`/`tenantId`/`actorId`/`scopes`; Office musí umět token okamžitě revokovat, ne jen čekat na expiraci. `tenantId` samo nikdy není token — je to trvalá identita organizace, token je jen dočasné oprávnění jednat jejím jménem. **MFA:** konfigurovatelné per tenant (`OPTIONAL`/`REQUIRED`/`REQUIRED_FOR_PRIVILEGED`), plus **step-up MFA** na kritické operace (např. schválení zápisu do BC nad limit) — Office samo MFA neimplementuje, jen čte úroveň autentizace, kterou dosvědčí IdP, a zapisuje ji do audit historie rozhodnutí. Přímo navazuje na `accessJwtVerified: false` (Posudek 7 MAJOR 2 / Posudek 8 P0-1 / Posudek 12 bod 7) — Office je architektonické místo, kam ta oprava patří, ne řešení samo o sobě | **vysoké, jakmile přibude druhý lidský uživatel nebo tenant** — dnešní jediný vlastnický účet za Cloudflare Access mezeru zakrývá; bez Office nemá multi-tenant provoz, kde stojí tenant/role resolution, a `TrustedContext` by dál stál na perimeter trust, ne na kryptograficky ověřené identitě |
| **Connector Layer** | **3 z N hotové a nasazené (9. 9. 2026, HANDOFF 57–61), řádek opraven 13. 9. 2026** | `document-host`, `apf-mail-ingest` a `apf-email-executor` běží na farmě, zapojené a nasazené na stejné úrovni jako `document.stamp`. `apf-mail-ingest`'s `email()` handler skutečně přijímá poštu (velikostní limit, prázdná zpráva, přeposlání do gateway `POST /mail-intake`) — `setReject()` volání jsou skutečná validace, ne placeholder; první reálný **event-driven** case je hotový, ne rozpracovaný | nízké — dvě capability navíc na stejném ověřeném vzoru jako `document.stamp`. Tenhle řádek byl přes čtyři dny (9.–13. 9. 2026) zastarale tvrdil `501 NOT_WIRED`/skeleton — HANDOFF (61) to už 9. 9. přiznal jako otevřený dluh dokumentace, jen se do teď needitovalo |
| **Audit provenance (COW zero-trust)** | nalezeno externím posudkem 9. 9. 2026 (`docs/POSUDKY.md` Posudek 7, MAJOR 5), ověřeno v kódu, **PARTIALLY MITIGATED od HANDOFF 95/96 (11. 9. 2026), opraveno v dokumentaci 14. 9. 2026 — externí posudek si všiml, že tenhle řádek zaostával za kódem** | `POST /audit` (`apf-gateway/src/index.ts`) zapíše skoro celý `Partial<AuditRecord>` z requestu (jen `auditId`/`at` přepíše); `RelayAudit.append()` (`apf-document-host`/`apf-email-executor`) posílá kompletní záznam přes service binding. Od (95)/(96) ale `auditClaimContradicts()` (`page.ts`) porovná tvrzený `tenantId` proti gateway's vlastnímu `WorkflowInstance` journalu (pravdivý zdroj) a `/audit` s rozporem vrátí `403 TENANT_MISMATCH` + zapíše `AUDIT_TENANT_MISMATCH` — živě ověřeno i s reálným pokusem o zfalšování (HANDOFF 96). **Co pořád chybí:** `actorId`/`capability`/`kind` a další pole nejsou kryptograficky svázané s konkrétním podepsaným dispatchem, jen `tenantId` je ověřený proti journalu — ne plný Ed25519-vázaný audit zápis | **nízké dnes** (jediné volající Workery jsou first-slice vlastní kód) — **vysoké před první třetí-stranovou COW** (Capability Marketplace), protože kompromitovaná COW by pořád mohla vyrábět falešné `actorId`/`capability` tvrzení pro správný tenant. Zbývající řešení: vázat celý `/audit` zápis na stejný Ed25519 dispatch podpis jako capability volání, ne jen tenantId na journal |
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

### Srovnání s enterprise konkurencí — Copilot Studio/Agent 365, Salesforce Agentforce, LangGraph (12. 9. 2026)

Vlastníkovo srovnání **koncepce** (ne dnešního kódu) proti tomu, kam se v roce 2026 posouvají
enterprise agentní platformy. Důležitá výhrada hned na začátku: **nesrovnává se rozsah produktu.**
Microsoft a Salesforce mají obrovský ekosystém, IAM, SLA, globální infrastrukturu, roky vývoje —
farma nemá a v dohledné době mít nebude. Srovnává se **architektonická koncepce bezpečného
vykonávání agentních business procesů**, kde je pozice farmy nezvykle silná.

**Co to potvrzuje:** Microsoft Agent 365 funguje jako centrální control plane s identitou agentů v
Entra, nad kterou lze aplikovat Conditional Access/RBAC/ABAC — tedy **autorizace vynucovaná identity
systémem, ne instrukcí v promptu**. To je přesně `## Positioning`'s `AI navrhuje → deterministická
vrstva autorizuje → úzký COW vykonává` — farma tedy nejde exotickou cestou, jde stejným směrem jako
enterprise lídr, jen vlastní implementací.

**Kde je farma koncepčně nadstandardní:** typický agentní framework pracuje hlavně se stavem
(`Agent A → state → Agent B → state → tool`) — výstup předchozího kroku se bere jako fakticky
pravdivý vstup dalšího. Řetěz `Kráva → Žlab (immutable evidence) → Dojička → Konev
(kryptograficky zapečetěný CertifiedBusinessObject) → Mlékárna` (`### Tři role, ne dvě` výš) jde
dál: výstup není automaticky pravda, je to **tvrzení s původem, hashem a důkazem**. Stejně
`COMPROMISED-ORCHESTRATOR`/composition attack suite (`### Nový povinný test...`, `### Composition
attack suite` výš) řeší explicitně to, co shared-responsibility modely (Salesforce Agentforce) nechávají
na zákazníkovi doladit: architektonickou cestu, jak zabránit „AI mistake → účetní zápis" i když je
Farmář nebo jednotlivá kráva kompromitovaná.

**Co si vzít z LangGraphu:** durable execution + inspekce/modifikace stavu za běhu je silná stránka
LangGraphu. `Průsvitná stáj` (`## Vrstvy` výš) je farmin ekvivalent — se zásadním rozdílem, který
se má zachovat: pozorovací/řídicí kanál (`STEP`/`BREAKPOINT`/`REPLAY`) nikdy nesmí být cestou, jak
obejít tenant/policy/integrity pravidla, jen cestou, jak proces zpomalit a zviditelnit.

**Co velcí mají a farma ne:** Entra, Conditional Access, Purview, Sentinel, DLP, CMK, regionální
data residency, síťové řízení, ALM, governance, obrovský connector ekosystém — roky budované
identity/data/security infrastruktury. **Farma dnes má architektonický návrh a postupně vznikající
implementaci, ne hotovou platformu.** Správná formulace není „farma je bezpečnější než Microsoft
Agent 365" — je to „koncepce farmy je na úrovni moderních enterprise agent-security principů a v
několika konkrétních oblastech (evidence/provenance, DRY_RUN jako povinnost, kompozice více
agentů) jde ještě tvrdším směrem".

**Vnější signál, který tohle podporuje:** průzkum Harnessu (2026) uvádí mezeru mezi důvěrou firem
v zabezpečení agentů a tím, co skutečně dokážou ověřit, včetně nízkého rozšíření deployment gates a
kill switchů. Farma na tohle nezávisle došla stejným směrem — `Admission Gate → CertificationRecord
→ Argos (detekce) → Safety Executor (quarantine/capability-tenant kill switch/emergency READ_ONLY)`,
s **Ponocným jako nezávislým heartbeat/canary hlídačem Argose samotného** (`## Vrstvy` výš, opraveno
13. 9. 2026 — Ponocný se dřív mylně popisoval jako sám enforcement arm) — signál, že se řeší
správný problém, ne že je řešení už hotové.

**Metodologická poznámka:** číselné skóre v tomhle srovnání je vlastníkovo konceptuální hodnocení
(kam farma míří po naplnění dnešních invariantů), ne měření dnešního kódu — na rozdíl od
`docs/POSUDKY.md`'s posudků, který se drží disciplíny „ověřeno v kódu, ne převzato z tvrzení",
tohle je vědomě dopředu hledící srovnání a mělo by se tak i číst.

**Zdroje (vlastníkovo srovnání, 12. 9. 2026):**
[Copilot Studio security/governance](https://learn.microsoft.com/en-us/microsoft-copilot-studio/security-and-governance) ·
[Copilot Studio multitenant mode (preview)](https://learn.microsoft.com/en-us/microsoft-copilot-studio/multi-tenant-overview) ·
[Microsoft: Authorization and Identity Governance Inside AI Agents](https://techcommunity.microsoft.com/blog/microsoft-security-blog/authorization-and-identity-governance-inside-ai-agents/4496977) ·
[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) ·
[Agentforce Security and the Shared Responsibility Model](https://help.salesforce.com/s/articleView?id=005315874&language=en_US&type=1) ·
[ITPro: agent security/governance practices survey (Harness)](https://www.itpro.com/software/development/agents-have-hit-the-mainstream-in-software-engineering-but-security-and-governance-practices-arent-evolving-fast-enough).

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
  **Postaveno 13. 9. 2026, viz `## Pořadí` bod 5 níže pro detail.** API zdroj ověřen 11. 9. 2026:
  `EkonomickeSubjektySluzba` (`GET
  https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}`) — bezplatné,
  oficiální (MF ČR). `Ico_T` je pevných 8 číslic, shoduje se s `invoice.extract`'s `companyId`
  validací beze změny. Klíčová pole: 404/`VYSTUP_SUBJEKT_NENALEZEN` = IČO neexistuje (business
  výsledek, ne technická chyba — stejně jako `OTHER` u `document.classify`), `datumZaniku` =
  subjekt zanikl i když "existuje", `seznamRegistraci.stavZdrojeRes`/`stavZdrojeVr` = per-registr
  aktivní/neaktivní stav.
- **`cz.vat.verify`** (deterministický, žádné AI) — stav plátce DPH a **zveřejněný bankovní účet
  u Finanční správy**. **Postaveno 13. 9. 2026, viz `## Pořadí` bod 6 níže pro detail.** API zdroj
  ověřen 11. 9. 2026: SOAP webová služba MOJE daně
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
**Potvrzeno 11. 9. 2026 — dvě entity s reálným spotřebitelem, ne jedna:**

- **`customers` (zákazníci)** — spotřebitel: dávkový audit ("ověř zdraví zákazníků v BC", `##
  Dávkové úlohy...` výše). Číslování v tenantu vlastníka: `C*****` (např. `C00010`).
- **`vendors` (dodavatelé)** — spotřebitel: **invoice→BC řetěz samotný**, ne dávkový audit. Faktura
  (`invoice.extract`) je typicky přijatá od dodavatele — `cz.company.verify` ověří IČO proti ARES
  (**vnější** autorita: "existuje ten subjekt vůbec"), ale zápis do BC (budoucí BC Executor)
  potřebuje existující **Vendor No.** — tedy druhou, **vnitřní** otázku: "je tenhle IČO už u nás v
  BC veden, a pod jakým číslem". Bez týhle krávy import nejde nikdy dotáhnout, i kdyby BC Executor
  byl hotový — `cz.company.verify` sama o sobě zápis neumožní najít cílový záznam. Přesné pole, kam
  BC ukládá IČO dodavatele (`VAT Registration No.`, `Registration Number`, nebo tenant-specific
  custom pole), zatím neověřeno — zjistí se při stavbě, ne teoreticky teď.

Obě jsou **read-only** (nízké riziko) a **stavitelné už dnes**, nezávisle na tom, že BC Executor
(write strana) je zatím odložený za JSON Export mezifázi — čtecí strana integrace nemusí čekat na
zápisovou.

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

### Tři role, ne dvě — a plná linka Žlab → Dojička → Konev → Mlékárna (pojmenování zpřesněno 12. 9. 2026)

- **Farmář** (orchestrátor) — jen hrubé rozpoznání záměru a routing. „Tohle vypadá jako faktura, cíl:
  připravit k importu do BC." Nic víc. Nečte a neskládá business data, jen rozhoduje, která COW má
  přijít na řadu.
- **Krávy** (COW) — jednoúčelové, úzké. Každá dělá jeden konkrétní úkon (přečti dokument do MD,
  vytáhni pole faktury, ověř IČO proti ARES, ověř DIČ, ověř bankovní účet, ověř součty/DPH/data).
- **Žlab** — formální jméno pro to, co je výš i níž popsané jako „sklad": **immutable, signed**
  úložiště, kam krávy odkládají `Evidence` (viz `### Kontrola musí být svázaná s konkrétní hodnotou`
  níže) — append-only, hash-chained (`parent hash` na předchozí záznam), nikdy se v něm nic
  nepřepisuje ani nemaže. Farmář do Žlabu smí jen *ukazovat* (odkazem na artefakt), nikdy do něj
  psát business hodnotu vlastní rukou (`### Hlavní invariant` níže). Dojička čte výhradně ze Žlabu,
  nikdy z tvrzení Farmáře. **Implementováno jako testovaný primitiv 13. 9. 2026** —
  `src/platform/evidence.ts`'s `EvidenceLedger`, `tests/zlab.test.ts` (HANDOFF 121); zatím
  nezapojeno do žádné reálné capability. **Trusted `EvidenceWriter` hotov 13. 9. 2026** (Posudek 15
  P1-2, HANDOFF 128): `EvidenceLedger.append()` je jen storage primitiv, ne trust boundary (vlastní
  doc comment to přiznává) — `src/platform/evidence-writer.ts`'s `EvidenceWriter` je ta chybějící
  hranice — identita (`producerId`/`capabilityVersion`/`buildHash`) svázaná jednou při konstrukci
  (jedna instance = jedna capabilita, nikdy per-call přepsatelná), `tenantId`/`workflowId`/
  `operationId` čtené z `HandlerInput` (co Router/ExecutorHost produkuje až po schema/binding/
  signature/scope/policy kontrolách), kráva smí dodat jen doménový `EvidenceClaim` (pole/hash/
  výsledek) — bez vlastního `tenantId`/`producerId` pole, tedy ani přes cast nejde identitu
  podvrhnout. `tests/evidence-writer.test.ts`, 6 testů (EW-001..004).
- **Dojičky** — nová role vedle COW. Na rozdíl od COW (jednoúčelová) je dojička **jednoduchá
  kumulativní**: deterministicky sesbírá evidenci víc krav ze Žlabu do jednoho dalšího balíku/stavu
  podle pevného kontraktu. Nic nevymýšlí, nic neopravuje, nic nepřepisuje — jen skládá.
  **Implementována jako testovaný primitiv 13. 9. 2026** — `src/platform/aggregator.ts`'s
  `EvidenceAggregator`, `tests/dojicka.test.ts` (HANDOFF 121); `Konev`/zápis do BC pod ní ještě
  nestojí.
- **Konev** — zapečetěný (kryptograficky podepsaný) výstup dojičky: `CertifiedBusinessObject`.
  Obsahuje výsledná business data + odkazy na všechnu evidenci ze Žlabu, ze které vznikla, plus
  podpis nad tím vším. Jakmile je Konev zapečetěný, žádná další komponenta (ani Farmář, ani
  Mlékárna) nesmí jeho obsah změnit — jen ho buď přijme celý, nebo odmítne celý.
  **Implementován jako testovaný primitiv 13. 9. 2026** (Posudek 14, HANDOFF 125) —
  `src/platform/konev.ts`'s `BusinessObjectSealer`: `seal()` přijme jen `AggregateResult` s
  `decision: "READY"` (strukturálně, ne jen disciplínou volajícího) a nezávisle si znovu ověří
  každou odkazovanou evidenci proti Žlabu (tenant/integrita/lineage) v okamžiku zapečetění, ne
  jen převezme, co si Dojička už myslela. `verify()` dělá dvě oddělené kontroly: shodu `rootHash`
  s obsahem objektu samotného (tamper na Konvi) a živé přeověření každé odkazované evidence proti
  Žlabu (tamper na evidenci **po** zapečetění) — druhé Konev's vlastní `rootHash` nemůže sám
  odhalit, protože neobsahuje hashe evidence, jen jejich id. `tests/konev.test.ts`, 8 testů
  (KONEV-001..008). **Zatím nenapojeno na žádnou reálnou Mlékárnu** — spotřebitel je zatím jen
  testovací fixture.
- **Mlékárna** — obecné jméno pro to, co je dnes konkrétně `BC Executor`: úzce oprávněný, „hloupý"
  write executor, který přijme zapečetěný Konev, ověří pečeť/fingerprint a zapíše ho do cílového
  systému (BC, ale stejně tak budoucí jiný systém) — nikdy nečte a nezpracovává nic mimo Konev
  samotný. Generalizace stejná jako u `### DRY_RUN jako obecný princip`: BC Executor je první
  konkrétní Mlékárna, ne jediná možná.

```
faktura → Farmář (rozpozná: "faktura, cíl BC import")
        → Kráva: Document Reader (MD)
        → Kráva: Invoice Extractor (pole faktury)
        → Krávy: ARES / VAT / Bank Account / Math validation (paralelně, jednoúčelově)
        → [ZAPIŠOU EVIDENCI DO ŽLABU — immutable, signed, hash-chained]
        → Dojička: čte ze Žlabu, složí Invoice Package (Extraction/ARES/VAT/Účet/Math/Duplicita
          → Overall) → zapečetí jako Konev (CertifiedBusinessObject)
        → Import Gate (deterministický, viz níže) — poslední kontrola před předáním Konve dál
        → Mlékárna (konkrétně: BC Import COW) — přijme Konev, zapíše, nebo NE
```

Tenhle vzorec je konkrétní instance `## Připravované doménové COW`'s řetězu `invoice.extract →
cz.company.verify → cz.vat.verify` — dojička je chybějící dílek mezi „samostatné capabilities" a
„jeden agent, co dělá všechno", co ta sekce výslovně zakazuje.

**Poznámka k pojmenování:** Žlab/Konev/Mlékárna vznikly ve vlastníkově diskuzi mimo tenhle repo
(12. 9. 2026) a jsou tu zapsané podle nejlepšího porozumění kontextu, který se sem dostal
zprostředkovaně — **ne z přímého zadání v týhle konverzaci**. Sémantika (immutable evidence store →
deterministický skladač → zapečetěný podepsaný výstup → úzce oprávněný zapisovač) je vnitřně
konzistentní se vším, co SEVERKA už dřív řešila pod jmény „sklad"/`CertifiedInvoice`/BC Executor —
formálně tohle jen dává těm už existujícím konceptům jména. Pokud vlastníkův záměr byl jiný, tahle
sekce se má přepsat, ne brát jako hotové rozhodnutí.

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

**Vynutit schématem, ne jen dokumentací (Posudek 12 bod 10, 12. 9. 2026):** dnešní invariant je
zapsaný slovy tady v SEVERKA, ne vynucený strojově. Cílový stav: Farmářovo vlastní input/output
schéma (stejná disciplína jako `module-descriptor.v1.schema.json` u COW) nesmí vůbec **dovolit**
pole jako `amount`/`bankAccount`/`ico`/`vatId`/`supplier` na výstupu — ne aplikační kontrola, která
by taková pole vyhodila, ale schema, kde ta pole strukturálně neexistují (`additionalProperties:
false` + žádná business-value property v `properties`). Stejně dojička: její API nesmí nabízet
`setAmount()`/`setBankAccount()` ani nic, co by hodnotu mohlo přepsat — jen `compose(evidence[])
→ decision`. Schema-level zákaz je silnější důkaz než code review, že farmář/dojička nemůže nosit
hodnoty ani omylem, natož úmyslně.

### Import Gate — deterministický, čte ze Žlabu, ne od Farmáře

```
FARMÁŘ → "import INVOICE-4711"
            ↓
      IMPORT GATE (deterministický, žádné AI)
            ↓ načte ZE ŽLABU — immutable, signed (ne od Farmáře)
   IČO, ÚČET, ČÁSTKA + evidence každé kontroly
            ↓
   všechny důkazy patří INVOICE-4711 a sedí na AKTUÁLNÍ obsah?
            ↓ ANO
      zapečetí jako KONEV (CertifiedBusinessObject)
            ↓
   MLÉKÁRNA (konkrétně: BC Executor) → Business Central
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

**Formalizace jako platformní primitivum `Evidence` (Posudek 12 bod 11, 12. 9. 2026):** místo že
by dojička četla samotné `field: PASS` nebo samotný `valueHash`, každá validační kráva vrací
strukturovaný záznam:

```
Evidence
  evidenceId
  tenantId
  capability     (např. cz.vat.verify)
  provider       (kdo evidenci vydal)
  inputField     (které pole faktury ověřuje)
  inputValueHash (= valueHash výš, hash ověřované hodnoty)
  result         (PASS | FAIL | ...)
  observedAt
  expiresAt?
  buildHash      (jaký build krávy evidenci vyrobil — váže se na CertificationRecord výš)
```

Dojička pak nečte "VAT = PASS", ale "VAT PASS pro hash 91ab…, od `cz.vat.verify`, build 83cd…" —
pokud farmář nebo kdokoli jiný mezitím změní vstupní hodnotu, `inputValueHash` už neodpovídá
aktuálnímu poli a evidence automaticky přestává platit (stejný mechanismus jako
`VALUE_CHANGED_AFTER_VERIFICATION` výš, jen jako explicitní typované pole, ne implicitní
porovnání). `expiresAt` řeší stárnutí evidence (viz composition attack suite níže — "evidence je
stará 30 dní, dojička ji přesto použije"). **Implementováno jako testovaný primitiv 13. 9. 2026**
(`src/platform/evidence.ts`, HANDOFF 121) — `expiresAt` skutečně kontroluje `EvidenceAggregator`
(`src/platform/aggregator.ts`, HANDOFF 121), ne jen návrh. Zatím kandidát pro rozšíření
`module-descriptor.v1.schema.json` společně s formalizací Dojičky/Kráva typu výš — descriptor sám
o Evidenci dnes neví, jen kód.

**Úložiště pro `Evidence` je Žlab** (`### Tři role, ne dvě` výš) — append-only, hash-chained
(každý záznam nese `parent hash` na předchozí záznam ve stejném řetězu, ne jen svůj vlastní hash),
podepsaný v okamžiku zápisu. „Immutable" znamená doslova: žádná komponenta, včetně Farmáře, nemá
oprávnění existující `Evidence` záznam ve Žlabu přepsat nebo smazat — jen přidat nový. To je
mechanismus, který dělá `VALUE_CHANGED_AFTER_VERIFICATION` detekovatelným navždy, ne jen dokud
někdo záznam nepřepíše.

### Composition attack suite — útoky na skládání výsledků víc krav, ne na jednu COW (Posudek 12 bod 12, 12. 9. 2026)

`### Zero-trust model`'s `Adversarial test suite` (níže) řeší útoky na **jednu** COW (cross-tenant,
credential escape, replay, forged context...). Jakmile začne existovat víc krav skládaných
dojičkou, vzniká nová třída rizika na **rozhraní mezi nimi**, kterou žádný z dnešních testů
nepokrývá:

- Kráva A vrátí výsledek pro fakturu X, ale farmář (chybou nebo úmyslně) ho použije pro fakturu Y.
- ARES evidence platí pro staré IČO, zatímco extrakce mezitím vytvořila nové (dokument se
  přeparsoval, IČO se opravilo).
- VAT evidence patří tenantovi A, dojička počítá výsledek pro tenanta B.
- Kráva je po certifikaci upgradovaná (nový `buildHash`), ale stará `CertificationRecord`/evidence
  je pořád považovaná za platnou.
- Evidence je stará 30 dní (za hranicí rozumné platnosti), dojička ji přesto použije, protože
  `expiresAt` nikdo nekontroluje.
- Dvě krávy vrátí vzájemně konfliktní fakta o stejném poli (např. dvě různá ARES volání s
  rozdílným výsledkem kvůli mezičasové změně u zdroje).
- Jedna kráva vůbec neodpoví (timeout/výpadek) a Planner/dojička se přesto pokusí dokončit import,
  jako by chybějící evidence znamenala PASS.

Tyhle scénáře patří do Verification Contractu jako nová testovací kategorie (pracovní název:
`COMPOSITION`), doplňující `### Nový povinný test pro Admission Gate: COMPROMISED-ORCHESTRATOR /
CONFUSED-DEPUTY` výš — ten řeší kompromitovaného farmáře, tahle sada řeší **poctivého** farmáře a
poctivé krávy, které přesto composition-level chybou/útokem skončí se špatným výsledkem. Žádný
z těchto scénářů není dnes implementovaný jako test — čeká na vlastníkovo rozhodnutí, kdy na řadu
přijde (Posudek 12 řadí za `cz.company.verify`/`cz.vat.verify`/`bc.vendors`/první dojičku, před
ostrým BC write).

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

**P0 před BC live write (Posudek 14 bod 5, 13. 9. 2026):** dnešní `checkEffectFieldValidators()`
(`src/platform/policy.ts`, `## Vrstvy` → `Policy Engine`) čte `validation.status: "passed"` **uvnitř
business payloadu** — to je legitimní obecný policy mechanismus (a dnes jediný skutečně vynucený),
ale **budoucí Mlékárna nesmí BC zápis autorizovat na základě tohoto tvrzení v payloadu.** Musí
ověřit celý **Konev** (`BusinessObjectSealer.verify()` — `## Vrstvy` výš, HANDOFF 125): `rootHash`
+ platform signature + živý stav každé odkazované evidence. `validation.status` v payloadu zůstává
užitečný pro capability, které Evidence/Žlab vůbec nepotřebují (menší riziko, jiná kategorie);
BC/Mlékárna třída write capabilit (R3+, `### Risk profily řídí povinné testy` výš) má vždy ověřovat
Konev, nikdy substituovat `checkEffectFieldValidators()` za tuhle kontrolu.

**Vývojová/ověřovací fáze, rozhodnuto 11. 9. 2026 (vlastník):** dokud řetěz není hotový a ověřený,
BC Executor se nestaví ani nezapojuje — poslední krok místo něj je **JSON Export** (stejně „hloupý",
no-AI, jen zapíše `CertifiedInvoice` jako JSON, žádný reálný credential ani side effect mimo
platformu). K ověření, že extrakce+verifikace vrací správná data, slouží samostatný krok
**Invoice Generator** — vezme JSON a **deterministicky, bez AI** z něj sestaví fakturu (šablona,
ne věrný vizuál — „rychlé, levné, hloupé, jen pro kontrolu"). Člověk porovná vygenerovanou fakturu s
originálem = živé ověření, že řetěz nic needitoval a nic nevynechal, bez nutnosti reálného BC přístupu.
Až řetěz projde touhle kontrolou, JSON Export se nahradí skutečným BC Executorem beze změny zbytku
řetězu (Import Gate/fingerprint/farmář-bez-přístupu zůstává stejné, mění se jen poslední krok).

**Tohle je první instance obecného principu, ne BC-specifická výjimka — viz `### DRY_RUN jako
obecný princip pro write capability` níže** (zpřesnění vlastníka 12. 9. 2026): každá budoucí write
capabilita (ne jen BC) má mít stejný `DRY_RUN` mód, než dostane skutečný credential.

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
záplatu. **Od 15. 9. 2026 v kódu:** `plan()` vrací `CAPABILITY_GAP` s `NO_PRODUCER`/`UNSATISFIABLE`
a seznamem vyzkoušených producentů (`src/platform/planner.ts`, PLAN-003).

### Slovník faktů a deterministické skládání — Farmář smí znát sémantiku, nikdy hodnoty (15. 9. 2026)

Z Posudku 17 (`docs/POSUDKY.md`), čtyři kola externí review + ověření v kódu. Cíl: Farmář nemá mapovat
JSONy ani „nadefinovat celou cestu" per případ (n8n riziko), ale řešit *co ještě chybí ke splnění
cíle* — a to deterministicky, ne LLM. Přijatý invariant:

> **Planner/Scheduler smí pracovat se sémantikou, identitou a stavem faktů/evidence, ale nesmí dostat
> autoritativní business hodnoty. Generovaný plán smí obsahovat pouze reference na business objekty,
> faktové klíče, evidence a artifacts; dereference hodnot probíhá až v důvěryhodné platformní vrstvě.**

Přímé pokračování `### Hlavní invariant: farmář nesmí nosit hodnoty`. Dnešní `resolveRef()`
(`$steps.classify.payload.documentType` v ručně psaných workflow) je pro první slice v pořádku, ale
generovaný plán nesmí takové odkazy na business hodnoty vůbec vyrábět. Základní jednotka systému není
workflow, ale **fakt + capability + policy**; kráva je schopnost („umím z těchto faktů vyrobit tyto"),
ne krok — neví, co bude potom, odkud vstup přišel ani kdo ji volá.

**Hotovo 15. 9. 2026 jako testovaný primitiv (HANDOFF 154):**
- `contracts/facts.v1.json` — sémantický jmenný prostor: co klíč *znamená*, nikdy hodnota (`kind`
  fact/artifact/evidence/effect — Scheduler nesmí zaměnit „znám IČO" za „IČO bylo ověřeno proti ARES";
  `authority` source/derived; evidence nese `for` a `resultVocabulary` ze skutečného kódu). Obsahuje i
  klíče bez producenta (`supplier.vatId`, `vendor.bcNumber`) — slovník říká, co fakt znamená, ne kdo ho umí.
- `src/components/<module>/facts.json` — sidecar (descriptor zmrazený) s `consumes`/`produces` ve
  skupinách artifacts/facts/evidence/effects; množina capabilit musí sedět s `descriptor.json`
  (FACT-004). Trust není pole na faktu — spotřebitel explicitně konzumuje evidenci
  (`document.stamp` konzumuje `document.type.validated`), přesně jako Dojička čte Žlab.
- `src/platform/fact-catalog.ts` (`FactCatalog.build()`, fail-closed, odmítá i pole mimo kontrakt —
  strukturálně nemůže nést hodnotu) a `src/platform/planner.ts` (`plan({goal, available}) →
  PLANNED | CAPABILITY_GAP | CYCLE | INVALID`, backward chaining + Kahn s pevným tie-breakem podle
  jména, vstup i výstup jen klíče — PLAN-005).
- **Tvrdá brána myšlenky splněna:** PLAN-001/002 — `plan()` z katalogu reprodukuje přesně dnešní
  `document-intake` v1/v2 a `mail-intake` v1/v2 řetězce. Katalog tedy kóduje to, co workflow už vědí,
  nic navíc. Planner sám našel dva reálné gapy: `supplier.vatId` nemá producenta (`invoice.extract` v1
  DIČ neextrahuje → `cz.vat.verify` nemá kdo krmit), `vendor.bcNumber` nemá producenta
  (`bc.vendors`, `## Pořadí` 7).

**Fáze (shoda vlastník + posudek):** fáze 1 = `goal → deterministic plan → immutable WorkflowDef →
execution`. Compile krok `plan → WorkflowDef` (retry budgety, role, deadliny, strategie = execution/policy
parametry, ne vlastnost cíle — patří do policy/profile vrstvy nebo goal template) a AI Planner (záměr →
`goal`) zůstávají za `## Pořadí` body 1–10. **Runtime replanning po každém kroku se nedělá** — je to
nový orchestration model (verze plánu, idempotency, approval, crash recovery), ne mutace běžící
instance; případně později jako nová verze/pokračování, nikdy úprava rozběhnutého workflow.

**PURE / READ / WRITE bez nového enumu:** `sideEffects` ve zmrazeném schématu zůstává; PURE vs READ se
derivuje z `sideEffects: none` + `allowedNetworkDestinations` (prázdné = PURE, neprázdné = READ /
external observation — má egress, cenu, freshness a posílá tenantova data ven). Argos rozhoduje z
konkrétních vlastností, ne ze sebeoznačení krávy.

**Dvě návrhová rozhodnutí před dalšími kravami (Posudek 17 kolo 4, nerozhodnuto v kódu) — obě
rozhodnou, jestli Fact Contract vydrží rozšiřování bez rozbití:**

1. **Identita entit v kolekcích (`invoice.line`).** Index (`invoice.lines[0]`) je špatná identita —
   přeuspořádání nebo re-extrakce rozbije vazbu evidence. Návrh: stabilní platformní `entityId`
   (ULID-styl, nese nulovou business hodnotu), capability se binduje na **typ entity + typ faktu**
   (`invoice.line` × `description`), ne na JSON cestu. Id entity **není součást klíče** ve slovníku
   (uzavřený namespace, FACT-002/003) — klíč zůstává typ (`invoice.line.description`, `scope:
   invoice.line`), entita je samostatná souřadnice adresy faktu; kanonická serializace `klíč@entityId`
   jen pro hashování/journal/Konev `fieldHashes`. Evidence se váže na **hash obsahu entity** (stejný
   princip jako Konev): re-extrakce se změněným obsahem evidenci správně zneplatní, s identickým obsahem
   ji zachová. „Jednou per entitu, kde fakt chybí" = nový `forEach` krok ve `WorkflowDef` (bounded
   loop — `### Bounded looping`, N = počet položek, idempotency key per `(step, entityId)`), ne runtime
   replanning. Stejný mechanismus pro `order.line`, `contract.party`, `email.attachment`, `payment.item`.
   Předpoklad pro `accounting.account.resolve` — dnes `invoice.extract` v1 položky vůbec neextrahuje.
2. **Authority domain evidence místo jedné osy trustu.** Kráva smí tvrdit jen „produkuji X"; kdo je
   oprávněn tvrdit konkrétní fakt, přiděluje instalace: grant `authorities: { "cz.company.registry":
   ["cz.company.verify"], "tenant.businessCentral": ["bc.vendors"], "tenant.human-review": [...] }`
   (stejné místo jako scopes/granty, ADR-016 per tenant). `EvidenceWriter` razítkuje `authorityDomain`
   z grantu (platforma, ne kráva — sebetvrzení „jsem authoritative" je stejná chyba jako `expiresAt` od
   krávy, Posudek 16 P1-10). Dojička pak nepožaduje `producerId` konkrétní krávy (dnešní
   `RequiredEvidence` — výměna ARES adaptéru za jiný registr by rozbila kontrakt), ale doménu:
   `supplier.companyId → cz.company.registry`, `vendor.bcNumber → tenant.businessCentral`. ARES je
   autorita pro název a stav firmy, ne pro `bcVendorId`; BC přesně naopak. Samostatný `trustLevel` na
   evidenci není potřeba — doména ho subsumuje; `FieldValue.trustLevel` zůstává jako platformou
   **odvozený** souhrn, kráva smí nastavit jen nejnižší. Táž policy tabulka nese `maxEvidenceTTL` per
   doména. Vedlejší zisk: `available` pro `plan()` spočítané ze Žlabu (čerstvá evidence pro stejný hash
   IČO) zkrátí řetězec — „známý dodavatel nepotřebuje `company.verify`" vypadne zadarmo.

**Role po kole 4 (shoda):** Kráva vyrábí fakta · Žlab drží evidenci (hodnoty faktů žijí v artefaktech
a journalu instance — samostatný Fact Store není pro fázi 1 potřeba) · Farmář hledá, co chybí a kdo to
umí · Argos rozhoduje, co smí být spuštěno · Dojička rozhoduje, zda jsou splněny podmínky cíle
(**platformní role, nikdy kráva** — kompromitovaná capability nesmí být rozhodčí) · Konev pečetí ·
Adapter deterministicky tvoří cílový payload · Mlékárna/ExecutorHost provede write.

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

**Doplněno 15. 9. 2026 (Posudek 17):** vedle descriptoru má každý modul sidecar `facts.json` —
`consumes`/`produces` v klíčích `contracts/facts.v1.json`, skupiny artifacts/facts/evidence/effects;
množina capabilit v něm musí sedět s descriptorem (FACT-004). Viz `### Slovník faktů a deterministické
skládání` výše. Sidecar, ne rozšíření descriptoru: zmrazený kontrakt se nemění bez evidence z kódu.
Pět otázek pro novou krávu (jaký doménový problém · jaké fakty potřebuje · jaké vyrobí · jak moc jim
věřit · jaký side effect) a naming test (`after`/`before`/`step`/`then`/`workflow` v názvu = popisuje
místo v procesu, ne schopnost) patří do promptu Kravské dílny — nepostaveno.

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

**`CertificationRecord` — `ACTIVE` vázané na konkrétní build, ne na ruční rozhodnutí (Posudek 12,
12. 9. 2026):** dnešní self-test infrastruktura (D1, historie per capabilita, HEALTHY badge s
rozpisem) je dobrý základ, ale sama o sobě není certifikace — neváže výsledek na to, jaký kód
skutečně běží. Chybějící vazba:

```
CertificationRecord
  gitSha / buildHash
  module
  capability
  riskProfile
  requiredTests   (odvozeno z riskClass, viz "Risk profily řídí povinné testy" výše)
  actualResults
  = PASS | FAIL
```

Pravidlo: `Lifecycle` smí modul/capabilitu přepnout do `ACTIVE` jen když `CertificationRecord.PASS
&& certifiedBuildHash == runningBuildHash` — ne ruční allow-list zápis (dnešní stav,
`config/<installation>/lifecycle.json`), a ne jen "self-test dřív prošel na nějakém buildu". Bez
téhle vazby může běžet kód, který se od certifikace změnil, a lifecycle o tom neví. Přímo doplňuje
`NEW/TESTING/CERTIFIED/DEGRADED` stavy výš (`## Vrstvy`, Admission Gate řádek) o mechanismus,
který o přechodu do `CERTIFIED`/`ACTIVE` rozhoduje. **Implementováno jako testovaný primitiv
13. 9. 2026** (`src/platform/certification.ts`'s `CertificationRegistry`/`deriveLifecycleStatus()`,
HANDOFF 126) — zatím samostatně, nezapojeno do `LifecycleRegistry`/`Router.route()` na skutečné
farmě (viz `## Pořadí` bod 4 níže pro důvod, proč to čeká na vlastníkovo rozhodnutí).

### Kráva z GUI — generátor propojení, ne ruční zakládání (13. 9. 2026)

Vlastníkovo rozhodnutí, revidující `## Cílová architektura pro standardizované přidávání COW`'s
8. 9. 2026 výhradu „čerpá se až bude evidence [druhá reálná write-capabilita, druhý reálný tenant],
ne teď dopředu" — pro tenhle jeden kus (GUI + generátor propojení) chce stavět už teď: „jak bude
aplikace hotová, tak už nechci chodit do kódu, chci všechno obsluhovat z webové stránky ...
případně bysme tam mohli využívat i tu vrstvu AI." Přispěvatel (vlastník) dodává jen doménový kus —
kód volání ven (např. ARES/VAT klient) — a **veškeré propojení generuje nástroj, ne ruce**:
`descriptor.json`, schémata, `handler.ts` s injektovaným adaptérem (vzor `### COW technický pas`
výš a `document-validator`/`RegistryAdapter`), policy soubor(y), `conformance/<capability>/`
kostra, zápis do `router.register()` (`src/slice.ts`), položka v `docs/cow-catalog.json`.

**Co se nemění, i když se mění kdo píše soubory:**
- Nic se nestane `ACTIVE` bez průchodu dnešní bránou (`npm run typecheck && test && arch &&
  farm:check`, viz `### Admission Gate` výš) — generátor udělá commit/PR, gate ho otestuje stejně
  neúprosně, ať psal soubory člověk nebo AI.
- **Žádné živé zapojení kódu do běžícího Workeru bez rebuildu.** Cloudflare Workers dynamický
  `new Function`/eval technicky nedovolují (`docs/BUILD.md:34` — proto i validátor schémat je
  `@cfworker/json-schema`, ne Ajv) — i kdyby GUI posílalo kód rovnou za běhu, platforma by ho
  nespustila. Nasazení zůstává samostatný `wrangler deploy` krok, i když ho GUI spustí jedním
  kliknutím.
- Build-bound `CertificationRecord`/`deriveLifecycleStatus()` (`## Pořadí` body 3–4) beze změny —
  nová kráva začíná `NEW`, ne `ACTIVE`, dokud certifikace neproběhne na konkrétním `buildHash`.

**Upřesnění 13. 9. 2026: vstup nemusí být hotový kód, může být prompt.** Vlastník si představuje i
variantu, kdy nedodá kód volání ven sám, ale jen popíše promptem, co potřebuje ("ověření plátcovství
DPH proti Finanční správě") — AI vrstva pak sama dohledá dokumentaci/API (přesně postup použitý
ručně u `cz.company.verify`: curl proti reálnému `ares.gov.cz`, ověření tvaru 200/404/400 odpovědí,
teprve pak napsaný adaptér), vytáhne potřebné údaje a napíše i doménový kus, ne jen propojení.
**Nemění to nic z výše uvedeného** — je to jen posun v tom, kolik autorské práce dělá AI (od
"propojení" po "propojení i doménová logika"), ne v tom, co se stane s výsledkem: pořád jen commit/
PR, pořád stejná brána, pořád `NEW` až do certifikace na konkrétním buildu.

**Otevřené (cílový obraz, ne rozhodnuté):** kde generátor běží (nová `apf-*` služba s
GitHub/Cloudflare/AI credentialy, mimo dnešních pět farm deployables?); jak a kde se ty
credentialy drží (Office jako cílové místo pro tenhle typ správy zatím jen `## Vrstvy`'s target
design, nepostaveno); jestli GUI žije uvnitř `apf-gateway` (za Cloudflare Access) nebo je to
samostatný nástroj; a jestli mezi „gate zelený" a `wrangler deploy` zůstává explicitní lidský klik,
nebo je to jedno tlačítko od formuláře k nasazení.

### Risk profily řídí povinné testy, ne autor COW

`riskClass` v dnešním descriptoru (`LOW`/`MEDIUM` v repu) by se rozšířil na explicitní úroveň
(R0 read-public → R1 tenant-read → R2 external-write → R3 business-critical-write → R4
financial/high-impact), která **sama určuje** povinnou sadu testů a kontrol (R4 = durable
idempotency + reconciliation + human approval + amount limity + kompletní audit navíc). Autor
COW nemůže napsat nižší riziko, než jaké capabilita fakticky má — platforma ho odvodí ze
`sideEffect`/`capability` deklarace, ne z tvrzení.

### DRY_RUN jako obecný princip pro write capability, ne jen pro BC (12. 9. 2026)

`### BC Executor musí být „hloupý"` výš popisuje konkrétní řešení pro jeden write executor: dokud
řetěz není ověřený, BC Executor se nahradí **JSON Export** (zapíše zamýšlený efekt jako neškodný
JSON, žádný reálný credential/side effect) + **Invoice Generator** (deterministicky z JSONu
sestaví levnou, ne-věrnou náhledovou fakturu, kterou člověk porovná s originálem). Vlastník
12. 9. 2026 zpřesnil: **tohle není BC-specifická výjimka, je to první instance obecného principu**,
který má platit pro **každou** write capability, ne jen pro BC Executor.

Zobecněný tvar:

```
DRY_RUN mode (povinná vlastnost každé write capability od R2 výš)
  ↓ projde CELÝM rozhodovacím řetězem (schema, policy, effect-field validators,
    approval, idempotency check) přesně jako live
  ↓ ale místo skutečného side effectu:
     - zapíše zamýšlený efekt do inertního výstupu (JSON export — obecný sink,
       ne BC-specifický formát)
     - vydá vlastní credential ani nespotřebuje — write executor v DRY_RUN
       módu nesmí mít přístup ke skutečnému write credentialu vůbec, ne že
       ho jen nepoužije
  ↓ volitelný human-verifiable preview (Invoice Generator je jeden konkrétní
    příklad pro fakturační doménu — jiná write capabilita může mít jiný
    formát náhledu, princip "levné, deterministické, bez AI, jen pro
    kontrolu" zůstává stejný)
```

**Důsledky pro Admission Gate:** capabilita s `riskClass` R2 (`external-write`) a výš nesmí projít
do `ACTIVE`, dokud nemá funkční `DRY_RUN` mód — stejná disciplína jako u ostatních povinných testů
podle risk profilu (`### Risk profily řídí povinné testy` výš). Kandidát pro rozšíření
`module-descriptor.v1.schema.json` (`### COW technický pas` výš): `dryRunSupported: boolean` +
referenci na sink, kam DRY_RUN zapisuje. Přechod z `DRY_RUN` na `live` u konkrétní capability je
pak jen výměna posledního kroku (skutečný Executor místo JSON Export sinku), beze změny zbytku
řetězu — přesně jak to `### BC Executor musí být „hloupý"` už popisuje pro BC samotné, teď jako
obecné pravidlo, ne jednorázové řešení.

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

## Roadmapa M0–M8 — od first-slice k prvnímu autonomně skládanému případu (15. 9. 2026)

Z Posudku 17, kolo 5 (`docs/POSUDKY.md`): reviewer navrhl 8 milníků, asistent je ověřil proti kódu
a `## Pořadí` (5 úprav + 1 mezera: durable Žlab), **vlastník potvrdil 15. 9. 2026**. Milníky jsou
vrstva **nad** `## Pořadí` — body 1–10 se do nich mapují beze zbytku (sloupec vpravo), nic se neztrácí.
Hlavní demonstrační scénář: *přijde dodavatelská faktura → Farma zjistí, co je potřeba → platforma
doplní fakta → případ projde Dojičkou → deterministický náhled → člověk schválí → Mlékárna zapíše
fakturu do BC* — **bez ručně nadrátovaného invoice workflow**. Až to projde, je důkaz, že architektura
není n8n.

**Tři povinné exit vrstvy každého milníku:** (1) *functional* — testy s Test ID; (2) *adversarial* —
útočné scénáře jako testy, ne poznámky; (3) *live farm verification* — nasazeno na `farm-bass443`
a ověřeno živě (`gitSha`), ne jen `npm test`. „Prošlo unit testem" ≠ hotovo.

| M | Název | Hlavní exit | `## Pořadí` |
|---|---|---|---|
| **M0** | **Fact Contract v1** | `FactAddress` (klíč, scope, entityId mimo klíč), `EntityHash` s kontinuitou id podle obsahu, `AuthorityGrant` (domény v `authorities.json`, `EvidenceWriter` razítkuje, Dojička podle domény, TTL per doména), **durable Žlab** (DO SQLite synchronně + D1 insert-only zrcadlo, důvěra jen z podpisu). Návrh: **`docs/M0-FACT-CONTRACT-V1.md`** — čistý návrh se čtyřmi částmi (invarianty, datový tvar, validace, adversarial), **kód až po schválení** | Posudek 16 punch list: durable Žlab, TTL z policy (P1-10), domain separation (P1-12) |
| **M1** | **AI Credential & Usage Layer** | sjednotit cestu credentialů (`modelTable()` → `CredentialResolver`), `response.usage` do auditu, tier mapování v profilu; krok 0 = vlastník nastaví `ANTHROPIC_API_KEY`. Exit: přepnout provider/model bez změny krávy (dnes částečně přes `profile.json`) | Posudek 17 1-2/1-3/1-4 |
| **M2** | **Invoice Understanding v2** | `invoice.extract/2`: hlavička, dodavatel, částky, `invoice.line × N` s identitou z M0; ISDOC deterministická strategie (jistota 1,0 + zlatý standard pro totéž PDF); `forEach` bounded krok; anonymizovaný korpus 30–50 faktur mimo repo (R2); metriky v `MEASUREMENT.md`. Exit: Žlab má správný canonical invoice včetně řádků a původu každého faktu | nová kráva → Admission Gate (3, 4) |
| **M3** | **No-n8n Gate** | compile `plan → WorkflowDef`, `available` počítané ze Žlabu (hash + TTL + doména), živě. **Killer test bez BC:** (1) Žlab bez platné evidence `cz.company.verify` → plán obsahuje verify; (2) čerstvá evidence správné domény → verify z plánu zmizí; (3) prošlá / cizí tenant / špatná doména → verify se vrátí. Bez editace jediného workflow. Adversarial: podvržené `available` klíče | 5, 6 (skutečná `HttpAresAdapter`/`HttpMojeDaneAdapter` volání) |
| **M4** | **BC Read World** | BC **sandbox**, `cred:bc` přes `CredentialResolver`; `bc.vendor.resolve` READ (= `bc.vendors`); `accounting.account.candidates` = kandidáti + evidence bez grantu autority, rozhodnutí člověka = doména `tenant.human-review`. Exit: Farma doplní BC dodavatele a účetní kontext bez ručně vytvořené cesty | 7 |
| **M5** | **Readiness & Composition Safety** | goal contract (`purchaseInvoice.readyForBc` = required facts + domény + TTL), Dojička READY / REVIEW / REJECT nad živým Žlabem, Konev; **composition attack suite** jako exit (každá capability sama vypadá povoleně, dohromady nesmí projít) | 8, 8b, 9 |
| **M6** | **Sealed Dry Run** | deterministický BC adapter z Konve vytvoří přesný náhled + technický payload, žádné LLM; review task **vázaný na hash Konve** — změna chráněného faktu = approval neplatné → nová Konev → nový DRY_RUN → nové approval | 10 (DRY_RUN) |
| **M7** | **Controlled BC Write** | **tvrdý gate: kryptograficky ověřená identita schvalovatele** (Posudek 7 MAJOR 2, `accessJwtVerified`) — bez toho žádný write. Rozsah: `create purchase invoice`, stav **Open**, **bez zaúčtování** (posting zůstává člověku v BC). Executor kontroluje seal, approval, tenant, scope, idempotency key, target. Reconciler UNKNOWN_OUTCOME: lookup vendor + vendorInvoiceNumber (pokud v tenantovi jednoznačné). Exit: reálná testovací faktura od vstupu do BC + zpětně dohledatelný celý řetěz (co přišlo, co extrahováno, kdo vytvořil který fakt, jaká evidence, co Farmář naplánoval, co Argos povolil, co člověk opravil, co Dojička uznala, co zapečetěno, co schváleno, jaký payload, co Executor poslal, co BC odpověděl) = **SEVERKA v1** | 10 (live) |
| **M8** | **Second-domain Proof** | jiný use-case (např. Gwalarn: `calendar.availability`, `calendar.event.prepare`, `location.resolve`, `booking.missingInformation`) jen přidáním faktů + kontraktů + krav — **bez sahání na Farmáře, Argose, Žlab, Dojičku, Konev**. Druhý acceptance test: platforma, ne systém na faktury | — |

**Průřezově:** každá nová kráva (M2, M4, M8) projde Admission Gate (`## Pořadí` 3–4, dnes ruční
allow-list `lifecycle.json`); farma se nasazuje na konci každého milníku (15. 9. 2026 je 2 commity
pozadu — vlastníkův krok).

**Co se teď nedělá:** Gmail, Telegram, FIO, kalendář, další ERP, autonomní učení (silo), vizuální
editor workflow, „deset dalších krav". Faktura → BC je vertikální řez, který obsahuje všechno, co je
architektonicky potřeba vyřešit.

**Teď:** M0 → M1 → M2 → M3. M3 je brána: dokud změna dostupných faktů sama nemění plán bez editace
workflow, nepokračuje se k zápisu.

## Pořadí (co je skutečně příští, ne všech vrstev najednou)

**Přepsáno 12. 9. 2026 podle vlastníkova pořadí (Posudek 12, `docs/POSUDKY.md`)** — starší verze
tohoto seznamu (Review/idempotency/mail.ingest/Registry) je z 9. 9. 2026; body 1 (Durable Review),
4 (Agent Registry) a 5 (`invoice.extract`) jsou od té doby hotové (viz `## Vrstvy` a HANDOFF), proto
teď mimo aktivní pořadí. Dvě položky staré verze **zůstávají otevřené, ale vlastník je dnes
nepřeřazoval** — zapsány zvlášť pod čarou, ne zapomenuté.

1. **Policy Enforcement v2** — `checkGrant()` dřív vynucoval jen actor/scope/tenant; `approval`/
   `effectFieldValidators`/`isolation` byly deklarované, ne vynucené (Posudek 7 MAJOR 3 / Posudek 8
   P0-2 / Posudek 11 bod 4). **Hotovo 12. 9. 2026** (checkpoint `fc76849` z 11. 9. dotažen do
   zelena, HANDOFF 116, 348/348 testů) — `checkEffectFieldValidators()`/`checkApproval()` v
   `ExecutorHost` (FOUNDATION-core §3.3 kroky 5–6) + isolation cross-check při `Router.register()`.
   `rateLimit` (na `Grant`) zůstává deklarované, nevynucené — nezařazeno samostatně, nízká priorita
   dokud žádná reálná policy `rateLimit` nenastavuje.
2. **Evidence/Provenance Contract — Žlab** (Posudek 12 bod 11, viz `### Kontrola musí být svázaná
   s konkrétní hodnotou` výše). **Hotovo jako testovaný primitiv 13. 9. 2026** (HANDOFF 121):
   `src/platform/evidence.ts`'s `EvidenceLedger` — append-only, platform-signed (Ed25519, ne cow's
   vlastní klíč), `verify()` detekuje tamper i hash-only forgery, `verifyLineage()` chodí po
   `parentRefs`/`parentHashes` (hashový graf) a najde přesně zlomeného předka. `tests/zlab.test.ts`,
   7 testů (ZLAB-001..007). **`EvidenceWriter` (trusted-context-bound writer) hotov 13. 9. 2026**
   (HANDOFF 128, Posudek 15 P1-2) — `tenantId`/`workflowId`/`operationId` jen z `HandlerInput`, nikdy
   z krávina tvrzení. **`cz.company.verify`/`cz.vat.verify` reálně volají `EvidenceWriter.write()` od
   14. 9. 2026** (HANDOFF 151) — `deps.evidence?.write(...)` na každém `SUCCEEDED` (FAILED/WAITING
   se nikdy nezapisují), `inputField` "companyId"/"vatId" podle `invoice.v1` názvosloví, `result` =
   ACTIVE/CEASED/NOT_FOUND (company) nebo přímo `reliability` ANO/NE/NENALEZEN (vat, beze změny —
   evidence.ts's vlastní příklad vocabulary). `tests/cz-verify-evidence.test.ts`, 6 testů
   (CZV-EVD-001..005). **`cz.company.verify`/`cz.vat.verify` samotné jsou od 14. 9. 2026 zapojené i
   do živého `apf-gateway` Routeru** (HANDOFF 152, bod 5–6 níže) — dispatchovatelné a v self-testu na
   `apf.maxferit.cz`. **Ale bez `EvidenceWriter`** — živé zapojení vědomě evidenci nezapisuje, dokud
   Žlab zůstává jen v paměti DO (durabilita je otevřený bod Posudku 16, vlastníkovo rozhodnutí o
   pořadí, `docs/POSUDKY.md:553-565`); zapsat živou evidenci, co evikce Durable Objectu může tiše
   ztratit, by bylo přesně to, co tenhle projekt jinde nikdy netoleruje. `buildHash` zůstává jen
   `src/slice.ts`'s testovací placeholder (`"slice-dev"`) — skutečný zdroj (Cloudflare Version
   Metadata binding, needs verification) čeká na stejné rozhodnutí.
3. **Build-bound `CertificationRecord`** — `Lifecycle` smí přepnout na `ACTIVE` jen když
   `CertificationRecord.PASS && certifiedBuildHash == runningBuildHash` (Posudek 12 bod 6, viz
   `### Admission Gate` výše). **Hotovo jako testovaný primitiv 13. 9. 2026** (HANDOFF 126):
   `src/platform/certification.ts`'s `CertificationRegistry` — `certify()` odvozuje `decision`
   samo (chybějící `actualResults` pro požadovaný test = FAIL, ne tichý PASS), `canActivate()`
   kontroluje přesně `(module, buildHash)` dvojici, nikdy nepřenáší certifikaci na jiný build
   téhož modulu. `tests/certification.test.ts`, 8 testů (CERT-001..008).
4. **Lifecycle `NEW → TESTING → CERTIFIED → ACTIVE → DEGRADED → QUARANTINED`** — dnes
   `LifecycleRegistry` pořád jen `ACTIVE`/`QUARANTINED` (Posudek 8/9/10/11/12 nezávisle opakovaně
   potvrzují stejnou mezeru). **Odvozovací funkce hotová 13. 9. 2026** (`deriveLifecycleStatus()`
   v `certification.ts`, HANDOFF 126) — čistá funkce z `CertificationRecord` + `admitted`/
   `degraded`/`quarantined` signálů na plný stavový slovník (`quarantined` vždy vyhraje,
   chybějící certifikace → `NEW`, `FAIL` → `QUARANTINED`, `PASS` bez `admitted` → `CERTIFIED`,
   `PASS`+`admitted` → `ACTIVE`/`DEGRADED` podle `degraded`). **Zatím nezapojeno do
   `LifecycleRegistry`/`Router.route()`** — živé nasazení by změnilo fail-closed chování
   dispatchu na skutečné farmě a čeká na vlastníkovo rozhodnutí o `DEGRADED`'s dispatch
   sémantice (pouští provoz se sníženou důvěrou, nebo taky fail-closed jako `QUARANTINED`?),
   ne na dnešní rozhodnutí.
5. **`cz.company.verify`** — API zdroj ověřen 11. 9. 2026 (ARES, bezplatné, viz
   `## Připravované doménové COW` výše). **Postaveno 13. 9. 2026** (HANDOFF 132):
   `src/components/cz-company-verify/handler.ts` + `src/adapters/ares.ts` (`AresAdapter`, fake +
   `HttpAresAdapter` bez zabudovaného hostname — ARCH-DEP-001, real `baseUrl` je instalační
   hodnota, dosud nikde nedosazená). `found`/`active` jsou záměrně nezávislé bity (`datumZaniku`
   ≠ not-found — SEVERKA vzor "existuje, i když zaniklo"), `VYSTUP_SUBJEKT_NENALEZEN` je business
   `SUCCEEDED found:false`, ne `FAILED` (stejný vzor jako `document.classify`'s `OTHER`).
   `conformance/cz.company.verify/`, 7 fixtures, `tests/ctr.test.ts`'s `COMPONENTS` mapa. 405/405
   testů, typecheck, arch, farm:check zelené (oba installations, `farm-bass443` i `local-fakes`).
   **Zapojeno do živého `apf-gateway` Routeru 14. 9. 2026** (HANDOFF 152) — dispatchovatelné a v
   self-testu, proti `FakeAresAdapter` (žádný reálný `baseUrl` ještě není instalační hodnota,
   stejný "chybí reálný zdroj → fake fallback" vzor jako `buildAdapters()`'s `FakeLlmAdapter`).
   **Pořád mimo živou invoice→BC workflow definici a pořád bez skutečného `HttpAresAdapter`
   volání** — to je samostatný, pozdější krok, čeká na vlastníkovo rozhodnutí (reálné volání na
   ares.gov.cz z produkce vs. fake dvojice přes `apf-fakes`).
6. **`cz.vat.verify`** — API zdroj ověřen 11. 9. 2026 (MOJE daně SOAP, bezplatné, zveřejněné účty
   = zdroj pro Import Gate ACCOUNT_VERIFICATION). **Postaveno 13. 9. 2026** (HANDOFF 136):
   `src/components/cz-vat-verify/handler.ts` + `src/adapters/moje-dane.ts` (`MojeDaneAdapter`, fake
   + `HttpMojeDaneAdapter`, SOAP 1.1 přes `fast-xml-parser` — nová závislost). Protokol ověřen přímo
   proti `adisrws.mfcr.cz` (curl, ne dokumentace): reálný `getStatusNespolehlivySubjektRozsirenyV2`
   běh, reálný `NENALEZEN` běh, reálný SOAP Fault (HTTP 500 na neplatné tělo). **Protokolová
   asymetrie oproti ARES:** `cz.company.verify`'s "neexistuje" je HTTP 404 (transportní signál,
   adaptér ho promění na exception); MOJE daně's "neexistuje" (`NENALEZEN`) je obyčejné pole uvnitř
   běžné 200 odpovědi — žádná exception, handler ho čte jako každé jiné pole. Stejný business
   výsledek (`SUCCEEDED found:false`), dvě strukturálně jiné cesty, protože dva reálné protokoly
   jsou strukturálně jiné — SEVERKA `## Připravované doménové COW`'s "tři různé protokoly, tři
   různé adaptéry" se potvrdilo doslova. `HttpAresAdapter`/`baseUrl` bez zabudovaného hostname
   (ARCH-DEP-001) narazilo znovu — tentokrát i na univerzální SOAP 1.1 envelope namespace
   (`schemas.xmlsoap.org`), který ale není instalační hodnota (stejný pro každou SOAP zprávu na
   světě) — vyřešeno malou, zdůvodněnou výjimkou v `scripts/arch-dep.mjs`
   (`PROTOCOL_NAMESPACE_EXEMPT`, po vzoru existujícího `CLOCK_EXEMPT`), ne oslabením pravidla.
   `conformance/cz.vat.verify/`, 8 fixtures. 419/419 testů, typecheck, arch, farm:check zelené
   (obě instalace). **Zapojeno do živého `apf-gateway` Routeru 14. 9. 2026** (HANDOFF 152), proti
   `FakeMojeDaneAdapter` — stejná výhrada jako `cz.company.verify` výš (mimo živou workflow
   definici, žádné skutečné `HttpMojeDaneAdapter` volání, vlastníkovo rozhodnutí o dalším kroku).
7. **`bc.vendors`** — vnitřní protějšek k `cz.company.verify` (existující Vendor No. v BC, ne jen
   vnější potvrzení, že IČO existuje — HANDOFF 113), nepostaveno. Pole, která `erp.post` bude
   potřebovat na `purchaseInvoices`/`purchaseInvoiceLines` (`vendorNumber` odsud jako jediné
   nenahraditelné), ověřena proti oficiální BC API v2.0 dokumentaci 14. 9. 2026 — viz
   `docs/BC-PURCHASE-INVOICE-POLE.md` (HANDOFF 149).
8. **První deterministická dojička** (Posudek 11 bod 7 / Posudek 12 bod 9). **Hotovo jako testovaný
   primitiv 13. 9. 2026** (HANDOFF 121, opraveno HANDOFF 127): `src/platform/aggregator.ts`'s
   `EvidenceAggregator` — bez LLM, bez credentialu, bez zápisové cesty do Žlabu (jen čte); kontroluje
   úplnost požadované evidence (a že jde o **přijatelný** `result`, ne jen o shodu producenta —
   Posudek 15 P0-1, viz níže), integritu/lineage přes `EvidenceLedger`, tenant, `workflowId`,
   expiraci, shodu `inputValueHash` napříč evidencí **a** vazbu na autoritativní `fieldHashes`
   aktuálně certifikovaného objektu (Posudek 15 P0-2) → `READY`/`REVIEW`/`REJECT` s typovanými
   `findings` (`missing`/`expired`/`tenant_mismatch`/`workflow_mismatch`/`integrity_failed`/
   `lineage_broken`/`conflict`/`rejected`/`not_bound`). `tests/dojicka.test.ts`, 15 testů
   (DOJ-001..012). **Zatím nenapojeno na skutečnou capabilitu** — `cz.company.verify`/
   `cz.vat.verify`/`bc.vendors` (body 5–7) jsou první krávy, co by do Žlabu měly reálně zapisovat;
   dojička sama je hotová a čeká na ně, ne naopak.

   **Posudek 15 (13. 9. 2026), dva P0 nálezy z nepřátelského adversarial review, opraveny ve stejný
   den:** (1) `required` kontrola dřív ověřovala jen shodu `producerId`, ne `result` — jediná
   evidence s `result: "FAIL"` požadavek splnila a `READY` mohlo vzniknout i s explicitním selháním;
   opraveno `RequiredEvidence.acceptableResults` (default `["PASS"]`) + nový `FindingKind: "rejected"`.
   (2) `aggregate()` nedostávalo autoritativní aktuální hodnotu certifikovaného objektu — interně
   konzistentní evidence z **jiné** faktury/workflow stejného tenanta by prošla; opraveno povinným
   (ne optional) `fieldHashes: Record<string,string>` porovnaným s `Evidence.inputValueHash` a
   volitelným `workflowId` porovnaným s `Evidence.workflowId`, když ho evidence deklaruje.
8b. **Konev** (Posudek 14 bod 6, 13. 9. 2026 — "nejvyšší priorita projektu"). **Hotovo jako testovaný
   primitiv 13. 9. 2026** (HANDOFF 125): `src/platform/konev.ts`'s `BusinessObjectSealer` —
   `seal()` přijme jen `decision: "READY"` (strukturálně), znovu ověří evidenci proti Žlabu při
   zapečetění (ne jen důvěra v `AggregateResult`), `verify()` odděleně kontroluje vlastní obsah
   Konve a živý stav odkazované evidence. `tests/konev.test.ts`, 8 testů (KONEV-001..008). **Zatím
   žádná reálná Mlékárna, co by Konev přijímala** — BC Executor pod ní ještě nestojí.
9. **Compromised-farmer / composition attack suite** (Posudek 12 bod 12, viz `### Composition
   attack suite` výše) — testuje skládání víc krav dohromady (cizí-tenant evidence, zastaralá
   evidence, konfliktní fakta, nereagující kráva), ne jednotlivou COW.
10. **Write capability obecně nejdřív `DRY_RUN`, pak live** — zpřesněno vlastníkem 12. 9. 2026:
    `DRY_RUN` mód (viz `### DRY_RUN jako obecný princip pro write capability` výše) je požadavek
    na **každou** write capabilitu od `riskClass` R2 výš, ne jen na BC Executor. BC je první
    konkrétní instance (JSON Export + Invoice Generator, viz `### BC Executor musí být „hloupý"`
    výše) a zapíná se až po uzavření bodů 1–9, ne dřív — ale princip samotný patří do Admission
    Gate obecně, ne jen do BC řetězu.

**`cz.insolvency.check`** zůstává mimo číslované pořadí — zdroj zatím neurčen (placený `isir.info`
vlastník odmítl, hledá se oficiální bezplatná `isir.justice.cz` alternativa); vloženo do pořadí až
po nalezení zdroje.

**Planner jako generátor `WorkflowDef`** (nikdy přímý executor) zůstává až za vším výše — plánuje
až nad reálnou, dotaženou farmou, ne nad rozestavěnou; proto poslední, ne proto, že by byl málo
důležitý. **Deterministický základ (slovník faktů + `plan()`) je hotový 15. 9. 2026 jako testovaný
primitiv (Posudek 17, HANDOFF 154) — pořadí to nemění:** AI část (záměr → `goal`) a compile krok
(`plan → WorkflowDef`) zůstávají za body 1–10; postaven byl jen „důkaz skládání", ne runtime Scheduler.
Před `bc.vendors` (bod 7) a jakoukoli položkovou krávou je třeba rozhodnout identitu entit v kolekcích
a authority domain evidence (`### Slovník faktů a deterministické skládání`, dvě návrhová rozhodnutí).

Tenant resolution zůstává mimo tohle pořadí — dnes to není bug (`CLOUD_SINGLE_TENANT`), je to
budoucí capability; řešit se má, až bude existovat druhý reálný tenant, ne preventivně. **Office**
(`## Vrstvy` výše) je architektonické místo, kam tahle capabilita i `accessJwtVerified` oprava
patří, ale vlastník ji dnes do číslovaného pořadí nezařadil — čeká na rozhodnutí, kdy na ni dojde.

**Oprava 13. 9. 2026:** tenhle odstavec dřív (12. 9. 2026) tvrdil dvě položky jako „dosud otevřené"
— durable idempotency na `apf-email-executor` a dokončení `mail.ingest`/`email.send` skeleton. Obě
byly ve skutečnosti hotové už 9. 9. 2026 (HANDOFF 57–69) — přejaty sem omylem ze zastaralých řádků
`## Vrstvy` (Execution Engine/Connector Layer), teď oba opravené. Žádná položka staré verze pořadí
tedy dnes nezůstává otevřená mimo číslované pořadí výš.

**Why:** foundation je zmrazený přesně kvůli deterministické, auditovatelné povaze platformy
(4 kola oponentury, 80 nálezů). Každá nová vrstva, která zavádí nedeterminismus (Planner,
Memory), musí zůstat *uvnitř* stejné fail-closed brány, ne vedle ní. Dnešní přeřazení (Posudek 12)
řadí policy/evidence/certifikaci před další krávy proto, že bez nich by dojička četla důkazy, které
nic nezaručují — přesně ten typ mezery, co čtyři kola oponentury (Posudek 7/8/9/10/11) opakovaně
pojmenovávala jako prioritu, teprve dnes s konkrétním pořadím pro zbytek řetězu.
