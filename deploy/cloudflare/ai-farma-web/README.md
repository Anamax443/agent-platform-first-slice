# AI Farma – zákaznický web

Statický responzivní web bez externích knihoven. Žije v `deploy/cloudflare/ai-farma-web/` uvnitř
`agent-platform-first-slice` (ne ve vlastním repu) a nasazuje se jako samostatný Worker (Workers Static
Assets, `wrangler deploy` z tohoto adresáře) — bez Access, bez instalačního overlaye, na rozdíl od pěti
farm deployables. Veřejná adresa je `ai-farma-web.<subdomain>.workers.dev`.

## Spuštění
Otevřete `index.html` v prohlížeči, nebo v adresáři spusťte jednoduchý HTTP server.

Např.:

```bash
python -m http.server 8080
```

## Stránky
- `index.html` – landing page
- `jak-to-funguje.html` – proces a role platformy
- `kravy.html` – katalog COW
- `bezpecnost.html` – bezpečnostní principy
- `multitenant.html` – multi-tenant vysvětlení
- `kontakt.html` – návrhový kontaktní formulář

## Poznámky k obsahu
Web záměrně nepoužívá vymyšlené statistiky typu „99 % přesnost“ nebo „200+ zákazníků“. Texty jsou napsané tak, aby odpovídaly směru a vlastnostem aktuální implementace. Budoucí/plánované COW jsou označené jako plán nebo budoucí.

Zobrazované jméno asistenta není použito jako technický identifikátor. „Erwin“ je jen příklad zobrazovaného jména a může být per tenant jiné.

## Katalog COW se čerpá z docs/cow-catalog.json

Karty COW na `index.html` (teaser) a `kravy.html` (plný katalog) se negenerují ručně — vygeneruje je `scripts/build-cow-catalog.mjs` ze souboru `docs/cow-catalog.json` v kořeni `agent-platform-first-slice` (ten projekt je zdroj pravdy o tom, co je `live`/`plan`/`future` — marketingový web tohle tvrzení nesmí vymýšlet sám).

Po každé změně katalogu (nová COW, změna stavu live/plan/future):

```bash
node scripts/build-cow-catalog.mjs
```

Skript přepíše obsah mezi značkami `<!-- COW-CATALOG:START ... -->` / `<!-- COW-CATALOG:END ... -->` v `index.html` (jen live/plan, ne future) a `kravy.html` (celý katalog). Needituj tyhle bloky ručně, přepíšou se.
