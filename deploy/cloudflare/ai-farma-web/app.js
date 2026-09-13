
const D=window.FARM_DATA;
const app=document.getElementById('app');

app.innerHTML=`
<div class="app-shell">
  <aside class="sidebar">
    <div class="brand"><div class="logo">🌾</div><div class="brand-text"><b>Průsvitná stáj</b><small>AI Farma · demo</small></div></div>
    <div class="nav-title">Provoz</div>
    ${nav('overview','⌂','Přehled',true)}
    ${nav('intake','📬','Podatelna')}
    ${nav('ohrada','✓','Ohrada')}
    ${nav('staj','◫','Stáj')}
    ${nav('argos','🐕','Argos')}
    ${nav('vysledek','↯','Výsledek')}
    ${nav('denik','≡','Deník')}
    <div class="nav-title">Správa · plán</div>
    ${nav('office','▦','Office')}
    <div class="side-health"><span class="dot"></span> <span class="txt"><b>Farma zdravá</b><br><small style="color:var(--muted)">6/6 Workerů OK · build b153</small></span></div>
  </aside>
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
  <div class="content">
    <header class="topbar">
      <button class="hamburger" id="hamburgerBtn" aria-label="Otevřít menu" aria-expanded="false">☰</button>
      <div class="tenant-chip">🏢 <div><strong>${D.tenant.name}</strong><small>Tenant ${D.tenant.id}</small></div></div>
      <span class="pill good">● LIVE</span>
      <span class="pill">${D.tenant.region}</span>
      <span class="spacer"></span>
      <span class="pill good">Argos HEALTHY</span>
      <span class="pill">MT</span>
    </header>
    <main>
      ${pageOverview()}
      ${pageIntake()}
      ${pageOhrada()}
      ${pageStaj()}
      ${pageArgos()}
      ${pageVysledek()}
      ${pageDenik()}
      ${pageOffice()}
      <footer>AI Farma — demo Průsvitné stáje · sekce Přehled/Podatelna/Ohrada/Stáj/Argos/Výsledek/Deník odpovídají skutečné IA apf-gateway (HANDOFF #129) · Office je plánované rozšíření mimo dnešní rebuild · demo data</footer>
    </main>
  </div>
</div>`;

function nav(id,ico,label,active=false){return `<button class="navbtn ${active?'active':''}" data-page="${id}"><span class="ico">${ico}</span><span>${label}</span></button>`}
function kpi(v,l,s=''){return `<div class="card kpi"><div class="value">${v}</div><div class="label">${l}</div><div class="sub">${s}</div></div>`}
function hero(t,p,a=''){return `<div class="hero"><div><h1>${t}</h1><p>${p}</p></div><div class="actions">${a}</div></div>`}

