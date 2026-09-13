# AI Farma — Human Control Plane (demo)

Statický interaktivní demo prototyp Human Control Plane pro `agent-platform-first-slice`. Žije v
`deploy/cloudflare/ai-farma-web/` (ne ve vlastním repu) a nasazuje se jako samostatný Worker (Workers Static
Assets, `wrangler deploy` z tohoto adresáře) — bez Access, bez instalačního overlaye, na rozdíl od pěti farm
deployables. Veřejná adresa je `ai-farma-web.<subdomain>.workers.dev`.

Žádné externí knihovny, žádný build krok.

## Spuštění
Otevřete `index.html` v prohlížeči, nebo v adresáři spusťte jednoduchý HTTP server, např.:

```bash
python -m http.server 8080
```

## Nasazení

```bash
npx wrangler deploy
```

## Obsah
- Přehled
- Podatelna
- Ohrada
- Stáj (registry krav + živá animovaná ukázka krokování dokumentu farmou)
- Argos
- Výsledek
- Deník
- Office (plán — mimo dnešní apf-gateway, viz níže)

## Poznámka k názvosloví
Sekce Přehled/Podatelna/Ohrada/Stáj/Argos/Výsledek/Deník záměrně kopírují IA skutečné operátorské
stránky `apf-gateway` (`deploy/cloudflare/apf-gateway/src/page.ts`, viz `HANDOFF.md` #129, 2026-09-13),
aby tohle veřejné demo nepůsobilo jako jiná/starší vize. Když se reálná IA znovu přejmenuje nebo
přeskupí, tenhle soubor u toho zaostane — než se to napraví, `page.ts` je zdroj pravdy, ne tenhle README.

Office (tenanty, tokeny, e-mailové aliasy) v dnešním rebuildu apf-gateway není — je to plánované
rozšíření správy, proto má vlastní odsazenou skupinu v menu a badge „PLÁN“ v nadpisu stránky.

Data v prototypu jsou ilustrační (`sample-data.js`), stejně jako krokovaná sekvence v `app.js` — žádné
napojení na živou farmu, žádná reálná tenant data. UI vychází z aktuální architektury projektu: Farmář →
COW → Žlab → Dojička → Konev → Mlékárna, plus Argos, Ponocný a Podatelna — viz `docs/SEVERKA.md`
v kořeni repa.
