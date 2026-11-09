/* Connect phone: the window, the review list, the "Syncing..." cover and the green dots.
   The computer side of the work is in electron/phone-sync/syncServer.cjs (reached through window.fleetDesktop.sync*).
   Opening this window starts the connection; closing the window leaves it on until FleetPilot closes or the owner disconnects. */
import qrcode from './vendor/qrcode.js';
import help from './connectHelp.json';

const PANEL_LISTS = { 'panel-vehicles': 'vehicles', 'panel-drivers': 'drivers', 'panel-clients': 'clients', 'panel-bookings': 'bookings', 'panel-rentals': 'rentals', 'panel-payments': 'payments', 'panel-expenses': 'expenses' };
const LINK_LISTS = { vehicleId: 'vehicles', clientId: 'clients', driverId: 'drivers', rentalId: 'rentals' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = iso => { try{ return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }catch(e){ return ''; } };
const mb = n => (n / 1048576 < 10 ? (n / 1048576).toFixed(1) : Math.round(n / 1048576)) + ' MB';
const dur = ms => { const m = Math.round(Math.abs(ms) / 60000); return m >= 120 ? Math.round(m / 60) + ' hours' : m + ' minutes'; };

export function qrSvg(text, px){
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), quiet = 3, size = n + quiet * 2; let d = '';
  for(let y = 0; y < n; y++) for(let x = 0; x < n; x++) if(q.isDark(y, x)) d += 'M' + (x + quiet) + ',' + (y + quiet) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="Pairing code"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

export function initConnectPhone(ctx){
  const bridge = window.fleetDesktop;
  if(!bridge || typeof bridge.syncOpen !== 'function') return { open(){ ctx.toast('Phone sync is only available in the installed desktop app.'); } };
  let box = null, timer = null, barTimer = null, bar = null, barSeen = new Set(), started = false, helpOpen = false, shown = '', arrivals = new Set(), cover = null, busyAction = false, editing = null;
  const style = document.createElement('style');
  style.textContent = `
  .fpc-back{position:fixed;inset:0;z-index:99950;background:rgba(10,14,20,.62);display:flex;align-items:center;justify-content:center;padding:18px;}
  .fpc-box{background:#fff;color:#16222b;width:min(980px,100%);max-height:calc(100vh - 36px);overflow:auto;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.4);font:14px/1.45 system-ui,sans-serif;}
  .fpc-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #e3e9ee;position:sticky;top:0;background:#fff;z-index:1;}
  .fpc-head h2{margin:0;font-size:19px;flex:1;}
  .fpc-body{padding:16px 20px 22px;display:grid;gap:14px;}
  .fpc-card{border:1px solid #dfe6ec;border-radius:11px;padding:12px 14px;}
  .fpc-card h3{margin:0 0 8px;font-size:14px;}
  .fpc-row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;}
  .fpc-pin{font:700 30px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;}
  .fpc-btn{border:1px solid #c9d3db;background:#f5f8fa;border-radius:8px;padding:6px 11px;font:600 13px system-ui;cursor:pointer;color:#16222b;}
  .fpc-btn:hover{background:#e9eff3;} .fpc-btn.go{background:#1f7a4d;border-color:#1f7a4d;color:#fff;} .fpc-btn.warn{background:#fff3e0;border-color:#e8b45a;}
  .fpc-btn[disabled]{opacity:.5;cursor:default;}
  .fpc-q{width:34px;height:34px;border-radius:50%;border:1px solid #c9d3db;background:#f5f8fa;font:700 16px system-ui;cursor:pointer;}
  .fpc-ok{color:#1f7a4d;font-weight:600;} .fpc-bad{color:#b3261e;font-weight:600;} .fpc-dim{color:#5d6b76;font-size:12.5px;}
  .fpc-item{border-top:1px solid #edf1f4;padding:9px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
  .fpc-item:first-of-type{border-top:0;} .fpc-item .tt{flex:1;min-width:240px;}
  .fpc-tag{display:inline-block;border-radius:6px;padding:1px 7px;font:700 11px system-ui;background:#e6eef5;color:#27475e;margin-right:6px;text-transform:uppercase;}
  .fpc-help h4{margin:10px 0 4px;} .fpc-help ol{margin:4px 0 4px 20px;padding:0;}
  .fpc-form{display:grid;grid-template-columns:150px 1fr;gap:6px 10px;align-items:center;margin:10px 0;} .fpc-form input,.fpc-form select{width:100%;padding:6px 8px;border:1px solid #c9d3db;border-radius:7px;font:13px system-ui;}
  .fpc-cover{position:fixed;inset:0;z-index:100010;background:rgba(10,14,20,.72);color:#fff;display:flex;align-items:center;justify-content:center;font:600 20px system-ui;letter-spacing:.02em;}
  .fpb{position:fixed;left:0;right:0;bottom:0;height:26px;z-index:99900;display:flex;align-items:center;gap:10px;padding:0 14px;font:600 12.5px system-ui,sans-serif;cursor:pointer;user-select:none;background:#2b3640;color:#e8eef2;border-top:1px solid rgba(255,255,255,.12);}
  .fpb .dot{width:10px;height:10px;border-radius:50%;background:#8a98a3;flex:none;}
  .fpb .sp{flex:1;} .fpb .dim{font-weight:500;opacity:.85;}
  .fpb.on{background:#1f7a4d;color:#fff;} .fpb.on .dot{background:#7dffb5;box-shadow:0 0 0 3px rgba(125,255,181,.3);}
  .fpb.sy .dot{animation:fpbp 1s infinite;} .fpb.ask{background:#b36b00;color:#fff;} .fpb.ask .dot{background:#ffd27a;animation:fpbp 1s infinite;}
  .fpb.off{background:#2b3640;color:#cfd8de;} .fpb.off .dot{background:#8a98a3;}
  @keyframes fpbp{50%{opacity:.35;}}
  body.fp-sbar .app{height:calc(100vh - 26px);}
  @media print{.fpb{display:none !important;}}
  .fp-arrived{display:inline-block;width:9px;height:9px;border-radius:50%;background:#2fb36b;margin-right:6px;vertical-align:middle;box-shadow:0 0 0 2px rgba(47,179,107,.25);}
  `;
  document.head.appendChild(style);

  /* ---------- the status bar (every screen): green = a phone is connected ---------- */
  function barEl(){
    let el = document.getElementById('fpStatusBar');
    if(!el){ el = document.createElement('div'); el.id = 'fpStatusBar'; el.className = 'fpb'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.title = 'Click to open Connect phone';
      el.addEventListener('click', () => open()); document.body.appendChild(el); document.body.classList.add('fp-sbar'); }
    return el;
  }
  function barView(b){
    if(!b) return { cls: 'off', text: 'Phone connection: unavailable', dim: '' };
    if(!b.running) return { cls: 'off', text: 'Phone connection is off', dim: b.error ? b.error.slice(0, 110) : 'click here to connect' };
    if(!b.network) return { cls: 'off', text: 'No network found on this computer', dim: 'phones cannot connect. Click here for ways to connect' };
    if(b.waiting > 0) return { cls: 'ask', text: 'A phone is waiting for your answer', dim: 'click here to answer' };
    const lastSync = b.lastSync ? ' \u00b7 last sync ' + new Date(b.lastSync.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const rev = b.review ? ' \u00b7 ' + b.review + ' to review' : '';
    if(b.connected.length){ const names = b.connected.map(c => c.name).join(', ');
      return { cls: 'on' + (b.syncing ? ' sy' : ''), text: b.syncing ? 'Syncing with ' + names + '\u2026' : 'Phone connected: ' + names, dim: lastSync.replace(/^ \u00b7 /, '') + rev }; }
    return { cls: '', text: 'Ready for a phone', dim: (b.paired ? b.paired + ' paired, none connected now' : 'no phone paired yet') + lastSync + rev + (b.address ? ' \u00b7 ' + b.address : '') };
  }
  function paintBar(){
    const v = barView(bar), el = barEl(), sig = v.cls + '|' + v.text + '|' + v.dim; if(el.dataset.sig === sig) return; el.dataset.sig = sig;
    el.className = 'fpb ' + v.cls;
    el.innerHTML = '<span class="dot"></span><span>' + esc(v.text) + '</span><span class="dim">' + (v.dim ? esc(v.dim) : '') + '</span><span class="sp"></span><span class="dim">\ud83d\udcf1 Connect phone</span>';
  }
  async function pollBar(){
    try{ const r = await bridge.syncBar(); bar = r && r.ok ? r.bar : null; }catch(e){ bar = null; }
    if(bar && bar.waitingIds){                                // a toast the first time a phone starts waiting, so it is not missed
      const fresh = bar.waitingIds.filter(id => !barSeen.has(id)); bar.waitingIds.forEach(id => barSeen.add(id));
      if(fresh.length && !box) ctx.toast('A phone wants to connect. Click the bar at the bottom to answer.');
    }
    paintBar();
  }
  function startBar(){ barEl(); if(!barTimer){ pollBar(); barTimer = setInterval(pollBar, 2000); } }
  /* ---------- the "Syncing..." cover ---------- */
  const coverShow = () => { if(cover) return; cover = document.createElement('div'); cover.className = 'fpc-cover'; cover.setAttribute('role', 'alert'); cover.textContent = 'Syncing\u2026 please wait a few seconds'; document.body.appendChild(cover); };
  const coverHide = () => { if(cover){ cover.remove(); cover = null; } };

  /* ---------- green dots (records that arrived from the phone today; not saved anywhere, not in Excel) ---------- */
  let dotObs = null, dotTimer = null;
  function paintDots(){
    if(dotObs) dotObs.disconnect();
    Object.keys(PANEL_LISTS).forEach(pid => {
      const panel = document.getElementById(pid); if(!panel) return; const list = PANEL_LISTS[pid];
      panel.querySelectorAll('tr').forEach(tr => {
        const btn = tr.querySelector('.row-edit[data-id],.row-del[data-id]'); const td = tr.querySelector('td'); if(!btn || !td) return;
        const has = td.querySelector('.fp-arrived'), want = arrivals.has(list + ':' + btn.dataset.id);
        if(want && !has){ const s = document.createElement('span'); s.className = 'fp-arrived'; s.title = 'Arrived from the phone today'; td.insertBefore(s, td.firstChild); }
        else if(!want && has) has.remove();
      });
    });
    watchDots();
  }
  function watchDots(){
    if(!dotObs) dotObs = new MutationObserver(() => { clearTimeout(dotTimer); dotTimer = setTimeout(paintDots, 60); });
    Object.keys(PANEL_LISTS).forEach(pid => { const p = document.getElementById(pid); if(p) dotObs.observe(p, { childList: true, subtree: true }); });
  }
  async function loadArrivals(){
    try{ const r = await bridge.syncArrivals(); arrivals = new Set(((r && r.items) || []).map(x => x.list + ':' + x.id)); }catch(e){ arrivals = new Set(); }
    paintDots();
  }

  /* ---------- the computer asks the screen to save first, then to reload ---------- */
  bridge.onSyncPrepare(async () => { coverShow(); const ok = await ctx.flush(); if(!ok) coverHide(); return ok; });
  bridge.onSyncReload(async info => {
    try{ if(info && info.changed){ await ctx.reload(); await loadArrivals(); } }
    finally{ coverHide(); }
    if(info && info.changed) ctx.toast('Phone changes were added.');
    if(box) refresh();
  });
  loadArrivals();
  let day = new Date().toDateString(); setInterval(() => { const d = new Date().toDateString(); if(d !== day){ day = d; loadArrivals(); } }, 60000);   // dots clear the next day

  /* ---------- the generic Edit form (every field of the record; links are lists to choose from) ---------- */
  function openEditor(opts){          // { title, record, reviewId, list, id }
    const db = ctx.getDb(), rec = JSON.parse(JSON.stringify(opts.record || {}));
    const ov = document.createElement('div'); ov.className = 'fpc-back'; ov.style.zIndex = 99960;
    const label = (list, r) => r ? (r.reg || r.plate || r.name || r.person || (r.pickup ? r.pickup + ' ' : '') + '#' + r.id) : '';
    const fields = Object.keys(rec).map(k => {
      const v = rec[k], name = esc(k);
      if(k === 'id') return '<label>' + name + '</label><span>' + esc(v) + '</span>';
      if(LINK_LISTS[k]){ const list = LINK_LISTS[k], opts2 = (db[list] || []).map(r => '<option value="' + esc(r.id) + '"' + (String(r.id) === String(v) ? ' selected' : '') + '>' + esc(label(list, r)) + '</option>').join('');
        const missing = v != null && v !== '' && !(db[list] || []).some(r => String(r.id) === String(v));
        return '<label>' + name + '</label><select data-f="' + name + '" data-k="link"><option value=""></option>' + (missing ? '<option value="' + esc(v) + '" selected>' + esc(v) + ' (missing)</option>' : '') + opts2 + '</select>'; }
      if(typeof v === 'boolean') return '<label>' + name + '</label><input type="checkbox" data-f="' + name + '" data-k="bool"' + (v ? ' checked' : '') + '>';
      if(typeof v === 'number') return '<label>' + name + '</label><input type="number" step="any" data-f="' + name + '" data-k="num" value="' + esc(v) + '">';
      if(v !== null && typeof v === 'object') return '<label>' + name + '</label><span class="fpc-dim">' + esc(JSON.stringify(v)).slice(0, 120) + ' (not editable here)</span>';
      return '<label>' + name + '</label><input type="text" data-f="' + name + '" data-k="str" value="' + esc(v == null ? '' : v) + '">';
    }).join('');
    ov.innerHTML = '<div class="fpc-box" style="width:min(640px,100%)"><div class="fpc-head"><h2>' + esc(opts.title || 'Edit') + '</h2><button class="fpc-btn" data-x>Cancel</button></div><div class="fpc-body"><div class="fpc-form">' + fields + '</div><div class="fpc-err fpc-bad"></div><div><button class="fpc-btn go" data-save>Save</button></div></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', async e => {
      if(e.target === ov || e.target.closest('[data-x]')){ ov.remove(); return; }
      if(!e.target.closest('[data-save]')) return;
      const out = JSON.parse(JSON.stringify(rec));
      ov.querySelectorAll('[data-f]').forEach(el => { const k = el.dataset.f, kind = el.dataset.k;
        if(kind === 'bool') out[k] = el.checked; else if(kind === 'num') out[k] = el.value === '' ? 0 : Number(el.value);
        else if(kind === 'link'){ const raw = el.value; out[k] = raw === '' ? (typeof rec[k] === 'number' || rec[k] === null ? null : '') : (/^\d+$/.test(raw) ? Number(raw) : raw); }
        else out[k] = el.value; });
      const r = await bridge.syncResolve(opts.reviewId, 'edit', { data: out, list: opts.list, id: opts.id });
      if(r && r.ok){ ov.remove(); ctx.toast('Saved.'); refresh(); }
      else ov.querySelector('.fpc-err').textContent = 'That could not be saved: ' + ((r && r.error) || 'unknown problem') + '.';
    });
  }
  const findRec = (list, id) => (ctx.getDb()[list] || []).find(r => String(r.id) === String(id));

  /* ---------- the window ---------- */
  function helpHtml(noNet){
    return '<div class="fpc-card fpc-help"><h3>' + esc(help.title) + '</h3><p>' + esc(help.intro) + '</p>' + (noNet ? '<p class="fpc-bad">' + esc(help.noNetwork) + '</p>' : '')
      + help.ways.map(w => '<h4>' + esc(w.title) + '</h4><div class="fpc-dim">' + esc(w.needs) + '</div><ol>' + w.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol><div class="fpc-dim">How you know it worked: ' + esc(w.worked) + '</div>').join('')
      + '<h4>If something does not work</h4><ul>' + help.ifStuck.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>';
  }
  function reviewButtons(it){
    const b = (a, label, cls) => '<button class="fpc-btn ' + (cls || '') + '" data-act="' + a + '" data-id="' + it.id + '">' + label + '</button>';
    const P = it.payload || {};
    if(it.kind === 'conflict') return b('edit', 'Edit') + b('useOther', 'Use the other version') + b('dismiss', 'Keep as it is');
    if(it.kind === 'delete-edit') return b('restore', 'Restore it', 'go') + b('edit', 'Edit and restore') + b('dismiss', 'Keep it deleted');
    if(it.kind === 'held') return b('edit', 'Edit and add it', 'go');
    if(P.a && P.b) return '<button class="fpc-btn" data-act="editrec" data-id="' + it.id + '" data-list="' + esc(P.a.list) + '" data-rec="' + esc(P.a.id) + '">Edit first</button><button class="fpc-btn" data-act="editrec" data-id="' + it.id + '" data-list="' + esc(P.b.list) + '" data-rec="' + esc(P.b.id) + '">Edit second</button>' + b('dismiss', 'It is fine');
    if(P.auto) return b('dismiss', 'I have looked');
    return b('edit', 'Edit') + b('dismiss', 'I have looked');
  }
  const KIND = { conflict: 'Edited on both sides', 'delete-edit': 'Deleted and edited', held: 'Held aside', overlap: 'Double booking', duplicate: 'Possible duplicate', 'broken-link': 'Missing link' };
  function pendingHtml(st){
    let h = '';
    st.pending.forEach(p => {
      h += '<div class="fpc-item"><div class="tt"><b>' + esc(p.name) + '</b> wants to connect.' + (p.clock ? '<div class="fpc-bad">The clocks differ by about ' + dur(p.diffMs) + '. This computer says ' + esc(t(p.desktopTime)) + ', the phone says ' + esc(t(p.phoneTime)) + '. Which one is correct?</div>' : '') + '</div>'
        + (p.clock ? '<button class="fpc-btn go" data-act="approve" data-id="' + p.id + '" data-ref="phone">The phone is right</button><button class="fpc-btn go" data-act="approve" data-id="' + p.id + '" data-ref="desktop">This computer is right</button>'
          : '<button class="fpc-btn go" data-act="approve" data-id="' + p.id + '">Approve</button>') + '<button class="fpc-btn" data-act="reject" data-id="' + p.id + '">Not this phone</button></div>';
    });
    st.clockPending.forEach(c => {
      h += '<div class="fpc-item"><div class="tt"><b>' + esc(c.name) + '</b>: the clocks now differ by about ' + dur(c.diffMs) + '. This computer says ' + esc(t(c.desktopTime)) + ', the phone says ' + esc(t(c.phoneTime)) + '. Which one is correct? Syncing continues as soon as you answer.</div>'
        + '<button class="fpc-btn go" data-act="clock" data-dev="' + esc(c.device) + '" data-ref="phone">The phone is right</button><button class="fpc-btn go" data-act="clock" data-dev="' + esc(c.device) + '" data-ref="desktop">This computer is right</button></div>';
    });
    return h ? '<div class="fpc-card" style="border-color:#e8b45a;background:#fffaf0"><h3>Waiting for you</h3>' + h + '</div>' : '';
  }
  async function render(){
    const sr = await bridge.syncStatus(); if(!box) return;
    if(!sr || !sr.ok){ box.querySelector('.fpc-body').innerHTML = '<div class="fpc-card">Connect phone could not start: ' + esc(sr && sr.error || 'unknown problem') + '</div>'; return; }
    const st = sr.status, rv = await bridge.syncReview(), items = (rv && rv.items) || [];
    if(!box) return;                                           // closed while waiting
    const noNet = !st.network;
    let h = '';
    h += '<div class="fpc-card"><span class="' + (noNet ? 'fpc-dim' : 'fpc-ok') + '">' + (noNet ? 'No network found on this computer.' : 'This computer is on a network.') + '</span> <span class="fpc-dim">' + (st.running ? 'Phones can connect at any time while FleetPilot is open. You can close this window.' : '') + '</span></div>';
    if(st.error) h += '<div class="fpc-card">' + esc(st.error) + '</div>';
    if(helpOpen || noNet) h += helpHtml(noNet);
    if(st.running){
      h += '<div class="fpc-card"><h3>Connect a phone</h3><div class="fpc-row"><div>' + qrSvg(st.qr, 190) + '</div><div style="flex:1;min-width:240px">'
        + '<div class="fpc-dim">PIN (one phone, one time)</div><div class="fpc-pin">' + esc(st.pin) + '</div>'
        + '<p class="fpc-bad">Sync traffic is not encrypted yet. Use only a trusted private network; do not pair or sync on public or guest Wi-Fi.</p>'
        + '<p class="fpc-dim">On the phone open <b>Connect to desktop</b> and scan the code. If the camera is not allowed, type this address and the PIN instead:</p>'
        + '<div><b>' + esc(st.addresses.join('   or   ') || 'no address found') + '</b></div>'
        + (st.badPins ? '<p class="fpc-dim">There have been ' + st.badPins + (st.badPins === 1 ? ' wrong PIN attempt.' : ' wrong PIN attempts.') + ' After five, pairing from that network address is locked for five minutes. Changing the PIN does not remove the lock.</p>' : '')
        + '<div><button class="fpc-btn" data-act="newpin">New PIN</button> <button class="fpc-btn warn" data-act="disconnect">Disconnect</button></div></div></div></div>';
    }else{
      h += '<div class="fpc-card"><h3>Phone connection is off</h3><p class="fpc-dim">Phones cannot connect until you press Connect. FleetPilot does not listen for phone connections until you open Connect phone.</p><button class="fpc-btn go" data-act="restart">Connect</button></div>';
    }
    h += pendingHtml(st);
    h += '<div class="fpc-card"><h3>Paired phones</h3>' + ((st.devices || []).length ? (st.devices || []).map(d => '<div class="fpc-item"><div class="tt"><b>' + esc(d.name) + '</b> <span class="fpc-dim">paired ' + esc(t(d.paired_at)) + '</span></div><div class="fpc-dim">' + (d.last_sync_at ? 'Last sync ' + esc(t(d.last_sync_at)) : 'Has not synced yet') + '</div></div>').join('') : '<span class="fpc-dim">No phone is paired yet.</span>') + '</div>';
    const hl = st.health || {}, lc = hl.lastCheck;
    h += '<div class="fpc-card"><h3>Database health</h3><div class="' + (!lc || lc.ok ? 'fpc-ok' : 'fpc-bad') + '">' + (!lc ? 'Database healthy (checked when this window opened)' : lc.ok ? 'Database healthy' : 'The last check found a problem') + '</div>'
      + '<div class="fpc-dim">' + (lc ? 'Last check ' + esc(t(lc.at)) + '. ' : '') + esc(st.records) + ' records. ' + (hl.lastCopy ? 'Last safety copy ' + esc(t(hl.lastCopy.madeAt)) + '. ' : 'No safety copy yet. ') + 'Safety copies use ' + mb(hl.copiesBytes || 0) + '.</div>'
      + '<div style="margin-top:7px"><button class="fpc-btn" data-act="check">Check now</button> <button class="fpc-btn" data-act="folder">Open the data folder</button> <button class="fpc-btn" data-act="copies">Manage safety copies</button></div><div id="fpcCopies"></div></div>';
    h += '<div class="fpc-card"><h3>Review list (' + items.length + ')</h3>' + (items.length ? items.map(it => '<div class="fpc-item"><div class="tt"><span class="fpc-tag">' + esc(KIND[it.kind] || it.kind) + '</span>' + esc(it.title) + '</div>' + reviewButtons(it) + '</div>').join('') : '<span class="fpc-dim">Nothing needs your attention. Held, clashing and doubled records will be listed here, and nothing is changed until you decide.</span>') + '</div>';
    const sig = JSON.stringify([h]); if(sig === shown) return; shown = sig;
    const body = box.querySelector('.fpc-body'), keep = body.scrollTop; body.innerHTML = h; body.scrollTop = keep;
  }
  const refresh = () => render().catch(e => console.warn('connect phone refresh', e));

  async function onClick(e){
    const q = e.target.closest('.fpc-q'); if(q){ helpOpen = !helpOpen; shown = ''; return refresh(); }
    if(e.target.closest('[data-close]')) return close();
    const el = e.target.closest('[data-act]'); if(!el || busyAction) return;
    const act = el.dataset.act, id = el.dataset.id; busyAction = true;
    try{
      if(act === 'approve'){ const r = await bridge.syncApprove(id, el.dataset.ref ? { reference: el.dataset.ref } : undefined); if(!r.ok) ctx.toast(r.error || 'Could not approve.'); else ctx.toast('Approved. The phone can now receive your ledger.'); }
      else if(act === 'reject') await bridge.syncReject(id);
      else if(act === 'newpin'){ const r = await bridge.syncNewPin(); ctx.toast(r && r.ok ? 'A new PIN is showing.' : ((r && r.error) || 'Could not make a new PIN.')); }
      else if(act === 'disconnect'){ if(confirm('Disconnect phones from this computer?\n\nPhones cannot sync until you press Connect again. Nothing is deleted.')){ await bridge.syncStop(); ctx.toast('Phones are disconnected.'); pollBar(); } }
      else if(act === 'restart'){
        if(confirm('Phone sync uses unencrypted network traffic. Connect only on a trusted private network, not public or guest Wi-Fi. Continue?')){
          const r = await bridge.syncRestart(ctx.dbName());
          ctx.toast(r && r.ok ? 'Phones can connect again.' : ((r && r.error) || 'It could not connect.'));
          pollBar();
        }
      }
      else if(act === 'clock'){ const r = await bridge.syncClock(el.dataset.dev, el.dataset.ref); if(!r.ok) ctx.toast(r.error || 'Could not save that.'); }
      else if(act === 'check'){ const r = await bridge.syncHealth(); ctx.toast(r.ok ? 'Database healthy.' : 'The check found a problem. Do not sync; recover a safety copy.'); }
      else if(act === 'folder') await bridge.dbShowFolder();
      else if(act === 'copies') await showCopies();
      else if(act === 'delcopy'){ if(confirm('Remove this copy from this computer?\n\n' + el.dataset.name + '\n\nIt cannot be brought back.')){ const r = el.dataset.kind === 'extra' ? await bridge.syncDeleteExtra(el.dataset.name) : await bridge.dbDeleteCopy(el.dataset.name); ctx.toast(r.ok ? 'Removed.' : (r.error || 'Could not remove.')); await showCopies(); } }
      else if(act === 'dismiss'){ await bridge.syncResolve(Number(id), 'dismiss'); }
      else if(act === 'useOther' || act === 'restore'){
        const r = await bridge.syncResolve(Number(id), act); ctx.toast(r.ok ? 'Done.' : (r.error || 'Could not do that.'));
      }else if(act === 'edit' || act === 'editrec'){
        const rv = await bridge.syncReview(), it = (rv.items || []).find(x => x.id === Number(id)); if(it){
          const P = it.payload || {}; let rec = null, list = it.list, rid = it.rec_id;
          if(act === 'editrec'){ list = el.dataset.list; rid = el.dataset.rec; rec = findRec(list, rid); }
          else if(it.kind === 'conflict') rec = findRec(list, rid) || P.desktop;
          else if(it.kind === 'delete-edit') rec = P.edited;
          else if(it.kind === 'held') rec = P.change && P.change.data;
          else rec = findRec(list, rid);
          if(!rec) ctx.toast('That record is no longer on this computer.'); else openEditor({ title: 'Edit ' + String(list).replace(/s$/, '') + ' ' + rid, record: rec, reviewId: it.id, list, id: rid });
        }
      }
    }finally{ busyAction = false; shown = ''; refresh(); }
  }
  async function showCopies(){
    const host = box.querySelector('#fpcCopies'); if(!host) return;
    const c = await bridge.dbCopies(), x = await bridge.syncExtras();
    const rows = ((c && c.copies) || []).map(k => ({ name: k.id, size: k.size, kind: 'copy', note: k.kind === 'monthly' ? 'monthly copy ' + k.tag : 'copy before upgrade ' + k.tag }))
      .concat(((x && x.items) || []).map(k => ({ name: k.name, size: k.size, kind: 'extra', note: /phone backup/.test(k.name) ? 'phone backup' : 'before pairing' })));
    host.innerHTML = '<div style="margin-top:8px">' + (rows.length ? rows.map(r => '<div class="fpc-item"><div class="tt">' + esc(r.note) + ' <span class="fpc-dim">' + esc(r.name) + ' (' + mb(r.size) + ')</span></div><button class="fpc-btn warn" data-act="delcopy" data-kind="' + r.kind + '" data-name="' + esc(r.name) + '">Remove…</button></div>').join('') : '<span class="fpc-dim">No copies yet.</span>') + '<div class="fpc-dim">Nothing is ever removed unless you press Remove and confirm.</div></div>';
  }

  async function open(){
    if(box) return;
    const name = ctx.dbName(); if(!name){ ctx.toast('The database is not ready yet.'); return; }
    if(!started){ started = true; startBar(); }
    const first = await ctx.flush();                              // what is on screen is saved first
    box = document.createElement('div'); box.className = 'fpc-back';
    box.innerHTML = '<div class="fpc-box" role="dialog" aria-label="Connect phone"><div class="fpc-head"><h2>\ud83d\udcf1 Connect phone</h2><button class="fpc-q" title="How do I connect?" aria-label="How do I connect?">?</button><button class="fpc-btn" data-close>Close</button></div><div class="fpc-body"><div class="fpc-card">Starting\u2026</div></div></div>';
    box.addEventListener('click', onClick); document.body.appendChild(box); shown = ''; helpOpen = false;
    await refresh(); timer = setInterval(refresh, 1500);
    try{ const s = (await bridge.syncStatus()).status; if(s && !s.network){ helpOpen = true; shown = ''; refresh(); } }catch(e){}
    if(first === false) ctx.toast('Your last change could not be saved first. Check the red message before syncing.');
  }
  async function close(){
    clearInterval(timer); timer = null;
    if(box){ box.remove(); box = null; }
    loadArrivals(); pollBar();                                  // closing the window leaves the connection on
  }
  return { open, close, loadArrivals };
}