function pageOverview(){return `
<section class="page active" id="overview">
${hero('Farma je zdravá.','Úvodní stránka říká během pár sekund, co vyžaduje pozornost. Technická brutalita je až o jeden klik níž.','<button class="btn">▶ Self-test</button><button class="btn primary" data-go="staj">Otevřít Stáj</button>')}
<div class="g3 grid" style="margin-bottom:14px">
  <div class="card persona"><div class="avatar">🧑‍🌾</div><div><small>FARMÁŘ</small><h2>Erwin</h2><span class="status good">ONLINE</span><p style="color:var(--muted)">Orchestrace a routing. Bez business write credentials.</p></div></div>
  <div class="card persona"><div class="avatar">🐕</div><div><small>HLÍDACÍ PES</small><h2>Argos</h2><span class="status good">HEALTHY</span><p style="color:var(--muted)">Self-testy, incidenty, alerty a health farmy.</p></div></div>
  <div class="card persona"><div class="avatar">🌙</div><div><small>NEZÁVISLÝ WATCHDOG</small><h2>Ponocný</h2><span class="status warn">TARGET DESIGN</span><p style="color:var(--muted)">Hlídá Argose z jiné failure domény.</p></div></div>
</div>
<div class="grid g4">${kpi(D.stats.ops,'operací dnes','+12 % proti včerejšku')}${kpi(D.stats.ready,'READY','98,2 % bez zásahu')}${kpi(D.stats.review,'čeká v Ohradě','nejstarší 14 min')}${kpi(D.stats.tests,'testy platformy','poslední CI PASS')}</div>
<div class="section-title"><h2>Potřebuje pozornost</h2><span>jen věci s dopadem</span></div>
<div class="attention">
 <div class="card">
  <div class="issue warn"><div class="badge-ico">⚠️</div><div><b>3 faktury čekají na rozhodnutí</b><small>Účet není ve zveřejněných účtech. Automatický write zablokován.</small></div></div>
  <div class="issue"><div class="badge-ico">🐄</div><div><b>cz.vat.verify je pomalejší</b><small>p95 2,8 s · funkční · žádný FAIL</small></div></div>
  <div class="issue"><div class="badge-ico">📬</div><div><b>Podatelna přijala 42 dokumentů</b><small>40 e-mail · 2 upload · 0 odmítnuto</small></div></div>
 </div>
 <div class="card"><h2>Bezpečnostní stav</h2><div class="detail-grid"><div class="detail-box"><small>Tenant isolation</small><b style="color:var(--good)">PASS</b></div><div class="detail-box"><small>Alert channel</small><b style="color:var(--good)">PASS</b></div><div class="detail-box"><small>Quarantined COW</small><b>0</b></div><div class="detail-box"><small>Cross-tenant 24 h</small><b>0</b></div></div><div class="security-strip"><span class="pill good">Router fail-closed</span><span class="pill good">Evidence signed</span><span class="pill warn">Office target</span></div></div>
</div>
</section>`}

function pageIntake(){return `
<section class="page" id="intake">
${hero('Podatelna','Ruční jednotlivé podání i dávkový příjem. Všechny vstupy do farmy mají explicitní tenant binding, audit a immutable artifact. Obsah dokumentu neurčuje tenant ani oprávnění.','<button class="btn primary" id="uploadDemo">+ Nahrát dokument</button><button class="btn">+ Přidat kanál</button>')}
<div class="intake-grid">
 ${intake('📄','Ruční vložení','PDF, JPG, PNG, dokumenty z prohlížeče.','READY','good')}
 ${intake('✉️','E-mail','Tenant-specific schránka / alias. Přílohy jdou rovnou do intake.','CONNECTED','good')}
 ${intake('✈️','Telegram','Soubor, foto nebo zpráva poslaná botovi.','OPTIONAL','info')}
 ${intake('🔌','API','Autentizovaný tenant-scoped intake endpoint.','AVAILABLE','good')}
 ${intake('＋','Nový vstup','OneDrive, SharePoint, scanner, SFTP, sledovaná složka…','ADD','')}
</div>
<div class="section-title"><h2>Poslední intake</h2><span>co přišlo do farmy</span></div>
<div class="card"><table class="table"><thead><tr><th>Čas</th><th>Kanál</th><th>Soubor / zpráva</th><th>Tenant</th><th>Artifact</th><th>Stav</th></tr></thead><tbody>
<tr><td>17:42:11</td><td>✉️ E-mail</td><td>Faktura_1847.pdf</td><td>T-000042</td><td><code>art-02f1</code></td><td><span class="status good">ACCEPTED</span></td></tr>
<tr><td>17:39:02</td><td>📄 Upload</td><td>scan_991.png</td><td>T-000042</td><td><code>art-a932</code></td><td><span class="status good">ACCEPTED</span></td></tr>
<tr><td>17:31:54</td><td>✈️ Telegram</td><td>photo.jpg</td><td>T-000042</td><td><code>art-b12c</code></td><td><span class="status warn">REVIEW</span></td></tr>
</tbody></table></div>
</section>`}
function intake(ico,t,p,state,cls){return `<div class="intake-card ${state==='ADD'?'add':''}"><div class="big">${ico}</div><h3>${t}</h3><p>${p}</p><div class="bottom"><span class="pill ${cls}">${state}</span><button class="btn" style="padding:5px 8px">Nastavit</button></div></div>`}

