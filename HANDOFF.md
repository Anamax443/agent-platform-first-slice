# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

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
