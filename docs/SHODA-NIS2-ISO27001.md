# Shoda s NIS2 a ISO/IEC 27001 — mapování kontrol farmy (agent-platform-first-slice)

Požadavek vlastníka (6. 9. 2026): „vše musí splňovat NIS2, ISO 27000 atd." Tento dokument mapuje, **co farma dělá dnes**, **kde je to doložené** a **co chybí**, proti oblastem ISO/IEC 27001:2022 (Annex A) a NIS2 čl. 21 odst. 2. Není to prohlášení o shodě; je to evidence pro ISMS a seznam mezer, který se aktualizuje s každým celkem (stejně jako MEASUREMENT).

**Rozsah:** farma `farm-bass443` (Cloudflare účet bass443, zóna maxferit.cz): gateway s objekty instancí, hosty, R2, D1, Workers AI, volitelně Anthropic API. Role: vlastník je provozovatel i správce údajů; Cloudflare a Anthropic jsou zpracovatelé (dodavatelé).

## Mapování kontrol

| Oblast (ISO 27001 A.x / NIS2 čl. 21) | Co farma dělá dnes | Evidence (kde) | Mezera / další krok |
|---|---|---|---|
| Řízení přístupu (A.5.15–5.18, A.8.2–8.5; NIS2 21(2)(i)) | Vstup jen přes Cloudflare Access: politika „Jen Ja" (lidé) a service token `apf-harness` (stroje); hosty bez veřejné routy, jen service bindingy; identity a scopes z profilu instalace, policy per capability fail-closed (ADR-016); AI identita bez write scope (F1) | `config/farm-bass443/profile.json`, `policy/*.json`, `deploy/cloudflare/README.md`, testy `SEC-PRIV`, `SEC-CTX`, `INST-001` | ověření Access JWT ve Workeru (dnes jen hlavička od Access; `WIRED.accessJwtVerified=false`); mapování Access identit na `human` identity profilu; review role zatím bez skutečných uživatelů |
| Kryptografie a klíče (A.8.24; NIS2 21(2)(h)) | Obálky podepsané Ed25519 (JCS kanonizace), privátní klíč jen jako Worker secret, veřejný klíč v overlay instalace, okna platnosti a grace period v `KeyRegistry` (SEC-CRED-002/003); TLS a šifrování at rest zajišťuje Cloudflare | `src/platform/signing.ts`, `config/farm-bass443/farm.json` (`$signingPublicKeys`), HANDOFF (17) | rotace klíče ještě neproběhla v provozu (postup: nový `keyId` + nový secret + redeploy hostů); hosty dosud veřejný klíč nedostávají (celek D) |
| Logování a audit (A.8.15, A.5.28; NIS2 21(2)(b),(f)) | Audit append-only: v objektu instance (SQLite) a kopie ve společné D1; každý záznam má aktéra, čas UTC, druh, korelaci; mazání instance zanechá záznam `PURGED` s aktérem a důvodem; `EVD-004` hlídá, že audit nemá update/delete API | `deploy/cloudflare/apf-gateway/src/store.ts`, `/audit.json`, testy `EVD-*` | export/retence auditu (90 dní podle profilu) není automatizovaná; alert kanál při `STORAGE_FULL` a bezpečnostních událostech chybí (W10); centrální log mimo Cloudflare (SIEM) není |
| Integrita a původ dat (A.8.9, A.5.33) | Originály neměnné (klíč = sha256), derivace s provenancí (`derivedFrom`, `producer`, `modelId`, `promptVersion`); výstup modelu je jen data přes allowlist (F2), druhý nezávislý signál před zápisem (W4) | `src/platform/artifacts.ts`, `EVD-001`, `SEC-INJ-*`, MEASUREMENT N9/N11 | golden set a AI-EVAL nad skutečným modelem (krok 7) |
| Umístění dat a zpracovatelé (A.5.19–5.23, A.5.31; NIS2 21(2)(d)) | R2 `apf-artifacts` jurisdiction **EU**, D1 `apf-audit` region **EEUR**; Anthropic volby v profilu s `inferenceGeo: eu` (kde model umožňuje) a poznámkou `processor` (DPA, retence 30 dní, ZDR na žádost); Workers AI = Cloudflare jako zpracovatel | `config/farm-bass443/profile.json` (`models`), `deploy/cloudflare/README.md` | **Durable Object bez pinované jurisdikce EU** (`jurisdiction("eu")`, celek D); Workers AI region volí Cloudflare (nelze pinovat); smluvní podklady (DPA Cloudflare, Anthropic commercial terms) zatím nejsou v repu ani v evidenci ISMS |
| Retence a mazání (A.5.33, A.8.10; GDPR čl. 5) | Profil definuje retenci (originály 30 d, journal 30 d, audit 90 d); ruční `purge` maže R2 objekty, obsah objektu instance a zapisuje `PURGED` | `config/*/profile.json` (`retentionDays`), HANDOFF (16) | **automatická retence** (DO alarm per instance + D1 mazání podle `at`) = samostatný celek; osobní údaje v auditu (e-mail odesílatele) podléhají 90denní retenci |
| Bezpečný vývoj a změny (A.8.25–8.29, A.8.32; NIS2 21(2)(e)) | CI: typecheck, 219 testů, lint architektury a instalačních hodnot, gitleaks, kontrola odkazů; kód bez instalačních hodnot a bez secretů (jen jména); definice toku neměnné (verze v1/v2); malé celky s HANDOFF a commitem; zmrazená norma se mění jen s evidencí | `.github/workflows/kontrola.yml`, `scripts/arch-dep.mjs`, HANDOFF, MEASUREMENT | pentest izolace (ADR-017, krok 6) neproběhl; SBOM / kontrola závislostí (npm audit v CI) chybí |
| Dodavatelský řetězec (A.5.19–5.22; NIS2 21(2)(d)) | Zpracovatelé pojmenovaní per model v profilu; závislosti pinované v `package-lock.json`; id modelů se ověřují za běhu (`MODEL_UNAVAILABLE` s důvodem) | `config/farm-bass443/profile.json`, HANDOFF (17) nález (a) | registr dodavatelů (Cloudflare, Anthropic, GitHub, npm balíčky) s posouzením rizik mimo repo; automatický `npm audit` |
| Incidenty a kill switch (A.5.24–5.27; NIS2 21(2)(b), čl. 23) | `KILL_SWITCH` var zastaví příjem (503); explicitní konce toku (žádné tiché selhání), `DEPENDENCY_UNAVAILABLE` místo předstíraného úspěchu; review fronta pro sporné případy | `deploy/cloudflare/apf-gateway/src/index.ts`, WF/RES testy | postup hlášení incidentů (24 h / 72 h podle NIS2) a kontaktní role neexistují jako dokument; alerting (viz logování) |
| Kontinuita a zálohy (A.5.29–5.30, A.8.13–8.14; NIS2 21(2)(c)) | Stav instance trvalý v objektu (SQLite), kopie originálů v R2 a auditu v D1; `recover()` po restartu (RES-CRASH-001); dva runtime (Node testy, farma) | `src/platform/orchestrator.ts`, `RES-*` | zálohy R2/D1 mimo účet a test obnovy chybí; `RES-CRASH-001` přes evikci DO (krok 5) |
| Specifika AI (AI Act, ISO/IEC 42001 orientačně) | AI jen rozpoznává, kód vykonává; model volen z profilu, nikdy bez modelu; výstup modelu jako data s allowlistem; provenance s `modelId`; injekce testované (fixtures) | MEASUREMENT W4, W17, `conformance/document.classify` | golden set + AI-EVAL nad skutečným modelem; dokumentace „vysvětlení rozhodnutí" pro review roli |