function pageOhrada(){return `
<section class="page" id="ohrada">
${hero('Ohrada','Instance, co čekají na rozhodnutí, nebo skončily s chybou, co si žádá pohled člověka — zde se nic samo neprovede.')}
<div class="g2 grid">
 <div class="card"><h2>FV-2026-1847 <span class="pill warn">BANK ACCOUNT</span></h2><p>Účet na faktuře není mezi zveřejněnými účty. Konev nebyla zapečetěna.</p><div class="detail-grid"><div class="detail-box"><small>Faktura</small><b>123456/0100</b></div><div class="detail-box"><small>Registr</small><b>987654/0100</b></div></div><div class="actions" style="margin-top:14px"><button class="btn danger">Zamítnout</button><button class="btn">Evidence</button><button class="btn primary">Prověřit ručně</button></div></div>
 <div class="card"><h2>Audit rozhodnutí</h2><p style="color:var(--muted)">Ukládá se actor, tenant, MFA context, čas, policy version a evidenceRefs. UI nevytváří novou autoritu.</p></div>
</div>
</section>`}

function pageStaj(){
 const cards=D.cows.map(c=>`<div class="cow"><h3><span>🐄 ${c.name}</span><span class="status ${c.state==='NEW'?'warn':'good'}">${c.state}</span></h3><div class="meta"><span class="pill">${c.risk}</span><span class="pill">${c.kind}</span><span class="pill good">${c.tests}</span></div><small style="color:var(--muted)">build-bound lifecycle · conformance</small></div>`).join('');
 return `
<section class="page" id="staj">
${hero('Stáj','Kravičky a co skutečně smí vykonat, seskupeno po modulu jako Ohrada — riziko a izolace jsou vlastní tvrzení komponenty, stav na kartě je to, co Router doopravdy vynucuje před každým dispatchem.','<button class="btn">Spustit self-testy</button>')}
<div class="cow-grid">${cards}</div>
<div class="section-title"><h2>Živá ukázka: dokument prochází stájí</h2><span>krokování, Žlab, Evidence a Konev na jedné obrazovce</span></div>
<div class="actions" style="margin-bottom:14px">
  <button class="btn primary" id="autoRun">▶ AUTO</button><button class="btn" id="stepRun">→ STEP</button><button class="btn" id="dryRun">DRY RUN</button><button class="btn" id="jsonRun">OUTPUT TO JSON</button><button class="btn" id="resetRun">↺ Reset</button>
</div>
<div class="barn-layout">
 <div class="flow"><div class="stage">
  <div class="flow-row" style="margin-bottom:26px">
    ${node('n-intake','📬','Podatelna','artifact + tenant','INTAKE')}
    ${conn('cx0')}
    ${node('n-erwin','🧑‍🌾','Erwin','intent → route','ORCHESTRATING')}
    ${conn('cx1')}
    ${node('n-argos','🐕','Argos','watchdog','WATCHING')}
  </div>
  <div class="flow-row">
    ${node('n0','📄','Originál PDF','immutable artifact','SEALED')}
    ${conn('c0')}${node('n1','🐄','Reader COW','document.read','WAIT')}
    ${conn('c1')}${node('n2','🐄','Invoice Extract','invoice.extract','WAIT')}
    ${conn('c2')}${node('n7','🥛','Dojička','aggregate evidence','WAIT')}
    ${conn('c7')}${node('n8','🪣','Konev','CertifiedInvoice','WAIT')}
  </div>
  <div class="flow-branch">
    ${node('n3','🐄','ARES','IČO','WAIT')}
    ${node('n4','🐄','VAT','DIČ','WAIT')}
    ${node('n5','🐄','Účet','published account','WAIT')}
    ${node('n6','🐄','BC Vendor','read-only lookup','WAIT')}
  </div>
  <div class="progress"><div class="bar" id="runBar"></div></div>
  <div class="g2 grid">
    <div class="card"><h3>Aktuální krok</h3><div id="stepDetail" style="color:var(--muted)">Proces ještě nezačal.</div></div>
    <div class="card"><h3>Bezpečnost</h3><div>Tenant ✓ · Policy ✓ · Signature ✓ · Lifecycle ✓</div></div>
  </div>
 </div></div>
 <aside class="card trough"><div style="display:flex;gap:8px;align-items:center"><h2 style="margin:0">🥣 Žlab</h2><span class="pill good">append-only</span></div><p style="color:var(--muted);font-size:12px">Každý záznam má tenant, provenance, hash a platformní podpis.</p>
 ${feed('f1','document.md','md-8821','derivedFrom art-02f1')}
 ${feed('f2','companyId','12345678','hash 4b29…')}
 ${feed('f3','vatId','CZ12345678','hash aa91…')}
 ${feed('f4','bankAccount','123456/0100','hash 23e7…')}
 ${feed('f5','ARES evidence','PASS','signed · inputHash 4b29…')}
 ${feed('f6','VAT evidence','PASS','signed · inputHash aa91…')}
 ${feed('f7','Account evidence','FAIL','signed · inputHash 23e7…')}
 ${feed('f8','BC Vendor evidence','FOUND V00123','signed')}
 </aside>
</div>
<div class="section-title"><h2>Živý audit</h2><span>bez chain-of-thought, jen provozní pravda</span></div>
<div class="card"><div class="log" id="runLog"></div></div>
<div class="section-title"><h2>Výstup</h2></div>
<div class="card"><div class="json" id="runOutput">{ "status": "WAITING" }</div></div>
<h3 style="margin:18px 0 8px">Kapability (Admission Gate)</h3>
<div class="security-strip"><span class="pill good">document.read · ADMITTED</span><span class="pill good">invoice.extract · ADMITTED</span><span class="pill good">cz.company.verify · ADMITTED</span><span class="pill good">cz.vat.verify · ADMITTED</span><span class="pill warn">vat.account.verify · ADMITTED (FAIL na tomto běhu)</span><span class="pill good">bc.vendors · ADMITTED</span></div>
</section>`}
function node(id,e,t,s,st){return `<div class="node" id="${id}"><div class="pulse-ring"></div><div class="emoji">${e}</div><b>${t}</b><small>${s}</small><div class="mini">${st}</div></div>`}
function conn(id){return `<div class="connector" id="${id}"></div>`}
function feed(id,t,v,h){return `<div class="trough-item" id="${id}"><b>${t}</b><code>${v}</code><span class="hash">${h}</span></div>`}

