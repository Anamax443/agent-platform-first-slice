# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

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
