/* Expense explorer: every type of expense with its figure for a month (or several months), and a click on a type shows
   every line behind it, so "Garage" lists all the garage lines of that month and you can see how the month ran.
   Used twice: the "All expenses" button inside Expenses (one month at a time), and Pilot > Pages > All expenses (any range, whole or month by month).
   The figures come from drillRecords/monthlySummary, the same functions as the Overview, so the totals always agree with it. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { SUMMARY_COLUMNS, CAT_COL } from './summary.js';
import { drillRecords } from './pages.js';
import { gridHtml, bindGrid } from './gridEdit.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
const shift = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while(m > 12){ m -= 12; y++; } while(m < 1){ m += 12; y--; } return y + '-' + String(m).padStart(2, '0'); };
const monthsBetween = (a, b) => { const out = []; for(let m = a; m <= b && out.length < 120; m = shift(m, 1)) out.push(m); return out; };
const thisMonth = () => new Date().toISOString().slice(0, 7);

export const exState = (mode, db) => {
  const all = []; ((db && db.expenses) || []).forEach(x => { if(/^\d{4}-\d{2}/.test(x.date || '')) all.push(x.date.slice(0, 7)); });
  all.sort(); const last = all.length ? all[all.length - 1] : thisMonth(), cur = thisMonth();
  const m = last > cur ? cur : last;
  return { mode, from: mode === 'range' ? (all[0] || m) : m, to: m, vehicleId: '', type: null, matrix: false };
};

/* every type of expense: the Overview columns, then each other category the expenses actually use (Maintenance, Parking, Salaries ...) */
export function expenseTypes(db){
  const base = SUMMARY_COLUMNS.map(c => ({ id: c.key, col: c.key, label: c.label }));
  const others = [...new Set((db.expenses || []).filter(x => !CAT_COL[x.category]).map(x => x.category || 'Other'))].sort();
  return base.concat(others.map(c => ({ id: 'other:' + c, col: 'other', cat: c, label: c })));
}
export function typeSpec(t, from, to, vehicleId){ const s = { col: t.col, from, to }; if(t.cat) s.cat = t.cat; if(vehicleId) s.vehicleId = vehicleId; return s; }
/* the figures: one row per type for the range, optionally per month */
export function explore(db, ex, ctx){
  const types = expenseTypes(db), vid = ex.vehicleId || '';
  const rows = types.map(t => { const d = drillRecords(db, typeSpec(t, ex.from, ex.to, vid), ctx); return { type: t, total: d.total, count: d.rows.length }; }).filter(r => r.total || r.count);
  rows.sort((a, b) => b.total - a.total);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const months = monthsBetween(ex.from, ex.to);
  const matrix = ex.matrix ? rows.map(r => ({ type: r.type, cells: months.map(m => drillRecords(db, typeSpec(r.type, m, m, vid), ctx).total) })) : null;
  return { rows, total, months, matrix };
}

const registry = {};
export const explorerRegistry = registry;