function pageArgos(){return `
<section class="page" id="argos">
${hero('Argos hlídá','Argosův vlastní verdikt a nálezy — deterministická pravidla, žádné AI. Karanténa se mění deployem, ne odsud — tahle stránka jen čte, nikdy nezapisuje.','<button class="btn">Spustit retest</button><button class="btn">Test alert kanálu</button>')}
<div class="grid g3">${kpi('<span style="color:var(--good)">HEALTHY</span>','verdikt','0 aktivních incidentů')}${kpi('22 s','od heartbeat','scheduled self-test')}${kpi('OK','alert channel','naposledy 16:58')}</div>
<div class="section-title"><h2>Incidenty</h2><span>root cause + resolution method</span></div>
<div class="card">
 <div class="incident"><b>RECOVERED · document.classify 17/18</b><p>Fixture <code>injection-approve</code> selhala jednou, retest 18/18. Dopad: žádný write. Bezpečnostní invariant zachován.</p><small>12. 9. · 9 min · build b151…</small></div>
 <div class="incident critical"><b>CONTAINED · podezřelé PDF</b><p>Low-contrast text layer na straně 2. Workflow zastaveno, originál v karanténě, žádný write efekt. Doporučení: forensic render + rasterizace.</p><small>11. 9. · artifact art-771…</small></div>
</div>
</section>`}

