/* Admin "Pilot" area (behind the PIN): Overview (was Sheet1), Loans, Insurance, Chama, OCHWADA statement.
   Everything is drawn live from the database; nothing here is typed twice. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { monthlySummary, SUMMARY_COLUMNS } from './summary.js';
import { statement } from './statement.js';
import { pagesHtml, pagesClick, pagesChange, drillHtml, fig, PAGE_LIST } from './pages.js';
import * as PC from './pilotConfig.js';
import { initPilotConfigUi } from './pilotConfigUi.js';
import { loansHtml, loansClick, loansChange, loansRegistry } from './loans.js';
import { explorerClick, explorerChange, explorerRegistry } from './expenseExplorer.js';
import { bindGrid } from './gridEdit.js';
import { carPerfHtml } from './carPerf.js';
import { subhireRegistry, subhirePageHtml, driverPageHtml } from './subhireUi.js';
import { chamaHtml, chamaClick, chamaChange, chamaRegistry } from './chama.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthName = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
const num = v => Number(v) || 0;
const DEFAULT_TABS = [['overview', 'Overview'], ['pages', 'Pages'], ['subhire', 'Sub-hire'], ['loans', 'Loans'], ['insurance', 'Insurance'], ['ochwada', 'OCHWADA']].map(([id, label]) => ({ id, label }));
const DEFAULT_PAGES = PAGE_LIST.map(p => ({ id: p.id, label: p.label }));
const OV_COLS = SUMMARY_COLUMNS.map(c => ({ id: c.key, label: c.label })).concat([{ id: 'other', label: 'Other' }, { id: 'total', label: 'Total spent' }, { id: 'billed', label: 'Billed' }]);
const DESTINATIONS = DEFAULT_TABS.map(t => ({ dest: 'tab:' + t.id, label: t.label, group: 'Sections' })).concat(DEFAULT_PAGES.map(p => ({ dest: 'page:' + p.id, label: p.label, group: 'Pages' })));

export function initPilot(ctx){
  const root = document.getElementById('panel-pilot');
  let tab = 'overview', carryBF = true;
  const chamaSt = { view: {}, showNew: false };
  const loanSt = { dueMonth: '' };
  const pg = { page: 'progress', vehicleId: '', month: '', drill: null };
  const pgCtx = { fmt: n => ctx.fmt(n), paidFor: id => ctx.paidForRental(id), nav: ctx.nav, db: () => ctx.getDb(), uid: () => ctx.uid(), toast: m => ctx.toast(m), markDirty: () => ctx.markDirty(),
    guard: (date, label, cb) => ctx.guard(date, label, cb), removeExpense: (id, cb) => ctx.removeExpense(id, cb), redraw: () => render() };
  const db = () => ctx.getDb();
  const fmt = n => ctx.fmt(n);
  const save = () => { ctx.markDirty(); render(); };

  /* ---------- display settings (the ⋮ menu): see pilotConfig.js ---------- */
  const cfg = () => { const st = db().settings || (db().settings = {}); if(!st.pilotConfig || typeof st.pilotConfig !== 'object' || Array.isArray(st.pilotConfig)) st.pilotConfig = {}; return st.pilotConfig; };
  const tabsR = () => PC.resolveList(DEFAULT_TABS, cfg().tabs), pagesR = () => PC.resolveList(DEFAULT_PAGES, cfg().pages), colsR = () => PC.resolveList(OV_COLS, cfg().cols);
  const linksR = () => PC.resolveLinks(cfg().links, DESTINATIONS.map(d => d.dest));
  const tabLabel = id => (tabsR().find(t => t.id === id) || DEFAULT_TABS.find(t => t.id === id) || { label: id }).label;
  pgCtx.pageList = () => pagesR().filter(p => !p.hidden).map(p => ({ id: p.id, label: p.label }));
  function renderLinks(){
    const holder = document.getElementById('pilotLinks'); if(!holder) return;
    holder.innerHTML = linksR().map(l => { const d = PC.destOf(l.dest); if(!d) return '';
      return `<button class="sub" data-panel="pilot" data-tab="${d.kind === 'tab' ? esc(d.key) : 'pages'}"${d.kind === 'page' ? ` data-page="${esc(d.key)}"` : ''}><span class="label-txt">${esc(l.label)}</span></button>`; }).join('');
  }
  const configUi = initPilotConfigUi({ destinations: DESTINATIONS,
    lists: () => ({ links: linksR(), tabs: tabsR(), pages: pagesR(), cols: colsR() }),
    save: patch => { const c = cfg(); Object.keys(patch).forEach(k => { c[k] = k === 'links' ? patch[k].map(x => ({ id: x.id, label: x.label, dest: x.dest })) : PC.compact(patch[k]); }); ctx.markDirty(); render(); renderLinks(); },
    reset: which => { const c = cfg(); if(which === 'all'){ ['links', 'tabs', 'pages', 'cols'].forEach(k => { delete c[k]; }); } else delete c[which]; ctx.markDirty(); render(); renderLinks(); } });
  document.addEventListener('click', e => { const d = e.target.closest('[data-pldots]'); if(d){ e.preventDefault(); e.stopPropagation(); configUi.openMenu(d); } });
  document.addEventListener('keydown', e => { const d = e.target.closest && e.target.closest('[data-pldots]'); if(d && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); configUi.openMenu(d); } });

  function monthRange(){
    const d = db(); const all = [];
    const add = s => { if(s && /^\d{4}-\d{2}/.test(s)) all.push(s.slice(0, 7)); };
    d.rentals.forEach(r => add(r.pickup)); d.expenses.forEach(x => add(x.date)); d.insurance.forEach(i => add(i.paidDate));
    (d.settings.standingExpenses || []).forEach(s => add(s.fromMonth + '-01'));
    if(!all.length) return null;
    all.sort(); const today = new Date().toISOString().slice(0, 7);
    return [all[0], all[all.length - 1] > today ? all[all.length - 1] : today];
  }

  function overview(){
    const d = db(), rg = monthRange();
    if(!rg) return '<p class="subtitle">No data yet. Import the Excel file or add rentals and expenses.</p>';
    const rows = monthlySummary(d, rg[0], rg[1]); const snaps = d.settings.overviewSnapshots || {};
    const tot = Object.fromEntries(SUMMARY_COLUMNS.map(c => [c.key, 0]).concat([['billed', 0], ['rentals', 0], ['other', 0]]));
    rows.forEach(r => { Object.keys(tot).forEach(k => { tot[k] += num(r[k]); }); });
    const sumCols = r => SUMMARY_COLUMNS.reduce((s, c) => s + num(r[c.key]), 0) + num(r.other);
    const rent = (d.settings.standingExpenses || []).find(s => s.category === 'Rent') || { amount: 0, fromMonth: rg[0] };
    const cols = colsR().filter(c => !c.hidden);          // the person's own choice of columns, order and names (⋮ > Pilot display)
    const head = cols.map(c => `<th class="num">${esc(c.label)}</th>`).join('') + '<th></th>';
    const f = (r, col) => r[col] ? fig({ col, from: r.month, to: r.month }, fmt(r[col])) : '—';
    const cell = (r, c) => c.id === 'total' ? `<td class="num"><b>${sumCols(r) ? fig({ col: 'total', from: r.month, to: r.month }, fmt(sumCols(r))) : fmt(0)}</b></td>` : `<td class="num">${f(r, c.id)}</td>`;
    const body = rows.map(r => { const sn = snaps[r.month]; const changed = sn && sn.total !== sumCols(r);
      return `<tr><td>${monthName(r.month)}</td>${cols.map(c => cell(r, c)).join('')}
        <td>${sn ? (changed ? '<span title="Changed since it was saved">⚠ saved ' + fmt(sn.total) + '</span> ' : '✓ saved ') : ''}<button class="row-edit" data-act="savemonth" data-m="${r.month}">${sn ? 'Re-save' : 'Save month'}</button></td></tr>`; }).join('');
    const totSpent = SUMMARY_COLUMNS.reduce((s, c) => s + tot[c.key], 0) + tot.other;
    const foot = cols.map(c => c.id === 'total' ? `<th class="num">${totSpent ? fig({ col: 'total', from: rg[0], to: rg[1] }, fmt(totSpent)) : fmt(0)}</th>` : `<th class="num">${tot[c.id] ? fig({ col: c.id, from: rg[0], to: rg[1] }, fmt(tot[c.id])) : fmt(0)}</th>`).join('');
    return `${drillHtml(db(), pg, pgCtx)}<div class="form-grid" style="margin-bottom:12px;"><div><label>Standing rent per month</label><input id="pl_rent" type="number" value="${rent.amount}"></div>
        <div><label>From month (YYYY-MM)</label><input id="pl_rentFrom" value="${esc(rent.fromMonth)}"></div></div>
      <button class="btn" data-act="saverent" style="width:auto;padding:8px 16px;margin-bottom:14px;">Update rent</button>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>Month</th>${head}</tr></thead><tbody>${body}</tbody>
      <tfoot><tr><th>TOTAL</th>${foot}<th></th></tr></tfoot></table></div></div>
      ${carPerfHtml(d, { from: rg[0] + '-01', to: rg[1] + '-31' }, ctx)}
      <p class="subtitle">Updates as you work: add Rent 7,000 or Fuel 5,000 under Expenses and that month changes straight away. Click any figure to see the records behind it. "Save month" keeps that month's total so a later edit shows as a change.</p>`;
  }

  /* Loans: three editable tables (monthly, due in a month, individuals) hanging from the loan list. Drawn by loans.js, edited by gridEdit.js. */
  function loans(){
    return drillHtml(db(), pg, pgCtx) + loansHtml(db(), loanSt, { fmt: n => ctx.fmt(n), uid: () => ctx.uid() });
  }

  function insurance(){
    const d = db(); const veh = id => (d.vehicles.find(v => v.id == id) || {}).reg || '—';
    const list = newestFirst(d.insurance), today = new Date().toISOString().slice(0, 10);
    const total = list.reduce((s, i) => s + num(i.amount), 0), expired = list.filter(i => i.expiryDate && i.expiryDate < today).length;
    const byCar = {}, byMonth = {}, carId = {};
    list.forEach(i => { const r = veh(i.vehicleId); if(i.vehicleId) carId[r] = i.vehicleId; (byCar[r] = byCar[r] || { n: 0, t: 0 }); byCar[r].n++; byCar[r].t += num(i.amount);
      const m = (i.paidDate || '').slice(0, 7) || 'No date'; (byMonth[m] = byMonth[m] || { n: 0, t: 0 }); byMonth[m].n++; byMonth[m].t += num(i.amount); });
    const mini = (title, obj, label, sp) => `<div class="table-wrap" style="flex:1;min-width:260px;"><div class="table-scroll"><table class="pg-table" data-no-tools="1"><thead><tr><th>${title}</th><th class="num">Policies</th><th class="num">Total</th></tr></thead><tbody>${Object.keys(obj).sort().map(k => `<tr><td>${esc(label(k))}</td><td class="num">${obj[k].n}</td><td class="num">${obj[k].t ? fig(sp(k), fmt(obj[k].t)) : fmt(obj[k].t)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="3">Nothing yet.</td></tr>'}</tbody><tfoot><tr><th>TOTAL</th><th class="num">${list.length}</th><th class="num">${total ? fig({ col: 'insTab' }, fmt(total)) : fmt(total)}</th></tr></tfoot></table></div></div>`;
    const cards = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;"><div class="table-wrap" style="padding:10px 14px;min-width:160px;flex:1;"><div class="subtitle" style="margin:0;">Insurance total</div><div style="font-size:20px;font-weight:700;">${total ? fig({ col: 'insTab' }, fmt(total)) : fmt(total)}</div><div class="subtitle" style="margin:0;">${list.length} lines</div></div>
      <div class="table-wrap" style="padding:10px 14px;min-width:160px;flex:1;"><div class="subtitle" style="margin:0;">Expired</div><div style="font-size:20px;font-weight:700;${expired ? 'color:var(--red);' : ''}">${expired ? fig({ col: 'insTab', expired: true }, String(expired)) : expired}</div><div class="subtitle" style="margin:0;">with an expiry date in the past</div></div></div>`;
    const rows = list.map(i => `<tr><td>${esc(veh(i.vehicleId))}</td><td class="num">${fmt(i.amount)}</td><td>${esc(i.paidDate || '—')}</td>
      <td><input type="date" value="${esc(i.expiryDate || '')}" data-act="expiry" data-id="${i.id}" style="width:150px;"></td>
      <td>${i.expiryDate && i.expiryDate < today ? '<b style="color:var(--red)">expired</b>' : ''}</td></tr>`).join('');
    return `${drillHtml(d, pg, pgCtx)}<p class="subtitle">Dates from your sheet are payment dates. Add an expiry date where you know it.</p>${cards}
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">${mini('Per vehicle', byCar, k => k, k => ({ col: 'insTab', vehicleId: carId[k] || 'none' }))}${mini('Per month', byMonth, k => k === 'No date' ? k : monthName(k), k => ({ col: 'insTab', month: k === 'No date' ? 'none' : k }))}</div>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>Vehicle</th><th class="num">Amount</th><th>Paid on</th><th>Expires</th><th></th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="5">No insurance lines.</td></tr>'}</tbody><tfoot><tr><th>TOTAL</th><th class="num">${total ? fig({ col: 'insTab' }, fmt(total)) : fmt(total)}</th><th></th><th></th><th></th></tr></tfoot></table></div></div>`;
  }

  function subhire(){
    return `${drillHtml(db(), pg, pgCtx)}<p class="subtitle">Cars you hired from owners: what each owner is owed and whether you have paid them, the job each car did, and the drivers who took those jobs. Click a cell to type, as in the Excel.</p>
      ${subhirePageHtml(db(), pg, pgCtx)}<h2 id="shDrivers" style="margin:26px 0 4px;">Drivers on sub-hire cars</h2>${driverPageHtml(db(), pg, pgCtx)}`;
  }

  function chama(){ return drillHtml(db(), pg, pgCtx) + chamaHtml(db(), chamaSt, chamaCtx); }

  function ochwada(){
    const d = db(); const by = {};
    d.accounts.filter(a => a.account === 'OCHWADA').forEach(a => { const b = by[a.month] = by[a.month] || { month: a.month, bf: null, entries: [], sheetTotal: null }; if(a.kind === 'bf') b.bf = num(a.amount); else b.entries.push(a); });
    const blocks = Object.values(by).sort((a, b) => a.month < b.month ? -1 : 1);
    const st = statement(blocks, { carryBF });
    const dr = (i, kind, v, bold) => v ? fig({ col: 'account', month: blocks[i].month, kind, carry: carryBF }, bold ? '<b>' + fmt(v) + '</b>' : fmt(v)) : (bold ? '<b>' + fmt(v) + '</b>' : fmt(v));
    const rows = st.map((s, i) => `<tr data-m="${blocks[i].month}"><td>${monthName(blocks[i].month)}</td><td class="num">${dr(i, 'opening', s.opening)}</td><td class="num">${dr(i, 'charges', s.charges)}</td><td class="num">${dr(i, 'payments', s.payments)}</td><td class="num">${dr(i, 'closing', s.closing, true)}</td><td class="num">${s.bfDiff ? '<span style="color:var(--amber)" title="BF typed on the sheet was ' + fmt(s.typedBF) + '">BF differs ' + fmt(s.bfDiff) + '</span>' : ''}</td></tr>`).join('');
    const last = st[st.length - 1];
    return `${drillHtml(d, pg, pgCtx)}<label class="fm-check"><input type="checkbox" id="pl_carry" ${carryBF ? 'checked' : ''}><span>Carry each month's closing into the next BF (untick to use the BF typed on the sheet)</span></label>
      <div class="table-wrap" style="margin-top:10px;"><div class="table-scroll"><table><thead><tr><th>Month</th><th class="num">Opening (BF)</th><th class="num">Charges +</th><th class="num">Payments −</th><th class="num">Closing</th><th></th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="6">No OCHWADA lines.</td></tr>'}</tbody></table></div></div>
      ${last ? `<p class="subtitle">Balance now: <b>${last.closing ? fig({ col: 'account', month: last.month, kind: 'closing', carry: carryBF }, fmt(last.closing)) : fmt(last.closing)}</b>. Positive means he owes you.</p>` : ''}
      <div class="form-grid"><div><label>Date</label><input type="date" id="pl_adate"></div><div><label>Amount (− for a payment)</label><input type="number" id="pl_aamt"></div><div><label>Note</label><input id="pl_alabel"></div></div>
      <button class="btn primary" data-act="addaccount" style="width:auto;padding:9px 18px;">+ Add line</button>`;
  }

  function rememberPlace(){
    const t0 = tab, p0 = pg.page, m0 = pg.month; const label = 'Pilot · ' + tabLabel(t0) + (t0 === 'pages' ? ' · ' + p0 : '');
    if(window.fleetTableTools) window.fleetTableTools.pushPlace(label, () => { document.querySelector('.nav button[data-panel="pilot"]')?.click(); tab = t0; pg.page = p0; pg.month = m0; pg.drill = null; render(); }, 'pilot:' + t0 + ':' + p0);
  }
  function render(){
    const all = tabsR(); if(!all.some(t => t.id === tab)) tab = 'overview';
    const tabs = all.filter(t => !t.hidden || t.id === tab).map(t => [t.id, t.label + (t.hidden ? ' (hidden)' : '')]);       // a section that was removed from view but is open right now stays visible until you leave it
    const body = { overview, pages: () => pagesHtml(db(), pg, pgCtx), subhire, loans, insurance, ochwada }[tab]();
    root.innerHTML = `<div class="pl-titlebar"><h1>Pilot</h1><button type="button" class="pl-dots" data-pldots title="Pilot display: choose what is shown and what it is called" aria-label="Pilot display settings" aria-haspopup="menu">⋮</button></div><p class="subtitle">Admin overview. Not shown on the front screens. <span style="margin-left:12px;">Idle screen after <input id="pl_idle" type="number" min="0" max="240" value="${num((db().settings || {}).idleMinutes == null ? 5 : db().settings.idleMinutes)}" style="width:64px;display:inline-block;"> minutes (0 = never)</span></p>${ctx.hasDb && ctx.hasDb() ? '<div id="pl_dbbox" style="margin:0 0 12px;"></div>' : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">${tabs.map(([k, l]) => `<button class="btn ${k === tab ? 'primary' : ''}" data-tab="${k}" style="width:auto;padding:8px 16px;">${esc(l)}</button>`).join('')}</div>${body}`;
    if(ctx.dbBox){ const bx = root.querySelector('#pl_dbbox'); if(bx) ctx.dbBox(bx); }
  }

  const gridRegistry = new Proxy({}, { get: (_, k) => loansRegistry[k] || explorerRegistry[k] || subhireRegistry[k] || chamaRegistry[k] });
  bindGrid(root, gridRegistry, { settings: () => db().settings || (db().settings = {}), changed: () => { ctx.markDirty(); render(); }, confirm: m => window.confirm(m) });
  const loanCtx = { uid: () => ctx.uid(), toast: m => ctx.toast(m), changed: () => { ctx.markDirty(); render(); }, confirm: m => window.confirm(m), prompt: (m, v) => window.askText(m, { value: v }) };
  const chamaCtx = { uid: () => ctx.uid(), toast: m => ctx.toast(m), changed: () => { ctx.markDirty(); render(); }, confirm: m => window.confirm(m), fmt: n => ctx.fmt(n), settings: () => db().settings || (db().settings = {}) };
  root.addEventListener('click', e => {
    const fg = e.target.closest('[data-fuelgo]'); if(fg){ try{ ctx.nav.openFuel(JSON.parse(fg.dataset.fuelgo)); }catch(err){} return; }
    const fz = e.target.closest('[data-pg="drill"]');           // the Overview's Fuel figures are traced in the Fuel table (the other figures open their records here)
    if(fz){ try{ const sp = JSON.parse(fz.dataset.spec); if(sp && sp.col === 'fuel' && !sp.vehicleId){ ctx.nav.openFuel({ from: sp.from ? sp.from + '-01' : '', to: sp.to ? sp.to + '-31' : '' }); return; } }catch(err){} }
    if(e.target.closest('[data-cm]')){ if(chamaClick(e, db(), chamaSt, chamaCtx)) render(); return; }
    if(e.target.closest('[data-ex]')){ if(pg.ex && explorerClick(e, pg.ex, pgCtx)) render(); return; }
    if(e.target.closest('[data-ln]')){ loansClick(e, db(), loanSt, loanCtx); return; }
    if(e.target.closest('[data-pg]')){ if(e.target.closest('[data-pg]').dataset.pg === 'page' && e.target.closest('[data-pg]').dataset.page !== pg.page) rememberPlace(); if(pagesClick(e, pg, pgCtx)){ render(); if(pg.scrollDrill){ pg.scrollDrill = false; const el = document.getElementById('pgDrill'); if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } return; }
    const t = e.target.closest('[data-tab]'); if(t){ if(t.dataset.tab !== tab) rememberPlace(); tab = t.dataset.tab; pg.drill = null; render(); return; }
    const a = e.target.closest('[data-act]'); if(!a) return; const d = db(), act = a.dataset.act;
    if(act === 'savemonth'){ const r = monthlySummary(d, a.dataset.m, a.dataset.m)[0]; if(!r) return;
      d.settings.overviewSnapshots = d.settings.overviewSnapshots || {};
      d.settings.overviewSnapshots[a.dataset.m] = Object.assign({}, r, { total: SUMMARY_COLUMNS.reduce((s, c) => s + num(r[c.key]), 0) + num(r.other), savedAt: new Date().toISOString().slice(0, 10) }); save(); }
    if(act === 'saverent'){ const amount = num(document.getElementById('pl_rent').value), from = document.getElementById('pl_rentFrom').value.trim();
      if(!/^\d{4}-\d{2}$/.test(from)){ ctx.toast('From month must look like 2026-01'); return; }
      d.settings.standingExpenses = (d.settings.standingExpenses || []).filter(s => s.category !== 'Rent').concat([{ category: 'Rent', amount, fromMonth: from }]); save(); }
    if(act === 'toggleloan'){ const l = d.loans.find(x => x.id == a.dataset.id); if(!l) return; const sch = JSON.parse(l.schedule || '[]'); const s = sch[Number(a.dataset.i)]; if(!s) return;
      s.paid = !s.paid; l.schedule = JSON.stringify(sch); const p = sch.filter(x => x.paid); l.paidThrough = p.length ? p[p.length - 1].month : ''; save(); }
    if(act === 'addaccount'){ const date = document.getElementById('pl_adate').value, amount = num(document.getElementById('pl_aamt').value);
      if(!date || !amount){ ctx.toast('Date and amount are needed'); return; }
      d.accounts.push({ id: ctx.uid(), account: 'OCHWADA', month: date.slice(0, 7), date, kind: amount < 0 ? 'payment' : 'charge', amount, label: document.getElementById('pl_alabel').value.trim(), note: '', xlRef: '' }); save(); }
  });
  root.addEventListener('change', e => {
    if(e.target.closest('[data-cm-name]')){ chamaChange(e, db(), chamaCtx); return; }
    if(e.target.closest('[data-exset]')){ if(pg.ex && explorerChange(e, pg.ex)) render(); return; }
    if(loansChange(e, loanSt)){ render(); return; }
    if(e.target.closest('[data-pg-set]')){ if(pagesChange(e, pg)) render(); return; }
    if(e.target.id === 'pl_idle'){ const d = db(); d.settings = d.settings || {}; d.settings.idleMinutes = Math.max(0, Math.min(240, Math.round(num(e.target.value)))); ctx.markDirty(); if(window.fleetIdle) window.fleetIdle.restart(); ctx.toast(d.settings.idleMinutes ? 'Idle screen after ' + d.settings.idleMinutes + ' minutes' : 'Idle screen turned off'); return; }
    if(e.target.id === 'pl_carry'){ carryBF = e.target.checked; render(); return; }
    if(e.target.dataset.act === 'expiry'){ const i = db().insurance.find(x => x.id == e.target.dataset.id); if(i){ i.expiryDate = e.target.value; ctx.markDirty(); render(); } }
  });
  /* jump to a place inside Pilot, used by the Pages drill-down (an insurance line, the rent setting, an invoice month) */
  function go(t){
    rememberPlace(); if(t.tab) tab = t.tab; if(t.page){ pg.page = t.page; } if(t.month) pg.month = t.month; if(t.dueMonth) loanSt.dueMonth = t.dueMonth;
    if(t.chamaView && t.chamaView.name){ chamaSt.view = chamaSt.view || {}; chamaSt.view[t.chamaView.name] = t.chamaView.v || 'cur'; }
    pg.drill = null; render();
    if(t.focus){ setTimeout(() => { let el = null; try{ el = root.querySelector(t.focus); }catch(e){ el = null; } if(!el) return; const row = el.closest('tr') || el;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('fp-flash'); setTimeout(() => row.classList.remove('fp-flash'), 2600); }, 60); }
  }
  return { render, go, renderLinks };
}