export function explorerHtml(db, ex, ctx){
  Object.keys(registry).forEach(k => delete registry[k]);
  if(ex.from > ex.to) ex.to = ex.from;
  const f = ctx.fmt, res = explore(db, ex, ctx), single = ex.from === ex.to;
  const vopts = '<option value="">All vehicles</option>' + [...(db.vehicles || [])].sort((a, b) => a.reg < b.reg ? -1 : 1).map(v => `<option value="${v.id}" ${String(ex.vehicleId) === String(v.id) ? 'selected' : ''}>${esc(v.reg)}</option>`).join('');
  const bar = ex.mode === 'month'
    ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px;"><button type="button" class="btn" data-ex="prev" style="width:auto;padding:6px 12px;">‹</button><input type="month" data-exset="month" value="${esc(ex.from)}" style="width:auto;"><button type="button" class="btn" data-ex="next" style="width:auto;padding:6px 12px;">›</button>
        <select data-exset="vehicleId" style="width:auto;">${vopts}</select><b style="margin-left:6px;">${monthName(ex.from)}</b></div>`
    : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;"><label style="margin:0;">From</label><input type="month" data-exset="from" value="${esc(ex.from)}" style="width:auto;"><label style="margin:0;">To</label><input type="month" data-exset="to" value="${esc(ex.to)}" style="width:auto;">
        <select data-exset="vehicleId" style="width:auto;">${vopts}</select>
        <button type="button" class="btn ${ex.matrix ? '' : 'primary'}" data-ex="whole" style="width:auto;padding:6px 12px;">As a whole</button><button type="button" class="btn ${ex.matrix ? 'primary' : ''}" data-ex="bymonth" style="width:auto;padding:6px 12px;">Month by month</button></div>`;
  const maxT = Math.max(1, ...res.rows.map(r => r.total));
  const sel = ex.type;
  let table;
  if(ex.matrix && ex.mode === 'range'){
    const head = res.months.map(m => `<th class="num">${monthName(m).slice(0, 3)} ${m.slice(2, 4)}</th>`).join('');
    const colTot = res.months.map((m, i) => res.matrix.reduce((s, r) => s + r.cells[i], 0));
    table = `<div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Type</th>${head}<th class="num">Total</th></tr></thead><tbody>${res.matrix.map((r, k) => `<tr${sel === r.type.id ? ' style="background:rgba(120,120,120,.12);"' : ''}><td><button type="button" class="btn" data-ex="type" data-type="${esc(r.type.id)}" style="width:auto;padding:3px 9px;">${esc(r.type.label)}</button></td>${r.cells.map((v, i) => `<td class="num">${v ? `<button type="button" class="pg-fig" data-ex="cell" data-type="${esc(r.type.id)}" data-month="${res.months[i]}">${f(v)}</button>` : '<span class="pg-nil">—</span>'}</td>`).join('')}<td class="num"><b>${f(res.rows[k].total)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><th>TOTAL</th>${colTot.map(v => `<th class="num">${f(v)}</th>`).join('')}<th class="num">${f(res.total)}</th></tr></tfoot></table></div></div>`;
  } else {
    table = `<div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Type of expense</th><th class="num">Lines</th><th class="num">Total</th><th style="width:22%"></th></tr></thead><tbody>${res.rows.map(r => `<tr${sel === r.type.id ? ' style="background:rgba(120,120,120,.12);"' : ''}>
        <td><button type="button" class="btn ${sel === r.type.id ? 'primary' : ''}" data-ex="type" data-type="${esc(r.type.id)}" style="width:auto;padding:4px 11px;">${esc(r.type.label)}</button></td><td class="num">${r.count}</td><td class="num"><b>${f(r.total)}</b></td>
        <td><div style="height:8px;border-radius:4px;background:rgba(214,168,79,.55);width:${Math.max(2, Math.round(r.total / maxT * 100))}%;"></div></td></tr>`).join('') || '<tr class="empty-row"><td colspan="4">No expenses in this period.</td></tr>'}</tbody>
      <tfoot><tr><th>TOTAL</th><th class="num">${res.rows.reduce((s, r) => s + r.count, 0)}</th><th class="num">${f(res.total)}</th><th></th></tr></tfoot></table></div></div>`;
  }
  const note = `<p class="subtitle">Fuel here is the fuel actually taken (fills). Money paid into the station's account is on Pilot › Pages › Fuel. The total matches the Overview for the same months.</p>`;
  return bar + table + note + detail(db, ex, ctx);
}

/* the lines behind the chosen type, in the chosen months */
function detail(db, ex, ctx){
  if(!ex.type) return '<p class="subtitle">Press a type to see every line behind it.</p>';
  const t = expenseTypes(db).find(x => x.id === ex.type); if(!t) return '';
  const from = ex.detailFrom || ex.from, to = ex.detailTo || ex.to, spec = typeSpec(t, from, to, ex.vehicleId);
  const d = drillRecords(db, spec, ctx), f = ctx.fmt;
  const exp = new Map((db.expenses || []).map(x => [String(x.id), x]));
  const editable = d.rows.filter(r => r.open && r.open.panel === 'expenses' && exp.has(String(r.open.id)) && exp.get(String(r.open.id)).source !== 'rental');
  const rest = d.rows.filter(r => !editable.includes(r));
  const cats = [...new Set(['Fuel', 'Maintenance', 'Garage', 'Insurance', 'Cleaning', 'Airport', 'Parking', 'Driver allowance', 'Owner payout', 'Leased car', 'Salaries', 'Rent', 'Utilities', 'Bank Charges', 'Transport', 'Sub-hire driver', 'Other'].concat((db.settings && db.settings.expenseTypes) || [], (db.expenses || []).map(x => x.category).filter(Boolean)))];
  const veh = [{ value: '', label: 'Office' }].concat([...(db.vehicles || [])].sort((a, b) => a.reg < b.reg ? -1 : 1).map(v => ({ value: String(v.id), label: v.reg })));
  const rows = newestFirstByMonth(editable.map(r => exp.get(String(r.open.id))), x => String(x.date || '').slice(0, 7)).map(x => ({ id: x.id, date: x.date, vehicleId: x.vehicleId == null ? '' : String(x.vehicleId), category: x.category, desc: x.desc || '', amount: num(x.amount) }));
  const find = id => (db.expenses || []).find(x => String(x.id) === String(id));
  registry.exlines = { id: 'exlines', title: t.label + ' · ' + (from === to ? monthName(from) : monthName(from) + ' to ' + monthName(to)) + (ex.vehicleId ? ' · ' + ((db.vehicles || []).find(v => String(v.id) === String(ex.vehicleId)) || {}).reg : ''),
    fmt: f, formats: (db.settings.rowFormats || {}).exlines, label: 'TOTAL', rows,
    columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'vehicleId', label: 'Vehicle', type: 'select', options: veh },
      { key: 'category', label: 'Category', type: 'select', options: cats }, { key: 'desc', label: 'Description', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }],
    totals: { amount: 'sum' },
    onSet: (id, k, v) => { const x = find(id); if(!x) return; ctx.guard(x.date, 'change this expense', () => { if(k === 'vehicleId') x.vehicleId = v === '' ? '' : (isNaN(Number(v)) ? v : Number(v)); else x[k] = v; ctx.markDirty(); ctx.redraw(); }); },
    onRemove: id => { ctx.removeExpense(id, () => ctx.redraw()); }, rowOpen: id => ctx.nav.openRecord({ panel: 'expenses', id }), rowOpenLabel: 'Open in Expenses' };
  const shown = gridHtml(registry.exlines);
  const restHtml = rest.length ? `<div class="table-wrap" style="margin-top:10px;"><div class="subtitle" style="padding:8px 10px 0;"><b>Worked out from rentals, insurance or settings (change them where they are kept)</b></div><div class="table-scroll"><table class="pg-table"><thead><tr>${d.head.map((h, i) => `<th class="${i === d.head.length - 1 ? 'num' : ''}">${esc(h)}</th>`).join('')}<th></th></tr></thead><tbody>${rest.map(r => `<tr>${r.cells.map((c, j) => `<td class="${j === r.cells.length - 1 ? 'num' : ''}">${esc(c)}</td>`).join('')}<td><button type="button" class="row-edit" data-ex="open" data-open="${esc(JSON.stringify(r.open))}">↗</button></td></tr>`).join('')}</tbody></table></div></div>` : '';
  return `<h3 style="margin:16px 0 6px;">${esc(t.label)} <span class="subtitle" style="font-weight:400;">· ${d.rows.length} line${d.rows.length === 1 ? '' : 's'} · ${f(d.total)}</span></h3>${rows.length ? shown : ''}${restHtml}${!d.rows.length ? '<p class="subtitle">No lines.</p>' : ''}`;
}