## NIS2 čl. 21 odst. 2 — rychlá orientace

| Písmeno | Požadavek | Stav |
|---|---|---|
| a | politiky analýzy rizik a bezpečnosti informací | částečně: návrhové listy a norma jako politika návrhu; formální analýza rizik chybí |
| b | řešení incidentů | částečně: explicitní stavy a audit; postup a alerting chybí |
| c | kontinuita, zálohy, obnova | částečně: trvalý stav a recover; zálohy mimo účet chybí |
| d | bezpečnost dodavatelského řetězce | částečně: zpracovatelé pojmenovaní; registr a posouzení chybí |
| e | bezpečnost při pořizování, vývoji a údržbě, zvládání zranitelností | dobře: CI, lint, testy, malé změny; `npm audit` a pentest chybí |
| f | hodnocení účinnosti opatření | částečně: MEASUREMENT a posudky; periodický přezkum ISMS chybí |
| g | kybernetická hygiena a školení | mimo rozsah farmy (organizační) |
| h | kryptografie a šifrování | dobře: podpis obálek, secrets, TLS/at rest Cloudflare; rotace klíče neprověřena |
| i | bezpečnost lidských zdrojů, řízení přístupu, správa aktiv | částečně: Access + identity z profilu; registr aktiv = tento dokument + deploy README |
| j | MFA, zabezpečená komunikace | částečně: Access (IdP s MFA podle nastavení účtu), service tokeny; interní komunikace přes service bindingy s podepsanými obálkami (od celku D) |

## Mezery v pořadí priority

1. Durable Object v jurisdikci EU (jedno volání, celek D).
2. Automatická retence podle profilu (DO alarm + D1), včetně osobních údajů v auditu.
3. Ověření Access JWT ve Workeru a mapování lidských identit do profilu.
4. Alerting (bezpečnostní události, `STORAGE_FULL`, selhání modelů) a postup pro incidenty s lhůtami NIS2.
5. Zálohy R2/D1 mimo účet a test obnovy; `RES-CRASH-001` přes evikci DO.
6. Pentest izolace podle ADR-017 (krok 6) a `npm audit` v CI.
7. Registr dodavatelů a smluvních podkladů (Cloudflare DPA, Anthropic commercial terms/ZDR) mimo repo; rotace podpisového klíče nacvičená v provozu.
8. Golden set a AI-EVAL nad skutečným modelem (krok 7).