function pageVysledek(){return `
<section class="page" id="vysledek">
${hero('Výsledek','Výsledek se složí, uloží a zaznamená — statistika za celou dobu a poslední zpracované dokumenty.','<button class="btn">Filtr: vše</button><button class="btn">Export</button>')}
<div class="card"><table class="table"><thead><tr><th>Objekt</th><th>Workflow</th><th>Tenant</th><th>Poslední krok</th><th>Stav</th><th>Režim</th><th>Integrita</th></tr></thead><tbody>
<tr><td><b>FV-2026-1847</b></td><td><code>wf-91e2</code></td><td>T-000042</td><td>🥛 Dojička</td><td><span class="status warn">REVIEW</span></td><td><span class="pill">DRY_RUN</span></td><td><span class="status good">VALID</span></td></tr>
<tr><td><b>FV-2026-1846</b></td><td><code>wf-a410</code></td><td>T-000042</td><td>🪣 Konev</td><td><span class="status good">SEALED</span></td><td><span class="pill info">JSON</span></td><td><span class="status good">VALID</span></td></tr>
<tr><td><b>MAIL-99218</b></td><td><code>wf-dfa1</code></td><td>T-000042</td><td>🏭 email.send</td><td><span class="status good">DONE</span></td><td>LIVE</td><td><span class="status good">VALID</span></td></tr>
</tbody></table></div>
</section>`}

function pageDenik(){return `
<section class="page" id="denik">
${hero('Audit — Deník','Živý terminál: syrový auditní záznam napříč celou farmou, jeden řádek = jedna událost, nejnovější dole (jako tail -f).')}
<div class="card" style="margin-bottom:20px"><div class="log">
<div class="logline">17:21:03  INPUT art-02f1 · tenant T-000042 · hash 818a…</div>
<div class="logline">17:21:05  document.read PASS · output md-8821</div>
<div class="logline">17:21:07  invoice.extract PASS · evidence ev-9033</div>
<div class="logline">17:21:08  ARES PASS · inputHash 4b29…</div>
<div class="logline">17:21:09  ACCOUNT FAIL · inputHash 23e7…</div>
<div class="logline">17:21:10  Dojička REVIEW · Konev not sealed</div>
</div></div>
<div class="g2 grid">
 <div class="card"><h2>Timeline · wf-91e2</h2><div class="timeline"><div class="timeline-item"><b>17:21:03 · INPUT</b><small>artifact art-02f1 · tenant T-000042 · hash 818a…</small></div><div class="timeline-item"><b>17:21:05 · document.read PASS</b><small>output md-8821 · build b153…</small></div><div class="timeline-item"><b>17:21:07 · invoice.extract PASS</b><small>evidence ev-9033 · signature valid</small></div><div class="timeline-item"><b>17:21:08 · ARES PASS</b><small>inputHash 4b29…</small></div><div class="timeline-item"><b>17:21:09 · ACCOUNT FAIL</b><small>inputHash 23e7…</small></div><div class="timeline-item"><b>17:21:10 · Dojička REVIEW</b><small>Konev not sealed</small></div></div></div>
 <div class="card"><h2>Integrity graph</h2><div class="json">original.pdf [818a…]
 └─ document.md [b013…]
    └─ invoice.extract [98fc…]
       ├─ companyId [4b29…]
       │  └─ ARES PASS [e812…] ✓
       ├─ vatId [aa91…]
       │  └─ VAT PASS [f103…] ✓
       └─ bankAccount [23e7…]
          └─ ACCOUNT FAIL [19c2…] ✓

Aggregate: REVIEW
CertifiedBusinessObject: NOT CREATED</div></div>
</div>
</section>`}

