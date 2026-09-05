# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

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
