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
| **Execution Engine** | existuje (`Router`, `ExecutorHost`, retry/review/journal) | — | — |
| **Human Review** | existuje (`WAITING(REVIEW)`, `/review`) | — | — |
| **Tenant Layer** | částečně, s živým bugem | `tenants: string[]` + jediné globální `roles.orchestrator` → `tenant-7` se do intake prakticky nedostane (`apf-gateway/index.ts` `intakeTenant()`). Cíl: `TenantConfig { tenantId, assistant.displayName, orchestration.actorId }` | oprava je bug fix, ne nová schopnost — patří **první**, ne až po Planneru |
| **Connector Layer** | 1 z N hotový | `document-host` běží na farmě; `apf-mail-ingest` a `apf-email-executor` jsou na farmě doslova skeleton (`501 NOT_WIRED`, `email()` handler dělá `setReject`) | dokončení = zároveň první reálný **event-driven** case (mail přijde → spustí workflow), ne samostatná vzdálená vrstva |
| **Event-driven provoz** | rozpracováno (`apf-mail-ingest` k tomu existuje) | „něco se stalo" spouští workflow samo, ne jen dotaz uživatele | — |
| **Scheduling / condition engine** | chybí | „zkontroluj za 3 dny", „každé ráno", „až přijde odpověď" | nižší riziko, přirozeně navazuje na event-driven |
| **Capability Marketplace** | chybí | Registry + samopopis (vstupy/výstupy/oprávnění/cena/limity/verze/health) tak, aby centrální blok neměl ručně zadrátované znalosti o agentovi | až bude reálně víc než 2–3 typy agentů — dřív to jen předbíhá potřebu |
| **Memory/context vrstva** | chybí | tenant preference, dlouhodobý kontext, návaznost na předchozí úkol | **nejcitlivější nová vrstva na seznamu.** Platforma razítkuje dokumenty a archivuje do DMS — paměť ovlivňující chování agenta potřebuje stejnou fail-closed disciplínu jako dnešní signing key. Tvrdé pravidlo: **paměť nikdy není totéž co oprávnění** — nesmí se stát vstupem do policy rozhodnutí |
| **Agent lifecycle management** | koncepčně zapsáno (HANDOFF first-slice #26 — admin konzole) | instalace, connector test jako gate, sandbox, schválení, aktivace, verze, rollback, deaktivace | — |
| **Observability/Audit** | existuje (D1 audit, append-only) | — | — |
| **Admin Console** | koncepčně zapsáno (HANDOFF #26), 0 % kódu | — | — |

---

## Pořadí (co je skutečně příští, ne všech 13 vrstev najednou)

1. **Tenant resolution fix** — bug, existuje dnes nezávisle na čemkoli dalším
2. **Agent Registry** — formalizace `descriptor.json` + `router.register()`
3. **Dokončit `mail.ingest`/`email.send` skeleton** — je to zároveň první event-driven case
4. **Planner jako generátor `WorkflowDef`** (nikdy přímý executor)
5. **Risk tiering** nad existujícím Policy Engine
6. Marketplace, Memory/context, Scheduler, plný Lifecycle GUI — až bude bolet ruční drátování s víc než 2–3 typy agentů, ne dřív

**Why:** foundation je zmrazený přesně kvůli deterministické, auditovatelné povaze platformy
(4 kola oponentury, 80 nálezů). Každá nová vrstva, která zavádí nedeterminismus (Planner,
Memory), musí zůstat *uvnitř* stejné fail-closed brány, ne vedle ní.