function pageOffice(){return `
<section class="page" id="office">
${hero('Office <span class="pill warn" style="font-size:12px;vertical-align:middle">PLÁN</span>','Tenanty, identity, tokeny a e-mailové aliasy. Identitu ověřuje IdP; Office mapuje ověřenou identitu, token nebo příchozí e-mail na tenant a oprávnění — mimo dnešní rebuild apf-gateway (HANDOFF #129), plánované rozšíření správy.','<button class="btn primary">+ Založit tenant</button>')}
<div class="office-grid">
 <div class="card"><h2>Tenanty</h2><div class="tenant-row active"><b>T-000042 · AXIMA</b><small>ACTIVE · MFA REQUIRED_FOR_PRIVILEGED</small></div><div class="tenant-row"><b>T-000043 · Demo CZ</b><small>TESTING · MFA REQUIRED</small></div><div class="tenant-row"><b>T-000044 · Sandbox</b><small>SUSPENDED</small></div></div>
 <div class="card"><div style="display:flex;gap:10px;align-items:center"><h2 style="margin:0">AXIMA</h2><span class="pill good">ACTIVE</span><span class="pill">T-000042</span></div><div class="section-title"><h2>Identity</h2></div><table class="table"><thead><tr><th>Identita</th><th>Role</th><th>MFA</th><th>Stav</th></tr></thead><tbody><tr><td>milan@firma.cz</td><td>Tenant Admin</td><td><span class="status good">FIDO2</span></td><td>ACTIVE</td></tr><tr><td>ucetni@firma.cz</td><td>Accountant</td><td><span class="status good">TOTP</span></td><td>ACTIVE</td></tr></tbody></table><div class="section-title"><h2>Přihlašovací politika (tenant)</h2></div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><label style="color:var(--muted);font-size:12px">Vynucení MFA</label><select><option>Nepovinné</option><option selected>Vyžadováno pro citlivé akce</option><option>Vyžadováno vždy</option></select><button class="btn" style="padding:5px 8px">Uložit</button></div><div class="section-title"><h2>Konektory</h2></div><div class="security-strip"><span class="pill good">BC READ ✓</span><span class="pill warn">BC WRITE DRY_RUN</span><span class="pill good">MAIL ✓</span><span class="pill good">ARES ✓</span></div><div class="section-title"><h2>Výchozí expirace (per tenant)</h2></div><div class="detail-grid"><div class="detail-box"><small>Nové tokeny</small><b>90 dní</b></div><div class="detail-box"><small>Nové e-mailové aliasy</small><b>bez expirace</b></div></div><div class="actions" style="margin-top:10px"><button class="btn" style="padding:5px 8px">Upravit výchozí expiraci</button></div></div>
</div>
<div class="section-title"><h2>Přihlašovací politika platformy (vlastní účet)</h2><span>nezávisle na tenantech — platí pro Farmáře/admina</span></div>
<div class="card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
 <div style="flex:1;min-width:220px"><b>milan@firma.cz</b><br><small style="color:var(--muted)">Admin farmy · aktuálně FIDO2</small></div>
 <label style="color:var(--muted);font-size:12px">Vynucení MFA</label>
 <select><option>Nepovinné</option><option>Vyžadováno pro citlivé akce</option><option selected>Vyžadováno vždy</option></select>
 <button class="btn primary" style="padding:5px 8px">Uložit</button>
</div>
<div class="section-title"><h2>Tokeny</h2><span>jeden aktivní token na firmu (tenant), pokrývá všechny scope — ne token na uživatele nebo na integraci</span></div>
<div class="card"><table class="table"><thead><tr><th>Token</th><th>Scope</th><th>Tenant (firma)</th><th>Vytvořen</th><th>Expirace</th><th>Poslední použití</th><th>Stav</th><th></th></tr></thead><tbody>
<tr><td><code>tok_8f3c…</code></td><td>intake:write, bc:read</td><td>T-000042 · AXIMA</td><td>2026-08-01</td><td>2026-10-30 <small class="dim">(za 47 dní)</small></td><td>dnes 09:12</td><td><span class="status good">ACTIVE</span></td><td><button class="btn" style="padding:5px 8px">Odvolat</button></td></tr>
<tr><td><code>tok_2b91…</code></td><td>bc:read</td><td>T-000043 · Demo CZ</td><td>2026-05-14</td><td><span style="color:var(--muted)">bez expirace</span></td><td>—</td><td><span class="status bad">REVOKED</span></td><td><button class="btn" style="padding:5px 8px" disabled>Odvolat</button></td></tr>
</tbody></table><p style="color:var(--muted);font-size:12px;margin:10px 2px 0">Vygenerování nového tokenu pro tenant automaticky odvolá ten předchozí — nikdy jich neběží víc najednou.</p><div class="actions" style="margin-top:10px;align-items:center;gap:10px"><span class="pill">Nová expirace: <b style="margin-left:4px">90 dní</b></span><button class="btn primary">↻ Znovu vygenerovat token pro AXIMA</button></div></div>
<div class="section-title"><h2>E-mailové aliasy</h2><span>kam se má příchozí pošta zařadit v Podatelně — expirace uvolní alias zpět, když zákazník skončí</span></div>
<div class="card"><table class="table"><thead><tr><th>Alias</th><th>Tenant</th><th>Kanál</th><th>Expirace</th><th>Stav</th><th></th></tr></thead><tbody>
<tr><td>faktury@t000042.aifarma.cz</td><td>T-000042 · AXIMA</td><td>Podatelna · e-mail</td><td><span style="color:var(--muted)">bez expirace</span></td><td><span class="status good">ACTIVE</span></td><td><button class="btn" style="padding:5px 8px">Přeřadit</button></td></tr>
<tr><td>podatelna@t000043.aifarma.cz</td><td>T-000043 · Demo CZ</td><td>Podatelna · e-mail</td><td>2026-12-31 <small class="dim">(pilotní smlouva)</small></td><td><span class="status good">ACTIVE</span></td><td><button class="btn" style="padding:5px 8px">Přeřadit</button></td></tr>
</tbody></table><div class="actions" style="margin-top:12px"><button class="btn primary">+ Přiřadit alias</button></div></div>
</section>`}

