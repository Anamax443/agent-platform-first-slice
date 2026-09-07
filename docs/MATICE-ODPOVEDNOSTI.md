# Matice odpovědnosti — kdo (jaká kapabilita/kravička) odpovídá za co

Živý dokument, aktualizovat při každé nové/změněné kapabilitě (stejné pravidlo jako u `docs/SHODA-NIS2-ISO27001.md`). Poskládáno z toho, co už existuje jinde (deskriptory kapabilit v `src/components/*/descriptor.json`, granty v `config/<instalace>/policy/*.json`, zapojení hostitelů v `platform-wiring.ts`) — poprvé na jednom místě, 7. 9. 2026.

Sloupec **Kdo smí volat** čte granty z `config/farm-bass443/policy/` — jsou identické pro obě instalace, jen jiné konkrétní `actorId` u `local-fakes`.

## Univerzální kapability (běží u každého dokumentu bez ohledu na typ)

| Kapabilita | Kravička (Worker) | Externí systém | Kdo smí volat | Riziko | Lidský vstup | Selhání vede k |
|---|---|---|---|---|---|---|
| `document.classify` | `apf-gateway` (router v objektu instance) | Workers AI / Anthropic (LLM), model podle profilu | `svc-orchestrator`, `svc-orchestrator-t7`, `ai-doc-classifier` | LOW, `usesLlm: true` — jediná kapabilita, kde AI vůbec rozhoduje (jen o `documentType`) | žádný přímý; je to samo o sobě první ze dvou nezávislých signálů | `MODEL_UNAVAILABLE`, `MODEL_OUTPUT_NOT_ALLOWED` → tok se nespustí / stop |
| `document.validate` | `apf-gateway` | `apf-fakes` (testovací dvojník registru — ostrý registr zatím neexistuje) | `svc-orchestrator`, `svc-orchestrator-t7` | LOW, deterministické (`usesLlm: false`) — druhý, nezávislý signál k `document.classify` (W4) | žádný přímý; produkuje `CLASSIFICATION_DISPUTED`/`STAMP_NOT_ALLOWED`, které vyvolají review | `CLASSIFICATION_DISPUTED`, `STAMP_NOT_ALLOWED`, `REGISTRY_UNAVAILABLE` → **review** |
| `document.stamp` | `apf-document-host` (samostatný Worker, celek D2, izolace LOGICAL) | DMS (dnes `apf-fakes` dvojník, ne ostrý systém) | `svc-orchestrator`, `svc-orchestrator-t7` | LOW, zápisová (`sideEffects: internal-write`), idempotentní (retence 30 dní) | žádný (`humanApproval: none`) | `DMS_REJECTED`, `VALIDATION_EVIDENCE_MISSING`, `ARTIFACT_HASH_MISMATCH` |

## Zapojené, ale v běžném toku nepoužité

| Kapabilita | Kravička | Externí systém | Kdo smí volat | Poznámka |
|---|---|---|---|---|
| `document.archive` | `apf-document-host` (sdílený proces se `stamp`, izolace LOGICAL) | Archiv (dnes `apf-fakes` dvojník) | `svc-orchestrator`, `svc-orchestrator-t7` | Existuje jen kvůli testu izolace (`SEC-HOST-001`, dva handlery/dva credential v jednom hostu) — `document-intake.v2.json` ho nikdy nevolá |

## Kapability toku e-mailů (mail-intake, jiná workflow definice)

| Kapabilita | Kravička | Externí systém | Kdo smí volat | Riziko | Poznámka |
|---|---|---|---|---|---|
| `mail.ingest` | `apf-mail-ingest` (sdílený proces, izolace LOGICAL) | Cloudflare Email Routing | `svc-orchestrator`, `svc-orchestrator-t7` | LOW | Vstupní bod mail-intake toku; sám dál volá gateway (ne opačně) |
| `email.send` | `apf-email-executor` (**vlastní proces, izolace PRINCIPAL** — nejsilnější, jediný binding Email Sending) | SMTP (Cloudflare Email Sending) | `svc-orchestrator`, `svc-orchestrator-t7` | **MEDIUM**, `sideEffects: external-write`, `reversibility: IRREVERSIBLE` — jediná kapabilita s vyšším rizikem než LOW a jedinou PRINCIPAL izolací | Odchozí e-mail nejde vzít zpět; proto přísnější izolace než u ostatních |

## Návrh — zatím nepostaveno (krok 8b, žádný kód)

| Kapabilita | Kravička | Externí systém | Kdy se spustí | Poznámka |
|---|---|---|---|---|
| `cz.company.verify` | zatím nepostaveno | ARES | agendy podle konfigurace (dnes navrženo: faktura, objednávka, smlouva) | Ověří IČO, existenci, právní formu, adresu |
| `cz.vat.verify` | zatím nepostaveno | Finanční správa (needs verification — přesný název/kontrakt služby zatím neověřen) | jen tam, kde `cz.company.verify` už proběhl a subjekt je tuzemský | DPH plátcovství, nespolehlivý plátce, zveřejněný účet; „nevztahuje se" ≠ selhání |

## Co z tabulky plyne (shrnutí zásad, ne nová pravidla)

- **AI rozhoduje jen v `document.classify`**, a jen o jedné hodnotě (`documentType`). Nikde jinde AI nevybírá, které kapability se spustí — to je vždy pevná workflow definice ([[project-agent-platform-first-slice]], zásada „AI jen rozpoznává, kód vykonává").
- **`failClosed: true` u všech šesti dnešních kapabilit** — chybějící/neplatný grant vždy zastaví, nikdy neprojde tiše.
- **`email.send` je jediná s rizikem nad LOW a jedinou PRINCIPAL izolací** — logicky, protože je to jediná nevratná (`IRREVERSIBLE`) akce směrem ven ze systému.
- **Univerzální vs. agendové** (vlastníkův postřeh 7. 9. 2026): `classify`/`validate`/`stamp` běží vždy; `cz.company.verify`/`cz.vat.verify` až budou postavené, poběží jen pro nakonfigurovaný seznam agend, ne pro každý dokument.
