# BC API v2.0 `purchaseInvoices` — jaká pole skutečně potřebujeme k zápisu

Živý dokument (bude se ladit postupně s vlastníkem, ne jednorázově uzavřený). Účel: dát konkrétní,
z reálné oficiální dokumentace ověřený seznam polí, která `erp.post` (Mlékárna / BC Executor,
`## Pořadí` bod 9+) bude muset umět naplnit — a jasně oddělit, co už farma dnes extrahuje
(`invoice.extract` v1), co je navržené (`invoice.v1`, `NAVRHOVY-LIST-farma.md` krok 8a) a co ještě
nemá vůbec žádnou krávu.

**Zdroj (ověřeno 14. 9. 2026, oficiální Microsoft Learn, BC API v2.0):**
- Hlavička: `.../api-reference/v2.0/api/dynamics_purchaseinvoice_get` a `..._create`
- Řádky: `.../api-reference/v2.0/api/dynamics_purchaseinvoiceline_create`

Stejná disciplína jako u ARES/MOJE daně (HANDOFF 111-112): ověřeno přímo v dokumentaci k
endpointu (reálné request/response příklady), ne odhadnuto z entity reference.

## Hlavička (`purchaseInvoices`)

| BC pole | V praxi nutné k zápisu | Co to je | Odkud u nás dnes |
|---|---|---|---|
| `vendorNumber` (nebo `vendorId`) | **ano** — bez něj BC neví, komu fakturu přiřadit | interní číslo dodavatele v BC tenantu (`C*****`-styl) | **CHYBÍ.** Přesně úkol `bc.vendors`, `SEVERKA.md ## Pořadí` bod 7, dosud nepostaveno. `invoice.extract`'s `companyId` (IČO) sem nejde napřímo — je to jen vyhledávací klíč, výstupem zápisu je `vendorNumber`, ne IČO |
| `vendorInvoiceNumber` | ano (identita dokladu, duplicitní kontrola) | číslo faktury, jak ho vydal dodavatel | `invoice.extract.invoiceNumber` — **hotovo**, v1 kontrakt |
| `invoiceDate` | ano | datum vystavení | `invoice.v1` návrh ("datumy — vystavení"), **není** v dnešním `invoice.extract` v1 (ten má jen 4 pole) |
| `postingDate` | ano | účetní datum zaúčtování | nejasné mapování na DUZP, viz otevřené otázky níže |
| `dueDate` | ano (platební řízení) | splatnost | `invoice.v1` návrh, není v extract v1 |
| `currencyCode` | ano, pokud ne domácí měna (jinak default LCY) | měna dokladu | `invoice.v1` návrh ("měna"), není v extract v1 |
| `totalAmountIncludingTax` | **jen orientačně** — BC ho přepočítává z řádků, viz zjištění níže | celkem s DPH | `invoice.extract.totalWithVat` — **hotovo**, v1 kontrakt, ale nestačí samo o sobě (viz níže) |
| `orderId`/`orderNumber` | volitelné | vazba na nákupní objednávku | `invoice.v1` návrh ("reference — objednávka") |
| `payToVendorId/Number`, `buyFrom*`/`shipTo*` adresy | volitelné — BC je dopočítá z karty dodavatele, pokud chybí | adresy | mimo rozsah v1, necháme na BC master datech |

## Řádky (`purchaseInvoiceLines`)

| BC pole | Poznámka | Odkud u nás dnes |
|---|---|---|
| `lineType` | `"Item"` / `"G/L Account"` / `"Fixed Asset"` / `"Charge"` / `"Comment"` | **CHYBÍ zcela** — dnešní extrakce nerozlišuje typ řádku |
| `lineObjectNumber` | číslo položky nebo účtu podle `lineType` | **CHYBÍ** — potřebuje mapping (text položky na faktuře → BC Item No. nebo G/L účet), instalačně specifické |
| `quantity`, `unitCost` | množství, cena/jednotka | `invoice.v1` návrh ("položky"), není v extract v1 |
| `description` | text řádku | `invoice.v1` návrh |
| `taxCode` | **BC kód sazby** (např. `"FURNITURE"`), ne holé procento DPH | **CHYBÍ** — potřebuje mapping tabulku sazba %→`taxCode`, jiná pro každý BC tenant/instalaci |

