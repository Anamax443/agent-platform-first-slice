# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

## 2026-09-09 (69) — email executor dostal durable idempotency (dokončení posudku 7, MAJOR 4)

**Dokončeno ověření zbylých bodů Posudku 7** (`docs/POSUDKY.md`) proti kódu — MAJOR 2
(`accessJwtVerified: false` doslova na `index.ts:90`), MAJOR 3 (`checkGrant()` v `src/platform/policy.ts:46-51`
čte jen `actorId`/`scopes`/`tenants`, nikdy `approval`/`effectFieldValidators`/`isolation`/`rateLimit`
z `Policy`/`Grant`) — oba potvrzené, oba ponechané jako `Z` (architektonicky velké, mimo dnešní
rozsah). MEDIUM nález je stejná mezera jako MAJOR 5 (68), zapsáno společně.

**MAJOR 4 opraven:** `apf-email-executor`'s `/dispatch` stavěl `new ExecutorHost({...})` bez
`idempotency` volby → výchozí `InMemoryIdempotencyStore`, který se zahazuje s každým fresh
`ExecutorHost` per request — žádná deduplikace napříč požadavky (stejný nález jako `document-host`
mělo předtím, `SEVERKA.md` to už evidovalo jako otevřený bod). Oprava = přesná kopie
`apf-document-host`'s už fungujícího a živě ověřeného vzoru, ne nový mechanismus:
`deploy/cloudflare/apf-email-executor/src/idempotency-ledger.ts` (nový soubor, `IdempotencyLedger`
Durable Object, identický s document-host verzí — duplikováno, ne sdíleno napříč deployables,
stejná konvence jako `relay-audit.ts`), `DurableIdempotencyStore` adapter v `index.ts` (taky
duplikovaný z document-host), `wrangler.jsonc` dostal `durable_objects`/`migrations` binding
`IDEMPOTENCY` → `IdempotencyLedger`.

**Vědomě bez nového testu:** stejná disciplína jako u `document-host`'s vlastní `IdempotencyLedger`
(taky nikdy neměla dedikovaný unit test) — dedup KEY logika (`tenantId + handlerId + idempotencyKey`,
fingerprint, `IDEMPOTENCY_CONFLICT`) je sdílený, host-nezávislý kód v `src/platform/executor-host.ts`
a je pokrytý `tests/idm.test.ts`; jediné nové je Cloudflare Durable Object plumbing, které
typecheck/`farm:check` (`wrangler deploy --dry-run` nad novým configem) pokryje staticky, živé
ověření dokáže chování skutečně — stejný vzor jako `/capabilities` (64) a alarm (67).

**Brány zelené:** typecheck (root i `deploy/cloudflare`), 246/246 testů (beze změny počtu — čistě
Cloudflare-only kód), `arch`, `farm:check` (10 configů včetně nového `IDEMPOTENCY` bindingu na
`apf-email-executor`). Nasazeno na `farm-bass443`.

## 2026-09-09 (68) — Human Review autorizace: tautologická kontrola role opravena (externí posudek 7)

**Nález (externí čtenář, poslán vlastníkem, `docs/POSUDKY.md` Posudek 7, MAJOR 1):** `decideReview()`
(`deploy/cloudflare/apf-gateway/src/index.ts`) posílalo `role: task.requiredRole` přímo do
`ReviewService.decide()`, jejíž vlastní kontrola `task.requiredRole !== by.role` tím porovnávala
hodnotu se sebou samou — nikdy nemohla selhat. Ověřeno přímo v kódu (ne převzato od posudku).
Navazuje na **Posudek 6, bod 4** (6. 9. 2026, „`ReviewService` bez trusted principal" — tehdy `Z`,
protože `/review` ještě neexistovalo; od (50)–(52) existuje, takže mezera byla živá).

**Oprava:** nová `IdentityProvider.authorizeRole(actorId, tenantId, requiredScope)`
(`src/platform/gateway.ts`) — rozhoduje výhradně z identity (tenant + přiřazené `scopes`), nikdy
z hodnoty, kterou nese request/task. `decideReview()` ji volá dřív, než cokoli předá
`review.decide()`; při zamítnutí zapíše `kind: "security"` audit (`REVIEW_ROLE_NOT_AUTHORIZED`)
a vyhodí chybu (existující `/workflow/:id/review/decide` route ji už zachytávala a vracela 400).

**`installation.profile.identities` na farmě neměla žádnou lidskou identitu** (jen
`svc-orchestrator`/`svc-orchestrator-t7`/`ai-doc-classifier`). Doplněna
`{"actorId": "access:bass443@gmail.com", "actorType": "human", "tenantId": "tenant-42", "scopes": ["document.reviewer", "document.supervisor"]}`
— přesný `access:`-string nebyl odhad, ale ověřený z reálného `/audit.json` záznamu živého
rozhodnutí z (50)–(52) (`grep -o '"access:[^"]*"' ` přes živý audit trail). **Vědomé omezení:**
identita je vázaná jen na `tenant-42`; `tenant-7` je čistě protistrana bezpečnostních testů
(SEVERKA.md Tenant Layer), `Identity` má jediné `tenantId`, ne pole — jediný lidský reviewer by
dnes review úkol pod `tenant-7` rozhodnout nemohl. Přijato jako správný default, ne přehlédnutí.

**Testy (`tests/sec.test.ts`, nový blok `SEC-REV`):** 4 nové (`SEC-REV-001..004`) — autorizovaná
identita se svým scope ve svém tenantu projde; neznámý actor nikdy neprojde bez ohledu na
požadovanou roli; známá identita mimo svůj tenant zamítnuta (žádná cross-tenant eskalace); známá
identita bez přiřazeného scope zamítnuta i ve svém tenantu. **246/246 testů** (242 → 246), typecheck
(root i `deploy/cloudflare`), `arch`, `farm:check` zelené. Nasazeno na `farm-bass443`.

**Vědomě mimo rozsah dneška:** posudek přinesl ještě MAJOR 2–5 a MEDIUM (Access JWT
kryptografické ověření, Policy Engine enforcement za popisem descriptoru, email executor durable
idempotency, `/audit` důvěra ke kompromitované COW, interní endpointy bez service identity) —
vlastník zvolil ověřit a opravit nejdřív jen MAJOR 1; zbytek zapsán v `docs/POSUDKY.md` Posudek 7
jako **Z, nezávisle neověřeno** (většina se kryje s už existujícími řádky v `SEVERKA.md`), čeká na
rozhodnutí, kdy na ně dojde stejnou disciplínou ověření (přečíst kód, ne převzít tvrzení).

## 2026-09-09 (67) — WF-REV-003 nasazeno a alarm mechanismus živě ověřen dočasnou izolovanou diagnostikou

**Nasazení (66):** `165fe38` nasazen na `farm-bass443` (`node scripts/farm-deploy.mjs farm-bass443`), `/version` potvrdil `gitSha: "165fe38"`. Commit byl do té doby jen lokální — pushnut na `origin/main` (`f351483..165fe38`).

**Nový CF Access service token `apf-harness-2`:** vytvořen (asistent neměl na tomhle stroji `.env` s platným `apf-harness` secretem, jen `.env.example`), přidán jako druhý `Include → Service Token` do politiky `harness` u aplikace `apf-gateway` (vedle původního `apf-harness`, ne místo něj). `.env` doplněn přes PowerShell (`Read-Host -AsSecureString`, hodnoty nešly přes chat). `GET /version` přes něj vrátil 200.

**Proč ne přímo živá review-expirace:** reálná cesta k review úkolu má `expiresInMs` dané workflow definicí (`workflows/document-intake.v2.json` atd.) — ta je záměrně immutable (FOUNDATION-core §5.7), 3 dny / 4 h u UNKNOWN_OUTCOME, nic v `/intake` requestu to nepřebíjí. Živě ověřit celou byznys transakci by znamenalo buď čekat řádově hodiny, nebo zasahovat do jádra orchestrátoru — moc velký zásah na jedno ověření.

**Co bylo místo toho živě ověřeno:** jediná fakticky neověřená věc byla, jestli Cloudflare Durable Object `alarm()` hook na `farm-bass443` vůbec vystřelí (`applyReviewExpiries()` logika samotná už měla 242 testů od (50)/M1 — "nic na farmě ho nikdy nevolalo" byl proto zápis o chybějící *infrastrukturní* cestě, ne o neotestované logice). Dočasně přidáno (mimo real journal/reviewStore, nulové riziko pro skutečný stav instancí): `WorkflowInstance.diagArmAlarm(ms)` (`ctx.storage.put("diagAlarmAt", ...)` + `ctx.storage.setAlarm(...)`), `alarm()` na začátku zkontroluje `diagAlarmAt` a pokud je nastavený, zapíše audit `DIAG_ALARM_FIRED` místo běžné `applyReviewExpiries()` větve, a dočasná route `GET /diag/arm-alarm?ms=`. Nasazeno, zavoláno s `ms=20000`, `GET /audit.json?after=` po ~20 s ukázal `{"status":"DIAG_ALARM_FIRED","armedFor":"2026-09-09T06:47:43.609Z","firedAt":"2026-09-09T06:47:43.610Z"}` — alarm vystřelil přesně na deadline (1 ms rozdíl). **Kód vrácen** (`git checkout --`), `git diff` prázdný, redeploy, `/version` znovu potvrdil čistý `gitSha: "165fe38"`.

**Zbývá:** živě potvrdit celou byznys transakci (skutečný `WAITING(REVIEW)` přes reálný `WorkflowDef`, co přirozeně expiruje a projde `EXPIRE_TO_FAILED`/`ESCALATE`) — dosud ověřená je jen infrastrukturní vrstva (alarm → hook), ne plný běh. `docs/SEVERKA.md` Human Review řádek aktualizován na tenhle přesný stav.

## 2026-09-09 (66) — WF-REV-003 časové expirace dostaly funkční cestu na farmě: Durable Object Alarm

**Nález (asistent, čtením `docs/SEVERKA.md` proti kódu, ne od vlastníka):** řádek „Human Review" v `SEVERKA.md` byl zastaralý stejným způsobem jako dřív Execution Engine (62) — popisoval stav před (50)/(52) jako aktuální, ačkoli decision cesta (`/review/decide` → `decideReview()`) je hotová a živě ověřená od (52). Skutečná zbývající mezera: `orchestrator.applyReviewExpiries()` (WF-REV-003 — `EXPIRE_TO_FAILED`/`EXPIRE_TO_CANCELLED`/`ESCALATE`/`CREATE_NEW_REVIEW`) existuje a je otestovaný (`tests/wf.test.ts`) od (50)/M1, ale nic na farmě ho nikdy nevolalo — ruční rozhodnutí fungovalo, časové politiky ne.

**Proč ne cron:** `apf-gateway`'s `scheduled()` řeší jen R2 inbox. Globální cron nemůže vyjmenovat „všechny instance dnes ve `WAITING(REVIEW)`" — každá `WorkflowInstance` je vlastní Durable Object bez sdíleného adresáře. Řešení: každá instance si sama nastaví alarm na deadline svého vlastního otevřeného review úkolu — žádný nový registr, žádný zásah do zmrazených kontraktů.

**`deploy/cloudflare/apf-gateway/src/index.ts`:** nová `rearmReviewAlarm()` (čte `this.reviewStore.all()`, najde nejbližší `expiresAt` mezi úkoly se `status: OPEN`, `ctx.storage.setAlarm(...)`, nebo `ctx.storage.deleteAlarm()` když žádný není) volaná po každém místě, kde může vzniknout nebo se změnit review úkol: konec `intake()`, konec `mailIntake()`, konec `decideReview()`. Nová `alarm()` metoda (Durable Object built-in hook) sestaví orchestrátor přes existující `orchestratorFor()`, zavolá `applyReviewExpiries()` (beze změny — už řeší FAILED/CANCELLED/ESCALATE/NEW_REVIEW), zrcadlí audit do D1 (`copyOut()`) a znovu zavolá `rearmReviewAlarm()` (ESCALATE nechává instanci čekat na nový úkol s pozdějším deadline, alarm se musí přenastavit na ten).

**Vědomě mimo rozsah:** žádný nový lokální test — `alarm()` je čistě Cloudflare Durable Object chování (žádný `vitest-pool-workers` v projektu), stejná disciplína jako `/capabilities` (63)/(65): typecheck a `farm:check` ho pokryjí staticky, živé ověření (jako u (50)–(52)) dokáže chování skutečně.

**`docs/SEVERKA.md`:** Human Review řádek opraven na aktuální stav (decision cesta hotová a ověřená, expirace teď implementovaná, čeká na nasazení a živé ověření).

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 242 testů (beze změny počtu — Cloudflare-only kód, viz výše), arch, farm:check. **Nenasazeno zatím** — nasazení a živé ověření (krátký `expiresInMs` review úkol, počkat na alarm, potvrdit transition) je bezprostředně další krok, stejná rigoróznost jako (50)–(52).

## 2026-09-09 (65) — `/farm`'s Deník dostal živý terminál ("vidět co se šustne")

**Pokyn vlastníka:** chtěl v GUI "terminal kde uvidím co se šustne" — vybral (AskUserQuestion) nejdřív živý pohled na existující D1 audit trail, skutečný `wrangler tail`-styl přes Tail Workers zapsat do `SEVERKA.md` jako budoucí krok, ne stavět hned.

**`deploy/cloudflare/apf-gateway/src/index.ts`:** `GET /audit.json` dostal `?after=<ISO at>` (ascending, striktně novější než zadaný záznam) vedle beze změny výchozího `?limit=` (descending, nejnovější N) — jediný, zpětně kompatibilní branch navíc.

**`deploy/cloudflare/apf-gateway/src/page.ts`:** Deník view dostal `<div class="p-term" id="denik-term">` nad existující tabulkou (tabulka zůstala beze změny, pro dohledání konkrétní události nejnovější-nahoře) — chronologicky, nejnovější dole jako `tail -f`, seedováno server-side ze stejných dat jako `denikRows` (`terminalLine()`/`terminalSeed`, sdílí `auditSummary()`/`esc()`), aby box nebyl prázdný před prvním klientským pollem. Tlačítko „⏸ Pozastavit"/"▶ Živě" (`#denik-live-toggle`).

**Klientský JS (nový blok v existující IIFE):** `setInterval` po 3 s volá `/audit.json?after=<poslední at>&limit=200`, jen když je záložka viditelná (`!document.hidden`) a "živě" není pozastaveno; nové řádky se skládají přes `document.createElement`/`textContent` (**nikdy ne `innerHTML` ze síťových dat**) — audit `details` může nést text vytažený přímo z nedůvěryhodného dokumentu (F2), takže tohle je jediné bezpečné místo pro sestavení řádku bez rizika, že se z operátorské konzole stane HTML-injection cesta. Krátká flash animace (`.t-new`, `@keyframes term-flash`) na nově přidaném řádku, strop 500 řádků v DOM (odstraňuje nejstarší), auto-scroll na konec.

**Živě ověřeno na `farm-bass443`** (nasazeno, ověřeno, viz i (64) pro postup): `/farm`'s HTML nese 50 seedovaných `.t-line` řádků se správným escapingem (`&quot;` v JSON detailu, ne syrové uvozovky); `/audit.json?after=<nejnovější at>` vrací `[]`; `/audit.json?after=<starší at>&limit=5` vrací přesně záznamy striktně novější, vzestupně.

**Beze změny gates** (žádný nový local test — stejná disciplína jako `/capabilities`: Cloudflare-only HTTP chování, typecheck/farm:check ho pokryje, živé ověření dokazuje chování).

## 2026-09-09 (64) — Nasazeno a živě ověřeno: `/capabilities` na všech třech providerech na `farm-bass443`

**Nasazení:** `node scripts/farm-deploy.mjs farm-bass443` (bez `--bootstrap`, žádná nová vazba/binding — jen nová route na existujících třech Workerech), všech pět beze změny pořadí. `/version` potvrdil `gitSha: "595d272"`.

**`GET /capabilities` na `apf-gateway`** (`https://apf.maxferit.cz/capabilities`, přes CF Access service token) vrátilo přesně `gatewayCatalog()`: `document.classify`/`document.validate`/`mail.ingest`, se správným `riskClass`/`sideEffects`/`trustClass`/`usesLlm` z descriptorů.

**`apf-document-host`/`apf-email-executor` nemají veřejnou route** (`workers_dev: false`, žádný `routes` v `farm.json` — jen service binding z gatewaye) — ověřeno dočasným diagnostickým patchem na gatewayi (`GET /diag/capabilities`, fetch přes `env.DOCUMENT_HOST`/`env.EMAIL_EXECUTOR` stejným vzorem jako `/farm`'s `deployableInfo()`, nasazeno, ověřeno, **vráceno zpět, `git diff` prázdný**, redeploy). Výsledek: `document.stamp`+`document.archive` (LOW/LOGICAL/internal-write) a `email.send` (MEDIUM/PRINCIPAL/external-write) — přesně podle descriptorů, žádný pád, žádné `notWired`.

**Beze změny počtu testů/gates** — čistě nasazení a živé ověření (63).

## 2026-09-09 (63) — SEVERKA bod 4, druhá polovina: `/capabilities` na všech třech providerech (`descriptor.json`'s vlastní deklarovaný endpoint, dřív nikde neimplementovaný)

**Kontext:** dokončení (61) — vlastní posudek nad `d6f8287` navrhl dodělat runtime stranu Registry (endpoint, ne jen data uvnitř `Router`), než se jde k Planneru. Každý `descriptor.json` už rok deklaruje `endpoints.capabilities: "/capabilities"` (`mail-ingest`, `email-executor`, `document-executor-host`), ale nic tu cestu neobsluhovalo (zjištěno explorací k (61)) — teď existuje, na všech třech.

**`src/platform/registry.ts`:** nová `catalogOf(descriptor)` — každá capability descriptoru na svém `preferredVersion`, žádný živý `Router` potřeba (descriptor byl validován už při `Router.register()`, tohle ho jen čte znovu).

**`apf-document-host`/`apf-email-executor`:** nová `GET /capabilities` vrací `{ deployable, capabilities: catalogOf(descriptor) }`; `/version`'s dřív natvrdo psané `capabilities: ["document.stamp","document.archive"]` / `["email.send"]` teď `capabilityNamesOf(descriptor)` (stejná hodnota, odvozená).

**`apf-gateway`:** `platform-wiring.ts` dostala `gatewayCatalog()` (agreguje `catalogOf()` nad classifier/validator/ingest descriptory — capabilities co gateway hostuje in-process, žádný per-DO-instance round-trip potřeba, stejná úvaha jako u `GATEWAY_CAPABILITIES`); nová `GET /capabilities` na top-level fetch handleru (ne uvnitř `WorkflowInstance` DO — deterministické, stejné pro každou instanci).

**`tests/reg.test.ts`:** `REG-005` — `catalogOf()` vrací jeden řádek na capabilitu, shoduje se s `catalogEntry()`.

**Vědomě mimo rozsah:** integrace do `/farm`'s Kravičky panelu (dnes pořád čte `/version`'s prostý `capabilities` seznam, ne bohatý `/capabilities` katalog — funkční, jen ne využívá nová data), `lifecycleStatus`/health/cena pole (vyžadovalo by rozšíření zmrazeného `contracts/module-descriptor.v1.schema.json` — mimo proces, `SEVERKA.md` to sama jmenuje jako "kandidát pro rozšíření, ne dnešní kontrakt").

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), **242 testů** (241 + `REG-005`), arch, farm:check. **Nenasazeno zatím** — na rozdíl od (61) (beze změny chování) tohle je skutečně nová cesta na farmě, čeká na živé ověření jako každá nová Cloudflare-strana věc dřív.

## 2026-09-09 (62) — `SEVERKA.md` Execution Engine řádek byl zastaralý (nález externího posudku nad `d6f8287`, ověřeno proti kódu)

**Nález:** externí posudek nad (61) upozornil, že řádek Execution Engine popisuje stav před `b5b8be8`/`f29eb6f` (8. 9. 2026) — tvrdil, že hlubší idempotency identita a `IDEMPOTENCY_CONFLICT` zůstávají otevřené, což už týden neplatí. Ověřeno přímo v `src/platform/executor-host.ts` (ne převzato): `dedupKey()` je univerzálně `tenantId + handlerId + idempotencyKey`, fingerprint (`sha256(canonicalize(payload))`) rozlišuje replay od `IDEMPOTENCY_CONFLICT` — pro každý `ExecutorHost`, ne jen `document-host`.

**Nuance, kterou posudek zjednodušil:** durable effect ledger (`IdempotencyLedger` Durable Object) běží zatím **jen na `apf-document-host`**. `apf-email-executor`'s `/dispatch` (`deploy/cloudflare/apf-email-executor/src/index.ts`) staví `ExecutorHost` bez `idempotency` volby → výchozí `InMemoryIdempotencyStore`, zahozený s každým požadavkem (fresh `ExecutorHost` per `/dispatch`, žádná Durable Object). Composite klíč/fingerprint je tedy univerzální, durabilita ne — dva různé kroky bodu 2 `SEVERKA.md`, ne jeden. Neškodí, dokud `SEND_MODE: "sandbox"`; před `"live"` stojí za rozhodnutí.

**`docs/SEVERKA.md`:** Execution Engine řádek přepsán na aktuální stav (opraveno + zbylá mezera u `email.send`), ne smazán beze stopy.

**Beze změny kódu, gates neběžely** (dokumentační oprava).

## 2026-09-09 (61) — SEVERKA bod 4, první krok: `src/platform/registry.ts` — Agent Registry jako čtení nad `Router`, ne nová autorita