function showPage(id){
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===id));
 document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.page===id));
 window.scrollTo({top:0,behavior:'smooth'});
 closeMenu();
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.go)));

/* Mobile hamburger menu (sidebar doubles as slide-in drawer under 760px) */
const sidebarEl=document.querySelector('.sidebar'),backdropEl=document.getElementById('sidebarBackdrop'),hamburgerEl=document.getElementById('hamburgerBtn');
function openMenu(){sidebarEl.classList.add('open');backdropEl.classList.add('open');hamburgerEl.setAttribute('aria-expanded','true')}
function closeMenu(){sidebarEl.classList.remove('open');backdropEl.classList.remove('open');hamburgerEl.setAttribute('aria-expanded','false')}
hamburgerEl?.addEventListener('click',()=>{sidebarEl.classList.contains('open')?closeMenu():openMenu()});
backdropEl?.addEventListener('click',closeMenu);

document.getElementById('uploadDemo')?.addEventListener('click',()=>{
 alert('Demo: dokument by se zde vložil do Podatelny jako nový immutable artifact svázaný s tenantem.');
});

/* Animated barn (Stáj → živá ukázka) */
const sequence=[
 {node:'n0',state:'SEALED',cls:'done',detail:'Originál uložen jako immutable artifact.',log:'INPUT art-02f1 · tenant T-000042 · hash 818a…'},
 {node:'n1',state:'PASS',cls:'done',feeds:['f1'],detail:'Reader COW vytváří odvozený text/MD.',log:'document.read PASS · output md-8821'},
 {node:'n2',state:'PASS',cls:'done',feeds:['f2','f3','f4'],detail:'Invoice Extract vytahuje strukturovaná pole.',log:'invoice.extract PASS · companyId/vatId/bankAccount → Žlab'},
 {node:'n3',state:'PASS',cls:'done',feeds:['f5'],detail:'ARES ověřuje pouze IČO.',log:'cz.company.verify PASS · ARES'},
 {node:'n4',state:'PASS',cls:'done',feeds:['f6'],detail:'VAT COW ověřuje DIČ.',log:'cz.vat.verify PASS'},
 {node:'n5',state:'FAIL',cls:'fail',feeds:['f7'],detail:'Účet není zveřejněný. Explicitní FAIL blokuje READY.',log:'vat.account.verify FAIL'},
 {node:'n6',state:'FOUND',cls:'done',feeds:['f8'],detail:'BC Vendor lookup našel V00123.',log:'bc.vendors FOUND V00123'},
 {node:'n7',state:'REVIEW',cls:'review',detail:'Dojička skládá Evidence a vrací REVIEW.',log:'invoice.aggregate REVIEW'},
 {node:'n8',state:'NOT SEALED',cls:'review',detail:'Konev se nevytvoří, protože není READY.',log:'CertifiedInvoice NOT CREATED'}
];
let stepIndex=0,timer=null,mode='NORMAL';
function logLine(t){const log=document.getElementById('runLog');const e=document.createElement('div');e.className='logline';e.textContent=new Date().toLocaleTimeString('cs-CZ')+'  '+t;log.appendChild(e);log.scrollTop=99999}
function clearActive(){document.querySelectorAll('#staj .node').forEach(n=>n.classList.remove('active'));document.querySelectorAll('#staj .connector').forEach(c=>c.classList.remove('hot'))}
function runStep(){
 if(stepIndex>=sequence.length){stopAuto();return}
 clearActive();const s=sequence[stepIndex],n=document.getElementById(s.node);n.classList.add('active');n.classList.add(s.cls);const mini=n.querySelector('.mini');mini.textContent=s.state;mini.className='mini '+(s.cls==='fail'?'bad':s.cls==='review'?'warn':'good');
 document.getElementById('stepDetail').textContent=s.detail;document.getElementById('runBar').style.width=((stepIndex+1)/sequence.length*100)+'%';
 (s.feeds||[]).forEach((id,k)=>setTimeout(()=>{const f=document.getElementById(id);f.classList.add('visible','flash');setTimeout(()=>f.classList.remove('flash'),700)},k*100));logLine(s.log);stepIndex++;
 if(stepIndex===sequence.length)setTimeout(finalize,400);
}
function finalize(){clearActive();const out= mode==='JSON'?{mode:'OUTPUT_TO_JSON',status:'REVIEW',writePerformed:false,target:'Business Central',reason:'BANK_ACCOUNT_NOT_PUBLISHED'}:mode==='DRY'?{mode:'DRY_RUN',status:'REVIEW',writePerformed:false,reason:'Required evidence failed'}:{status:'REVIEW',certifiedBusinessObject:null,writePerformed:false};document.getElementById('runOutput').textContent=JSON.stringify(out,null,2)}
function stopAuto(){if(timer){clearInterval(timer);timer=null}}
function resetRun(){stopAuto();stepIndex=0;mode='NORMAL';clearActive();document.querySelectorAll('#staj .node').forEach(n=>{n.classList.remove('done','fail','review')});document.querySelectorAll('#staj .trough-item').forEach(f=>f.classList.remove('visible','flash'));document.getElementById('runBar').style.width='0';document.getElementById('stepDetail').textContent='Proces ještě nezačal.';document.getElementById('runLog').innerHTML='';document.getElementById('runOutput').textContent='{ "status": "WAITING" }'}
document.getElementById('stepRun')?.addEventListener('click',runStep);
document.getElementById('autoRun')?.addEventListener('click',()=>{if(timer)return;logLine('AUTO started');timer=setInterval(()=>{runStep();if(stepIndex>=sequence.length)stopAuto()},950)});
document.getElementById('dryRun')?.addEventListener('click',()=>{mode='DRY';logLine('DRY_RUN enabled')});
document.getElementById('jsonRun')?.addEventListener('click',()=>{mode='JSON';logLine('OUTPUT_TO_JSON enabled')});
document.getElementById('resetRun')?.addEventListener('click',resetRun);