/* clicks and changes; true = redraw */
export function explorerClick(e, ex, ctx){
  const t = e.target.closest('[data-ex]'); if(!t) return false; const a = t.dataset.ex;
  if(a === 'prev'){ ex.from = ex.to = shift(ex.from, -1); ex.detailFrom = ex.detailTo = null; return true; }
  if(a === 'next'){ ex.from = ex.to = shift(ex.from, 1); ex.detailFrom = ex.detailTo = null; return true; }
  if(a === 'whole'){ ex.matrix = false; return true; }
  if(a === 'bymonth'){ ex.matrix = true; return true; }
  if(a === 'type'){ ex.type = ex.type === t.dataset.type && !ex.detailFrom ? null : t.dataset.type; ex.detailFrom = ex.detailTo = null; return true; }
  if(a === 'cell'){ ex.type = t.dataset.type; ex.detailFrom = ex.detailTo = t.dataset.month; return true; }
  if(a === 'open'){ ctx.nav.openRecord(JSON.parse(t.dataset.open)); return false; }
  return false;
}
export function explorerChange(e, ex){
  const t = e.target.closest('[data-exset]'); if(!t) return false; const k = t.dataset.exset, v = t.value;
  if(k === 'month'){ if(!/^\d{4}-\d{2}$/.test(v)) return false; ex.from = ex.to = v; }
  else if(k === 'from' || k === 'to'){ if(!/^\d{4}-\d{2}$/.test(v)) return false; ex[k] = v; if(ex.from > ex.to){ if(k === 'from') ex.to = v; else ex.from = v; } }
  else ex[k] = v;
  ex.detailFrom = ex.detailTo = null; return true;
}