Podporuje se i **deep insert** — hlavička + jeden řádek v jednom `POST` na `purchaseInvoices` (vnořené
`purchaseInvoiceLines: [...]`), a `$batch` s `Isolation: snapshot` pro přidání víc řádků k existující
faktuře atomicky. Užitečné pro `erp.post`'s tvar zápisu — jedna transakční operace, ne řetěz volání
bez záruky atomicity.

## Klíčové zjištění z reálného chování API

**Hlavičkový `totalAmountIncludingTax` poslaný v `POST` se v odpovědi vrátil jako `0`**, protože
faktura vznikla bez řádků (`status: "Draft"`). BC **přepočítává celkové částky z řádků, ne z
hlavičkového pole.** Důsledek: zápis jen se souhrnnými částkami z hlavičky (bez řádků) vytvoří
fakturu s nulovým součtem — nepoužitelné k zaúčtování. **Musí existovat aspoň jeden řádek**, i kdyby
to byl jeden souhrnný `lineType: "G/L Account"` řádek s částkou = základ daně a odpovídajícím
`taxCode`.

## Otevřené otázky (needs verification, stejná disciplína jako u MOJE daně/ARES)

1. **Souhrnný řádek vs. plná extrakce položek** — rozhodnutí vlastníka: jeden G/L řádek (rychlejší,
   ztrácí položkovou granularitu) vs. plná extrakce položek z faktury (odpovídá `invoice.v1`'s
   skupině "položky", ale vyžaduje rozšířit `invoice.extract`/`invoice.normalize` o mnohem víc polí
   a mapovat každou položku na Item No./účet).
2. **DUZP → `postingDate`?** DUZP (datum uskutečnění zdanitelného plnění) je český koncept; BC
   `purchaseInvoices` header má jen `invoiceDate`/`postingDate`/`dueDate` — žádné samostatné pole
   pro DUZP nebylo v ověřené dokumentaci nalezeno. **Neověřeno**, jestli DUZP sedí na `postingDate`,
   nebo jestli existuje jiné VAT-specifické pole (např. na úrovni General Ledger Setup / VAT
   Entries) — nedohledávat od boku, ověřit před psaním `erp.post` kódu.
3. **`taxCode` mapping** — BC kódy sazeb jsou nastavené per instalace/tenant (`"FURNITURE"` v
   příkladu je jen ukázka), ne standardizovaná hodnota napříč BC tenanty. Bude potřeba konfigurovatelná
   mapovací tabulka (stejný princip jako `config/<instalace>/`), ne natvrdo zadrátovaná v kódu.
4. **`bankAccount` (dnešní `invoice.extract` pole) nemá protějšek na `purchaseInvoices`.** V BC žije
   bankovní účet na kartě dodavatele / platebním exportu, ne na faktuře samotné. U nás má jinou roli:
   je to vstup do **Import Gate's `ACCOUNT_VERIFICATION`** (ověření proti zveřejněným účtům MOJE daně,
   `SEVERKA.md ### Kontrola musí být svázaná s konkrétní hodnotou`) — kontrolní pole, ne BC write pole.

## Doporučené pořadí sestavení (návazně na `SEVERKA.md ## Pořadí` a HANDOFF 110)

1. `invoice.extract`/`invoice.normalize` — rozšířit o `invoiceDate`/`postingDate`-kandidát/`dueDate`/
   `currencyCode` (dnes v extract v1 kontraktu chybí, jsou ale v `invoice.v1` návrhu).
2. `cz.company.verify` (hotovo) → `cz.vat.verify` (hotovo) → **`bc.vendors`** (chybí, bod 7) — vyřeší
   `vendorNumber`, jediné pole bez kterého se zápis vůbec nedá odeslat.
3. Dojička (hotovo) → Konev (hotovo) → sestavit `purchaseInvoices` payload (hlavička + min. 1
   souhrnný řádek podle rozhodnutí v otázce 1).
4. `erp.post` nejdřív jako `DRY_RUN`/JSON Export (HANDOFF 110 — dočasná náhrada BC Executoru), ostrý
   zápis až po uzavření P0-1/P0-2 (POSUDKY.md).

Čistě dokumentační krok — žádný kód, žádná nová capabilita zatím postavena.