**Kontext:** externí posudek nad commitem (60) navrhoval jít rovnou do Admission Gate; vlastník rozhodl (AskUserQuestion) pokračovat podle vlastního kanonického pořadí `SEVERKA.md` — bod 4, Agent Registry, ne přeskočit dopředu (`SEVERKA.md`'s vlastní podmínka pro čerpání z Admission Gate sekce — druhý reálný tenant — stejně ještě není splněná).

**Explorace před psaním kódu potvrdila přesný rozsah:** `Router` už drží vše potřebné (`resolved: {component, capability, validateInput}[]`), ale `providers()` to zplošťuje na řetězec `"capability/vN@module"` a zahazuje riziko/izolaci/side effects, které `descriptor.json` už nese. Skutečný nález: `platform-wiring.ts` má **ruční, duplikované** `GATEWAY_CAPABILITIES`/`DOCUMENT_HOST_CAPABILITIES`/`EMAIL_EXECUTOR_CAPABILITIES` pole (přesně ta věc, kterou `SEVERKA.md`'s řádek pro Agent Registry pojmenovává jako "dnes ruční `router.register()` v `platform-wiring.ts`") — nic dřív neověřovalo, že se shodují s tím, co `apf-document-host`/`apf-email-executor` doopravdy registrují ve vlastním `Router`; drift by potichu skončil na `notWired`.

**`src/platform/registry.ts` (nový):** `capabilityNamesOf(descriptor)` (jméno capability přímo z descriptoru — jediný zdroj pro cross-Worker dispatch tabulky) a `catalogEntry(descriptor, capability, version)` (jeden řádek katalogu: capability/version/module + riziko/izolace/sideEffects/scopes/usesLlm/conformanceTier z descriptoru, žádné secrets/granty). Čistě čtecí, žádná nová autorita — `Router.route()` beze změny jediné rozhoduje, co smí běžet.

**`src/platform/router.ts`:** nová `catalog(): CapabilityRecord[]` metoda vedle `providers()` (beze změny), mapuje `resolved` přes `catalogEntry()`.

**`deploy/cloudflare/apf-gateway/src/platform-wiring.ts`:** `GATEWAY_CAPABILITIES`/`DOCUMENT_HOST_CAPABILITIES`/`EMAIL_EXECUTOR_CAPABILITIES` teď `capabilityNamesOf(...)` nad přímo importovaným `descriptor.json` (`document-executor-host`, `email-executor`; classifier/validator/ingest descriptory už byly importované) — stejné hodnoty jako dřív (ověřeno testem i `farm:check`), ale odvozené, ne psané znovu vedle sebe.

**`tests/reg.test.ts`** (nová rodina, `REG-001..004`): `catalog()` se neliší od `providers()` (stejné triple), nese správné riskClass/isolationClass/sideEffects pro `email.send`/`document.classify`, `document.stamp`+`document.archive` sdílí modul, `capabilityNamesOf()` na skutečných descriptorech vrací přesně to, co dřív bylo ručně napsané v `platform-wiring.ts`.

**Vědomě mimo rozsah tohohle kroku** (druhá polovina, jako u mail.ingest/email.send): HTTP `/registry`/`/capabilities` endpoint (descriptory ho deklarují v `endpoints.capabilities`, nikde neimplementovaný — zjištěno, ne skryto), nahrazení natvrdo psaných `capabilities: [...]` polí ve `/version` handlerech `apf-document-host`/`apf-email-executor` něčím odvozeným z descriptoru, integrace do `/farm`'s Kravičky panelu, health/cena pole. Nic z tohohle nemění chování na farmě — nenasazeno, nepotřebuje živé ověření (hodnoty prokazatelně identické testem, ne jen okem).

**`docs/SEVERKA.md`** Agent Registry řádek aktualizován (první krok hotov, co chybí vypsáno). **`docs/BUILD.md`** rozšířeno o `reg` testovací rodinu.

**`docs/STATUS.html`/`STATUS.en.html` jsou pozadu** (232 testů, e-mail popsaný jako skeleton) — od Human Review opravy/idempotency ledgeru/mail.ingest+email.send se needitovaly. Otevřený dluh, ne skryto — přepis na aktuální stav je samostatný celek, ne součást tohohle kroku.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), **241 testů** (233 + 8 nových `REG-*`), arch, farm:check.

## 2026-09-09 (60) — Živé ověření (57)–(59): `mail.ingest` čistý, `email.send` naráží na stejný jev jako (56) — teď s potvrzenou příčinou

**Nasazeno a ověřeno na `farm-bass443`.** `apf-mail-ingest`/`apf-email-executor` hlásí `wired: true`, `/farm` je ukazuje jako „OK", ne „NEZAPOJENO".

**`mail.ingest` je čistý ve full-suite self-testu** (13/13 fixtur, žádné selhání) — in-process dispatch na gatewayi nemá cross-Worker fetch-back, takže žádný z problémů níže se ho netýká.

**`email.send` v plném `SUITES` běhu (za document.archive) dostává živě `RESOURCE_TENANT_UNRESOLVED` pro každou fixturu s reálným artefaktem — a tentokrát je příčina definitivně potvrzená, ne jen hypotéza.** Dočasný diagnostický patch (`fetchArtifact()` v `apf-email-executor` dočasně `throw` místo tichého `return undefined`, self-test dočasně přidal `DEBUG result.error` do diffu — obojí nasazeno, ověřeno, vráceno zpět, `git diff` prázdný) odhalil skutečnou zprávu:

> `Subrequest depth limit exceeded. This request looped back into the Workers runtime too many times. This can happen e.g. if you have a Worker or Durable Object that calls other Workers or objects recursively.`

**To přesně vysvětluje i nevysvětlený nález z (56).** `document.archive`'s `damaged-hash-mismatch` a teď `email.send` sdílejí stejný vzorec: cross-Worker fetch-back (`apf-email-executor`/`apf-document-host` → `env.GATEWAY.fetch(.../workflow/:id/artifact/:id)` → `WorkflowInstance` DO RPC) je řetězec vnořených Worker-do-Worker volání; `runSelfTest()` provede **jedno** top-level volání (`stub.selfTest()`) obsahující 30+ takových řetězců za sebou (klasifikace, validace, stamp, archive, teď i ingest/email) — Cloudflare počítá hloubku kumulativně za **celý** původní request, ne per-fixtura. Čím pozdější sada ve `SUITES`, tím blíž limitu; `document.archive` byl dřív poslední (proto padal nejčastěji), teď `email.send` je úplně poslední (padá pokaždé). Přeuspořádání `mail.ingest`/`email.send` na začátek (dočasně, vráceno) potvrdilo částečně — `mail.ingest` prošlo čistě, ale `email.send`'s vlastní řádky úplně zmizely z výstupu (jiný projev stejné třídy limitu, ne nová chyba) — konzistentní s tím, že `mail.ingest`'s 13 fixtur samo o sobě už spotřebuje část rozpočtu.

**Není to bug v `resourceTenant()`, idempotency ledgeru ani v `apf-email-executor`'s zapojení — je to limitace `self-test.ts`'s vlastního designu** (jeden gigantický request se desítkami vnořených cross-Worker řetězců), ne produkčního toku. Skutečný `mail-intake.v2` workflow má 5 kroků v **jedné** instanci, hluboko pod jakýmkoli limitem — tohle self-test nikdy nepotká mimo diagnostický kontext.

**Rozhodnuto, ne provedeno v tomhle kroku:** přestavět `self-test.ts`, ať běží každou sadu jako samostatné top-level volání (např. samostatná RPC/HTTP volání místo jedné velké smyčky), by limit odstranilo — zapsáno jako budoucí položka, mimo rozsah „dokončit skeleton". Pro tenhle celek stačí, že **logika je živě prokázaná správná** (fixtura při menším počtu předchozích řetězců projde), i když plný `SUITES` běh dnes `email.send` nedokáže čistě potvrdit.

**Dopad na hodnocení (57)–(59):** cíl SEVERKA.md bodu 3 — `mail.ingest`/`email.send` zapojené a nasazené na stejné úrovni jako `document.stamp` — je splněný. `email.send`'s omezení je diagnostického nástroje, ne capability samotné.

**Brány beze změny** (žádný trvalý diff mimo self-test.ts komentář): typecheck, 233 testů, arch, farm:check.

## 2026-09-08 (59) — `mail.ingest`/`email.send` přidány do `self-test.ts` SUITES

**Kontext:** poslední kódový krok před společným nasazením a živým ověřením obou capabilit z (57)/(58) — parita s `document.stamp`/`document.archive`, co self-test už pokrývá od (49).

**`deploy/cloudflare/apf-gateway/src/self-test.ts`:** dva nové řádky v `SUITES` (13 fixtur `mail.ingest`, 15 `email.send`) — mechanický přídavek, žádná změna `runSelfTest()`'s smyčky nebyla potřeba: existující logika (artifact `put()` jen když `f.artifact`, skip na `f.adapters`/`f.storage`, `actor` override) už přesně sedí na tvar obou fixture sad. `mail.ingest` fixtury nikdy neodkazují `$artifactId` (samy vytvářejí artefakt z `rawMail`), `email.send` fixtury ho potřebují stejně jako `document.stamp` — stejný `SELF_TEST_WORKFLOW_ID` mechanismus (fixní workflowId → stejná Durable Object → fetch-back najde artefakt) funguje beze změny.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 233 testů, arch, farm:check. **Nenasazeno** — nasazení a živé ověření (deploy + self-test běhy + `wrangler tail`, stejná rigorózita jako u `document.stamp`) je bezprostředně další krok.

## 2026-09-08 (58) — SEVERKA bod 3, druhá polovina: `apf-email-executor` skutečně odesílá (sandbox)

**Kontext:** dokončení (57) — `email.send` je PRINCIPAL (vlastní credential doména, jediné write právo je Email Sending binding), takže na rozdíl od `mail.ingest` zůstává skutečným remote dispatchem, ne in-process. Struktura zrcadlí `apf-document-host`'s `/dispatch` (celek D2) téměř 1:1, jediný strukturní rozdíl: fetch-back artefaktu je tady **read-only** (`email.send` artefakt jen referencuje přes `params.artifactId`, nikdy neodvozuje) — nová `ReadOnlyArtifactStore` (jen `get()`, ne `derive()`/`put()`), ne kopie plného `SingleArtifactStore`.

**`deploy/cloudflare/apf-email-executor/src/relay-audit.ts`** (nový, duplikát `apf-document-host`'s — stejná konvence, každý deployable soběstačný, ne sdílený balíček) a **`smtp-adapter.ts`** (nový): `CloudflareSmtpAdapter` nad nativním Email Sending bindingem (`env.EMAIL.send({to, from, subject, text})`, ověřeno proti `cloudflare-email-service` skillu, ne z paměti). **Zdokumentované omezení, ne skryté:** Cloudflare's nativní API nemá dotaz podle reference (žádné „už se poslalo clientRef X?"), takže `status()`/`read()` vrací vždy `UNKNOWN`/`undefined` — pád mezi „odesláno" a zápisem do lokálního idempotency ledgeru se nedá dořešit dotazem na skutečného poskytovatele (na rozdíl od `HttpDmsAdapter.status()` proti `apf-fakes`). Riziko je duplicitní nízko-rizikový notifikační e-mail, ne duplicitní finanční/dokumentový zápis. Postaveno, aby to prošlo typecheckem a bylo připravené, ale **`SEND_MODE` zůstává `"sandbox"`** — tahle větev se dnes nikde nespouští.

**`deploy/cloudflare/apf-email-executor/src/index.ts`:** `/dispatch` handler — `RelayAudit` + `CredentialResolver` (fixní `SMTP_CREDENTIAL_VALUE = "smtp-secret"`, odpovídá `FakeSmtpAdapter`'s výchozí hodnotě; `CloudflareSmtpAdapter` credential ignoruje, binding sám je autorizace, „Secrets: none" je bod PRINCIPAL) + `ExecutorHost` + `email.createEmailSendHandler` + `Router` s `email.descriptor`/policy. `recipients: RecipientDirectory` čte `recipientAllowlist[tenantId][ref]` ze stejné policy jako `src/slice.ts`. `/version`/`/health` teď hlásí `wired: true`.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 233 testů, arch, farm:check. **Nenasazeno zatím** — `self-test.ts` rozšíření o `mail.ingest`/`email.send` (SUITES) následuje jako poslední krok před společným nasazením a živým ověřením obou capabilit.

## 2026-09-08 (57) — SEVERKA bod 3, první polovina: `mail.ingest` dispatchovatelný, `apf-mail-ingest` skutečně přijímá poštu

**Kontext:** dokončení skeletonu `mail.ingest`/`email.send` (SEVERKA.md bod 3) — druhý reálný typ COW, první event-driven případ. Explorace potvrdila přesnou mezeru: core-platform handlery jsou hotové (stejná zralost jako `document.stamp`), ale gateway na ně dodnes neměla ŽÁDNOU dispatch cestu (`GATEWAY_CAPABILITIES`/`DOCUMENT_HOST_CAPABILITIES` je vůbec nezmiňovaly) a oba Cloudflare deployables byly skutečné skeletony (`wired: false`, `email()` handler vždy odmítal).

**Rozsah potvrzen s vlastníkem:** jen dokončit skeleton (ne rovnou stavět admission pipeline kolem toho). `mail.ingest` běží **in-process na gatewayi** (žádný credential k izolaci, jen zápis do vlastního tenant artifact store — stejný důvod jako `document.classify`/`document.validate`), `email.send` zůstává **remote dispatch** na `apf-email-executor` (PRINCIPAL, vlastní credential doména) — druhá polovina, samostatný krok.

**`deploy/cloudflare/apf-gateway/src/platform-wiring.ts`:** `mail.ingest` přidán do `GATEWAY_CAPABILITIES`, registrován přes vlastní `ExecutorHost`+`ingestCredentials` (prázdná tabulka, stejně jako `src/slice.ts`) — dostává STEJNÝ allowlist/context/idempotency řetězec jako každá jiná write capabilita, ne holý Handler. Zároveň přidána `EMAIL_EXECUTOR_CAPABILITIES`/`emailExecutor` wiring volba (RemoteHostTransport, zrcadlí `documentHost`) — připraveno pro druhou polovinu.

**`deploy/cloudflare/apf-gateway/src/index.ts`:** nová `mailIntake()` RPC metoda na `WorkflowInstance` (zrcadlí `intake()`, ale bez original/extraction — `mail.ingest` jako krok 1 workflow definice sám vytváří artefakt z `rawMail`), nová `startMailIntake()` (KILL_SWITCH/model/velikost kontroly, stejný tvar jako `startIntake()`), nová interní route `POST /mail-intake` (volá jen `apf-mail-ingest` přes `GATEWAY` binding, ne veřejný formulář — tenant se řeší server-side přes existující `intakeTenant()`).

**Nález cestou (ARCH-DEP-001 chytilo skutečnou chybu):** první verze natvrdo psala `"ops-mailbox"` do `index.ts` jako výchozí `notifyRef` — lint správně odmítl (installation hodnota v kódu). Opraveno: `notifyRef` je teď povinné pole, dodává ho volající (`apf-mail-ingest`); jeho výchozí hodnota `DEFAULT_NOTIFY_REF` žije v `config/farm-bass443/farm.json` (stejný vzor jako `EMAIL_FROM`/`INTAKE_ADDRESS` — base `wrangler.jsonc` var vůbec nedeklaruje, jen komentář kam patří).

**`deploy/cloudflare/apf-mail-ingest/src/index.ts`:** skutečný `email()` handler — `message.rawSize` kontrola proti `MAX_RAW_BYTES` ještě před čtením (bounce beze čtení, když je moc velká), `new Response(message.raw).text()` na vybufferování, POST na gatewayovu novou `/mail-intake` route, `setReject()` na jakoukoli chybu (nikdy tiché zahození). `/version`/`/health` teď hlásí `wired: true`.

**Otevřeno, nezakrýváno:** `MAX_MAILS_PER_DAY` je deklarovaná, ale nevynucená — skutečný denní rate limit potřebuje durable stav (KV/DO), mimo rozsah tohohle kroku, zapsáno jako známá mezera, ne mlčky přeskočeno.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 233 testů, arch, farm:check. **Nenasazeno zatím** — `email.send`/`apf-email-executor` (druhá polovina) a `self-test.ts` rozšíření následují jako další celek, pak společné nasazení + živé ověření.

## 2026-09-08 (56) — Nález (55) vysvětlen: `document.archive`'s `damaged-hash-mismatch` je objem/pořadí-závislý, ne bug v `resourceTenant()`

**Vlastníkovo rozhodnutí:** dořešit otevřený nález z (55) evidencí, ne odhadem, bez ohledu na širší diskuzi o pořadí prací (Admission Gate zůstává v pořadí SEVERKA.md beze změny — bod 3, `mail.ingest`/`email.send`, je další skutečná implementace).

**Diagnostický test:** `deploy/cloudflare/apf-gateway/src/self-test.ts`'s `SUITES` pole dočasně přeuspořádáno — `document.archive` přesunuto **první** (před `document.classify`/`document.validate`/`document.stamp`), nasazeno, spuštěno 4× živě. **Výsledek: `damaged-hash-mismatch` (i všechny ostatní archive fixtury) prošly čistě ve všech 4 bězích**, žádný `RESOURCE_TENANT_UNRESOLVED`. Po testu vráceno zpět na původní pořadí (`git diff` prázdný), znovu nasazeno — žádná trvalá změna kódu.

**Závěr:** nález z (55) **není bug v `resourceTenant()` ani v idempotency ledgeru** — je to objemově/pořadí-závislý jev specifický pro self-test samotný. `document.archive` v původním pořadí běží jako poslední sada (~20.–23. dispatch z ~30+ v jednom volání `stub.selfTest()`, každý s cross-Worker fetch-backem gateway↔document-host); v tomhle bodě něco (pravděpodobně Cloudflare limit na subrequesty nebo souběžná/vnořená Durable Object volání v rámci jednoho Worker invocation) způsobí, že `SingleArtifactStore` nedostane artefakt zpět, ačkoli existuje. Když archive běží první (minimální předchozí objem), jev zmizí — **potvrzeno, ne jen hypotéza**.

**Proč to nikdy nechytí lokální `npm test`:** `tests/ctr.test.ts` staví pro každou fixturu čerstvý `createSlice()` — žádný kumulativní objem požadavků napříč desítkami fixtur v jednom volání, žádný skutečný cross-Worker network round-trip. Přesně ten typ nálezu, co live self-test má odhalit a lokální conformance suite strukturálně nemůže — potvrzuje hodnotu celku z (49), ne slabinu.

**Nezasahováno do produkčního kódu** — `document.archive` v produkčním workflow neběží (jen `classify→validate→stamp`), takže tenhle limit dnes nikoho nepoškozuje. Pokud/až self-test poroste (víc capabilit, víc fixtur), stojí za zvážení jako budoucí položka: dávkovat `runSelfTest()` po menších skupinách (např. `ctx.waitUntil` mezi suitami, nebo limit souběžných cross-Worker volání) — zapsáno jako nápad, ne naplánováno.

**Brány beze změny** (žádný trvalý diff): typecheck, 233 testů, arch, farm:check zelené jako v (54)/(55).

## 2026-09-08 (55) — Živé ověření (54) na farmě: `document.stamp` čistý, `document.archive` má otevřený, nevysvětlený nález

**Nasazeno a ověřeno:** `farm-bass443` po (54), `/version` potvrdil `gitSha`. Živě ověřeno přes existující self-test (`/farm` → Kravičky → Spustit self-test), víc než deset opakování:

- **`document.stamp` (jediná capabilita v reálném produkčním toku) je čistá.** Přes `wrangler tail` ověřen kompletní běh 16 fixtur: `resourceTenant()` správně vrací `FOUND` pro reálné artefakty (dosáhne `write-intent`/`write-done`), `NOT_FOUND` jen pro záměrně chybějící (`error-artifact-missing`) a `TENANT_SCOPE_MISMATCH`/`CAPABILITY_NOT_ALLOWED`/`COMMAND_EXPIRED` přesně podle scénáře. `IdempotencyLedger.reserveOrGet`/`resolve`/`release` volání viditelná v tailu na každém zápisu.
- **`document.archive` má reprodukovatelný, ale nevysvětlený nález:** fixtura `damaged-hash-mismatch` (skutečně existující artefakt s podvrženým sha256) na živé farmě konzistentně (10+ opakování, vždy) dostane `RESOURCE_TENANT_UNRESOLVED` (NOT_FOUND) místo očekávaného `ARTIFACT_HASH_MISMATCH` — jako by `resourceTenant()` artefakt nenašel, i když existuje (sousední `canonical-archive` i záměrně chybějící `error-artifact-missing` fixtura fungují správně). **Lokálně (`npm test`, 233/233) tahle přesná fixtura prochází deterministicky** — bug se neprojevuje mimo živou farmu.

**Vedlejší nález cestou (samostatný, ne příčina výše):** `document.archive`'s `security`/`deny` audit záznamy (na rozdíl od `document.stamp`, kde jsou spolehlivě v D1) se v `/audit.json` prakticky nikdy neobjeví — `RelayAudit`/`copyOut()` kód je capability-agnostic, takže nejde o zjevnou logickou chybu, jen o pozorování. Nebráněno dál, protože `document.archive` dnes v produkčním workflow vůbec neběží (`document-intake.v2.json` má jen `classify→validate→stamp`; `document.archive` existuje jen pro SEC-HOST-001 izolační test a teď navíc self-test).

**Vyšetřeno a vyloučeno jako příčina** (než jsem se rozhodl nález nechat otevřený, ne hádat opravu): shoda `artifactId` regexu na gatewayi (`newId()` vždy `[A-Za-z0-9]+`, vyloučeno), staleness `notValidAfter`/hodin (přepočítává se per fixtura), sdílený stav mezi requesty (`SingleArtifactStore`/`ExecutorHost`/`Router` se staví nanovo při každém `/dispatch`), pořadí/souběžnost self-testu (`await` sekvenční, `RemoteHostTransport.dispatch()` plně awaitovaný), kolize obsahu/ID artefaktů (`artifactId` vždy čerstvý `newId`, ne content-addressed).

**Pracovní hypotéza, NEPOTVRZENÁ:** něco vázané na hloubku/objem požadavků uvnitř jednoho `stub.selfTest()` běhu (`document.archive` běží jako poslední sada, cca 20.–23. dispatch v pořadí) — možná Cloudflare limit na souběžné/vnořené Durable Object volání (gatewayovo `WorkflowInstance` DO obsluhuje jak vlastní `selfTest()` RPC, tak vnořené `artifact()` RPC z document-hostova fetch-backu). **Nehádat opravu bez důkazu** — zapsáno jako otevřená položka k vyšetření, ne opraveno naslepo.

**Přidáno cestou (drobné, komitnuto):** `RESOURCE_TENANT_UNRESOLVED` audit detail rozšířen o `artifactId`/`messageId` (`src/platform/executor-host.ts`) — trvalé zlepšení diagnostiky pro produkci, ne jen pro tenhle nález; použito při vyšetřování, nepomohlo (audit se pro `document.archive` stejně nedostal do D1, viz vedlejší nález výš).

**Dopad na hodnocení celku (54):** cíl tohoto celku — durabilita idempotency ledgeru pro **`document.stamp`**, jedinou capabilitu v reálném produkčním toku — je živě ověřená a čistá. `document.archive`'s nález je izolovaný na capabilitu mimo produkční cestu; nezastavuje ani neznevěrohodňuje (54).

**Brány zelené:** typecheck, 233 testů, arch, farm:check.

## 2026-09-08 (54) — SEVERKA bod 2, druhá polovina: durable `IdempotencyLedger` (Durable Object) na `apf-document-host`

**Kontext:** dokončení bodu 2 ze `SEVERKA.md` — (53) uzavřela kontraktovou část (hlubší klíč, `IDEMPOTENCY_CONFLICT`), tohle je skutečná durabilita, kterou (53) výslovně nechala otevřenou: `apf-document-host` je stateless Worker, `ExecutorHost` se staví nanovo při každém `/dispatch` requestu, výchozí `InMemoryIdempotencyStore` tedy na farmě nededupuje nic mezi požadavky ani isoláty.

**Volba mezi D1 tabulkou a vyhrazenou Durable Object byla probrána explicitně s vlastníkem** (ne rozhodnuta tiše): D1 by dodala perzistenci, ale ne atomicitu — souběžné duplicitní doručení může projít mezerou „přečti, pak zapiš" dřív, než první požadavek stihne zapsat. Durable Object adresovaná podle `dedupKey` (`idFromName`) dává atomicitu zdarma, protože Cloudflare serializuje požadavky do jednoho objektu — přesně to, co `SqliteReviewTaskStore` z (50) už jednou dokázalo pro Human Review. Zvoleno DO, vlastníkovo kritérium „robustní a udržitelné".

**`deploy/cloudflare/apf-document-host/src/idempotency-ledger.ts` (nový):** `IdempotencyLedger extends DurableObject`, jedna SQLite tabulka (`ledger`), čtyři metody (`peek`/`reserveOrGet`/`resolve`/`release`) — stejný vzor jako `SqliteReviewTaskStore`, jen samostatná DO třída místo store nad sdílenou `WorkflowInstance`. **Design rozhodnutí:** DO žije uvnitř `apf-document-host` samotného (ne cross-script binding na `apf-gateway`, co DO infrastrukturu už má) — vyhne se pořadí nasazení mezi dvěma samostatně nasazovanými Workery a drží nový prostředek jen tam, kde je potřeba.

**`deploy/cloudflare/apf-document-host/src/index.ts`:** nová `DurableIdempotencyStore` (adaptér `IdempotencyStore` ze `src/platform/idempotency.ts` na DO stub, `env.IDEMPOTENCY.get(idFromName(dedupKey))`), zapojená do `new ExecutorHost({ ..., idempotency: new DurableIdempotencyStore(env.IDEMPOTENCY) })` v `/dispatch`. DO třída exportována z `index.ts` (Workers to vyžadují pro každou třídu v `durable_objects.bindings`).

**`wrangler.jsonc`:** nový `durable_objects` binding (`IDEMPOTENCY` → `IdempotencyLedger`) + `migrations` (`new_sqlite_classes`), stejný tvar jako gatewayův `WORKFLOW` binding. Žádný záznam v `config/farm-bass443/farm.json` nepotřeba — je to stejný-Worker binding, ne externí prostředek s vlastním id.

**Otevřeně zapsáno, ne skryto:** lokální testovací harness (`tests/dh.test.ts`) neumí ověřit skutečnou atomicitu/durabilitu DO — je to opravdový Cloudflare runtime primitiv, ne něco, co Node/vitest simuluje. Ověření jde stejnou cestou jako Human Review v (52): nasazení na farmu, živý test.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 233 testů (beze změny — DO durabilita se testuje živě, ne jednotkovým testem), arch, farm:check.

**Kontext:** pokračování `## Pořadí` ze `SEVERKA.md` bodem 2 (durable idempotency/effect ledger), rozšířeno o nález z diskuze nad `docs/POSUDKY.md` (Posudek 5/6): `resourceTenant()` fail-open pattern. Explorace ukázala, že „durable ledger" jsou ve skutečnosti dvě oddělitelné věci — **tahle část je ta bez nové infrastruktury**, druhá (skutečně durable úložiště na `apf-document-host`, dnes stateless Worker bez DO/D1/KV) je rozpracovaná dál v tomhle celku.

**`src/platform/idempotency.ts` (nový):** `IdempotencyStore` rozhraní s atomickou `reserveOrGet()`/`resolve()`/`release()` semantikou (na rozdíl od `ReviewTaskStore`'s prostého get/set — tady je race mezi „zkontroluj" a „zapiš" přesně to, co se má uzavřít). `InMemoryIdempotencyStore` výchozí, triviálně atomická v jednom JS vlákně.

**`src/platform/executor-host.ts`:** dedup klíč `capability + idempotencyKey` → `tenantId + handlerId + idempotencyKey` (Posudek 5/6 — `handlerId` je dnes už 1:1 s capabilitou, takže žádná ztráta oproti dřívějšímu W19 fixu, jen navíc uzavírá cross-tenant kolizi). Fingerprint (`sha256(canonicalize(payload))`) rozlišuje replay (stejný klíč, stejný payload → stará odpověď) od konfliktu (stejný klíč, jiný payload → nový `IDEMPOTENCY_CONFLICT`, `class: VALIDATION`). Nová rezervace navíc chytá souběžné duplicity uprostřed běhu (`IDEMPOTENCY_IN_FLIGHT`, retryable). **Vedlejší nález cestou:** v souboru byl od nepaměti stray NUL byte místo mezery v `dedupKey()` (`\`${capability}\0${idempotencyKey}\``) — fungovalo náhodou (NUL je platný oddělovač), opraveno při přepisu.

**`ResourceTenantResult` (resourceTenant fail-open, Posudek 5/6):** `string | undefined` → explicitní `FOUND | GLOBAL_RESOURCE | NOT_FOUND | UNRESOLVED`. Jen `FOUND` s odpovídajícím tenantem a explicitně opted-in `GLOBAL_RESOURCE` (nové pole `HostHandlerSpec.allowsGlobalResource`, dnes jen `mail.ingest`) projdou; `NOT_FOUND`/`UNRESOLVED`/neopted-in `GLOBAL_RESOURCE` → nový `RESOURCE_TENANT_UNRESOLVED` (SECURITY), zamítnuto ještě před handlerem. **Ověřeno v kódu před opravou** (`stamp-handler.ts:35`, `archive-handler.ts:22`): neexistující `artifactId` dřív fail-open přeskočilo tenant kontrolu, zachytil to až handlerův vlastní `ARTIFACT_NOT_FOUND` — náhoda pořadí kontrol, ne záruka. Handlerův `ARTIFACT_NOT_FOUND` check zůstává jako defense-in-depth (dosažitelný jen když `skipContextMatch` mutant vypne bránu, `MUT-CTX-001`), ne smazán jako mrtvý kód.

**Dopad na conformance suite (očekávaný, ne regrese):** `error-artifact-missing` golden pro `document.stamp`/`document.archive`/`email.send` teď čeká `RESOURCE_TENANT_UNRESOLVED` místo `ARTIFACT_NOT_FOUND` — `errors.md` u všech tří doplněn (nový řádek pro normální cestu + poznámka o defense-in-depth cestě + `IDEMPOTENCY_CONFLICT`/`IDEMPOTENCY_IN_FLIGHT`). `tests/idm.test.ts` (`IDM-STRAT-001`): stará asercie „the key wins, not the payload" byla přesně ten dřívější slabý kontrakt, který se měl zpřísnit — přepsáno na explicitní `IDEMPOTENCY_CONFLICT` větev + ověření, že skutečný replay (stejný klíč a payload) pořád funguje.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 233 testů (beze změny počtu — testy upraveny na nový kontrakt, ne přidány), arch, farm:check. **Nenasazeno** — jen lokální commit, žádná Cloudflare vrstva se v tomhle kroku neměnila. Durable úložiště na `apf-document-host` (vyhrazená Durable Object `IdempotencyLedger`, atomická per-klíč, stejný vzor jako `SqliteReviewTaskStore`) je rozpracovaná jako navazující krok téže session.

## 2026-09-08 (52) — Pushnuto a živě ověřeno na farmě: Human Review decision cesta doopravdy funguje na `farm-bass443`

**Pokyn vlastníka:** „pushnout a udělat živé ověření na farmě" — poslední otevřený bod z (50)/(51).

**Push:** `42d6ee7` (oprava z (50) + regresní test z (51)) na `origin/main`. Beze změn v deployed kódu oproti (50) — `SliceOptions.reviewStore` z (51) je jen testovací harness, `apf-gateway` už opravu nesla od (50), jen nikdy nebyla nasazená.

**Nasazení:** `wrangler whoami` ověřen (`bass443@gmail.com`, účet `a37a36270aa2db7382f62912ba5a0130`), `node scripts/farm-deploy.mjs farm-bass443 --dry-run` čistý, pak ostrý běh — všech pět Workerů (`apf-fakes` → `apf-document-host` → `apf-email-executor` → `apf-mail-ingest` → `apf-gateway`) nahráno bez chyby. `/version` přes službový token (`CF-Access-Client-Id/Secret` z lokálního `.env`) potvrdil `"gitSha":"42d6ee7"`.

**Živé ověření přesně toho, co (50) opravilo (ne jen že se to nasadilo):**
1. `POST /intake` s textem newsletteru (fixtura `canonical-other-newsletter`) → `303` na novou instanci `wf-mtt2e5zg001a05ec7`.
2. `GET /workflow/:id.json` → `status: WAITING`, `waiting.reason: REVIEW`, `reviewTaskId: rev-mtt2e6s400g7e045d` (klasifikace `OTHER`, čeká na review stejně jako v testech).
3. `POST /workflow/:id/review/decide` s `decision=REJECT` → `303` (ne `400` z chybové větve `decideReview()`) — **tohle je přesně cesta, co na farmě před (50) neexistovala vůbec** (žádný `/review` handler, žádné volání `.decide(`).
4. `GET /workflow/:id.json` znovu → top-level `status: FAILED`, `waiting` pryč — instance se skutečně dokončila přes `resumeAfterReview()`, ne uvízla.

Testovací instance `wf-mtt2e5zg001a05ec7` ponechána na farmě jako doklad ověření (neobsahuje nic citlivého, jen fixturový newsletter text) — lze smazat přes `/purge`, až nebude potřeba jako evidence.

**Brány beze změny od (51):** typecheck, 233 testů, arch, farm:check — všechny zelené před nasazením.

## 2026-09-08 (51) — Dopsán regresní test z (50): RES-REVIEW-001, `SliceOptions.reviewStore`

**Pokračování přerušené práce z (50)** (`6dea224`, „pokračuj"): dopsáno přesně to, co bylo rozpracované — regresní test dokazující, že rozhodnutí přes samostatně sestavenou `ReviewService` instanci sdílející stejné úložiště funguje, vzorem `RES-CRASH-001`.

**`src/slice.ts`:** `SliceOptions` dostala `reviewStore?: ReviewTaskStore`; `createSlice()` ji předá do `new ReviewService(clock, audit, o.reviewStore)`, když je zadaná (beze změny výchozího chování — bez ní vznikne `InMemoryReviewTaskStore` jako dřív).

**`tests/res.test.ts` — nový `RES-REVIEW-001`:** dvě samostatná volání `createSlice()` sdílející `journalFile`/`auditFile`/`artifacts`/**`reviewStore`** (přesně vzor `RES-CRASH-001`, jen review store místo DMS/journal). První slice doběhne intake do `WAITING(REVIEW)`, druhé (nová `ReviewService` instance — simuluje druhý HTTP požadavek na stejný Durable Object) najde stejný úkol, rozhodne (`REJECT`) a `resumeAfterReview()` dokončí instanci na `FAILED`.

**Test ověřen, že skutečně chytá opravovaný bug, ne jen formálně existuje:** dočasně vrácen `after` slice bez sdíleného `reviewStore` (simulace stavu před opravou z (50)) → test spadl přesně na `expect(after.review.get(taskId)).toBeDefined()` s `undefined`. Vráceno zpět, změna zahozena, jen ověření.

**Otevřeno, nedokončeno (stejně jako v (50)):** **živé ověření na farmě zatím neproběhlo** — jen lokální brány. Commit zůstává lokální na pokyn vlastníka z (50) („Nepushovat, nenasazovat"); push a nasazení čekají na výslovné potvrzení.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), **233 testů** (232 + nový `RES-REVIEW-001`), arch, farm:check.

## 2026-09-08 (50) — Human Review dostal skutečnou decision cestu (oprava nejzávažnějšího nálezu z OPONENTURY)

**Kontext:** po rozsáhlé diskuzi o cílové platformě (zapsáno do `SEVERKA.md`) se vlastník rozhodl pokračovat blízkým plánem a rovnou opravit nejzávažnější doloženou mezeru z (49)/`docs/OPONENTURA-BEZPECNOST-STABILITA.md` bod 1: na farmě dnes neexistovala žádná funkční cesta k rozhodnutí o review.

**Než padl kód, ověřeno, že chybí jen jedna věc, ne celá logika:** `Orchestrator.resumeAfterReview(workflowId, reviewTaskId)` (`src/platform/orchestrator.ts:173`) už existuje, je hotový a otestovaný (`WF-REV-003`/`004`) — správně aplikuje `REJECT`/`APPROVE`/`CORRECT`/`RECLASSIFY` a znovu spustí tok. Jediné, co chybělo, byla trvalost `ReviewService.tasks` napříč samostatnými HTTP požadavky na tutéž Durable Object.

**Oprava (`src/platform/review.ts`):** `ReviewService` dostala injektovatelné úložiště (`ReviewTaskStore` rozhraní: `get`/`set`/`all`), výchozí `InMemoryReviewTaskStore` zachovává přesně dnešní chování (žádný existující test/volající se nezměnil — `new ReviewService(clock, audit)` funguje jako dřív). Každá mutace (`decide()`, `expire()`) teď po změně objektu volá `store.set()` explicitně, protože SQL-backed úložiště nevrací referenci jako `Map`.

**Cloudflare vrstva:** nová `SqliteReviewTaskStore` (`deploy/cloudflare/apf-gateway/src/store.ts`) — jedna řádka na review úkol v DO SQLite (`review` tabulka v DDL), stejný vzor jako `SqliteJournal`/`SqliteAudit`/`SqliteArtifacts`. `WorkflowInstance` v `index.ts` ji drží jako pole (`this.reviewStore`) a předává do `ReviewService` při každém `orchestratorFor()` — teď už sdílené, ne nové pokaždé.

**Nová metoda `decideReview()` na `WorkflowInstance`:** najde úkol, zavolá `ReviewService.decide()`, pak `Orchestrator.resumeAfterReview()` — a po úspěchu spustí stejné vedlejší efekty jako `intake()` (`copyOut()`, `visualStampIfApplicable()`). **Nález cestou:** oprava correction pole zabrala dvě kola. Nejdřív jsem chybně předpokládal, že se pole jmenuje jinak podle toho, jestli čeká krok classify (`documentType`) nebo validate (`correctedDocumentType`) — schémata mají `additionalProperties:false`, takže poslání špatného pole by spadlo. Skutečnost je elegantnější: workflow definice (`document-intake.v2.json`) mapuje **jediné** `$input.documentType` na payload klíč, který si každý krok sám pojmenuje (`classify` ho čte jako `documentType`, `validate`'s `inputs` ho přejmenuje na `correctedDocumentType`) — `decideReview()` tedy vždy posílá `{ documentType: correctedType }` bez ohledu na to, který krok čeká.

**Nová route `POST /workflow/:id/review/decide`** a formulář na stránce instance (`renderOutput` v `page.ts`) — zobrazí se jen když `status === "WAITING" && waiting.reason === "REVIEW"`: dropdown na opravený typ dokumentu + tři tlačítka (Opravit a zopakovat / Schválit tak, jak je / Zamítnout).

**Otevřeno, nedokončeno (přerušeno na pokyn vlastníka „udělej commit"):** rozdělaný regresní test dokazující, že rozhodnutí přes oddělenou `ReviewService` instanci sdílející stejné úložiště funguje (simulace dvou samostatných HTTP požadavků na tutéž Durable Object, vzorem `RES-CRASH-001`sdílející `journalFile`/`auditFile`/`artifacts` mezi dvěma `createSlice()`). `InMemoryReviewTaskStore` už exportovaná z `review.ts` pro tenhle účel, `SliceOptions.reviewStore` a samotný test zatím nenapsané. **Live ověření na farmě taky zatím neproběhlo** — jen lokální brány.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů (beze změny počtu — nový regresní test ještě nenapsán), arch, farm:check. **Nepushnuto, nenasazeno** — jen lokální commit na pokyn vlastníka.

## 2026-09-08 (49) — Dohnáno z druhého PC (8 commitů bez HANDOFF záznamu): self-test kraviček, oprava klíče vizuálního razítka, UI polish, podklad pro oponenturu

**Tenhle záznam vznikl zpětně** — session na druhém počítači udělala a pushnula osm commitů (`a3742f3`..`f30a22f`), ale nezapsala k nim HANDOFF, což porušuje zavedené pravidlo tohohle projektu („po každém malém celku HANDOFF + commit"). Rekonstruováno z podrobných commit zpráv, ne odhadem.

**1) Živý self-test kraviček z GUI** (`aea7edf`, `b6db148`, `d6b5dc9`, `f30a22f`) — na `/farm` → Kravičky přibylo tlačítko „Spustit self-test": pustí skutečné conformance fixtures `document.classify`/`document.validate`/`document.stamp`/`document.archive` proti **reálnému zapojení tohoto Workeru** (skutečný model, skutečný `apf-fakes` registr přes HTTP), ne proti Node fake adaptérům jako `npm test`. Výsledek (PASS/FAIL/SKIPPED + diff proti golden) na samostatné stránce, seskupený podle Workeru (`apf-gateway`/`apf-document-host`), ať je vidět, že ověření šlo přes skutečnou síť, ne jen lokálně.
   - **Slepá ulička cestou:** `document.stamp`/`document.archive` běží na jiném Workeru (`apf-document-host`), který si artefakt vyžádá zpět od gateway podle `workflowId` ve tvaru `wf-...` — self-test instance nejdřív používala jméno `"self-test"`, fetch-back 404oval, obě capability padaly na `ARTIFACT_NOT_FOUND` nesouvisející se skutečným zdravím. Dočasně vráceno jen na classify/validate (`b6db148`), pak doladěno.
   - **Řešení:** fixní `workflowId` `"wf-selftest"` (ne náhodný) pro všechny self-test dispatch zprávy — resolvuje na stejnou Durable Object instanci, do jejíhož artifacts store self-test soubor uložil (stejný reentrantní mechanismus jako produkce používá pro každý skutečný dokument, W21). `"wf-selftest"` vyloučeno z `recentInstances()` dotazu do D1, ať se neobjeví v „Poslední instance" jako falešný PURGED záznam (relay audit z document-hostu jinak píše do sdíleného D1 bez ohledu na tvar workflowId).
   - **Dvě opravy cestou:** poměr v hlavičce počítal SKIPPED jako „prošel" (chybně 15/11); chyběla substituce `$sha256:tampered` u fixtures na poškozený hash, padalo to na `SCHEMA_VALIDATION_FAILED` místo skutečného testu `ARTIFACT_HASH_MISMATCH` (SEC-ART-001).

**2) Oprava reálného produkčního nálezu: vizuální razítko se klíčovalo podle sha256, ne podle workflowId** (`0791d49`, nalezeno živě 8. 9. 2026) — dva různé dokumenty se stejným obsahem originálu (znovunahraný/duplicitně vyzvednutý soubor z inboxu) sdílely jeden R2 objekt `stamped-visual/<tenant>/<sha256>` — `/original-stamped` jedné instance uměl servírovat razítko (s cizím časem/referencí) druhé instance. Potvrzeno v D1 auditu na dvou konkrétních instancích se shodným sha256 originálu. Opraveno klíčováním podle `workflowId` — přesně to riziko, na které tenhle deník upozorňoval hned po zavedení vizuálního razítka v (42) implicitně (sha256 jako klíč bez ohledu na to, že stejný obsah může projít vícekrát).

**3) UI polish na `/farm`** (`12b2f1c`, `a3742f3`): „Poslední instance" teď má sbalitelné řádky (výchozí stav sbalený, klikem rozbalíš kroky), toolbar s výběrem počtu (15/30/50/100/200) a časového okna (24 h/7 dní/30 dní/celá historie) přes GET parametry; vedle typu dokumentu i velikost originální přílohy. Odsazení řádků pod skupinovou hlavičkou opraveno (`:has(tr.group-head)`, jen tam, kde skupiny skutečně jsou — Deník beze změny).

**4) Nový `docs/OPONENTURA-BEZPECNOST-STABILITA.md`** (`81c09d6`, 8. 9. 2026) — snímek pro chystanou externí oponenturu, sestavený čtením aktuálního kódu (soubor:řádek), ne opsáním starší dokumentace; kde se liší od `SEVERKA.md`/`HANDOFF.md`/`MEASUREMENT.md`, je to vyznačené. **Nejzávažnější zjištění, přísnější než dosavadní formulace:** na živé farmě dnes **neexistuje žádná funkční cesta k rozhodnutí o Human Review** — `ReviewService` se vytváří znovu s prázdnou mapou při **každém** volání `orchestratorFor()` (jediné volací místo: `startIntake()`), v nasazeném kódu není žádný `/review` handler ani jediné volání `.decide(`; `/farm`/`/workflow/:id` review task jen zobrazí, nedá se přes ně rozhodnout. Testy tohle nemůžou odhalit, protože `createSlice()` drží jeden `ReviewService` po celou dobu testu. Praktický důsledek: instance, co dnes doběhne do `WAITING(REVIEW)` (celý den jsme jich generovali spoustu — OTHER/CONTRACT-disputed dokumenty), zůstává takhle **natrvalo**, jediná dostupná akce je `/purge`. Dokument dál probírá W4 (crossCheck substring bez hranice slova — `dph` opraveno 7. 9., zbylých šest klíčových slov ne, bez regresního testu), W19/W20 (idempotence), SEC-CRED (klíč a rotace, funkční), tenant izolaci, mail/email skeleton, W23 (audit relay, vyřešeno) a W9 (co neběží a proč) — s prioritizovanými doporučeními pro oponenturu v sekci 9. **Je to snímek k 8. 9. 2026, ne živý dokument** (na rozdíl od `SEVERKA.md`); verdikt oponentury patří do `POSUDKY.md`, ne sem.

**`docs/SEVERKA.md`** zároveň zapracovala včerejší revizi (obsah nekontrolován do detailu v tomhle zpětném zápisu — viz soubor přímo).

**Poučení pro příště (zapsat, ne jen mlčky napravit):** i při rychlé iteraci na jednom PC platí totéž pravidlo jako při střídání počítačů — HANDOFF se píše průběžně, ne až když se o něj někdo přihlásí. Tenhle zpětný zápis je záchranná síť, ne standardní postup.

**Brány ověřeny znovu touto session po pullu:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check — všechny zelené.

## 2026-09-07 (48) — Statistiky v Přehledu: celkem/dnes/průměrný čas + graf podle typu dokumentu

**Pokyn vlastníka:** „v přehledu by měly být grafy jak si stojíme, kolik zpracováno celkem kolik to zabírá kolik zpracováno dnes a jaké agendy" — odloženo v (44), dnes dotaženo.

**Zjištění před psaním dotazů:** rozdělení podle typu dokumentu nešlo spočítat vůbec — `document.classify` má `sideEffects: none`, takže nikdy nedostal `write-intent`/`write-done` pár (ten je vyhrazený pro zápisové kapability); výsledek (`documentType`) žil jen uvnitř každé jednotlivé Durable Object instance, ne ve sdíleném D1 auditu. Vlastník zvolil **přidat audit záznam pro classify** (ne stavět dashboard bez agend).

**`recordClassifyResult()`** (nová metoda `WorkflowInstance`, volaná hned po `orchestrator.run()`): najde úspěšný krok `document.classify`, zapíše jeho výsledek do sdíleného auditu pod existující `kind: "state"` (žádný nový `AuditKind` — přidání nové hodnoty do core platform enumu by byl větší zásah, než tahle statistika potřebuje), odlišeno od instance-úrovňových `state` záznamů (RUNNING/SUCCEEDED) přítomností `capability: "document.classify"`.

**`farmStats()`**: tři SQL dotazy přímo nad sdíleným D1 (ne přes jednotlivé Durable Objecty — neškáluje se to, ale pro dnešní objem stačí): celkem zpracováno (`COUNT WHERE kind='state' AND capability IS NULL AND status='SUCCEEDED'`), dnes (totéž + `substr(at,1,10)=date('now')`, UTC den — může se lišit od CZ půlnoci o hodinu/dvě, nepřesnost zapsána, ne skryta), průměrný čas (pár RUNNING→SUCCEEDED časových razítek na `workflow_id`), rozdělení podle typu (`GROUP BY json_extract(documentType) WHERE capability='document.classify'`). **Všechny tři dotazy ověřeny přímo přes `wrangler d1 execute --remote` proti skutečné databázi před nasazením** (19 dokumentů celkem, časové rozpětí ~1–2,5 s na dokument) — typové rozdělení zatím prázdné, protože `recordClassifyResult()` je nový, poběží až pro dokumenty od tohoto nasazení dál, ne zpětně.

**UI:** tři dlaždice (Celkem/Dnes/Průměrný čas) + jednoduchý CSS sloupcový graf podle typu (žádná JS knihovna, stejná zásada jako zbytek Farmáře — server-rendered, ne aplikace).

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check.

## 2026-09-07 (47) — Matice odpovědnosti živě na `/farm` (ne jen v repu)

**Pokyn vlastníka:** „a proč to není v GUI?" — po (46) čekal, že nová matice odpovědnosti bude dostupná přímo z konzole, stejně jako `VYVOJOVY-DIAGRAM.html`.

**Řešeno identickým mechanismem jako vývojový diagram (HANDOFF 36):** nový `MATICE-ODPOVEDNOSTI.html` v kořeni repa (samostatná stránka, ne z markdownu generovaná — `docs/MATICE-ODPOVEDNOSTI.md` zůstává zdrojová verze pro vývojáře, obě se udržují ručně souběžně). `scripts/farm-config.mjs` (`generateDocsModule()`) ho čte a vkládá do `.wrangler/generated/docs.ts` vedle diagramů; ambientní typ `deploy/cloudflare/types/apf-docs.d.ts` rozšířen o `MATICE_ODPOVEDNOSTI_HTML`. Nová route `GET /MATICE-ODPOVEDNOSTI.html` na gatewayi, odkaz v menu Farmáře hned vedle „Jak to funguje".

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json` — chytilo chybějící ambientní export, opraveno), 232 testů, arch, farm:check.

## 2026-09-07 (46) — Matice odpovědnosti; potvrzeno „AI nikdy nevybírá kapability, jen klasifikuje"; univerzální vs. agendové kapability

**Nový `docs/MATICE-ODPOVEDNOSTI.md`** (vlastník: „nechybí nám matice odpovědnosti?", upřesněno na „která kapabilita/kravička odpovídá za co"): poprvé na jednom místě tabulka všech šesti dnešních kapabilit (`document.classify/validate/stamp/archive`, `mail.ingest`, `email.send`) + dvou návrhů z kroku 8b — kravička (Worker), externí systém, kdo smí volat (z policy grantů), riziková třída, lidský vstup, kam vede selhání. Poskládáno z existujících zdrojů (`descriptor.json`, `config/*/policy/*.json`, zapojení hostitelů), ne nový zdroj pravdy.

**Vlastníkův postřeh, potvrzeno a zapsáno:** kapability se dělí na **univerzální** (`classify`/`validate`/`stamp` — běží u každého dokumentu) a **agendové** (budoucí `cz.company.verify`/`cz.vat.verify` — poběží jen pro nakonfigurovaný seznam agend, ne pro každý dokument). Zapsáno i do `docs/NAVRHOVY-LIST-farma.md` u kroku 8b: seznam agend, pro které se `cz.*.verify` spouští, má být **konfigurovatelný** (`config/<instalace>/`), ne zadrátovaný v jedné workflow definici.

**Otázka vlastníka „mohla by AI sama rozhodnout, jaké agendy/kapability se pro zvláštní dokument spustí?" — zodpovězeno jasně NE, se souhlasem vlastníka.** Důvod zapsán jako princip (ne nová norma, jen zdůraznění existující): AI rozhoduje jen o `documentType` (jedna hodnota, allowlist), nikdy o tom, které kapability se dispatchují — to je vždy pevná workflow definice. Bezpečnostní důvod: kdyby AI směla dynamicky vybírat akce, injekce v neznámém dokumentu by mohla přimět AI přiřadit si nepovolené právo (např. `email.send`), místo dnešního nejhoršího důsledku (špatná nálepka typu, chycená druhým signálem/review). „Zvláštní" dokument dnes správně padá do `OTHER` → review, ne do AI-vymyšlené kombinace kroků.

**Beze změny kódu tento záznam** — jen dokumentace, žádné nasazení potřeba.

## 2026-09-07 (45) — Krok 8b rozdělen (cz.company.verify + cz.vat.verify), obojí v Kravičkách jako „Návrh"

**Vlastníkovo doplnění k dnešnímu krok 8b:** potvrdil rozdělení `cz.subject.verify` na dvě samostatné kapability — `cz.company.verify` (ARES, IČO) a `cz.vat.verify` (DPH plátcovství, nespolehlivý plátce, zveřejněný účet). Důvod zapsán do `docs/NAVRHOVY-LIST-farma.md`: jiný externí systém pro každou, `cz.company.verify` má širší použití než jen faktury, subjekt nemusí být plátce DPH (jiná sémantika „nevztahuje se" vs. selhání).

**Nové na `/farm`:** tabulka Kravičky dostala čtvrtou skupinu **„Návrh — zatím nepostaveno"** (vlastník: „do seznamu agentů dávej i nápady co mám v režimu návrh") — `PLANNED_DEPLOYABLES` v `page.ts`, ručně udržovaný seznam v souladu s návrhovým listem (ne parsovaný z markdownu), oba nové návrhy jako řádky se stavem „NÁVRH".

**Vysvětleno vlastníkovi (zapsáno, protože to není samozřejmé):** budoucí `cz.company.verify` se nespustí heuristicky nad libovolným textem, co obsahuje IČO — bude to explicitní krok ve workflow definici pro faktury, navazující na strukturované pole z `invoice.extract` (krok 8). Smlouva, co mimochodem zmíní IČO, kontrolu nespustí, protože neprochází fakturačním tokem vůbec.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check.

## 2026-09-07 (44) — Diakritika v orazítkovaném textu, DPH substring bug, „Nový dokument" jako sekce na /farm

**Tři nezávislé nálezy/požadavky ze stejné session:**

**1) Diakritika se kazila v `/workflow/:id/stamped` (vlastník, přes reálný test).** Kořen: `SingleArtifactStore.derive()` v `apf-document-host` měla výchozí `contentType = "text/plain"` **bez `charset=utf-8`** (stejně tak `SqliteArtifacts`/gateway `copyOut()`). Bez explicitního charsetu prohlížeč hádá kódování a u české diakritiky typicky uhodne špatně (UTF-8 bajty vykreslené jako Windows-1250 → „Ã¡" místo „á"). Opraveno na obou místech (`deploy/cloudflare/apf-document-host/src/index.ts`, `deploy/cloudflare/apf-gateway/src/index.ts` `copyOut()`) — vždy `text/plain; charset=utf-8`, ne holé `text/plain`.

**2) Skutečný klasifikační bug, ne teoretický: `objednavka.json` prošla jako `INVOICE` a rovnou se orazítkovala** (vlastník to našel klikáním, ne já). Příčina ověřená v kódu: JSON má pole `"celkemBezDph": 29600` — v malých písmenech `celkembezdph` obsahuje podřetězec `dph`, takže naivní `classifyByRules()` (deterministický druhý signál) řeklo INVOICE **z názvu pole**, ne z obsahu. LLM řeklo INVOICE taky (položky/množství/ceny vypadají fakturovitě). Oba signály se shodly na špatné odpovědi → nic to nezachytilo (druhý signál chrání jen před **neshodou**, ne před shodnou chybou). Horší varianta stejného jevu jako dřívější nález se smlouvou zmiňující DPH (ta aspoň skončila v review). Opraveno: `\bdph\b` (hranice slova) místo holého podřetězce v `src/adapters/llm.ts`. Neopravuje obecný problém (shodná chyba obou signálů), jen tenhle konkrétní, potvrzený případ.

**3) „Nový dokument" byl odkaz pryč ze `/farm` na jinou stránku (`/`), ne sekce jako ostatní čtyři (vlastník: „na přidávání je samostatná sekce, ne?").** Přesunuto: pátá karta v hash-routovaném menu (`#novy`, `VIEWS` pole v klientském JS), formulář identický s `renderHome()` (soubor/text/tok/model/text razítka → `POST /intake`), jen v bankovním vizuálu — přidána CSS pro `label/textarea/select/input/button` pod `.p-form` (banka dosud řešila jen tabulky a tlačítka, ne formulářová pole). Tlačítko „Nový dokument" v Přehledu teď vede na `#novy`, ne na `/`.

**Odloženo, vlastníkovy další požadavky ve frontě (ne v tomhle záznamu):** grafy/statistiky v Přehledu (kolik zpracováno celkem/dnes, jaké typy dokumentů, čas zpracování) — potřebuje nové agregační dotazy nad D1 a rozhodnutí o způsobu vykreslení (žádná externí knihovna, banka dnes nemá graf komponentu); přepínač CS/EN na `/farm` — celé UI je dnes jen česky, překlad je samostatná větší práce. Obojí zapsáno, nezačato.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů (žádný netestoval starý substring chybně, DPH fix nic nerozbil), arch, farm:check.

## 2026-09-07 (43) — Odkaz na vizuální razítko jen když razítko doopravdy proběhlo; popisky sekcí na /farm

**Nález (vlastník, přes reálné klikání):** stránka instance nabízela odkaz „zobrazit vizuálně orazítkovaný originál" **vždycky**, i u dokumentů, co se k `document.stamp` vůbec nedostaly (čekají na review — `CLASSIFICATION_DISPUTED`/`STAMP_NOT_ALLOWED`, což je dnes většina testovacích dokumentů). Klik vždy skončil `404` se třemi možnými důvody smíchanými do jedné věty — nešlo poznat skutečnou chybu od úplně normálního „ještě nebylo orazítkováno".

**Oprava:**
- `page.ts`: odkaz na vizuální razítko se teď zobrazí **jen** když poslední `document.stamp` krok má stav `SUCCEEDED` (`stampSucceeded`, čte se stejně jako u řádku „Razítko").
- `index.ts` (`/workflow/:id/original-stamped`): rozlišuje teď dva různé stavy místo jedné hlášky — (1) `document.stamp` vůbec neuspěl (`stampStepStatus` v odpovědi řekne přesně jaký je/byl stav) → jasná zpráva „ještě není co orazítkovat vizuálně"; (2) `document.stamp` uspěl, ale vizuální kopie v R2 chybí → skutečná diagnóza (buď ještě dopisuje `waitUntil`, nebo typ souboru nemá recept ve `visual-stamp.ts`).
- **Popisky sekcí na `/farm`** (vlastník: „chybí popisky, jinak se neví co to dělá" — musel se zeptat na rozdíl Poslední instance vs. Deník slovně): každá ze tří technických sekcí (Kravičky, Poslední instance, Deník) dostala jednořádkový popis pod nadpis, stejným tónem jako dřívější popisy rolí u kraviček.

**Vedlejší ověření živě:** PNG (`faktura_pdf_tisk_vzor_510.png`), co poprvé spadlo na `EXTRACTION_FAILED`, po „Zkusit znovu" prošlo extrakcí (byla to přechodná chyba Workers AI, ne vadný soubor) — teď visí na `CLASSIFICATION_DISPUTED` (stejný nález jako u `smlouva-kupni.pdf`: text zmiňuje DPH i smluvní náležitosti zároveň). Retry tlačítko z (42) tedy funguje přesně jak má.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check.

## 2026-09-07 (42) — Vizuální razítko (PDF + obrázky), inbox nesmí zablokovat jeden na druhém, tabulky místo počtů, návrh krok 8b

**Čtyři věci v jednom nasazení, vlastníkovy pokyny za sebou ve stejné session:**

**1) Vizuální razítko na originál — additivní, „vedle sebe" s dnešním textovým zápisem do DMS (vlastníkovo rozhodnutí, ne nahrazení).** Reálný přiklad z praxe („účetní vezme fakturu, napíše na ni razítko/poznámku a pak to dá scanovat") — teď dělá systém totéž digitálně. Nový modul `visual-stamp.ts`:
- **PDF** → `pdf-lib` (čistý JS, žádné nativní závislosti), červený rámeček + text (ZPRACOVANO, čas, ref) natočený -8°, **na každou stránku** (vlastník: „je to informace o zpracování systémem", ne jen titulní).
- **JPG/PNG** → Cloudflare `IMAGES` binding: **`.text()` umí renderovat text nativně** (žádná WASM knihovna typu resvg-wasm potřeba, ověřeno v aktuální dokumentaci), `.draw()` ho složí na originál. Kompromis: `ImageDrawOptions` nemá `rotate`, takže razítko na obrázku je rovné, ne natočené jako u PDF. Font: veřejná Google Fonts URL (`fonts.gstatic.com`, content-hash, ověřeno že nevyprší) — **ne literál v kódu**, `arch-dep.mjs` to správně odchytil jako "public hostname"; opraveno přes `config/<instalace>/farm.json` → `apf-gateway.vars.STAMP_FONT_URL` (nový `config/local-fakes/farm.json`, dřív neexistoval).
- Spouští se v `WorkflowInstance.intake()` přes `ctx.waitUntil()` hned po úspěšném `document.stamp`, píše do `stamped-visual/<tenant>/<sha256>` (originál sám zůstává nedotčen). Nová route `GET /workflow/:id/original-stamped`, odkaz na stránce instance vedle „zobrazit originál".
- Design ověřen napřed na skutečných testdokumentech mimo Worker (lokální `pdf-lib`/Pillow skripty ve scratchpadu), teprve po vlastníkově schválení vzhledu zapojeno do ostrého kódu.

**2) Dávkové zpracování: jeden vadný soubor nesmí zablokovat zbytek dávky (vlastníkův požadavek).** `processInbox()` neměl try/catch kolem těla smyčky — výjimka (ne jen normální `{ok:false}` výsledek) by vyhodila ven z `for` a **nechala nezpracované všechny soubory za tím, co spadl**, navíc by vadný soubor zůstal v `inbox/` a při příštím běhu cronu spadl znovu se stejným efektem. Opraveno: každý soubor ve vlastním try/catch, i neočekávaná výjimka teď skončí přesunem do `inbox/failed/` (`reason: UNEXPECTED_ERROR`) a smyčka pokračuje na další soubor.

**3) `/farm` ukazuje skutečné soubory, ne jen počty (vlastník: „inbox mi chybí na zobrazení a /failed také").** Nová `inboxDetail()` (nahrazuje `inboxStats`) vrací pole souborů, ne jen čísla. Panel „Dávkový příjem" teď má dvě tabulky: čekající (jméno, velikost, čas nahrání) a selhané (jméno, velikost, důvod + zpráva, tlačítko **„Zkusit znovu"** — nová route `POST /farm/inbox/retry`, přesune soubor zpět do `inbox/` pod čerstvým klíčem).

**4) Návrh krok 8b zapsán do `docs/NAVRHOVY-LIST-farma.md` (jen plán, žádný kód):** vlastníkův detailní návrh polí `invoice.v1` s provenancí per pole (`value/confidence/sourcePage/sourceBoundingBox/normalizedValue/validationStatus`, stejný vzor jako dnešní `FieldValue<T>`) a **samostatná capability `cz.subject.verify`** (nebo `cz.company.verify`/`cz.vat.verify`) ověřující IČO/DIČ/plátcovství DPH/nespolehlivého plátce/zveřejněný bankovní účet proti ARES a Finanční správě — vlastníkovo zdůvodnění „určitě bych to nemíchal do OCR/extraction agenta, je to deterministický kontrolní worker, ne volná úvaha AI" zapsáno doslovně. **Needs verification**, než se začne psát kód: přesný název/kontrakt webové služby Finanční správy pro SW třetích stran.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch (font URL teď čistý), farm:check. Ověřeno `wrangler dev` (local-fakes): `/farm` s novými tabulkami vykresluje bez pádu; `document.stamp` v samostatném gatewayi bez `apf-fakes`/`apf-document-host` logicky nedoběhne (DEPENDENCY_UNAVAILABLE už na validate) — vizuální razítko end-to-end ověřeno až přímo na farmě po nasazení.

## 2026-09-07 (41) — Název souboru a skutečný vizuál originálu na stránce instance

**Pokyn vlastníka:** po (40) nahrál přes nový upload 10 skutečných testovacích dokumentů (PDF, JPG, PNG, JSON, XML, TXT — faktury, smlouva, účtenka, záruční list, návod, lístek ze šatny, poznámka). Zeptal se „proč to nevidím v konzoli" a upřesnil na screenshotu z `/farm`: chybí název souboru (nejde poznat, který řádek je který dokument) a chybí možnost vidět skutečný vizuál dokladu (jen vytěžený text).

**Zjištění před opravou:** originální název souboru se nikdy neukládal — `startIntake()`/`intake()` ho měly k dispozici (`Original.name` u binárního vstupu), ale `SqliteArtifacts.putExternal()` ho na zápisu do SQLite tiše zahazovalo, nebyl ani sloupec v DDL.

**Oprava:**
- `src/platform/artifacts.ts`: `Artifact` dostal `name?: string` (display-only, nikdy součást identity/hashe).
- `deploy/cloudflare/apf-gateway/src/store.ts`: DDL `artifact` tabulky dostal sloupec `name`; `ExternalOriginal`, `putExternal()`, `store()` (INSERT) a `rowToArtifact()` ho nesou. Žádná migrace: každá `WorkflowInstance` DO má vlastní čerstvou SQLite databázi (`CREATE TABLE IF NOT EXISTS` v konstruktoru), takže nový sloupec dostanou automaticky všechny instance od teď — staré instance beze změny (u nich jméno nikdy nebylo, nedá se dodělat zpětně).
- `index.ts`: `intake()` teď posílá `name: o.name` do `putExternal()`.
- **Nová route `GET /workflow/:id/original`** (stejný vzor jako `/stamped` z (37)): najde nederivovaný artefakt instance, přečte bajty přímo z R2 (`location`) a vrátí je se správným `content-type` — prohlížeč tedy PDF/obrázek zobrazí doopravdy, ne jen text, co z něj vytáhla Workers AI.
- `page.ts`: řádek „Vstup" na stránce instance teď ukazuje `<b>název-souboru.pdf</b>` a odkaz „zobrazit originál" (jen když má artefakt `location`, tj. binární vstup). Group-head řádek v tabulce „Poslední instance" na `/farm` dostal stejné jméno na začátek řádku (`farmRowOf()` v `index.ts` čte `view.artifacts` navíc o `originalName`).

**Vedlejší nález, zapsán ale zatím neřešen (na vlastníkovo přání „schválit/zamítnout"):** `ReviewService` (kam padají čekající review úkoly, `STAMP_NOT_ALLOWED`/`CLASSIFICATION_DISPUTED`) drží úkoly jen v paměti (`Map`), ne v Durable Objectu úložišti. Po evikci objektu (běžné, ne okrajový případ) by `decide()` skončilo `APPROVAL_MISMATCH`, protože si úkol nepamatuje. Tlačítko schválit/zamítnout se **proto staví jako samostatný příští krok**, ne dnes — nejdřív potřebuje `ReviewTask` přežít v SQLite DO, ne jen v paměti. Vlastník souhlasil s tímhle pořadím.

**Živě ověřeno (vlastníkův test i vlastní):** z 10 nahraných dokumentů 6× `INVOICE` úspěšně orazítkováno, 4× `OTHER` správně zastaveno `STAMP_NOT_ALLOWED` (čeká na review), 1× (`smlouva-kupni.pdf`) reálný `CLASSIFICATION_DISPUTED` — AI řekl `CONTRACT` správně, deterministické pravidlo (`classifyByRules`) řeklo `INVOICE`, protože text smlouvy obsahoval slovo „DPH" (cenová doložka) a pravidlo kontroluje faktura-klíčová slova dřív než smlouva-klíčová. Zapsáno jako otevřený nález (ne opraveno) — vlastníkovi zbývá rozhodnout, jestli se pravidlo má zpřesnit.

**Ověřeno přes `wrangler dev`:** reálné PDF nahráno přes `/intake`, stránka instance ukázala `<b>faktura-tshydro.pdf</b>` a `/workflow/:id/original` vrátil přesně 1207 B `application/pdf` (shoda s originálem byte-for-byte podle Content-Length).

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check.

## 2026-09-07 (40) — Upload do inboxu přímo na `/farm`, ne přes Cloudflare dashboard

**Pokyn vlastníka:** po (39) zjistil, že popis „nahraj do Cloudflare R2" znamená doopravdy otevřít cizí dashboard — „ale já to potřebuji u farmáře a ne na Cloudflare". Ověřeno mezitím i to, že farma (`/version`) už běžela na `gitSha 8488422`, tedy dávkový příjem z (39) byl mezitím nasazen (nejspíš druhým PC) beze samostatného HANDOFF záznamu o nasazení.

**Řešení:** nová route `POST /farm/inbox` na gatewayi — vezme jeden nebo víc souborů (`<input type=file name=files multiple>`), pro každý zapíše bajty přímo do stejného R2 prefixu `inbox/` (klíč `inbox/<newId>-<sanitizovaný název>`, `sanitizeInboxName()` odstraní `/`/`\` ať název souboru neuteče z prefixu) a přesměruje zpět na `/farm`. **Žádná nová pipeline** — je to jen druhé, přívětivější místo, odkud se dá zapsat do přesně téhož inboxu, který stejně jako dřív sbírá `processInbox()`/Cron Trigger každých 5 minut; oversized soubor (nad `MAX_UPLOAD_BYTES`, stejný limit jako `/intake`) se tiše přeskočí, ne zařadí rozbitý. Formulář přidán přímo do panelu „Dávkový příjem (inbox)" na `/farm` (`page.ts`), odkaz na Cloudflare dashboard zůstal jako druhá, rovnocenná cesta pod ním.

**Vedlejší zjištění zapsáno vlastníkovi (ne W-položka, jde o produkt, ne o normu):** ověřeno v kódu, že `documentType` je dnes jen nálepka ze tří hodnot (`INVOICE`/`CONTRACT`/`OTHER`) a **faktura i smlouva jdou přes identický `classify → validate → stamp`** — testovací registr jim dokonce vrací stejnou dobu úschovy. Žádný „předpis" (jaká pole/pravidla se mají u které typu kontrolovat) v kódu není, ani navržený — rozpracovaný krok 8 pokrývá jen faktury (EN 16931). Otevřeno na vlastníkovi, zatím nezařazeno do pořadí.

**Vlastníkův předpoklad do budoucna (zapsáno, mimo rozsah dneška):** cílové úložiště orazítkovaných/archivovaných dokumentů má být skutečný DMS (např. M-Files) nebo jiné úložiště, ne `apf-fakes` dvojník. Adaptérová hranice (`HttpDmsAdapter`/`HttpArchiveAdapter`, `src/adapters/dms.ts`/`archive.ts`) je přesně pro tuhle výměnu stavěná — až přijde na řadu, mění se jen implementace adaptéru, ne tok.

**Ověřeno živě přes `wrangler dev` (local-fakes):** `POST /farm/inbox` s reálným multipart uploadem → `303` na `/farm#view-prehled` → čítač „čeká" naskočil z 0 na 1. Zbytek (cron vyzvedne soubor z inboxu) je beze změny, už otestovaný a na farmě ověřený mechanismus z (39).

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check.

## 2026-09-07 (39) — Dávkový příjem: R2 „inbox" + Cron Trigger každých 5 minut

**Pokyn vlastníka:** „chtěl bych nastavení kde bude adresář odkud se bude dávkově čerpat dokumenty... a to nastavení mi tam furt chybí." Workers nemají žádný přístup k lokálnímu adresáři na disku — probrány dvě reálné varianty (lokální skript vs. R2 „inbox" + Cron), vybráno **R2 + Cron**.

**Jak to funguje:** `inbox/` je prefix ve **stejném** R2 bucketu (`apf-artifacts`), co už drží originály a derivace — žádný nový binding. Nahrává se přímo z Cloudflare dashboardu (R2 → `apf-artifacts` → `inbox/`, drag-and-drop v prohlížeči), žádný S3 nástroj není potřeba. Cron Trigger (`*/5 * * * *`, na Free plánu do 3 triggerů na Worker, ověřeno skillem než se psal kód) spustí `scheduled()`, ten zavolá `processInbox()`: vezme až 10 souborů na běh, pro každý stejnou cestou jako webový formulář (`startIntake()` — vytažená sdílená logika, ne druhá kopie), a podle výsledku buď smaže z inboxu (skutečný originál už leží pod `originals/…`, tohle byl jen drop-off), nebo přesune do `inbox/failed/<jméno>` s důvodem v metadatech — ať se rozbitý soubor nezkouší dokola donekonečna a nemlátí zbytečně do Workers AI.

**Refaktor:** `/intake` HTTP handler i `scheduled()` teď volají stejnou `startIntake()` — dřív by druhá cesta znamenala kopii pěti kontrol (kill switch, neznámý tok, model, extrakce, limit délky) s rizikem, že se rozjedou.

**Farmář:** nová sekce v Přehledu — kolik čeká v inboxu, kolik selhalo (červeně, s návodem), kde nahrávat, jak často se to kontroluje.

**Vedlejší úkol:** vygenerováno 25 testovacích dokumentů (20 faktur — plátce/neplátce DPH, 1/3/4 položky —, 3 kupní smlouvy, 2 milostné dopisy jako negativní test klasifikátoru) do scratchpadu pro ruční i dávkové testování.

**Brány zelené:** typecheck, 232 testů, arch, farm:check (dry-run přes nový `triggers.crons` prošel). **Zatím nenasazeno na farmu** — commit proveden na pokyn vlastníka uprostřed práce, nasazení a živé ověření cronu (vyžaduje počkat na propagaci, až 15 min) je další krok.

## 2026-09-07 (38) — Kravičky lhaly o archivaci: „archivuje" tvrdilo něco, co se v toku nikdy nevolá

**Pokyn vlastníka:** „apf-fakes píšeš že doklady archivuje" + „a že je OK" — postřeh nad popisem `apf-document-host` v tabulce Kravičky.

**Ověřeno přímo v `workflows/document-intake.v1.json`:** kroky jsou jen `classify → validate → stamp`. **`document.archive` tam vůbec není.** Existuje jako druhá schopnost sdíleného hostu jen kvůli testu izolace (`SEC-HOST-001`, dva handlery se dvěma credentialy v jednom hostu) — v běžném zpracování dokumentu se nikdy nezavolá. Popis „Orazítkuje a archivuje dokument po ověření" tedy netvrdil jen nepřesnost, tvrdil něco, co se prakticky neděje.

**Vlastníkova doplňující otázka „a někam to zapisuje data, ne?":** ano, částečně opravdu — originál i orazítkovaný text se skutečně a trvale zapisují do R2 (Cloudflare úložiště, ne naoko). Ale **potvrzení „DMS"** je od `apf-fakes` (testovací dvojník), žádné napojení na reálný firemní DMS/ERP neexistuje.

**Opraveno:** text u `apf-document-host` teď říká přesně tohle — zapisuje proti testovacímu dvojníku, `document.archive` umí, ale nevolá se. Text u `apf-fakes` doplněn o vysvětlení, co jeho „OK" vlastně znamená (dvojník odpovídá, ne že je napojený skutečný systém) a jeho badge teď píše rovnou **„OK (dvojník)"**, ne holé OK — aby to nešlo přečíst jako „hotovo naostro" ani mimo kontext řádku.

**Brány zelené:** typecheck, 232 testů, arch, farm:check (cestou padla chyba — rovné uvozovky uvnitř řetězce ohraničeného rovnými uvozovkami rozbily parser; opraveno na české „…“). Nasazeno na `farm-bass443`.

## 2026-09-07 (37) — Nová route `/workflow/:id/stamped`: orazítkovaný text šel vidět jen jako ID, ne obsah

**Pokyn vlastníka:** „je možno vidět dokument? co jsme zpracovali?" → „ideálně orazítkovaný". Dosud šlo přečíst jen vytěžený text originálu (`renderOutput`), samotný **orazítkovaný artefakt** byl na stránce vidět jen jako `stampedArtifactId`/`stampedSha256` — ID bez obsahu.

**Proč to nebylo triviální:** bajty orazítkovaného artefaktu se v odpovědi `/dispatch` vůbec nevrací (`payloadFor()` v `stamp-handler.ts` nese jen id a hash), protože `apf-document-host` je od (25)/(29) samostatný vzdálený Worker (celek D2) — svůj `SingleArtifactStore.derive()` zapisuje bajty rovnou do R2 pod klíč `derived/<tenantId>/<sha256>`, asynchronně (`ctx.waitUntil`). Gateway ho tedy nikdy neuvidí přes journal ani audit, jen přes tenhle vedlejší R2 zápis — a instance's `artifacts[]` (co ukazuje `renderInstance`) orazítkovaný artefakt vůbec neobsahuje, protože ho nikdy nezaevidoval do vlastní SQLite.

**Řešení:** nová route `GET /workflow/:id/stamped` na gatewayi — najde poslední úspěšný krok `document.stamp`, vezme `stampedSha256` z jeho výsledku a `tenantId` instance, sestaví stejný R2 klíč (`derived/<tenant>/<sha>`) a přečte objekt přímo (stejný bucket `apf-artifacts`, žádná cesta přes document-host navíc). Odkaz „zobrazit orazítkovaný text" přidán do řádku Razítko na stránce instance.

**Důležité očekávání, řečeno nahlas vlastníkovi:** je to **text**, ne vizuálně orazítkované PDF. `document.stamp` v tomhle referenčním řezu pracuje nad vytěženým markdown textem (ne nad binárními bajty PDF), fake DMS vrátí text s vloženým řádkem `--- STAMPED ... ---`. Skutečné vizuální razítko na PDF by byla samostatná, mnohem větší práce (renderování/manipulace PDF), mimo dnešní rozsah.

**Brány zelené:** typecheck, 232 testů, arch, farm:check. Nasazeno na `farm-bass443`.

## 2026-09-07 (36) — `VYVOJOVY-DIAGRAM.html` živě na farmě (`apf:docs`), ne jen v repu

**Pokyn vlastníka:** proč znovu vysvětlovat architekturu (gateway volá hostitele) do chatu, když `VYVOJOVY-DIAGRAM.html` už tohle přesně kreslí — a schválil, ať ho `/farm` nabídne přímo.

**Metafora k zapsání (vlastníkova, přesnější než moje předchozí):** farmář = mozek s AI (gateway + klasifikace), kravičky = hloupí jednoúčeloví roboti (document-host, email-executor, mail-ingest — každý dělá jednu mechanickou věc), kontrolní mechanismy = hlídací psi (router permission chain, druhý signál validátoru, idempotency, audit — hlídají a štěkají, když něco nesedí).

**Jak je to zapojené:** soubor `VYVOJOVY-DIAGRAM.html`/`.en.html` v kořeni repa **není instalačně vázaný** (stejný obsah pro každou instalaci) a je moc velký na to, aby se ručně kopíroval do zdrojáku jako řetězec (riziko rozjetí, stejné jako u banky z (30)). Řešeno stejným životním cyklem jako `apf:installation`: `scripts/farm-config.mjs` dostal `generateDocsModule()`, který při každé generaci configu (= při každém nasazení) přečte oba soubory z kořene repa a zapíše `.wrangler/generated/docs.ts`; nový alias `apf:docs` (jen pro `apf-gateway`, ostatní deployables ho nepotřebují) na něj ukazuje. Ambientní typ `deploy/cloudflare/types/apf-docs.d.ts` podle vzoru `apf-installation.d.ts`. Nové routy `GET /VYVOJOVY-DIAGRAM.html` a `.en.html` na gatewayi, odkaz „Jak to funguje" přidán do menu Farmáře i na domovskou stránku.

**Brány zelené:** typecheck, 232 testů, arch, `farm:check` (dry-run i přes nový alias), ověřeno živě přes `wrangler dev` (skutečný obsah, 35 771 B, ne prázdná stránka). Nasazeno na `farm-bass443`.

## 2026-09-07 (35) — Kravičky: „OK" muselo znamenat i zapojeno, ne jen živé; gateway odděleně od hostitelů

**Dva ostré postřehy vlastníka nad stejnou tabulkou:**
1. „jak může být zatím nezapojeno do toku ve stavu OK?" — `apf-mail-ingest`/`apf-email-executor` odpovídají na `/version` (HTTP 200 → `d.ok = true`), ale jejich vlastní tělo hlásí `wired: false` (skeleton). Barva stavu vycházela jen z HTTP odpovědi, ne z obsahu — takže „OK" lhalo o tom, co slovo běžně znamená.
2. „vypadá to graficky, že apf-gateway je na stejné úrovni jako ostatní, ne?" — plochá tabulka pěti řádků neříkala nic o tom, že gateway těch čtyři ostatní **volá**, není jejich vrstevník.

**Opraveno:** `workerReady()`/`workerStateLabel()` — stav teď zohledňuje obojí (dosažitelnost i `wired`); nezapojený, ale živý Worker dostane žlutý badge **NEZAPOJENO**, ne zelené OK. Součet „X/Y Workerů OK" v hlavičce/toolbaru teď taky počítá jen skutečně zapojené. Tabulka Kravičky rozdělena na tři skupiny se záhlavím (`group-head`, stejný vzor jako u seskupených kroků instance): „Řídí tok" (gateway sám), „Hostitelé, které gateway volá" (document-host, email-executor, mail-ingest), „Testovací dvojník" (fakes).

**Brány zelené:** typecheck, 232 testů, arch, farm:check. Nasazeno na `farm-bass443`.

## 2026-09-07 (34) — `/farm`: syrový JSON pryč z výchozího pohledu, text se zalamuje

**Pokyn vlastníka:** „vůbec nevím o co tady jde. ani text to nemá zalomený" (Poslední instance i Deník) a „`/audit.json` nevím k čemu je". Tabulky (bank `.p-table`) mají záměrně `white-space:nowrap` + výpustku pro hustá tabulková data — u buněk s výsledkem kroku a detailem auditu to ale znamenalo, že syrový `JSON.stringify` zmizel mimo obrazovku beze stopy.

**Oprava — dvě věci:**
1. **Lidský překlad namísto syrového JSON.** Nové `humanStepResult()` (Poslední instance) a `auditSummary()` (Deník) překládají známé capability/druhy auditu do věty („typ: FAKTURA, jistota 0.9", „zápis dokončen SUCCEEDED", „čeká na schválení…"). Neznámý tvar padá do `rawJson()` — sbalené `<details>`, ne vnucené na očích.
2. **Buňky s výsledkem/detailem teď zalamují** (`td.wrap` přebíjí bankovní `nowrap` vyšší specificitou), rozbalený JSON má `pre.wrap` s `word-break`.

**`/audit.json` odstraněn z bočního menu Farmáře** — byl to matoucí odkaz na syrová data bez vysvětlení; Deník teď pokrývá totéž čitelně. Route `/audit.json` samotná zůstává (programový přístup), jen se v UI neproduje jako cíl navigace.

**Brány zelené:** typecheck, 232 testů, arch, farm:check. Nasazeno na `farm-bass443`.

## 2026-09-07 (33) — Kravičky v `/farm`: k čemu který Worker vlastně je

**Pokyn vlastníka:** u tabulky Kravičky „vůbec nevím co jednotlivé kravičky dělají" — stav (OK/DOWN), izolace (`LOGICAL`/`PRINCIPAL`) a syrový detail (`not wired`, seznam capabilities) nikde neříkaly, jakou roli daný Worker v toku hraje.

**Oprava:** pod jméno každého Workeru přidán jednořádkový lidský popis role (`apf-gateway` „Přijme dokument, rozpozná typ (AI) a řídí celý průběh", `apf-document-host` „Orazítkuje a archivuje…", `apf-fakes` „Testovací dvojník DMS/registru/archivu…" atd.). Sloupec `Isolation` přejmenován na „Izolace" s lidským popiskem místo holého `LOGICAL`/`PRINCIPAL` (hover vysvětlí rozdíl), `not wired` česky jako „zatím nezapojeno do toku", seznam capabilities uvozen „umí:".

**Brány zelené:** typecheck, 232 testů, arch, farm:check. Nasazeno na `farm-bass443`.

## 2026-09-07 (32) — Dokumentace aktualizovaná na aktuální stav (232 testů, 6 posudků, D2/W23/Farmář); nový manažerský výstup

**Pokyn vlastníka:** aktualizovat veškerou dokumentaci (HANDOFF, STATUS, vývojový diagram, ostatní) a vytvořit jednostránkový manažerský výstup pro vedení.

**STATUS.html + STATUS.en.html:** byly stale od cca HANDOFF (19) — chyběl D2 (dokončen 6. 9., před touto session), natož dnešní práce. Doplněno: stav „M4b farma živě" místo „M1–M4 hotové, bez cloudu"; počet posudků opraven z pěti na **šest** (Posudek 6 = ověření staršího nálezu, ne nový); KPI 230→232 testů; nové položky v Hotové (D2, jméno Erwin + `docs/SEVERKA.md`, W23 nález a oprava, stránka Farmář); přepracovaný seznam Zbývá podle aktuálního pořadí z (27) (retence → formáty faktur → e-mail → harness → fronta → pentest → reálný model → …).

**README.md/README.cs.md:** mlčely o tom, že dokumentový tok běží živě na Cloudflare (čtenář by si myslel, že je to pořád jen lokální fakes). Doplněna věta + odkaz na `/farm`. Počet testů opraven.

**docs/ARCHITECTURE.md:** nové odstavce o celku D2 (vzdálený host jako skutečný Worker, přednačtení artefaktu, distribuce veřejného klíče), o W23 (spolehlivost cross-Worker auditu, `RelayAudit.flush()`) a o `/farm` jako operátorském pohledu nad DO a D1.

**docs/SHODA-NIS2-ISO27001.md:** tenhle dokument se má aktualizovat s každým celkem (vlastní pravidlo v úvodu), a nebyl. W23 je přímo v oblasti „Logování a audit" — zapsáno jako nalezeno a opraveno, ne jako nová mezera. Řádek o kryptografii opraven: hosty **už** veřejný klíč dostávají (D2 hotovo), předtím psal opak. Počet testů opraven.

**VYVOJOVY-DIAGRAM.html/.en.html:** prošlo beze změny — diagram popisuje cestu příkazu bezpečnostním řetězcem a běh workflow, obojí se dnešní prací nezměnilo (žádná nová capability, žádný nový krok, žádný nový konec toku).

**Nový `docs/MANAZERSKY-VYSTUP.html`:** jednostránkový, tiskově čistý A4-na-výšku přehled pro vedení společnosti, bez žargonu. Čtyřkrokové schéma (příjem → AI rozpozná → nezávislá kontrola → zápis), proč to má smysl, bezpečnostní záruky v lidské řeči, „kde jsme dnes" **poctivě jako pilot** (živě běží, ověřeno jednou reálnou fakturou, ale ne ještě plný objem — e-mail a pentest v přípravě), další kroky. Žádné číslo v něm není vymyšlené nad rámec toho, co je doložené v STATUS/HANDOFF.

**Brány:** beze změny kódu tento záznam, jen dokumentace — typecheck/testy/arch/farm:check se od (31) neměnily.

## 2026-09-07 (31) — `/farm`: sekce jako přepínané panely (ne jedna rolovací stránka) + rail toggle

**Pokyn vlastníka:** čekal, že položky bočního menu ((30) je udělalo jako kotvy `#kravicky` atd. na jedné dlouhé stránce) otevřou obsah **vedle** menu, menu zůstává. Zmínil i možnost sbalit menu do úzkého režimu.

**Oprava:** čtyři sekce (`view-prehled`, `view-kravicky`, `view-instance`, `view-denik`) jsou teď samostatné `<div>` v `.p-main`, přepínané přes `hidden` atribut (banka ho už stylovala — `.ui [hidden]{display:none!important}`). Malý vanilla JS (žádný framework, žádné CDN) čte `location.hash`, ukáže odpovídající sekci, nastaví `aria-current` na aktivní položce menu; poslouchá `hashchange`, takže funguje i tlačítko zpět v prohlížeči. Bez JS zůstane vidět jen Přehled — přijatelná degradace pro interní nástroj.

**Sbalit menu:** banka už měla hotové `data-layout="rail"` (úzký 44px panel, jen ikony). Přidáno tlačítko (☰) v titulní liště, přepíná `data-layout` mezi `side-nav`/`rail` a pamatuje si volbu v `localStorage`. Položky menu dostaly jednoduché tahové SVG ikony (2×2 mřížka, stoh, seznam, hodiny…) podle §6 předpisu — bez nich by v rail režimu zbyly prázdné řádky.

**Brány zelené:** typecheck, 232 testů, arch, farm:check, vizuálně ověřeno přes `wrangler dev` + curl (4 view kontejnery, script přítomen). Nasazeno na `farm-bass443`.

## 2026-09-07 (30) — `/farm` na banku Interface-Par (saas-modern · side-nav) + deník

**Pokyn vlastníka:** vložil závazný předpis vzhledu (`saas-modern` · `side-nav`) z vlastního katalogu `Anamax443/Interface-Par` a požádal, ať `/farm` použije tenhle vzhled a přidá zobrazení deníku (sdíleného auditu).

**Zdroj vzhledu:** `D:\git\Interface-Par\bank\ui.css` (vrstva komponent, sdílená napříč styly) + `bank/tokens/style/saas-modern.css` (tokeny stylu) okopírované doslovně do nového `deploy/cloudflare/apf-gateway/src/bank.ts` — komentář u nich odkazuje na zdroj a na to, že se needitují ručně (přegenerovat odsud, kdyby se styl v katalogu změnil). Samotný předpis uložen jako `docs/UI/predpis-saas-modern-side-nav.txt`.

**Vědomé zjednodušení, řečeno nahlas:** `bank/fonts.css` (vendorované woff2 Inter/Cascadia Mono) se **nekopíroval**. `/farm` je nástroj pro jednoho operátora na jednom Windows PC — tokeny stylu už mají jako fallback `"Segoe UI Variable Text","Segoe UI",system-ui`, což je na Windows dost blízko Inter. Kdyby se to přestalo hodit (jiný operátor, jiný OS), doplnit `vendor/fonts/` a `fonts.css` podle předpisu.

**Nová stránka `/farm`:** vlastní HTML wrapper (ne `shell()` — jiný vizuální jazyk než zbytek gatewaye), `.ui[data-layout="side-nav"][data-style="saas-modern"]`, boční menu s kotvami na čtyři sekce jedné stránky (Přehled, Kravičky, Poslední instance, Deník — žádné klientské routování, jen `#kotvy`). Stav (Worker OK/DOWN, krok SUCCEEDED/FAILED/…) jde přes `.p-state`/`.p-dot` a třídy `st-ok`/`st-warn`/`st-crit`/`st-man`, ne barvou natvrdo — podle §8 předpisu „stav nese barvu i slovo".

**Nová sekce „Deník":** sdílený audit (D1 `audit` tabulka) — stejný zdroj jako `/audit.json`, teď čitelně v tabulce (čas, druh, instance, capability, detail), posledních 50 záznamů napříč celou farmou, ne jen jednou instancí.

**Poslední instance:** zůstává detail kroků z (29), jen přeskládaný do seskupených řádků tabulky (`group-head` řádek s odkazem/tenantem/stavem, pak řádek na krok) místo samostatných karet.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json`), 232 testů, arch, farm:check. Ověřeno i vizuálně přes `wrangler dev` + curl (local-fakes, prázdná data — žádný pád, čistý markup). Nasazeno na `farm-bass443`, kde uvidí operátor plná data (5 Workerů, reálné instance, deník).

## 2026-09-07 (29) — W23 ověřeno naživo (s důležitou nuancí o „Canceled"); `/farm` rozšířen o detail kroků z DO

**Živé ověření W23:** vlastník poslal nový testovací dokument přes `/`. Nová instance (`wf-mtr4okum...`) má v `/audit.json` **kompletní** trojici `dispatch`/`write-intent`/`write-done` pro `document.stamp`, časově plynule navazující až po `state: SUCCEEDED`. Na straně `apf-document-host` `wrangler tail` ukázal `/dispatch done ... status=SUCCEEDED (158ms)` **bez jediného `console.error`** z `RelayAudit`, což je možné jen když `flush()` čekal na všechny tři relaye a všechny odpověděly `res.ok`.

**Důležitá nuance, zapsat pro příště:** `wrangler tail` na `apf-gateway` **pořád** hlásí ty samé tři `POST .../audit` jako `Canceled` — i po opravě, i když data v D1 jsou teď prokazatelně kompletní a správná. `Canceled` v tail logu je tedy **kosmetika tail streamu, ne signál o ztrátě dat** — přesně tak, jak to (25) nechávalo otevřené jako otázku. Skutečný signál spolehlivosti je vždy obsah `/audit.json`, ne stav v `wrangler tail`. (Bonus pozorování: stejná trojice, co chyběla u prvního testu z 09:34, se mezitím sama doplnila do D1 s dodatečným zpožděním ~167 ms — což naznačuje, že `waitUntil` samo o sobě požadavek nezahazovalo hned, jen nezaručeně pozdě/nikdy; `flush()` teď dělá totéž zaručeně a synchronně vůči odpovědi.)

**`/farm` rozšířen** (na přání vlastníka: „bylo by dobré pokud by stránka obsahovala detailnější procesní kroky"): místo jednoho řádku se stavem teď každá z posledních 15 instancí ukazuje celou tabulku kroků (`stepsTable()`, sdílený helper se stránkou jedné instance) — capability, stav, pokus, výsledek. Zdroj je teď Durable Object (`stub.view()`), ne jen poslední D1 audit řádek, protože `steps[]` v D1 vůbec není. D1 se používá jen k rychlému výběru posledních `workflow_id` (`SELECT ... GROUP BY workflow_id`). Purgnutá instance ukáže badge `PURGED` místo pádu.

**Nález mimo normu (ne W-položka, jen poznámka pro příště):** `stub.view()` (RPC na Durable Object) má návratový typ `InstanceView | null` deklarovaný na třídě, ale přes RPC stub se TypeScriptu union s `null` sesype na holé `null` — `never` po `if (!view)` větvi. Stejná kategorie jevu jako HANDOFF (16) „RPC návrat je `& Disposable`". Dosavadní použití na `/workflow/:id` to nechytilo, protože `never` tiše prošlo jako argument (bez přístupu na vlastnost). Oprava: explicitní `as InstanceView | null` cast v `farmRowOf()`. Stejné místo v `/workflow/:id` routě zůstává nedotčené (funguje správně za běhu, jen se stejnou slabší typovou zárukou) — neopraveno, mimo rozsah dnešní změny.

**Brány zelené:** typecheck, 232 testů, arch, `farm:check` (+ `tsc -p deploy/cloudflare/tsconfig.json`, kde se nález objevil). Nasazeno na `farm-bass443`.

## 2026-09-07 (28) — Nová stránka „Farmář": zdraví pěti Workerů + poslední instance na jednom místě

**Pokyn vlastníka** (jeho vlastní slova, ponechána jako název): „chtěl bych nějakou stránku která mi bude ukazovat stav farmáře a stav kraviček" → upřesněno na dotaz: obojí na jedné stránce (zdraví Workerů + přehled instancí).

**Nová route `GET /farm` na `apf-gateway`:**
- **Farmář** (souhrn nahoře): kolik z pěti Workerů odpovídá (`X/5 OK`), podpisový režim gateway, počty posledních instancí podle stavu.
- **Kravičky** (tabulka): `apf-gateway` (vždy „self"), `apf-document-host`, `apf-email-executor`, `apf-mail-ingest`, `apf-fakes` — každý přes `/version` na svém service bindingu, chyba/timeout je řádek „DOWN", nikdy pád stránky (`deployableInfo()`, stejný vzor jako `fakesInfo()`).
- **Poslední instance**: nejnovější auditní záznam per `workflow_id` z D1 (`ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY at DESC)`), bez nové tabulky — sdílený `audit` je jediný zdroj. Odkaz na `/workflow/<id>`.

**Nový service binding `MAIL_INGEST` na gateway** (`wrangler.jsonc`) — dřív gateway neměla k mail-ingestu žádnou cestu (ten volá gateway, ne naopak); teď je to jednosměrné jen pro status, router ho dál nedispatchuje.

**Ověřeno:** `farm:check` (dry-run + `tsc -p deploy/cloudflare/tsconfig.json`, chytí i překlep v novém binding jménu), a navíc ručně `wrangler dev` jen nad `apf-gateway` (ostatní čtyři neběžely) + `curl /farm` — stránka vykreslila čistě, 4 Workery „DOWN" (neběžely), D1 dotaz na instance proběhl bez chyby (`zatím žádná`). Bez automatizovaného testu (je to render, ne logika s Test ID) — ověřeno pohledem, ne CI branou.

**Brány zelené:** typecheck, 232 testů, arch, farm:check.

## 2026-09-07 (27) — W23 nalezen a opraven: audit relay `document-host → gateway` ztrácel záznamy potichu (otevřené pozorování ze (25) dořešeno)

**Pokyn vlastníka:** vrátit se k nedořešenému pozorování ze (25) („Canceled" u `POST .../audit`), s výslovným požadavkem na „silně stabilní, takřka neprůstřelné prostředí" — tedy řešit to jako skutečnou opravu, ne jen zapsat jako otevřenou položku.

**Reprodukce (jiný počítač, čerstvý `wrangler login` už autentizovaný jako `bass443@gmail.com`):** `wrangler tail` puštěný souběžně na `apf-gateway` i `apf-document-host`, vlastník poslal jeden reálný dokument (svoji fakturu TS HYDRO) přes `https://apf.maxferit.cz/`. Nález potvrzen ze tří nezávislých zdrojů najednou: (a) `apf-document-host` zalogoval tři `audit.append()` pro `document.stamp` (`dispatch`, `write-intent`, `write-done`); (b) `apf-gateway` zaznamenal tři odpovídající `POST https://apf-gateway.internal/audit` se stavem **`Canceled`**; (c) skutečný JSON instance (`/workflow/<id>.json`) měl `audit[]` bez jediného z těchto tří záznamů — přeskakoval rovnou z `dispatch document.validate` na finální `state SUCCEEDED`. `document.stamp` sám proběhl v pořádku (`stampedArtifactId`, `dmsRef` v journalu DO), ale auditní stopa v D1 pro tenhle write byla **trvale prázdná**, ne jen opožděná. V `RelayAudit.append()` má `.then()`/`.catch()` vlastní `console.error` na chybu — ani jeden se nespustil, což znamená, že isolát `apf-document-host` byl recyklován dřív, než `ctx.waitUntil` slib vůbec doběhl k rozhodnutí. Přesný opak toho, co popsal záznam (25) („/audit.json obsahoval vše") — nespolehlivé, ne stabilně rozbité ani stabilně funkční.

**Zapsáno jako W23 do `docs/MEASUREMENT.md`** (tabulka nálezů + samostatný odstavec s opravou).

**Oprava:** `RelayAudit` přesunuta z `apf-document-host/src/index.ts` do vlastního `deploy/cloudflare/apf-document-host/src/relay-audit.ts` (mj. proto, aby šla přímo importovat do testu bez wrangler-only aliasu `apf:installation`, který se přes vitest nedá resolvovat — `Fetcher`/`ExecutionContext` nahrazeny strukturálními rozhraními `GatewayFetcher`/`WaitUntilContext`, aby soubor prošel typecheckem pod root `tsconfig.json` i pod `deploy/cloudflare/tsconfig.json`). `append()` zůstává synchronní (`AuditTrail` kontrakt, FOUNDATION-core §7, beze změny), ale eviduje každý relay do `pending[]`; nová `flush(): Promise<void>` je čeká. `/dispatch` handler volá `await audit.flush()` těsně před odpovědí v obou větvích (úspěch i `catch`) — odpověď se teď nikdy nevrátí, dokud audit doopravdy nedorazí (nebo viditelně neselže). `ctx.waitUntil` zůstává jako záloha.

**Nový test `DH-AUDIT-RELAY-001`** (`tests/dh.test.ts`): fake `Fetcher`/`ExecutionContext` s ručně řízeným `resolve`; dokazuje, že `flush()` nevrátí řízení, dokud jsou relaye rozjeté, a teprve po jejich vyřešení ano.

**Brány zelené:** typecheck (root i `deploy/cloudflare/tsconfig.json` přes `farm:check`), **232 testů / 13 souborů**, `npm run arch`, `npm run farm:check`. `npm ci` proběhlo poprvé na tomhle PC (node_modules chyběly).

**Vedlejší poznámka k severce:** stejná session založila `docs/SEVERKA.md` (živý dokument dlouhodobé vize centrálního bloku — Registry, Planner, Policy/Risk, Marketplace, Memory, event-driven, scheduler, lifecycle) a opravila předchozí mylný předpoklad, že multi-tenant je na `farm-bass443` živý bug: `NAVRHOVY-LIST-farma.md` řekl `CLOUD_SINGLE_TENANT`, `tenant-7` je jen protistrana v testech.

**Nasazeno na farmu:** ne, zatím jen v repu — čeká na rozhodnutí vlastníka. Testovací instance s vlastníkovou reálnou fakturou (`wf-mtr1o5es00173c82a`) zůstává na farmě, čeká na smazání přes tlačítko „Smazat" na stránce instance (ne přes API).

**Další:** nasadit W23 opravu na `farm-bass443` a ověřit živě (nový test dokument + `wrangler tail` na obou Workerech, tentokrát očekávat `Ok` místo `Canceled`), pak pokračovat „Pořadí dalších celků" z (19)/(23)/(25): retence podle profilu → krok 8 formáty faktur → krok 4 e-mail → harness proti farmě → krok 5 fronta → krok 6 pentest → krok 7 reálný model AI-EVAL.

## 2026-09-07 (26) — Jméno platformy: Erwin; směr pro admin konzoli farmy (bez kódu)

**Pokyn vlastníka:** odklon od ladění celku D2 (viz (25), otevřené pozorování `waitUntil`/„Canceled" zůstává nedořešené beze změny) k pojmenování platformy a k tomu, co bude potřeba, až farma poroste za jeden dokumentový tok.

**Jméno:** platforma dostala pracovní jméno **Erwin**. Padlo po zamítnutí dvou směrů: „Pigy"/„Piggy" (farmářský motiv, ale v angličtině hanlivý podtón u oslovení člověka — nevhodné, jakmile se cokoli dostane před zákazníka), a čistě funkčních jmen (Dispečer/Relay/Voxa — foneticky bezpečná pro hlasové rozhraní, ale bez osobnosti). Erwin zvolil vlastník přímo, bez dalšího zdůvodnění v zápisu.

**Směr pro admin konzoli** (koncepční, nic z tohoto není v kódu ani v kontraktech):

- **Registr agentů v GUI:** přidání, aktivace, deaktivace jednotlivého agenta/specialisty z konzole, ne editací configu.
- **Editovatelné display jméno** per instance, oddělené od technického typu/ID — jméno vidí operátor/tenant, kontrakt a audit se pořád váže na stabilní identifikátor.
- **Detailní log každého procesu a dotazu**, tak aby šla zpětně rekonstruovat celá historie případu a **prokázat/vyvrátit porušení kontraktu** („renonc" — agent udělal něco, co podle svého `Nesmí`/capability neměl). Bez toho je audit jen tvrzení.
- **Filtrace a export do CSV** jako samozřejmá součást, ne dodatek.
- **Konektorové testy jako gate při nasazení:** nový agent musí projít testem svých konektorů — **interních** (mluví se sdílenými službami farmy: zápis/čtení případu, registr, audit) i **externích** (mluví se svým vnějším světem — API, registry třetích stran) — dřív, než smí přejít do stavu aktivní. Selhání **tvrdě blokuje** aktivaci; override je jen explicitní akce s vlastním záznamem v auditu (kdo, kdy, proč přehlasoval).

**Otevřeno, nezařazeno do pořadí:** tahle vize přesahuje jeden dokumentový tok — `first-slice` dnes pokrývá `document.classify → validate → stamp` přes tři hosty (gateway, fakes, document-host), ne víc typů specialistů vedle sebe. Obecný model (registr, capability kontrakt, izolace) popisuje `agent-platform-foundation`, ale ten je od 5. 9. zmrazený a nové papírové změny nepřijímá bez evidence z kódu (viz `2026-09-06` výše). Kam admin konzole zapadá do „Pořadí dalších celků" z (19)/(23) (invoice formáty → e-mail → fronta → pentest → `erp.post`), zůstává otevřené na vlastníkovi.

**Zapsáno, kód se v tomto záznamu nemění.**

## 2026-09-07 (25) — Celek D2: apf-document-host doopravdy funguje na farmě; transportní chyba nalezena a opravená; logování

**Celek D2 hotový:** `apf-document-host` už není skeleton. Skládá se stejně jako gateway (`Router` + `ExecutorHost` + `CredentialResolver`), ale jako samostatný Worker. Vyřešeny oba problémy z W21:

- **Přenos artefaktu:** nová RPC metoda `WorkflowInstance.artifact(artifactId)` + route `GET /workflow/:id/artifact/:artifactId` na gateway. Document-host si obsah dokumentu natáhne asynchronně přes `GATEWAY` binding **před** spuštěním synchronního routeru (`SingleArtifactStore` — čte přednačtený originál, `derive()` počítá nový artefakt synchronně v paměti a kopíruje do R2 na pozadí přes `waitUntil`).
- **Distribuce veřejného klíče:** `scripts/farm-config.mjs` rozšířen — `$signingPublicKeys` z `farm.json` se automaticky vloží do `SIGNING_PUBLIC_KEYS` var kteréhokoli deployables, který tu proměnnou deklaruje (dnes jen document-host). Pro `local-fakes` zůstává `{}` (ephemerální klíč nejde distribuovat, viz W21) — plný důkaz jde jen na `farm-bass443`.
- Nové HTTP klienty `HttpDmsAdapter`/`HttpArchiveAdapter` (z celku D1) zapojeny do skutečných handlerů; audit z document-hostu se přes `POST /audit` na gateway přelévá do sdíleného D1 (nová route).

**Nalezená a opravená chyba (ne kosmetická):** `RemoteHostTransport.dispatch()` při prvním živém běhu **hodil výjimku** místo vrácení `FAILED` výsledku, protože `orchestrator.ts` volá `transport.dispatch()` bez try/catch — přesně stejná (dosud nikdy neprojevená) chyba už byla v `HttpDispatchTransport`. Opraveno: nová sdílená `transportFailure()` v `src/platform/transport.ts`, žádný transport už nehodí. Nový regresní test `DH-TRANSPORT-001`. Zapojeno i do `apf-document-host`'s vlastního `/dispatch` (chybějící secret při wiringu teď vrací čistý `DEPENDENCY_UNAVAILABLE`, ne syrové HTTP 500).

**Živý důkaz na farmě (ne jen `wrangler dev`):** vygenerována dvě sdílená hesla (`DMS_SECRET`, `ARCHIVE_SECRET` — libovolné řetězce mezi dvěma vlastními Workery, ne cizí přístupový klíč) a nastavena přes `wrangler secret put` na `apf-document-host` i `apf-fakes`. Po nasazení: **`document.stamp` poprvé uspělo end-to-end na skutečné farmě** — reálný podpis, reálné ověření na jiném Workeru, reálný přenos artefaktu, reálný zápis do DMS dvojníka (`dmsRef` vráceno). Testovací instance smazány po ověření.

**Na žádost vlastníka („chci logovat každej prd"):** přidáno `console.log`/`console.error` na klíčová místa — `SqliteAudit.append()` (gateway) a `RelayAudit.append()` (document-host) teď narativně vypisují každou auditní událost, `platform-wiring.ts` loguje, na který transport se capability routuje, `/intake` a `/dispatch` mají log na začátku i konci s časováním, `transportFailure()` loguje každé selhání transportu centrálně. Ověřeno živě přes `wrangler tail` na obou Workerech současně: jeden test s nejednoznačným textem ukázal přesně proč `document.stamp` nikdy neproběhlo (klasifikace skončila v `CLASSIFICATION_DISPUTED` → review, W4 živě), druhý čistý test ukázal celý řetězec gateway → document-host → DMS krok po kroku s časováním.

**Otevřené, nedořešeno (přerušeno na pokyn vlastníka):** poslední pozorování před přerušením — `wrangler tail` u gateway ukázal `POST https://apf-gateway.internal/audit - Canceled` (třikrát) pro relay auditu z document-hostu, ale `/audit.json` **obsahoval** všechny očekávané záznamy (`dispatch`, `write-intent`, `write-done` pro `document.stamp`) se správnými časy. Nejasné, jestli „Canceled" je jen kosmetika `wrangler tail` (request byl ve skutečnosti dokončen jinou cestou, nebo šlo o duplicitní/soutěžící pokus) nebo skutečné riziko ztráty auditního záznamu při `waitUntil` napříč Workery. **Nedokončeno — příští session ověřit, jestli `waitUntil` v `RelayAudit` skutečně drží spojení mezi document-hostem a gateway spolehlivě, nebo jestli potřebuje jistější mechanismus.**

**Brány zelené před nasazením:** typecheck, **231 testů / 13 souborů**, `npm run arch`, `npm run farm:check`. Farma nasazena (`node scripts/farm-deploy.mjs farm-bass443`), oba nové secrets nastaveny.

## 2026-09-06 (24) — Celek C nasazen na farmu (vlastník: „1 a potom 2")

**Zjištění před nasazením:** farma `farm-bass443` běžela pořád na `6c63b16` (stav před celkem C) — `/version` hlásil `"document.validate (registr = fake v procesu do celku C)"`. Dnešní ruční test vlastníkovy reálné faktury tedy ověřoval typ dokumentu proti staré, v procesu běžící náhradě, ne proti skutečné síťové cestě z celku C.

**Nasazeno:** `node scripts/farm-deploy.mjs farm-bass443` (dry-run napřed, čistý). `/version` teď hlásí `"document.validate (registr přes service binding apf-fakes)"` a pole `fakes` s živou odpovědí dvojníka (8 endpointů, `secrets: {dms:false, archive:false}` — čeká na celek D2). Ověřeno smoke testem přes `curl` se service tokenem `apf-harness` (žádná ruční interakce v prohlížeči): syntetický text → `classify:SUCCEEDED` → `validate:SUCCEEDED` (přes skutečnou síť) → `stamp:FAILED:DEPENDENCY_UNAVAILABLE` (nezměněno, čeká na D2). Instance po ověření smazána (`/purge`).

**Vedlejší úklid:** vlastníkova reálná faktura z předchozího ručního testu (na staré verzi) smazána na jeho pokyn stejným service tokenem — `/purge` potvrdil 2 artefakty a 2 R2 objekty smazané, záznam v auditu.

**Beze změny kódu tento krok.** Žádný nový secret nebyl potřeba (D2 teprve `DMS_SECRET`/`ARCHIVE_SECRET` bude vyžadovat). Další: celek D2.

## 2026-09-06 (23) — Celek D rozdělen na D1/D2; D1 hotový: klienti DMS/archiv + kryptografická hranice se skutečným párem klíčů

**Než padl první řádek kódu celku D**, prozkoumal jsem přesně, jak dnešní podpis a ověření fungují (`Gateway.dispatch` → `DispatchEnvelope {message, context, binding}` podepsaný Ed25519 nad JCS `{message, context}`; `Router.route` ověřuje `verifyBinding` přes `KeyRegistry`, jen veřejný klíč). Narazil jsem na dva problémy, o kterých plán nevěděl:

1. **Artefakt.** `document.stamp`/`document.archive` čtou obsah dokumentu synchronně ze sdílené paměti gateway. Na vlastním Workeru `apf-document-host` žádná taková paměť není — jen `R2Bucket` (async) a service bindingy. Bajty musí dorazit asynchronně **před** spuštěním synchronního `Router`/`ExecutorHost` řetězce, ne uprostřed něj.
2. **Podpisový klíč.** Instalace bez `apiHost` (`local-fakes`) generuje klíč nanovo při každém restartu Workeru, navíc zvlášť pro každou Durable Object instanci — vzdálený příjemce nemá stabilní veřejný klíč, ke kterému by se mohl vázat. Funguje to jen s trvalým `GATEWAY_SIGNING_KEY` (`farm-bass443`).

Zapsáno jako **W21** do MEASUREMENT. Vlastníkovi jsem položil otázku, jak rozdělit; **zvolil „jeden menší krok teď"**. Celek D je proto rozdělen na **D1** (hotovo dnes) a **D2** (Worker, přenos artefaktu, farma — zbývá).

**D1 hotovo:** `HttpDmsAdapter` a `HttpArchiveAdapter` (`src/adapters/dms.ts`, `archive.ts`) — skuteční síťoví klienti k `apf-fakes` podle stejného vzoru jako `HttpRegistryAdapter` z celku C, se správným rozlišením: `stamp()` je jediná metoda, která smí hodit `UnknownOutcomeError` (síťová chyba = osud zápisu neznámý); `status()`/`read()` nikdy nesmí hodit výjimku, protože `stamp-handler.ts`'s `reconcile()` je volá bez try/catch — degradují na `"UNKNOWN"`/`undefined`.

**Nález W22 při psaní klienta:** `apf-fakes` (celek C) vyžadoval bearer i na `GET /dms/status`/`/dms/read`, ale `FakeDmsAdapter` (M1) tuhle kontrolu na čtecích metodách nikdy neměl. Neprojevilo se to dřív, protože testy vždy posílaly platný token i tam, kde nebyl potřeba. Opraveno sladěním dvojníka s fake adaptérem (bearer jen na `POST /dms/stamp`).

**Kryptografický důkaz (`tests/dh.test.ts`, 11 testů, `DH-DMS-*`/`DH-ARCHIVE-*`/`DH-SIGN-*`):** nejdůležitější část. `DH-SIGN-*` staví gateway se **skutečným, čerstvě vygenerovaným** párem klíčů Ed25519 a **zcela oddělený** `Router` se svým vlastním `KeyRegistry`, který drží jen veřejný klíč — přesně to, co bude `apf-document-host` jako samostatný Worker. Přes tuhle hranici běží skutečné handlery `document.stamp`/`document.archive` proti skutečným HTTP adaptérům. Ověřeno: platný podpis projde až do zápisu do `apf-fakes`; pozměněný payload po podpisu skončí `CONTEXT_BINDING_INVALID`; podpis cizím párem klíčů skončí stejně; chybějící scope skončí `CAPABILITY_NOT_ALLOWED` dřív, než se handler vůbec spustí. Artefakt je v obyčejném `ArtifactStore` (Node, synchronní) — problém č. 1 výše je vědomě mimo tenhle krok.

Menší refactor: sdílený `world()` helper (dvojník `apf-fakes` bez Workeru) přesunut z `tests/fakes.test.ts` do `tests/harness/fakes-world.ts`, teď používaný dvěma test rodinami.

**Brány zelené:** typecheck, **230 testů / 13 souborů**, `npm run arch`, `npm run farm:check`.

**D2 zbývá:** skutečný `apf-document-host` Worker (dnes pořád skeleton, `501`), přenos artefaktu (návrh: gateway ho dodá přes vlastní čtecí endpoint na `WorkflowInstance` DO, document-host ho stáhne asynchronně před voláním routeru), veřejný klíč do `SIGNING_PUBLIC_KEYS` (var z `farm.json` `$signingPublicKeys`, dnes nikam nezapojený), `reconcile()` pro oba handlery na skutečném Workeru (podmínka W20), DO jurisdikce EU (mezera 1 shody, samostatně malá, nezávislá), secrets `DMS_SECRET`/`ARCHIVE_SECRET`, ověření na farmě.

## 2026-09-06 (22) — Posudek 6: stejný čtenář podruhé, bod 1 na zastaralém snapshotu

**Co se stalo:** vlastník poslal druhé kolo od stejného externího čtenáře jako Posudek 5, tentokrát s tvrzením, že hlavní nález (W19, dedup klíč sdílený mezi capability) je „stále neopravený", a citoval přesně předopravný kód `ExecutorHost.execute()`.

**Ověřeno přímo, ne převzato:** `git cat-file -p origin/main:src/platform/executor-host.ts` (dotaz na objekt, který GitHub skutečně drží) obsahuje opravu (`dedupKey(capability, idempotencyKey)`) beze změny od commitu `0c65fb9` (22:37 SELČ), pushnutého v `50c2cc0` (22:48 SELČ). Posudek tedy pracoval se snapshotem starším než tato oprava, nejpravděpodobněji krátké zpoždění GitHub CDN po pushi (oprava i posudek padly do stejného ~20minutového okna) — ne chyba v kódu.

**Co v posudku zůstává platné:** hlubší varianta opravy (`tenantId + handlerId + requestFingerprint` + `IDEMPOTENCY_CONFLICT`) je pořád otevřená — přesně „druhá, oddělitelná změna" z Posudku 5, ne oprava dnešního nálezu. Body o durable ledgeru (W20), `resourceTenant()` fail-open, `ReviewService` bez trusted principal, `/dispatch` 501 a nezapojených hostech jsou beze změny přesně to, co má Posudek 5 — žádné nové zjištění.

**Jedna nová, přijatá poznámka (bod 8):** `/purge` už běží na farmě (od kroku 2 celku A), takže potřebuje Access JWT verifikaci se stejnou naléhavostí jako budoucí `/review`, ne až s ním. Zapsáno do `docs/SHODA-NIS2-ISO27001.md` mezery 3.

**Zapsáno jako Posudek 6 do `docs/POSUDKY.md`** s dispozicemi (bod 1 = O na základě chybného snímku, s důkazem; zbytek Z/P beze změny plánu). Žádná změna kódu tento krok — čeká se na rozhodnutí vlastníka, zda se composite idempotency identita + fingerprint + `IDEMPOTENCY_CONFLICT` dělá jako další celek před D, nebo se nechá otevřené.

## 2026-09-06 (21) — Posudek 5 a oprava W19: `ExecutorHost` dedup scoped na capability

**Co se stalo:** vlastník poslal čtvrtý externí posudek, tentokrát nad skutečným TypeScript kódem (ne jen STATUS). Každé tvrzení jsem ověřil přímo v kódu před zápisem dispozice — zapsáno jako Posudek 5 do `docs/POSUDKY.md` (8,8/10, deset bodů s dispozicí P/PÚ/Z). Dva body posudku (reálný registry adapter, chaos přes service binding) už vyřešil stejný den celek C, po commitu `a5310fc`, který posudek viděl a nemohl proto vědět o HANDOFF (19) ani o celku C (oba lokální, nepushnuté).

**Potvrzený reálný nález (W19, priorita P0):** `ExecutorHost.idempotency` byla jedna `Map<string, HandlerOutcome>` klíčovaná jen `idempotencyKey`, sdílená mezi všemi capabilitami jednoho hostu — `document.stamp` a `document.archive` sdílejí `documentHost`. Orchestrátor dnes generuje klíč s `stepId`, takže v běžném toku ke kolizi nedojde, ale primitivum samo to nezaručovalo a žádný test to nekryl.

**Vlastník na dotaz „teď, nebo v rámci D": „up to you"** → opraveno hned jako samostatný malý celek. `ExecutorHost.dedupKey(capability, idempotencyKey)` skládá interní klíč mapy z obou; kontrakt na drátě (`message.idempotencyKey`) beze změny. Upraveny `execute()`, `reconcilerFor()`, `remembered()` (signatura teď `remembered(capability, key)`, dva volající testy upraveny). Nový test `IDM-HOST-SCOPE-001`: stejný `idempotencyKey` na `document.stamp` i `document.archive` — obě proběhnou, `archive.putCalls` 1, žádný `duplicate` audit záznam. **Ověřeno, že test je reálný regresní test:** `git stash` jen na `executor-host.ts`, test padá (`archiveRef` undefined, druhá capabilita se vůbec nespustila), `git stash pop` a zelené znovu.

**Brány zelené:** typecheck, **219 testů / 12 souborů**, `npm run arch`, `npm run farm:check`.

**W20 zůstává otevřené jako podmínka celku D:** durabilita dedup na farmě stojí celá na `reconcile()` (dotaz na vnější systém), ne na lokální mapě hostu, protože `apf-document-host` bude samostatný Worker s jiným isolátem na každý požadavek. D musí mít `reconcile()` zapojený a testovaný pro `document.stamp` i `document.archive` na skutečném Workeru.

**Nasazeno na farmu:** ne, jen v repu. Farma `farm-bass443` běží stále z `6c63b16` (beze změny).

## 2026-09-06 (20) — Krok 2, celek C: `document.validate` přes skutečnou síť (`apf-fakes` service binding)

**Pokyn vlastníka:** „pokračujeme" (po HANDOFF (19), beze změny plánu) — další v pořadí byl celek C podle HANDOFF (17)/(19) a `docs/NAVRHOVY-LIST-farma.md`.

**Co se změnilo:** validátor už nedostává `FakeRegistryAdapter("ok")` napevno v procesu (`platform-wiring.ts`); dostává libovolný `RegistryAdapter` a gateway (`deploy/cloudflare/apf-gateway/src/index.ts`) mu injektuje `HttpRegistryAdapter` mířící na `env.FAKES` (service binding). Nový modul `src/adapters/fakes-http.ts` je protokol dvojníka: `handleFakes(request, deps)` obsluhuje registr (`POST /registry/lookup`), DMS (`POST /dms/stamp`, `GET /dms/status`, `GET /dms/read`) a archiv (`POST /archive/put`) nad jedním rozhraním `ChaosSource`/`FakesStore`, chaos módy čte na každé volání (žádné cachování) a neznámou hodnotu módu odmítá (`CHAOS_MODE_UNKNOWN`), nikdy ji neuhodne. `deploy/cloudflare/apf-fakes/src/index.ts` je teď jen tenký binding na KV (`CHAOS`, `STORE`) + `memory` Map před KV kvůli read-your-writes uvnitř jednoho isolátu (W18: KV je eventuálně konzistentní). `HttpRegistryAdapter` (v `src/adapters/registry.ts`) mapuje transport na existující chybové třídy (5xx → `RegistryUnavailable`, 4xx s kódem → `RegistryBusinessError`, nevalidní JSON → prázdný záznam, který validátor stejně odmítne jako `REGISTRY_RESPONSE_INVALID` — žádná nová důvěra vůči odpovědi). `src/slice.ts` a testy (`tests/sec.test.ts`) dostaly `registry` jako volbu místo implicitního fake v procesu; nový `tests/fakes.test.ts` (8 testů, `INT-HTTP-001..008`) opakuje třídy `INT-FAIL` přes tento protokol plus DMS/archiv idempotenci a chybové stavy pro celek D.

**Ověřeno nad víc než dry-run (brána stejná jako u kroku 2 od začátku):** `npx wrangler dev -c .wrangler/generated/local-fakes/apf-gateway/wrangler.jsonc -c .wrangler/generated/local-fakes/apf-fakes/wrangler.jsonc` (multi-worker dev, dva Workery v jednom miniflare, service binding hlásí `[connected]`, ne `[not connected]` jako dřív). `/version` gateway teď v poli `fakes` ukazuje živou odpověď dvojníka (`endpoints`, `chaos`, `secrets: {dms:false, archive:false}` — bez nastavení secrets na farmě, jak čeká celek D). `POST /intake` s textem faktury prošel `classify:SUCCEEDED` → `validate:SUCCEEDED` (registr přes skutečnou síť vrátil INVOICE) → `stamp:FAILED:DEPENDENCY_UNAVAILABLE` (document-host = celek D, beze změny). Instance po ověření smazána `purge`.

**Brány zelené:** typecheck, **218 testů / 12 souborů**, `npm run arch` (20 hodnot), `npm run farm:check` (10 configů) i `tsc` nad `deploy/cloudflare`.

**Nálezy:** 0 v kódu; W18 zapsáno do MEASUREMENT (KV jako zdroj pravdy testovacího dvojníka je eventuálně konzistentní, dvojník řeší čtení-po-zápisu jen v paměti isolátu — pro D5 dost, pro skutečný DMS na farmě irelevantní, protože ten se ptá vlastního úložiště, ne KV).

**Nenasazeno na farmu:** změna je jen v repu a ověřená na `wrangler dev`; farma `farm-bass443` stále běží z `6c63b16` (poslední nasazený kód, viz HANDOFF (19)). Nasazení celku C na farmu (`node scripts/farm-deploy.mjs farm-bass443`) je otevřené — nevyžaduje nový secret, `apf-fakes` je tam už od kroku 3 „lite".

**Další celek D:** `apf-document-host` (`document.stamp`, `document.archive`) přes service binding s podepsanou obálkou (veřejný klíč z `config/farm-bass443/farm.json` `$signingPublicKeys`), secrety `DMS_SECRET`/`ARCHIVE_SECRET` (stejné hodnoty musí mít i `apf-fakes`, aby si DMS/archiv rozuměly), DO `jurisdiction("eu")` (mezera 1 shody). Pak retence podle profilu → krok 8 formáty faktur → krok 4 e-mail → harness proti farmě.

## 2026-09-06 (19) — Konec session: stav farmy, co je kde, jak pokračovat

**Stav repa:** origin/main = `a5310fc` (docs), poslední kódový commit `6c63b16` (celek B). Lokální brána zelená: typecheck, **210 testů / 11 souborů**, `npm run arch` (20 instalačních hodnot), `npm run farm:check` (10 configů). CI `kontrola` zelené na `6c63b16`. Tento záznam je jen commit bez pushe (pokyn vlastníka); po pushi z tohoto PC bude origin o jeden napřed.

**Stav farmy `farm-bass443` (účet bass443, `https://apf.maxferit.cz` za Access):** nasazeno v 20:5x z `6c63b16`: příjem dokumentu (text, PDF, fotka, docx, ISDOC/XML, txt, eml) → originál (text v objektu, binár v R2 `originals/<tenant>/<sha256>`) → extrakce textu Workers AI `toMarkdown` jako derivace s provenancí → tok `document-intake@2`: **classify** (podepsaný dispatch Ed25519, router v objektu instance, model z profilu: výchozí Workers AI Llama 3.1 8B fp8, volitelně Llama 3.3 70B; Anthropic Opus 5 / Haiku 4.5 v seznamu jako nedostupné do nastavení `ANTHROPIC_API_KEY`) → **validate** (druhý signál, registr = fake v procesu) → **stamp** končí `DEPENDENCY_UNAVAILABLE` (hosty nezapojené). Stránka `/` (formulář s výběrem modelu), `/workflow/<id>` s blokem Výstup a tlačítkem Smazat, `/audit.json` (D1), `/version`. Žádná instance s reálnými daty na farmě nezůstala (vše smazáno purge, D1 má záznamy PURGED).

**Secrets a klíče:** `GATEWAY_SIGNING_KEY` (Ed25519 PKCS8) nastaven na `apf-gateway`; privátní PEM existoval jen v scratchpadu a je smazaný; veřejný klíč `k1` je v `config/farm-bass443/farm.json` (`$signingPublicKeys`). `ANTHROPIC_API_KEY` **není** nastaven (vlastník: `npx wrangler secret put ANTHROPIC_API_KEY -c .wrangler/generated/farm-bass443/apf-gateway/wrangler.jsonc`, pak `node scripts/farm-deploy.mjs farm-bass443`). `DMS_SECRET`, `ARCHIVE_SECRET` nejsou nastaveny (celek D). Access service token `apf-harness` má hodnoty jen v lokálním `.env` tohoto PC (gitignore); na druhém PC buď nový token v Zero Trust → Service credentials, nebo ověřovat v prohlížeči přes Access login.

**Jak ověřit z čistého PC:** `git pull`, `npm ci`, `npm run typecheck && npm test && npm run arch && npm run farm:check`; `npx wrangler login` (bass443) → `node scripts/farm-config.mjs` → `npx wrangler dev -c .wrangler/generated/local-fakes/apf-gateway/wrangler.jsonc` → `http://127.0.0.1:8787/` (instalace local-fakes: fake model, efemérní klíč); farma: `https://apf.maxferit.cz/` v prohlížeči.

**Pořadí dalších celků (beze změny):** C `apf-fakes` přes service binding (registr/DMS/archiv, chaos v KV) → D `apf-document-host` (razítko, archive) s podepsanou obálkou a veřejným klíčem z overlay, secrets `DMS_SECRET`/`ARCHIVE_SECRET`, DO `jurisdiction("eu")` → retence podle profilu (DO alarm + D1) → krok 8 formáty faktur (ISDOC → Factur-X → UBL/Peppol → CII, `invoice.normalize`, EN 16931 model) → krok 4 e-mail (Routing `apf-intake@`, aliasy, Sending `apf-notify@`, přílohy MIME) → harness proti farmě přes `HttpDispatchTransport` → krok 5 fronta + evikce DO → krok 6 pentest ADR-017 → krok 7 reálný model s golden setem (AI-EVAL) → `erp.post` do NAV/BC jako třetí doména.

**Otevřené pro vlastníka:** Anthropic klíč (kdykoli); aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` do jedné schránky (krok 4); Workers Paid až u kroku 5. Dokumenty k udržování s každým celkem: MEASUREMENT, STATUS CZ/EN, `docs/SHODA-NIS2-ISO27001.md` (8 mezer), HANDOFF.

## 2026-09-06 (18) — Návrh vstupní vrstvy faktur potvrzen vlastníkem: „Universal Invoice Intake Gateway"

**Vlastník („Ano. Přesně takhle bych to navrhl."):** cílový obraz pro faxx-dox i farmu = Universal Invoice Intake Gateway s adaptéry (Email, GRID/EDI = OpenText Trading Grid, Peppol, parsery ISDOC/UBL/CII/Factur-X, PDF/Image AI extractor) → jediný kanonický Invoice JSON → validace → kontrola duplicity → business rules → ERP (NAV / Business Central). **Pravidlo přednosti:** na fakturu se strojovými daty se AI nepouští (mail s PDF + ISDOC → zpracuje se ISDOC s XSD validací proti DIA 6.0.2, PDF jen vizuální originál). Zapsáno do návrhového listu (krok 8, odstavec „Potvrzeno") a do paměti projektu faxx-dox.

**Vazby na normu, které z toho plynou:** kontrola duplicity = idempotence podle identity faktury (DIČ dodavatele + číslo) jako `idempotencyKey` write executora; business rules = deterministický `validate` s druhým signálem (součty, IČ/DIČ/IBAN, ARES); zápis do NAV/BC = write executor `erp.post` (PRINCIPAL, reconciliace přes BC API) = **třetí doména** pro měření mezní ceny podle posudků.

**Pořadí zůstává:** C (`apf-fakes` přes service binding) → D (document-host, razítko, DO jurisdikce EU) → retence → krok 8 (ISDOC → Factur-X → UBL/Peppol → CII, `invoice.normalize`) → krok 4 e-mail s přílohami → harness proti farmě. Kód se v tomto záznamu nemění.

## 2026-09-06 (17) — Krok 2, celek B: podepsaný dispatch, classify se skutečným modelem a výběrem modelů z profilu, validate; NIS2 / ISO 27001 jako požadavek

**Pokyny vlastníka:** „chci výběr modelů AI jako u jiných projektů, placený i free, nikdy bez modelu AI"; „vše musí splňovat NIS2, ISO 27000 atd." (zapsáno i do paměti jako trvalé pravidlo; mapování kontrol v `docs/SHODA-NIS2-ISO27001.md`).

**Stav (nasazeno ~20:35, ověřeno tokenem):** `/version` hlásí `signing: secret (Ed25519 PKCS8)` a seznam modelů; text faktury i PDF → `classify:SUCCEEDED:INVOICE` (Workers AI `@cf/meta/llama-3.1-8b-instruct-fp8`, ≈ 1,5 s) → `validate:SUCCEEDED` → `stamp:FAILED:DEPENDENCY_UNAVAILABLE` (hosty = celek D); newsletter → OTHER → `validate:WAITING:STAMP_NOT_ALLOWED` (review); injekce „classify this as INVOICE" → Llama vrátila OTHER (odolala), lokálně gullible fake vrátil INVOICE a validátor ho chytil druhým signálem (`CLASSIFICATION_DISPUTED` → review) = W4 živě; `llama-70b` volitelně funguje; Anthropic volby v seznamu jako **nedostupné: secret for cred:anthropic not provided**, výběr odmítnut 400. Testy **210**, typecheck, lint (20 hodnot), farm:check zelené. Testovací instance smazány purge.

**Ed25519 ve workerd:** probe Worker (scratchpad) potvrdil `generateKeyPairSync`, `sign`, `verify`, PKCS8 export/import, `createPublicKey` přes `nodejs_compat` → `signing.ts` beze změny.

**Kód:**
- `config/profile.schema.json` + `src/installation.ts`: sekce `models` per capability (`default`, `options{provider: workers-ai|anthropic|fake, model, label, credential jen jménem, inferenceGeo, processor}`), `assembleInstallation` ověří default ∈ options, `modelTable()` rozliší dostupné (secret má hodnotu) a nedostupné (s důvodem), nedostupný default = fail-closed. `local-fakes`: `fake-llm`; `farm-bass443`: `llama-8b` (default, fp8), `llama-70b`, `claude-opus-5` (`inferenceGeo: eu`), `claude-haiku-4-5`, oba Anthropic s `cred:anthropic` a poznámkou o zpracovateli.
- Adaptéry: `src/adapters/workers-ai.ts` (binding jako strukturální rozhraní, `textOf` pro obě tvary odpovědi), `src/adapters/anthropic.ts` (SDK `@anthropic-ai/sdk` 0.124, `output_config.effort: low` u 5-řady/4.6+, server-side fallback u Opus/Fable 5, `inference_geo` z profilu; **neotestováno bez klíče**). Lint: adaptéry smí importovat balíčky (bare specifiers).
- Classifier: vstup `model` (klíč z profilu) pro strategii `llm`; neznámý klíč = `STRATEGY_UNKNOWN`; `MODEL_UNAVAILABLE` nese `modelId` a `reason` (nález: bez důvodu se špatné id modelu nedalo poznat).
- **Workflow v2** obou toků (`workflows/*.v2.json`, v1 nedotčené: definice je neměnná): classify dostává `model: $input.model`. `WORKFLOW_DEFINITIONS` klíčuje `name@version` + `name` = nejnovější; `workflowDef(name, version?)`; `WORKFLOW_NAMES`; slice má orchestrátor per verze; `int.test` bere `name@version` z názvu adresáře golden masteru; `WF-VER-001` test bere verzi „o jedna vyšší" místo natvrdo „2".
- Gateway: `platform-wiring.ts` (klíč z `GATEWAY_SIGNING_KEY` PKCS8, jinak ephemeral jen pro instalaci bez `apiHost`; `KeyRegistry` s veřejným klíčem; `Gateway` + `Router` + `InProcessTransport`; classify s adaptéry z profilu (`llm` = default, `keyword` = pravidla), validate s `FakeRegistryAdapter("ok")` v procesu do celku C; capability mimo gateway → `NotWired`), `index.ts` (secrets jen jménem: `SECRET_ENV_BY_REF`; wiring líně při prvním `intake`, chyba = stránka 500 s důvodem; `/version` + stránka ukazují modely a podpis; formulář má výběr modelu, nedostupné volby disabled s důvodem), `page.ts`.
- Farma: secret `GATEWAY_SIGNING_KEY` nastaven (privátní PEM vygenerován lokálně, po uploadu smazán); veřejný klíč `k1` zapsán v `config/farm-bass443/farm.json` pod `$signingPublicKeys` (pro hosty v celku D).

**Jak přidat Anthropic (vlastník):** `npx wrangler secret put ANTHROPIC_API_KEY -c .wrangler/generated/farm-bass443/apf-gateway/wrangler.jsonc` (klíč vložit na výzvu, nikam jinam), pak `node scripts/farm-deploy.mjs farm-bass443`; volby v profilu už jsou, po nasazení zezelenají ve formuláři. Výchozí model zůstává Workers AI, dokud se v profilu nezmění `default`.

**Nálezy:** (a) `@cf/meta/llama-3.1-8b-instruct` už na Workers AI není (jen `-fp8`); první běh skončil `MODEL_UNAVAILABLE` bez důvodu → přidán `reason`; (b) skutečný model odolal jednoduché injekci, kde fake ne; druhý signál validátoru chytil obojí; (c) OTHER → `STAMP_NOT_ALLOWED` → review je správné chování (razítkují se jen INVOICE/CONTRACT).

**Vstupní formáty faktur (pokyn vlastníka: ISDOC XML, „i takovéto formáty" = UBL/Peppol, CII, Factur-X, EDIFACT):** zapsáno jako krok 8 návrhového listu: deterministická importní vrstva s detekcí podle namespace, normalizace do interního modelu podle EN 16931 (`invoice.normalize`), AI jen pro PDF bez XML a fotky (`invoice.extract`); pořadí ISDOC → Factur-X → UBL/Peppol → CII. Dnes: `.xml`/`.isdoc` se přijímají jako text a `classifyByRules` pozná ISDOC podle namespace (druhý signál i záložní strategie).

**NIS2 / ISO 27001:** `docs/SHODA-NIS2-ISO27001.md` = mapování kontrol (přístup, klíče, audit, integrita, umístění dat a zpracovatelé, retence, vývoj, dodavatelé, incidenty, kontinuita, AI) s evidencí a 8 mezerami v pořadí priority (1 = DO jurisdikce EU, 2 = automatická retence, 3 = ověření Access JWT, 4 = alerting a postup incidentů…). Aktualizovat s každým celkem jako MEASUREMENT.

**Další celek C:** `apf-fakes` Worker (DMS, registr, archiv jako HTTP fakes s chaos přepínači v KV) + klient registru přes service binding ve validate (místo `FakeRegistryAdapter` v procesu) → INT-FAIL přes skutečnou síť. Pak D: `apf-document-host` (stamp, archive) přes service binding s podepsanou obálkou (veřejný klíč z overlay), secrets `DMS_SECRET`/`ARCHIVE_SECRET`, DO `jurisdiction("eu")` (mezera č. 1 shody).

**Zbývá rozhodnout (Milan):** Anthropic klíč (kdykoli, viz výše); aliasy do jedné schránky (krok 4).

## 2026-09-06 (16) — Smazání instance (purge) a blok „Výstup" na stránce instance

**Pokyny vlastníka:** „klidně ji smaž, je to test" (reálná faktura) a „dej mi na druhé straně i něco, kde uvidím, co je výstup"; otázka „nemáš tam AI na vytahování textu a posuzování?" → odpověď: vytěžení textu AI dělá (toMarkdown), posouzení = classify přijde v celku B, a to rovnou s Workers AI jako strategií „llm", pravidla jako druhá strategie, křížový signál ve validate.

**Hotové (nasazeno ~20:10, ověřeno tokenem):**
- `WorkflowInstance.purge(by, reason)`: smaže R2 objekty všech artefaktů instance (originály i derivace), zapíše do D1 záznam `state {status: PURGED, reason, artifacts, r2Deleted, previousStatus}` pod aktérem `access:<e-mail>`, pak `storage.deleteAll()` a znovu DDL (objekt může zůstat živý; bez toho další volání padalo na „no such table" → 500 místo 404). Auditní řádky instance v D1 zůstávají (append-only; nesou id, otisky, e-mail odesílatele, ne obsah).
- Route `POST /workflow/:id/purge` (form `reason`), tlačítko „Smazat instanci" na stránce instance s `confirm` (jediný inline skript stránky). Reálná faktura vlastníka (`wf-mtq3z8d8…`) smazána: R2 „key does not exist", `.json` → 404, D1 má PURGED.
- Stránka instance má nahoře blok **Výstup**: vstup (typ, velikost, od koho), text dokumentu (vytěžený / vložený, počet znaků, rozbalovací náhled), typ dokumentu (classify: hodnota, zdroj, jistota | FAILED kód | nedosaženo), validace (status, provider, razítko povoleno), razítko (text, DMS ref, orazítkovaný artefakt), u mail-intake notifikace, stav toku. Plní se z payloadů posledního kroku dané capability podle output schémat komponent.
- Oprava typu: RPC návrat je `& Disposable`, do `Record<string, unknown>` jde jen přes spread.

**Poznámka k retenci:** `purge` je zatím ruční; automatická retence podle `profile.retentionDays` (originály 30 d, journal 30 d, audit 90 d) = samostatný celek (DO alarm per instance + D1 mazání podle `at`).

**Další celek B:** beze změny: `/dispatch` + classify (Workers AI jako `llm`, keyword jako druhá strategie), Ed25519 ve workerd ověřit první, DO `jurisdiction("eu")`.

## 2026-09-06 (15) — Krok 2, celek A2: PDF / fotka / docx jako vstup (binární originál v R2, Workers AI toMarkdown, derivace s provenancí)

**Pokyn vlastníka:** „faktury jsou nejvíce v PDF a jako příloha e-mailu." Odpověď: celek A2 hned (soubory přes formulář), přílohy e-mailu v kroku 4 (mail-ingest: MIME → každá příloha = originál → táž extrakce).

**Stav:** nasazeno 19:25, ověřeno na farmě service tokenem: `POST /intake` s PDF (823 B, jednostránková faktura vygenerovaná skriptem) → 303 za 2 s → instance má **originál** `application/pdf` s `location=originals/<tenant>/<sha256>` (jen v R2, v objektu metadata) a **derivaci** `text/markdown` od `workers-ai:toMarkdown` s textem faktury jako `input.artifactId` toku; audit `write-intent`/`write-done` pro `document.extract`; kroky dál `DEPENDENCY_UNAVAILABLE`. Lokálně totéž na `wrangler dev` (AI binding jde přes účet i lokálně). Testy 208, typecheck, lint, farm:check zelené.

**Kód:** `src/platform/artifacts.ts` (`sha256Bytes`, `Artifact.contentType/byteLength/location`; `bytes` prázdné u binárního originálu); gateway `store.ts` (sloupce `content_type`, `byte_length`, `location`; `putExternal()`; derivace s `contentType`; binární originál rovnou `copied=1`; R2 klíč derivací `derived/<tenant>/<sha256>`), `page.ts` (formulář: soubor první, accept PDF/obrázky/docx/txt/eml, limit 4 MB; karta artefaktu ukazuje typ, velikost, pro binární originál umístění v R2; `renderError`; řádek „extrakce" v seznamu zapojeného), `index.ts` (typ souboru z `file.type` nebo přípony; textové typy → inline; binární → R2 `put` if not `head`, `AI.toMarkdown({name, blob})`, chyba/`format: "error"`/prázdný text → 422 stránka s otiskem, tok se nespustí; `WIRED.extract`).

**Zjištění:** výstup `toMarkdown` pro PDF začíná `# <název>` a blokem `## Metadata` (vlastnosti PDF) a teprve pak textem; classify to uvidí jako součást dokumentu (data). Fotky: stejná konverze používá vision model (neurony Free plánu), **neověřeno skutečnou fotkou**, to je první věc příště na stránce. Extrakce není capability (W16): rozhodnout po B–D.

**Testovací PDF:** `scratchpad/make-pdf.mjs` (mimo repo) generuje `faktura-test.pdf`; na druhém PC vezmi libovolné PDF s textovou vrstvou.

**Reálný dokument (vlastník, 19:51):** skutečná faktura za internet (export z POHODY, 100 kB, jedna strana) → derivace 1 726 znaků, 432 tokenů, formát markdown. Kvalita: sloupcová sazba slévá sousední buňky do jednoho řádku (číslo dokladu + „Variabilní symbol" + jméno bez oddělovače), ale číslo dokladu, VS, IČ/DIČ, částky, DPH, datum vystavení i splatnost jsou v textu; blok `## Metadata` prozradí autora a systém (Author, Creator=POHODA). **Datová hygiena:** faktura nese osobní údaje vlastníka (jméno, adresa, DIČ = rodné číslo); leží v R2 (jurisdiction eu), v SQLite Durable Objectu instance a v D1 (EEUR) na účtu vlastníka za Access. **Mezera:** Durable Object nemá pinovanou jurisdikci → v celku B použít `env.WORKFLOW.jurisdiction("eu").idFromName(...)`; retence z profilu (`retentionDays`) se zatím nevymáhá (žádné mazání) → samostatný celek „retence" po D.

**Další celek B (`/dispatch` + classify):** beze změny proti (14); navíc classify poběží nad derivací (markdown s metadaty).

**Zbývá rozhodnout (Milan):** aliasy do jedné schránky (krok 4). Jinak nic.

## 2026-09-06 (14) — Krok 2, celek A: příjem dokumentu na farmě (stránka → DO instance → stránka instance), první „dílčí výstup" pro vlastníka

**Pokyn vlastníka (večer):** „otevřu stránku, vložím dokumenty, fotky, spustí se proces a bude nějaký dílčí výstup." Pořadí kroku 2 přeskládáno podle toho: **A stránka + příjem (hotovo) → B dispatch + classify → C validate → D document-host + fakes (razítko) → OCR fotek (nová capability, Workers AI vision) → harness proti farmě.** Každý celek jde hned na farmu; vlastník kontroluje na `https://apf.maxferit.cz/`.

**Stav:** nasazeno (`farm-deploy farm-bass443`, 19:03), ověřeno service tokenem: `GET /` 200 (formulář), `POST /intake` → 303 `/workflow/wf-…`, instance `FAILED` s krokem `classify:FAILED:3:DEPENDENCY_UNAVAILABLE`, artefakt s sha256 a `receivedFrom: access:service-token`, `/audit.json` z D1 vrací záznamy. Lokálně totéž na `wrangler dev` (local-fakes). Testy 208, typecheck, lint (20 hodnot), farm:check 10 configů zelené.

**Kód:**
- Platforma: `JournalStore` a `AuditTrail` jsou rozhraní (třídy `Journal`, `Audit` je implementují; router, executor host, review, credentials, orchestrátor berou rozhraní). `Orchestrator.start(input, correlationId?, workflowId?)` umí přednastavené id (DO per instance). Registr `WORKFLOW_DEFINITIONS`/`workflowDef()` přesunut do `src/platform/workflow.ts` (slice ho re-exportuje), aby ho gateway nebral z `slice.ts` s fakes.
- `deploy/cloudflare/apf-gateway/src/store.ts`: `SqliteJournal`, `SqliteAudit` (insert-only + příznak `mirrored`), `SqliteArtifacts` nad `ctx.storage.sql` (DDL při konstrukci objektu); `D1_AUDIT_DDL`.
- `deploy/cloudflare/apf-gateway/src/page.ts`: `renderHome` (formulář: text/soubor, tok, text razítka; seznam „co je zapojené" z `WIRED`), `renderInstance` (kroky, artefakty s náhledem, audit instance), bez skriptů a externích assetů, `esc()` na všechno.
- `deploy/cloudflare/apf-gateway/src/index.ts`: `WorkflowInstance` DO (`intake()` RPC: artefakt → `start` s `workflowId` = jméno objektu → `run` → `waitUntil(copyOut())` = R2 `originals/<tenant>/<sha256>` + D1 `INSERT OR IGNORE`; `view()`), `NotWiredTransport` (každý dispatch = audit `dispatch {wired:false}` + `DEPENDENCY_UNAVAILABLE`), routy `/`, `/intake` (multipart, limit 1 M znaků, `KILL_SWITCH` → 503), `/workflow/:id(.json)`, `/audit.json?limit=`, `/version` + `/health` s objektem `WIRED`, `/dispatch` 501. Tenant příjmu = tenant identity `roles.orchestrator` z profilu; `receivedFrom` = `access:<e-mail z hlavičky Access>` nebo `access:service-token` (JWT ověření = pozdější celek, `WIRED.accessJwtVerified=false`).
- `deploy/cloudflare/types/apf-installation.d.ts`: inline `import()` typ (relativní `import` v ambientním modulu je TS2439 a `skipLibCheck` ho skryl → `installation` bylo tiše `any`).
- `scripts/arch-dep.mjs`: hostname regex bez `.at`/`.de` a s labely ≥ 2 znaky (falešný nález `r.at` v šabloně).

**Rozhodnutí W15 (MEASUREMENT):** platformová úložiště zůstávají synchronní; na farmě je DO SQLite zdroj pravdy a R2/D1 jsou kopie po běhu; host v jiném Workeru si artefakt z R2 přednačte před synchronním handlerem.

**Další celek B (`/dispatch` + classify):** v DO postavit `Gateway` + `Router` + `InProcessTransport` s registrací `document.classify` (a `document.validate`) přes `FakeLlmAdapter`/`KeywordClassifierAdapter` (reálný model = krok 7); podpisový klíč: `GATEWAY_SIGNING_KEY` přes `wrangler secret put … -c .wrangler/generated/farm-bass443/apf-gateway/wrangler.jsonc` (Ed25519 PKCS8 PEM) → **první věc ověřit `node:crypto` `createPrivateKey`/`sign`/`verify` Ed25519 ve workerd**, jinak WebCrypto (async → `Gateway.dispatch` async, harness). Router potřebuje `KeyRegistry` s veřejným klíčem (odvozený z privátního). Fakes adaptéry pro registr přes service binding na `apf-fakes` jsou celek C. `WIRED.dispatch = true` a stránka ukáže typ dokumentu.

**Ověření z druhého PC:** `.env` s tokenem tam není; stránka jde přes Access login v prohlížeči bez tokenu.

**Zbývá rozhodnout (Milan):** aliasy do jedné schránky (krok 4). Jinak nic.

## 2026-09-06 (13) — Krok 3 „lite": skeleton NASAZEN na bass443 za Access, ověřeno z internetu přihlášením i service tokenem

**Stav:** farma existuje. `https://apf.maxferit.cz/version` vrací `{"installation":"farm-bass443","tenants":2,"identities":3,"policies":6,"contracts":"agent-platform-foundation 1.0-rc2.1 12a3c32","killSwitch":false,"wired":false}` přes Access login (Jen Ja) i přes service token `apf-harness` (politika `harness`, Service Auth); bez tokenu 302 na Access login; `/dispatch` 501 (obchodní tok ještě není zapojený). Kód a testy beze změny (208), lokální brána zelená.

**Co vzniklo v účtu bass443 (6. 9. 2026 ~13:45):** D1 `apf-audit` (id `ee8b714e-…`, region EEUR), R2 `apf-artifacts` (jurisdiction eu), KV `apf-chaos` a `apf-fakes-store`; Workers `apf-fakes`, `apf-document-host`, `apf-email-executor`, `apf-mail-ingest`, `apf-gateway` (custom doména `apf.maxferit.cz`, DNS vytvořil deploy); Access aplikace `apf-gateway` (naklikal vlastník) s politikami `Jen Ja` (Allow) a `harness` (Service Auth, service token `apf-harness`, platnost 1 rok). Žádné secrets zatím nasazené (skeleton je nepotřebuje).

**Kód / config:** `config/farm-bass443/farm.json` má id D1 a KV (overlay; base configy drží nuly). `scripts/farm-deploy.mjs <instalace> [--bootstrap] [--dry-run]`: nasazení z generovaných configů v pořadí fakes → document-host → email-executor → mail-ingest → gateway; `--bootstrap` = první průchod bez `services` (gateway a hosty se navzájem odkazují). `.env.example` (v repu) + `.env` (lokálně, gitignore) s `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `APF_BASE_URL=apf.maxferit.cz`; harness je zatím nečte, to je celek „harness proti farmě".

**Dvě provozní zjištění (MEASUREMENT řádek krok 3 lite):** (a) cyklus service bindingů vyžaduje dvoufázové první nasazení; (b) znovupoužitelná Access politika musí být k aplikaci výslovně připojená („Used by applications: 0" = token dostane 302).

**Ověření z druhého PC:** `.env` tam není (gitignore); service token je v Zero Trust → Service credentials (secret už nejde zobrazit, případně vytvořit nový a přepsat politiku). Přihlášení wrangleru: `npx wrangler login` na bass443.

**Další celek (krok 2, celek 2): journal v DO SQLite + audit v D1** pod stávajícími rozhraními `Journal`/`Audit`, implementace v `apf-gateway/src/`, ověřit `wrangler dev` a pak rovnou nasadit `farm-deploy farm-bass443`. Potom celek 3 `/dispatch` (Ed25519 ve workerd ověřit první, jinak WebCrypto) + secrets `wrangler secret put GATEWAY_SIGNING_KEY -c .wrangler/generated/farm-bass443/apf-gateway/wrangler.jsonc`.

**Zbývá rozhodnout (Milan):** zda aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` míří do jedné schránky (krok 4).

## 2026-09-06 (12) — Čas vlastníka doplněn, limit 40 h vyhodnocen; vlastník chce ověření v provozu

**Čas vlastníka (odhad vlastníka, potvrzeno „sedí"):** architektura a rozhodování 1,5 h · posudky a review 2 h · ladění 0,25 h · provoz a účty 0,5 h = **4,25 h za M0–M4b**. Zapsáno do MEASUREMENT (tabulka + vyhodnocení: s AI wall-clock ≈ 3 h 45 min celkem ≈ 8 h, limit 40 h na MUST sadu splněn s velkou rezervou; lidský čas se s asistentem přesouvá do rozhodování a review), STATUS CZ/EN (kpi, tabulka měření včetně řádků M4b, warnbox, Zbývá 5 hotové, rozhodnutí), POSUDKY (otevřené položky uzavřeny). Kód beze změny.

**Nový pokyn vlastníka (6. 9. 2026 odpoledne): „chtěl bych to ověřit v provozu."** Návrh postupu je v odpovědi asistenta a v dalším záznamu, až se rozhodne: nejdřív krok 3 „lite" = nasazení skeletonu pěti Workerů na bass443 za Access s custom doménou (ověří účet, prostředky D1/R2/KV, Access, doménu, `/version` z farmy), pak zbytek kroku 2 (journal DO, audit D1, `/dispatch`, hosty, fakes, harness) a teprve potom golden mastery proti farmě. Id prostředků (D1, KV) jsou instalační hodnoty → patří do `config/farm-bass443/farm.json`, ne do base configů.

**Zbývá rozhodnout (Milan):** jestli aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` míří do jedné schránky (krok 4); souhlas s nasazením skeletonu na účet bass443 (vytváří DNS záznam pro `apf.maxferit.cz`, Access aplikaci a prostředky D1/R2/KV; na Free plánu bez nákladů).

## 2026-09-06 (11) — M4b krok 2, celek 1: instalace navázaná do Workeru, validátor bez generování kódu, rozhodnutí o adresách a plánu

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **208 testů**), `npm run arch` (20 instalačních hodnot, 0 nálezů), `npm run farm:check` (**10 configů** = 2 instalace × 5 deployables, včetně `tsc` nad deploy s generovanými moduly) zelené. **Ověřeno na `wrangler dev`** (což dry-run neumí, viz W13): gateway z `.wrangler/generated/{local-fakes,farm-bass443}/apf-gateway/wrangler.jsonc` odpovídá na `/version` `{"installation":"…","tenants":2,"identities":3,"policies":6,…}`; `/health` ok; `/dispatch` dál 501.

**Rozhodnutí (asistent na „up to you" vlastníka, 6. 9. 2026):** adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@maxferit.cz`; schránky v allowlistu = aliasy Email Routing `apf-ops@`, `apf-supervisor@` (tenant-42), `apf-ops-t7@maxferit.cz` (tenant-7), cíl přeposílání jen v účtu (repo skutečnou schránku nezná); plán **Workers Free** do kroku 5. Zapsáno v `config/farm-bass443/` (profil, policy, farm.json), v návrhovém listu (otevřené otázky) a ve STATUS. Čas vlastníka zůstává nezměřen (nejde rozhodnout za něj).

**Hotové v tomto celku:**
- `src/platform/schemas.ts`: Ajv nahrazen `@cfworker/json-schema` (interpret draft 2020-12; jediný `format` v kontraktech je `date-time`; jeden `Validator` per kontrakt s ostatními schématy přidanými kvůli `$ref`). Důvod: Ajv staví validátory přes `new Function`, workerd to zakazuje, dry-run bundle přesto projde (W13). `ajv`, `ajv-formats` odinstalovány.
- `src/platform/bytes.ts` (utf8, hex, base64url nad `Uint8Array`); `ids.ts` přes `crypto.getRandomValues`, `signing.ts` a `artifacts.ts` bez `Buffer`. Důvod: workers-types deklaruje globální `Buffer: any`, vedle @types/node to rozbíjí typy (W14).
- `scripts/farm-config.mjs`: pro každou `config/<inst>/` s profilem generuje `.wrangler/generated/<inst>/installation.ts` (statické importy profilu + policy, `assembleInstallation` při importu) a configy všech deployables s aliasem `apf:installation`, `vars.INSTALLATION` a nepovinným overlay `farm.json`. `farm-check` dry-runuje jen generované (base config sám build neprojde: kód + instalace = deployable). `farm.json` zjednodušen (INSTALLATION doplňuje generátor).
- `deploy/cloudflare/types/apf-installation.d.ts`; deploy tsconfig `types: [workers-types, node]` + include generovaných modulů; `apf-gateway` importuje `apf:installation`, při neshodě s `env.INSTALLATION` odpovídá 500 `INSTALLATION_MISMATCH`, `/version` hlásí instalaci.
- `tests/inst.test.ts` INST-004: každá `config/*/` se sestaví Node loaderem (farm profil je build input, ne fixture).
- Docs: BUILD (validátor, farm-config/farm-check, `apf:installation`), ARCHITECTURE, README CZ/EN (validátor), deploy README (dvouvrstvé configy, příkazy s generovaným configem, sekce Rozhodnuto), návrhový list (otázky rozhodnuty), MEASUREMENT (řádek celku, W13, W14, 208/INST-004), STATUS CZ/EN.

**Další celek (krok 2, celek 2): journal a audit s vyměnitelnou implementací.** Rozhraní `Journal`/`Audit` zůstávají v platformě; `DoSqliteJournal` (DO `WorkflowInstance`, SQLite storage) a `D1Audit` v `apf-gateway/src/`, ověřené miniflare (`wrangler dev` + D1/DO lokálně). Pak celek 3: `/dispatch` (identita z hlavičky Access service tokenu, lokálně dev hlavička; podpis klíčem z `.dev.vars`). **Pozor pro celek 3:** `signing.ts` používá `node:crypto` `sign`/`verify`/`generateKeyPairSync` s `KeyObject` (Ed25519); ve workerd přes `nodejs_compat` ověřit hned první věcí, jinak WebCrypto `crypto.subtle` (async → `Gateway.dispatch` async, dotkne se harnessu a testů `slice.gateway.dispatch(...)`). `credentials.ts` má `AsyncLocalStorage` (nodejs_compat ji podporuje). `journal.ts`/`audit.ts` s `node:fs` ve Workeru nahradí implementace z celku 2.

**Postup pro lokální ověření:** `node scripts/farm-config.mjs` → `npx wrangler dev -c .wrangler/generated/local-fakes/apf-gateway/wrangler.jsonc --port 8787` → `curl http://127.0.0.1:8787/version`.

**Zbývá rozhodnout (Milan):** čas vlastníka za M1–M4b; zda aliasy `apf-ops@`/`apf-supervisor@`/`apf-ops-t7@` míří do jedné schránky (nastavení v účtu, krok 4).

## 2026-09-06 (10) — M4b krok 1 HOTOVÝ (celek B): lint instalačních hodnot, generované wrangler configy, docs; 207 testů, pushnuto

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **207 testů**), `npm run arch` (0 nálezů, 17 instalačních hodnot z obou profilů), `npm run farm:check` (**10 configů**: 5 base + 5 vygenerovaných pro `farm-bass443`) zelené lokálně. Krok 1 návrhového listu farmy je uzavřený; po pushi ověřit CI (nově běží i lint nad `deploy/` a dry-run nad generovanými configy).

**Hotové v tomto celku:**
- `scripts/arch-dep.mjs`: komponenty už nesmí `node:path`/`node:url` (statické importy je nepotřebují); **lint instalačních hodnot**: načte `config/*/profile.json` (název instalace, tenanty, actorId identit, kanály) a `config/*/policy/*.json` (actorId grantů, allowlist příjemců: tenant, ref i adresa) a hlídá, že žádná z nich, žádný e-mail ani veřejný hostname (regex nad TLD) není literál v `src/**` (.ts řetězce mimo komentáře, .json hodnoty), `deploy/cloudflare/*/src/**` a base `wrangler.jsonc` (tam navíc zakázané `routes`). Jeden nález na literál. Bez argumentu kontroluje všechno, s argumentem jen daný strom (testy). Test v `arch.test.ts` (3. případ: tenant z profilu, e-mail, hostname → `FAILED (3)`).
- `scripts/jsonc.mjs` (sdílený JSONC reader), `scripts/farm-config.mjs` (`merge` base + `config/<instalace>/farm.json` → `.wrangler/generated/<instalace>/<deployable>/wrangler.jsonc`, `main` přepočítaný relativně, `$schema` pryč; deployable v overlay musí existovat, nepojmenovaný dostane base beze změny), `scripts/farm-check.mjs` dry-run nad base i generovanými; **natvrdo zapsané account id ze skriptu pryč** (dry-run ho nepotřebuje, ověřeno).
- Base `wrangler.jsonc`: z gateway pryč `routes`, z email-executoru `EMAIL_FROM`/`EMAIL_FROM_NAME`, z mail-ingestu adresa v komentáři; overlay je má v `config/farm-bass443/farm.json`. Lint tyto čtyři hodnoty při prvním běhu našel (shoda s auditem v (5)).
- Docs: BUILD (příkazy `arch`/`farm:check`/`farm-config`, pin `CONTRACTS-VERSION.json`, sekce „Instalační profil", CI, testy `inst` + `mail`), ARCHITECTURE (`createSlice(installation, secrets, volby)`, `DispatchTransport`, statické importy; F1/F3 řádky), README CZ/EN (řádky `contracts/`, `config/`, `src/platform/`, `src/slice.ts`, `src/installation.ts`, `workflows/`), deploy README (dvouvrstvé configy, příkazy z generovaného configu, cesta k policy), MEASUREMENT (řádek M4b krok 1: ≈ 1 h 10 min AI, ≈ 1 010 řádků; W12 „vyřešeno v řezu"; „Co je zelené" 207/11 + INST), STATUS CZ/EN (kpi 207/11, hotové M4b krok 1, zbývá 1 = krok 2).

**Poznámky pro krok 2 (wrangler dev + harness proti localhost):**
- `HttpDispatchTransport` existuje, ale nikdo ho nevolá; harness `dispatch()` a orchestrátory berou `slice.transport`, takže přepnutí na HTTP je jen jiná instance v `createSlice` (volba `transport?`) nebo v `tests/harness/index.ts`.
- `Journal` a `Audit` v `src/platform` stále umí soubor (`node:fs`); ve Workeru půjde journal do DO SQLite a audit do D1: rozhraní zůstávají, implementace se vymění v gateway Workeru, ne v platformě.
- Worker si profil vezme statickým importem `config/<instalace>/profile.json` + policy podle `INSTALLATION` var (build-time výběr přes `farm-config`, ne runtime `fs`); to je první věc kroku 2.
- Fakes očekávají hodnoty `dms-secret`/`archive-secret`/`smtp-secret` (defaulty konstruktorů adaptérů); na farmě je nahradí skutečné secrets přes `SecretsSource` z `env`.

**Rozpracované / chybí:** krok 2 (výše); krok 3 nasazení (D1, R2 eu, KV, secrets, Access, doména); krok 4 e-mail; krok 5 fronta + RES-CRASH přes evikci DO; krok 6 pentest ADR-017 + řádek M4b s cenou; čas vlastníka do MEASUREMENT; W4 do normy; část XVII ve foundation (W12 + INST jako evidence pro instalační profil v normě).

**Zbývá rozhodnout (Milan):** beze změny: adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@maxferit.cz` a schránka za `ops-mailbox` (dnes placeholder v `config/farm-bass443/policy/email.send.v1.policy.json`); čas vlastníka za M1–M4.

## 2026-09-06 (9) — M4b krok 1, celek A ZELENÝ: platforma bez disku, instalační profil v kompozičním kořeni, 206 testů

**Stav:** `npm run typecheck`, `npm test` (11 souborů, **206 testů** = 198 + 8 nových INST), `npm run arch`, `npm run farm:check` zelené lokálně. Repo je po (8) zase funkční. Tento commit uzavírá body 1–4 z (8); body 5–7 (lint instalačních hodnot, `farm-config`, docs) jsou celek B a jdou hned za ním.

**Hotové v tomto celku:**
- `src/platform/schemas.ts`: pět schémat + `contracts/CONTRACTS-VERSION.json` importované staticky; žádné `node:fs`/`node:path`/`node:url`, žádný `projectRoot`, žádný `loadJson`. `CONTRACTS_VERSION` má stejný tvar jako dřív (`1.0-rc2.1 12a3c32`), navíc `CONTRACTS_PIN` (celý objekt).
- `workflows/workflow-definition.schema.json` (nové, slice-local, ne kontrakt foundation) + `src/platform/workflow.ts` s `parseWorkflowDef()`: schéma, unikátní id kroků, každý `$steps.<id>` ukazuje na dřívější krok; jinak výjimka.
- `src/installation.ts`: `credentialTable()` teď bere `{ handlerId: [reference, které kód potřebuje] }` a kontroluje, že profil je handleru přiznává (kód říká, co potřebuje; profil, co smí; obojí musí sedět). Přidané kontroly: duplicitní `actorId`, identita v neznámém tenantu.
- `src/installation-node.ts`: `loadInstallationFromDir(dir)` (fs až při volání) pro testy a Node.
- `src/slice.ts`: `createSlice(installation, secrets, opts)`; identity z profilu, policy přes `policyFor()`, credential tabulky přes `credentialTable()` per host, `InProcessTransport` do obou orchestrátorů i do návratu (`slice.transport`), workflow definice importované staticky a parsované (`WORKFLOW_DEFINITIONS`, `workflowDef(name)`). **Konstanty tenantů a identit ze `src/` zmizely**; `DEFAULT_CLOCK_START` zůstává (testovací default hodin, ne instalační hodnota).
- Harness: `tests/harness/paths.ts` (`projectRoot`, `loadJson` jen pro testy), `tests/harness/installation.ts` (`LOCAL_FAKES` z `config/local-fakes`, `FAKE_SECRETS`, `ORCHESTRATOR`/`TENANT_A`/`ORCHESTRATOR_B`/`TENANT_B`/`AI_AGENT` odvozené z profilu, ne literály), `index.ts` obaluje `createSlice(o)` a `dispatch()` jde přes `slice.transport`. Opravené importy v `suite.ts`, `rogue.ts`, `ctr.test.ts` (allowlist příjemců z `LOCAL_FAKES.policies`), `sec.test.ts`, `arch.test.ts`, `wf.test.ts` (dva `new Orchestrator` s `transport`).
- `tests/inst.test.ts` (INST-001..003): profil proti schématu, chybějící policy, policy bez `failClosed`, grant neznámé identitě / scope, který identita nedrží / neznámému tenantu, `roles.orchestrator` mimo identity; credential tabulka (handler bez záznamu, nepřiznaná reference, chybějící secret); workflow definice (schéma, duplicitní krok, dopředný `$steps`).

**Celek B (další commit):** 5. `scripts/arch-dep.mjs` zpřísnit (komponenty bez `node:path`/`node:url`) + lint instalačních hodnot v `src/**` a `deploy/cloudflare/*/src/**`; 6. `scripts/farm-config.mjs` + `farm:check` i nad generovanými configy, z base `wrangler.jsonc` pryč `routes` a `EMAIL_FROM*`; 7. docs (BUILD, README CZ/EN, ARCHITECTURE, deploy README, MEASUREMENT řádek M4b krok 1, STATUS CZ/EN). Push až po celku B (CI běží `farm:check`, generované configy musí projít).

## 2026-09-06 (8) — M4b krok 1 ROZPRACOVÁNO a přerušeno: portabilita platformy + instalační profil, repo je ČERVENÉ

**Pravidlo vlastníka od této chvíle:** postupovat po malých celcích jako po milnících; po každém celku aktualizovat HANDOFF a commitnout. Žádné velké dávky změn napříč deseti soubory najednou.

**Stav: NEKOMPILUJE a testy by nenaběhly.** Tento commit je záměrný snímek rozpracované práce, ne funkční stav. **Nepushovat, dokud další celek nezezelená** (CI by spadlo, GitHub je zdroj pravdy pro druhý PC). Typecheck: 5 chyb (`src/slice.ts` importuje odstraněný `loadPolicy` a orchestrátoru předává `gateway`/`router` místo `transport`; `tests/wf.test.ts` totéž na dvou místech). Runtime: `src/platform/schemas.ts` stále čte disk při importu a hledá textový `contracts/CONTRACTS-VERSION`, který je smazaný → import platformy by spadl na ENOENT.

**Hotové v tomto celku (funguje samo o sobě):**
- Pět handlerů importuje descriptor a schémata staticky (`import x from "./…json" with { type: "json" }`), bez `node:path`/`node:url`/`loadJson`. `loadJson` odebrán z `platform/api.ts`.
- `src/platform/policy.ts`: bez čtení disku; typy `Policy`, `PolicySet`, `policyFor` (fail-closed), `checkGrant`. `loadPolicy` odstraněn.
- `src/platform/transport.ts`: rozhraní `DispatchTransport`, `InProcessTransport` (gateway + router), `HttpDispatchTransport` (POST `/dispatch`, v těle jen `message`, identita jen z hlaviček, odpověď validovaná proti result-envelope). Orchestrátor už bere `transport` místo `gateway`+`router`.
- Instalační profil: `config/profile.schema.json`, `config/local-fakes/profile.json` (tenanty, identity, role orchestrátoru, credential reference per handler jen jménem, kanály null, retence, policyRefs), `config/farm-bass443/profile.json` (NÁVRH adres, čeká na vlastníka) a `config/farm-bass443/farm.json` (overlay routes/vars per deployable pro budoucí `scripts/farm-config.mjs`). Šest policy přesunuto `git mv` z `contracts/policy/` do `config/local-fakes/policy/` a zkopírováno do `config/farm-bass443/policy/`; v `contracts/policy/` zůstal jen vzor z foundation.
- `src/installation.ts`: typy `InstallationProfile`, `Installation`, `SecretsSource`; `assembleInstallation()` (schéma, každý policyRef přítomen, každý grant ukazuje na známou identitu s daným scope a známý tenant, `failClosed` povinné) a `credentialTable()` (chybějící secret = výjimka).
- `contracts/CONTRACTS-VERSION.json` místo textového souboru.

**Další malý celek = zezelenat (odhad 1 session, cca 10 souborů):**
1. `src/platform/schemas.ts`: statické importy pěti schémat a `CONTRACTS-VERSION.json`, odstranit `readFileSync`/`projectRoot`/`loadJson` (návrh byl připraven, zápis se nestihl).
2. `src/installation-node.ts`: `loadInstallationFromDir(dir)` (fs až při volání) — Node helper pro testy.
3. `src/slice.ts`: `createSlice(installation, secrets, opts)`; identity z profilu, policy přes `policyFor(installation.policies, …)`, credential tabulky přes `credentialTable()` per host, `InProcessTransport` do orchestrátorů a do návratu, workflow definice staticky importované a validované proti novému `workflows/workflow-definition.schema.json`; odstranit exportované konstanty tenantů a identit.
4. Harness: `tests/harness/paths.ts` (projectRoot, loadJson jen pro testy), `tests/harness/installation.ts` (LOCAL_FAKES z `config/local-fakes`, FAKE_SECRETS `cred:dms-stamp`→`dms-secret`, `cred:archive-store`→`archive-secret`, `cred:smtp`→`smtp-secret`, konstanty TENANT_A/B, ORCHESTRATOR(_B), AI_AGENT odvozené z profilu), `index.ts` obal `createSlice(o)` = core(LOCAL_FAKES, FAKE_SECRETS, o), `dispatch()` přes `slice.transport`; opravit importy v `suite.ts`, `rogue.ts`, `ctr.test.ts` (cesta k `email.send` policy je teď `config/local-fakes/policy/`), `sec.test.ts`, `arch.test.ts`, `wf.test.ts` (dva `new Orchestrator` s `transport`).
5. `scripts/arch-dep.mjs`: komponenty smí importovat jen `./`, `platform/api`, `adapters/*` (bez node:path/url); nový lint: žádný literál z `config/*/profile.json` a policy (tenanty, actor id, adresy, hosty) ani e-mail/doména regexem v `src/**` a `deploy/cloudflare/*/src/**`.
6. `scripts/farm-config.mjs` (merge base wrangler.jsonc + `config/<instalace>/farm.json` → `.wrangler/generated/`), `farm-check` dry-run i nad generovanými; z base configů odstranit `routes` a `EMAIL_FROM*`.
7. Docs po zezelenání: BUILD (CONTRACTS-VERSION.json, config/), README CZ/EN (řádek `config/`), ARCHITECTURE (profil, transport), deploy README, MEASUREMENT (M4b krok 1 řádek), STATUS.
Brána celku: `npm run typecheck`, `npm test` (198), `npm run arch`, `npm run farm:check` zelené; pak push.

## 2026-09-06 (7) — Posudky 2–4 nad implementací: 9,2/10 formální oponentura, dva konverzační; AI-EVAL jako podmínka v1.0, pentest o eskalaci práv

**Zdroj:** tři další posudky postoupené vlastníkem, protokol v `docs/POSUDKY.md`. Shoda se posudkem 1: norma nevyvrácena, 0 BLOCKER, 1 MAJOR (fyzická izolace, plán M4b), 3 MINOR (AI-EVAL, čas vlastníka, provozní realita).

**Co se změnilo:**
1. **Reálný model = podmínka v1.0** s konkrétním minimem: Workers AI za `document.classify`, golden set 10 faktur + 3 injection s ownerem labelů, `criticalFields: [documentType]`, `AI-EVAL-REG-001` + `AI-EVAL-ADV-001`. Krok 7 návrhového listu. Návrh pro foundation: XII.D doplnit podmínku v1.0 o AI-EVAL s reálným modelem.
2. **Pentest** kroku 6 rozšířen o scénář (d) eskalace práv (nepřímé cesty k cizím bindingům a podpisovému klíči).
3. **Durable Objects:** zapsáno, jak journal přežije evikci (stav jen v SQLite storage, `recover()` při reaktivaci, audit append-only v D1).
4. **Meze smyček** doloženy z workflow definic (2 strategie × qualityBudget 2, technicalRetries 2, reconciliationBudget 3, eskalace review 2, deadline 30 / 10 min) a zapsány do STATUS.
5. **STATUS „Zbývá" je číslované podle priority**; kategorie času vlastníka sjednoceny (posudky 1 a 2).

**Zbývá rozhodnout (Milan):** beze změny (čas vlastníka v členění, adresy pro farmu, schránka za `ops-mailbox`). Otázka posudku 3 „co bylo nejtěžší a co jinak" má v protokolu odpověď z pohledu implementace; odpověď vlastníka může být jiná.

## 2026-09-06 (6) — Posudek 1 nad implementací (9,1/10): W4 rozhodnuto jako CONDITIONAL, pořadí dalších kroků upraveno

**Zdroj:** externí posudek nad `STATUS.html`, který vlastník postoupil. Protokol s dispozicí každého doporučení: `docs/POSUDKY.md`. Hlavní závěr: první implementace normu nevyvrátila, testy našly konstrukční chyby, druhý tok prokázal reuse za 45 řádků platformy.

**Co se změnilo v plánu:**
1. **W4 rozhodnuto:** CONDITIONAL pravidlo (AI výstup → state-changing krok s `riskClass ≥ MEDIUM` vyžaduje nezávislý signál nebo human gate), ne univerzální invariant. V řezu zůstává druhý signál ve validátoru. Návrh pro foundation část XVII.
2. **Pořadí:** M4b farma → pentest credential izolace (tři otázky s očekávaným NE, kritéria v návrhovém listu krok 6) → reálný LLM + AI-EVAL → **třetí doména** kvůli mezní ceně → M5 `EXISTS × 2` → M6.
3. **M6 zúženo:** první sdílený balíček = kontrakty, schémata, fixtures, conformance runner. Orchestrátor a executor runtime zůstávají duplikované déle (P2).
4. **Měření:** čas vlastníka se člení (architektura / review / ladění / provoz); nová metrika „platforma +řádků na novou doménu" (M4 = 45).
5. **Formulace PRINCIPAL:** „design proven, physical isolation not yet proven", dokud `email.send` neběží jako vlastní deployable.

**Zbývá rozhodnout (Milan):** beze změny: čas vlastníka za M1–M4; adresy pro farmu (`apf.maxferit.cz`, `apf-intake@`, `apf-notify@`) a schránka za `ops-mailbox`. Cloudflare plán: začít na Free (fronty jsou dostupné, 10 000 operací/den), Paid až kdyby nestačil CPU limit 10 ms na požadavek.

## 2026-09-06 (5) — M4b zahájeno: farma na Cloudflare, návrhový list + skeleton pěti deployables

**Rozhodnutí vlastníka:** postavit malou farmu na Cloudflare, aby se závěry řezu ověřily na skutečném runtime (izolace PRINCIPAL, transport, fronta, pád DO, reálný model, reálná pošta). Zařazeno jako **M4b před M5/M6**, protože vyrábí evidenci pro otevřená rozhodnutí (pentest ADR-017, cena PRINCIPAL deployables). Žije v tomto repu (`deploy/cloudflare/`), testy a golden mastery zůstávají sdílené.

**Hotové v této session:**
- `docs/NAVRHOVY-LIST-farma.md` podle šablony ai-agenti: vstupy a odchozí kanály, nepřátelský vstup, regulace a retence per datová třída, scénáře S1–S5, brány a write akce, křížová kontrola, limity, selhání a vypínač, pět deployables jako moduly, pořadí stavby v šesti krocích, náklady, tři otevřené otázky.
- `deploy/cloudflare/`: `wrangler.jsonc` + stub Worker pro `apf-gateway` (DO `WorkflowInstance`, D1 audit, R2, Workers AI, service bindings, secret podpisového klíče), `apf-document-host` (LOGICAL, dva secrets), `apf-email-executor` (PRINCIPAL, jediný binding = Email Sending, žádné secrets), `apf-mail-ingest` (`email()` handler, R2), `apf-fakes` (KV chaos přepínače). Všechny odpovídají `501 NOT_WIRED` mimo `/health` a `/version`; nic není nasazené.
- `scripts/farm-check.mjs` + `npm run farm:check`: `wrangler deploy --dry-run` pro všech pět configů bez přihlášení. **Prošlo** (wrangler 4.129.0, workers-types nainstalované jako devDependency).
- Ověřeno `wrangler whoami`: účet **bass443** (`a37a36270aa2db7382f62912ba5a0130`), kde je zóna maxferit.cz, Access i Email Sending.

**Pravidlo vlastníka (6. 9. 2026): instalační profil.** Doména, adresy kanálů, identity, tenanty, granty, allowlisty a klíče jsou vázané na konkrétního zákazníka a prostředí; kód musí být pro každou instalaci stejný a nová instalace nesmí vyžadovat zásah do `src/`. Tři vrstvy (kód / instalační profil `config/<instalace>/` / secrets) a lint na instalační hodnoty v kódu jsou popsané v `docs/NAVRHOVY-LIST-farma.md` (sekce „Instalační profil"). Audit ukázal dnešní porušení: konstanty v `src/slice.ts`, `recipientAllowlist` a granty v `contracts/policy/`, doména a `EMAIL_FROM` ve `wrangler.jsonc`.

**Další krok = krok 1 návrhového listu (bez cloudu):** portabilita platformy **a instalační profil**. `src/platform/schemas.ts` a `policy.ts` čtou disk při importu (`readFileSync`, `projectRoot`), což ve Workeru neexistuje. Kontrakty se budou importovat staticky jako JSON; identity, tenanty a policy se přesunou do `config/local-fakes/` (testy) a `config/farm-bass443/` (farma), načítané přes schéma fail-closed; testy musí zůstat zelené. Pak rozhraní `DispatchTransport` (`in-process` = dnešní `slice.ts`, `http` = klient na farmu), aby týchž 198 testů běželo proti oběma.

**Rozpracované / chybí:**
1. Krok 1 (portabilita) a krok 2 (gateway + document-host + fakes na `wrangler dev`, harness proti localhost).
2. Krok 3 nasazení: D1, R2 (jurisdiction eu), KV, secrets, Access aplikace, custom doména `apf.maxferit.cz`.
3. Krok 4 e-mail: Email Routing rule `apf-intake@maxferit.cz`, Email Sending `apf-notify@maxferit.cz`, skutečná schránka za `ops-mailbox`.
4. Krok 5 fronta (Workers Paid) a `RES-CRASH-001` přes evikci DO; krok 6 pentest ADR-017 a řádek M4b v MEASUREMENT s cenou.
5. Stále: čas vlastníka do MEASUREMENT; W4 do normy?; část XVII ve foundation.

**Zbývá rozhodnout (Milan):** (a) Workers Paid kvůli Queues, nebo první verze bez front; (b) adresy `apf.maxferit.cz`, `apf-intake@`, `apf-notify@` a schránka za `ops-mailbox`. Kroky 1–2 na tom nezávisí.

## 2026-09-06 (4) — M4 hotové: druhý tok mail.ingest → document.* → email.send, W4 rozhodnuto druhým signálem

**Stav:** `npm run typecheck`, `npm test` (10 souborů, 198 testů) a `npm run arch` zelené lokálně. Tři rozhodnutí z minulého zápisu vzal na sebe asistent na pokyn vlastníka („up to you"): W4 řešit v řezu druhým deterministickým signálem a měřit; M4 žije v tomto repu jako druhý deployable; čas vlastníka zůstává nezměřen (nelze vymyslet).

**Hotové v této session:**
- `src/components/mail-ingest` (`mail.ingest/1`, internal-write, vlastní host bez credentialů, immutable originál z raw mailu, From/Subject parsovány pravidly a uloženy jako data, `STORAGE_FULL` při plném úložišti).
- `src/components/email-executor` (`email.send/1`, external-write, MEDIUM, **PRINCIPAL** = vlastní `ExecutorHost` + vlastní `CredentialResolver` s jediným `cred:smtp`; `recipientRef` se překládá na adresu jen přes `recipientAllowlist` v `contracts/policy/email.send.v1.policy.json`; šablony jen z enum a id; IRREVERSIBLE, reconcile přes `smtp.status(clientRef)`).
- `src/adapters/smtp.ts` (fake s dedup podle `clientRef` = business identita, režimy ok / unknown-once / unknown-always / reject), `ArtifactStore` s kapacitou a `put` v `ArtifactWriter`.
- `workflows/mail-intake.v1.json`: ingest → classify → validate → stamp → notify; vnořené `inputs` a `deadlineMs` per krok v orchestrátoru; orchestrátor zpracovává jen instance své definice (`workflow` guard v `run` i `recover`).
- W4: `document-validator` dostal `crossCheck` (pravidla nad textem bez instrukčních řádků); neshoda = `CLASSIFICATION_DISPUTED` (QUALITY) → review. Scénář `injection-in-allowlist` teď končí WAITING(REVIEW), ne razítkem.
- Conformance `mail.ingest` (5/1/2/1 + 4 error), `email.send` (5/1/1/1 + 7 error), golden master `mail-intake.v1` (5 scénářů), scénáře `document-intake.v1` přepsány do obecného formátu (`$artifact`, `$fixtureText`).
- Testy: `tests/mail.test.ts` (MUST sada `email.send` vč. 4 mutantů na druhém hostu, SEC-CTX-002 mezi toky, SEC-HOST-001 PRINCIPAL varianta, IDM-RET-002, RES-STOR-001, WF-UNK na SMTP, EVD toku 2, dvě workflow v jednom journalu); `ctr.test.ts` a `int.test.ts` zobecněny přes všechny komponenty a workflow adresáře.
- Stavový list `STATUS.html` (CZ) + `STATUS.en.html` (EN) v kořeni repa, stejná rodina jako ai-agenti a job-watch; odkazy v obou README. Aktualizovat každou session spolu s HANDOFF a MEASUREMENT.

**Nálezy této session (detail MEASUREMENT N10–N12):** sdílený journal by bez guardu nechal orchestrátor jednoho workflow „obnovit" instanci druhého; druhý signál chytil injection uvnitř allowlistu v obou tocích; fixture injekce jen v hlavičkách neměla co „poslechnout" (chyba scénáře, ne kódu).

**Rozpracované / chybí:**
1. Čas vlastníka do MEASUREMENT (M1–M4).
2. Ověřit CI po pushi.
3. M5 podle XII.G: obnova `EVIDENCE-MATRIX.md` ve foundation se dvěma novými řádky (document-intake, mail-intake) a Core Admission review `EXISTS × 2` (kandidáti: result envelope, error object, ClockFixture, CredentialResolverFixture, conformance runner, `subsetDiff` golden porovnání).
4. Přenést N5–N12 a W1–W10 do foundation jako část XVII „Protokol implementace".
5. Backoff a circuit breaker u technického retry (W6) až s durable frontou; alert při `STORAGE_FULL` (W10).

**Zbývá rozhodnout (Milan):** (a) zda W4 zůstane v řezu jako implementační volba, nebo půjde do normy jako CONDITIONAL pravidlo pro `usesLlm → write s riskClass ≥ MEDIUM`; (b) zda M5/M6 (první sdílený kontraktový balíček) začít hned, nebo napřed pentest izolace hostu podle ADR-017.

## 2026-09-06 (3) — M1 dokončeno, M2 a M3 hotové: 132 testů, 44 Test ID, MUST sada zelená

**Stav:** `npm run typecheck`, `npm test` (9 souborů, 132 testů) a `npm run arch` procházejí lokálně. CI `kontrola` dosud padala na chybějících testech a chybějícím `scripts/arch-dep.mjs`; oboje je teď v repu, CI přepnuto na Node 24 (varování o deprecaci Node 20 na runnerech).

**Hotové v této session:**
- Komponenty: `document-classifier/handler.ts` (prompt s oddělovači, enum allowlist čtený z output schématu, QUALITY retry s novým klíčem, provenance s modelId/promptVersion), `document-validator/` (descriptor s `dependsOn`, integrita sha256, registr přes `withTimeout`, mapování chyb, obě varianty INT-FAIL-004), `document-executor-host/` (descriptor se dvěma capability LOW/LOGICAL, stamp handler + reconciler přes `clientRef = idempotencyKey`, archive handler jako druhý handler v hostu). Output schémata pro všechny čtyři capability.
- Platforma: reconciliation hook v `ExecutorHost.reconcilerFor` (dedup záznam sleduje výsledek reconciliace), orchestrátor drží stejný `idempotencyKey` při technickém retry (`logicalAttempt` v journalu), `applyReviewExpiries` (WF-REV-003 mění stav instance), `acceptedMechanisms` v routeru (podvržený `in-process` binding neprojde), grace period klíče v `KeyRegistry` (SEC-CRED-003), `correlationId` na review tascích, `Audit.all()` vrací hluboké kopie.
- Kontrakty řezu: `contracts/policy/document.{classify,validate,stamp,archive}.v1.policy.json` (ADR-016), `workflows/document-intake.v1.json`, `src/slice.ts` (kompoziční kořen), `scripts/arch-dep.mjs` (ARCH-DEP-001 + lint hodin, VC §8.1).
- Conformance: `conformance/document.{classify,validate,stamp,archive}/` (fixtures, golden, README s MUST/DON'T CARE, `errors.md`, `compat.md`), `conformance/workflows/document-intake.v1/` (5 scénářů, golden master pro INT-E2E-001).
- Testy podle rodin: `tests/{ctr,sec,mut,idm,wf,res,int,evd,arch}.test.ts`, harness v `tests/harness/` (suite loader, conformance runner, rogue handlery pro SEC-HOST).
- `docs/MEASUREMENT.md`: M1–M3 zapsáno, 9 nálezů (4 zachytil test při prvním běhu, 4 vzešly z psaní testu proti normě, 1 doložená mez normy), 9 položek „obejito / chybělo" s návrhy pro foundation.

**Nejdůležitější nálezy pro foundation (detail v MEASUREMENT):** N5 klíč při technickém retry, N6 `in-process` binding, N7/W2 kdo mění dedup záznam po reconciliaci, N9/W4 injection uvnitř allowlistu projde F2.

**Rozpracované / chybí:**
1. Čas vlastníka do MEASUREMENT (řádky M1–M3), bez něj limit 40 h nejde vyhodnotit.
2. Ověřit zelené CI po pushi (gitleaks nad `dms-secret`/`archive-secret` v `src/slice.ts` by neměl reagovat, jsou to fake hodnoty; kdyby ano, allowlist v `.gitleaks.toml`).
3. M4 podle XII.G: druhý tok `mail.received` → `email.send` (PRINCIPAL, vlastní deployable), SEC-CTX-002 mezi oběma toky. WIP limit: až po uzavření M3, což je teď.
4. Nálezy N5–N9 a W1–W7 přenést do foundation jako část XVII „Protokol implementace" (změna zmrazených dokumentů jen s evidencí odsud, viz XVI).

**Zbývá rozhodnout (Milan):** (a) zda W4 (injection uvnitř allowlistu) řešit v normě druhým signálem, nebo nechat na AI-EVAL; (b) zda M4 žije v tomto repu (druhý deployable vedle) nebo v novém.

## 2026-09-06 (2) — M1 rozpracováno: platformové minimum a adaptéry, bez testů

**Stav:** typecheck prochází (`npx tsc --noEmit`), `npm test` zatím nemá co spouštět (žádný test soubor). Vlastník zastavil práci uprostřed M1; tento commit ukládá rozpracovaný stav tak, jak je, aby se dalo pokračovat z jiného počítače.

**Hotové (`src/platform`, 1 783 řádků včetně adaptérů):**
- `types.ts` (zrcadlí schémata), `clock.ts` (`SystemClock`, `FakeClock` = ClockFixture), `ids.ts`, `canonical.ts` (JCS), `schemas.ts` (Ajv nad `contracts/`, `CONTRACTS_VERSION`), `errors.ts` (tabulka platformových kódů s `retryable`/`reissuable`, `UnknownOutcomeError`, `ProcessCrash`).
- `signing.ts`: Ed25519 přes `node:crypto`, `KeyRegistry` s okny platnosti a ověřením proti klíči platnému v `signedAt` (SEC-CRED-002/003), `Signer` jen pro gateway, `verifyBinding` nad JCS `{message, context}`.
- `gateway.ts` (identity → `TrustedContext`, podpis, `rotate`), `policy.ts` (ADR-016 JSON policy per capability, `checkGrant`), `audit.ts` (append-only, bez update/delete API), `artifacts.ts` (immutable originál, `derive` s `derivedFrom`, `ArtifactReader`/`ArtifactWriter`), `credentials.ts` (CredentialResolverFixture: identita handleru z `AsyncLocalStorage`, režimy `strict`/`mutant`), `journal.ts` (JSON soubor, `structuredClone`).
- `router.ts`: řetězec schema → binding → expirace contextu → scope → policy grant (tenant) → input schema → handler; DENY audituje; sestavuje a validuje result envelope; `seen[]` pro SEC-INJ-001.
- `executor-host.ts`: allowlist → context match → deadline s tolerancí 30 s a skew logem → idempotency store → audit před/po → side effect pod identitou handleru; `mutants` flagy (MUT-PRIV-001, MUT-CTX-001, MUT-IDM-001, MUT-IDM-002). **Nález pro MEASUREMENT:** norma neříká, které outcomes idempotency store drží; zvoleno SUCCEEDED a UNKNOWN_OUTCOME (FAILED před side effectem zůstává retryable pod stejným klíčem).
- `review.ts` (task, authz rozhodnutí, `expire()` s policy vč. ESCALATE + `escalateTo` + hloubka), `orchestrator.ts` (statická definice, technical/quality retry s novým klíčem, WAITING(REVIEW), UNKNOWN_OUTCOME → reconciliation s budgetem → review, `recover()` po restartu, `resumeAfterReview`, pinning verze, publikovaný stav při reconciliaci), `api.ts` (jediná fasáda pro komponenty).
- `src/adapters`: `llm.ts` (`FakeLlmAdapter` záměrně náchylný na injection; `KeywordClassifierAdapter` pro INT-REPLACE-001), `registry.ts` (režimy ok / timeout / unavailable / business / nonsense-range / nonsense-semantic pro INT-FAIL-001..004), `dms.ts` (režimy ok / unknown-once / unknown-always / crash-after-write / auth-fail; `status`, `read` pro reconciliaci).
- `src/components/document-classifier`: `descriptor.json` (PROVIDER + AI_CAPABILITY, `usesLlm`), `input.schema.json`. **Handler ještě není** (zápis byl přerušen).

**Rozpracované / chybí:**
1. `document-classifier/handler.ts` (prompt s `<untrusted>` oddělovači, enum allowlist, QUALITY retry jinou strategií, provenance).
2. `document-validator/` (descriptor s `dependsOn`, handler: tenant, sha256 integrita, registr přes `withTimeout`, mapování chyb, nonsense varianty).
3. `document-executor-host/` (descriptor se dvěma capability `document.stamp` + `document.archive`, LOW/LOGICAL; stamp handler + reconciler; rogue handler pro SEC-HOST-001).
4. `contracts/policy/document.{classify,validate,stamp,archive}.v1.policy.json`, `workflows/document-intake.v1.json`, `scripts/arch-dep.mjs`, `src/slice.ts` (kompoziční kořen pro testy).
5. `conformance/` balíčky (5 + 1 + 1 + 1 fixtures, golden, `errors.md`, `compat.md`) a `tests/` podle rodin (CTR, SEC, MUT, IDM, WF, INT, RES, EVD, ARCH).
6. `docs/MEASUREMENT.md`: zapsat M1 (wall-clock, řádky, nález o idempotency store).

**Zbývá rozhodnout (Milan):** nic nového; postup podle XII.G platí.

## 2026-09-06 — M0: kostra repa, pinované kontrakty

- **Účel:** první implementace podle `Anamax443/agent-platform-foundation` v1.0-rc2.1 (zmrazeno). Řez podle XII.G:
  `document.classify` (AI) → `document.validate` (deterministický) → `document.stamp` (write executor, LOW, LOGICAL).
- **Kontrakty:** zkopírovaná schémata a vzor policy z foundation, pin v `contracts/CONTRACTS-VERSION`
  (`1.0-rc2.1 12a3c32`). Schémata se tady **nemění**; nález proti nim jde do `docs/MEASUREMENT.md` a zpět do foundation s evidencí.
- **Stack:** TypeScript, Node 20+, Vitest, Ajv. Bez frameworku a bez cloudu: první řez běží lokálně s adapter fakes,
  aby testy `CTR`, `SEC`, `IDM`, `WF`, `INT`, `RES`, `EVD` byly deterministické. Nasazení na Workers je až M4+.
- **Hotové:** kostra podle project-standard, `package.json`, `tsconfig`, `vitest.config`, `docs/MEASUREMENT.md`
  s lean kategoriemi a pravidly měření (AI wall-clock ≠ hodiny vlastníka; WIP limit jeden řez).
- **Rozpracované:** M1 (descriptory + platformové minimum: hodiny, id, schémata, JCS, Ed25519 podpis, gateway, router, policy).
- **Zbývá:** M2 conformance balíčky, M3 MUST testy + mutanty + INT + E2E + RES-CRASH + SEC-HOST, pak M4 druhý tok.
