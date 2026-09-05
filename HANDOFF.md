# HANDOFF — deník stavu: agent-platform-first-slice

Append-only. Nejnovější záznam nahoru. Slouží k pokračování z jiného počítače / po pauze.

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