/* The "All expenses" window opened from the Expenses screen: one month at a time. */
export function initExpenseExplorer(ctx){
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'expOverlay'; overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = '<div class="modal-box fm-box" style="max-width:980px;width:94vw;max-height:90vh;display:flex;flex-direction:column;"><div class="fm-head"><div><h2>All expenses</h2><p class="subtitle" style="margin:0;">Every type, one month at a time. For several months use Pilot › Pages › All expenses.</p></div><button class="modal-close" id="expClose" aria-label="Close">×</button></div><div id="expBody" style="overflow:auto;padding:4px 2px;"></div></div>';
  document.body.appendChild(overlay);
  const body = overlay.querySelector('#expBody'); let ex = null;
  const db = () => ctx.getDb();
  const xctx = Object.assign({}, ctx, { paidFor: id => ctx.paidForRental(id), redraw: () => render() });
  const render = () => { body.innerHTML = explorerHtml(db(), ex, xctx); };
  const close = () => { overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true'); };
  overlay.querySelector('#expClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
  body.addEventListener('click', e => { if(e.target.closest('[data-ex="open"]') || (e.target.closest('[data-g="open"]'))) close(); if(explorerClick(e, ex, xctx)) render(); });
  body.addEventListener('change', e => { if(explorerChange(e, ex)) render(); });
  bindGrid(body, registry, { settings: () => db().settings, changed: () => { ctx.markDirty(); render(); }, confirm: m => window.confirm(m) });
  function open(){ ex = exState('month', db()); render(); overlay.classList.add('show'); overlay.setAttribute('aria-hidden', 'false'); }
  /* the button, placed at the top of the Expenses screen */
  const panel = document.getElementById('panel-expenses');
  if(panel && !document.getElementById('btnExpExplorer')){
    const b = document.createElement('button'); b.id = 'btnExpExplorer'; b.type = 'button'; b.className = 'btn'; b.textContent = '▦ All expenses by type'; b.style.cssText = 'width:auto;padding:8px 16px;margin:0 0 12px;';
    const h = panel.querySelector('.subtitle'); (h ? h : panel.firstElementChild).insertAdjacentElement('afterend', b); b.addEventListener('click', open);
  }
  return { open, render };
}
