/* Coop: the COOP sheet as a table in the database (db.coops), with every field the sheet has:
   NAME, DATE (from-to), DAYS, AMOUNT, DRIVER, ALLOWANCE, FUEL, CONT NO, DEPARTMENT, KM OUT, KM IN.
   - "+ Add coop" takes all of those fields. It never adds the same coop twice (same contract number, or same name + date + amount).
   - A new line starts as "to complete": press ↗ and Rentals opens with what you typed filled in; pick the car, save, and the line is linked.
   - A rental made in Rentals with client type Coop gets its Coop line by itself (or joins the one you typed), so the two tables always agree.
   - Editing a linked line also updates its rental (dates, days, amount, contract, fuel, allowance, name), and the other way round. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { gridHtml, bindGrid } from './gridEdit.js';
import { monthName } from './loans.js';
import { rentalFuel, rentalDriver, fuelIndex } from './fuelCore.js';

const num = v => Number(v) || 0;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const up = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export const coopStatus = c => (c.rentalId ? 'done' : 'todo');
/* hire days counted from the day taken to the day returned, both included (1st to 5th = 5) */
export const daysBetween = (start, end) => (isDate(start) && isDate(end) && end >= start ? dayDiff(start, end) + 1 : 0);

function clientForCoop(db, uid, name){
  const k = up(name); if(!k) return null;
  let c = db.clients.find(x => up(x.name) === k);
  if(!c){ c = { id: uid(), name: k, phone: '', idnum: '', dl: '', type: 'coop', area: '', usualReg: '', driverName: '', driverPhone: '' }; db.clients.push(c); }
  else if(!c.type) c.type = 'coop';
  return c;
}

/* the same coop is never added twice */
export function findDuplicate(db, f, exceptId){
  const contract = String(f.contract || '').trim();
  return (db.coops || []).find(c => String(c.id) !== String(exceptId) && (
    (contract && String(c.contract || '').trim() === contract) ||
    (up(c.name) === up(f.name) && c.start === f.start && num(c.amount) === num(f.amount) && num(c.amount) > 0)));
}
export function addCoop(db, uid, f){
  const name = up(f.name); if(!name) return { ok: false, why: 'A name is needed' };
  if(!isDate(f.start)) return { ok: false, why: 'The date it was taken is needed' };
  const end = isDate(f.end) ? f.end : f.start;
  if(end < f.start) return { ok: false, why: 'The return date cannot be before the date taken' };
  const rec = { name, start: f.start, end, amount: num(f.amount), contract: String(f.contract || '').trim() };
  const dup = findDuplicate(db, rec); if(dup) return { ok: false, why: 'This coop is already on the table', dup };
  const client = clientForCoop(db, uid, name);
  const c = { id: uid(), name, clientId: client.id, start: f.start, end, days: num(f.days) || daysBetween(f.start, end) || 1, amount: num(f.amount), driverPay: num(f.driverPay), allowance: num(f.allowance), fuel: num(f.fuel),
    contract: rec.contract, department: String(f.department || '').trim().toUpperCase(), kmOut: num(f.kmOut), kmIn: num(f.kmIn), withVat: 0, note: '', rentalId: '', status: 'todo', xlRef: '' };
  (db.coops = db.coops || []).push(c); return { ok: true, coop: c };
}

/* A rental made with client type Coop must be on the Coop table. Join a waiting line when it is the same hire, else make one. */
export function syncCoopsFromRentals(db, uid){
  db.coops = db.coops || []; let made = 0, joined = 0;
  const linked = new Set(db.coops.filter(c => c.rentalId).map(c => String(c.rentalId)));
  db.rentals.forEach(r => {
    if(r.type !== 'coop' || r.status === 'Cancelled' || linked.has(String(r.id))) return;
    const cl = db.clients.find(x => String(x.id) === String(r.clientId)); if(!cl) return;
    const waiting = db.coops.find(c => !c.rentalId && up(c.name) === up(cl.name) && c.start === r.pickup && (!c.contract || !r.contract || c.contract === r.contract));
    if(waiting){ waiting.rentalId = r.id; waiting.status = 'done'; waiting.clientId = cl.id; linked.add(String(r.id)); joined++; return; }
    if(r.contract && db.coops.some(c => !c.rentalId && String(c.contract) === String(r.contract))){ const w = db.coops.find(c => !c.rentalId && String(c.contract) === String(r.contract)); w.rentalId = r.id; w.status = 'done'; w.clientId = cl.id; linked.add(String(r.id)); joined++; return; }
    db.coops.push({ id: uid(), name: up(cl.name), clientId: cl.id, start: r.pickup || '', end: r.return || r.pickup || '', days: num(r.days), amount: num(r.amount), driverPay: 0, allowance: num(r.allowance), fuel: num(r.fuel),
      contract: r.contract || '', department: '', kmOut: 0, kmIn: num(r.mileage) ? num(r.mileage) : 0, withVat: 0, note: '', rentalId: r.id, status: 'done', xlRef: '' });
    linked.add(String(r.id)); made++;
  });
  return { made, joined };
}

/* line -> its rental */
export function pushCoopToRental(db, c){
  const r = c.rentalId ? db.rentals.find(x => String(x.id) === String(c.rentalId)) : null; if(!r) return false;
  r.pickup = c.start || r.pickup; r.return = c.end || r.return; r.days = num(c.days) || r.days; r.amount = num(c.amount) + num(c.driverPay);
  r.contract = c.contract || ''; if(c.clientId) r.clientId = c.clientId;
  if(num(c.kmIn) > num(c.kmOut) && num(c.kmOut) > 0) r.mileage = num(c.kmIn) - num(c.kmOut);
  return true;
}
/* one field of a line changed */
export function setCoopField(db, uid, c, key, value){
  const textKeys = ['department', 'contract', 'note'];
  if(key === 'name'){ const n = up(value); if(!n) return false; c.name = n; const cl = clientForCoop(db, uid, n); c.clientId = cl.id; }
  else if(textKeys.includes(key)) c[key] = key === 'department' ? up(value) : String(value || '').trim();
  else if(key === 'start' || key === 'end'){ c[key] = value; if(!isDate(c.end) || c.end < c.start) c.end = c.start; const d = daysBetween(c.start, c.end); if(d) c.days = d; }
  else c[key] = num(value);
  pushCoopToRental(db, c); return true;
}
/* rental -> its line (called by cascade.syncCoopFromRental through housekeeping) */
export function removeCoop(db, id){ db.coops = (db.coops || []).filter(c => String(c.id) !== String(id)); }
export const coopForRental = (db, rentalId) => (db.coops || []).find(c => String(c.rentalId) === String(rentalId)) || null;

/* ---------- figures of a line: fuel, driver and allowance are READ from its rental (one source), never typed twice ---------- */
export const VAT = 0.16;
const r2 = x => Math.round(x * 100) / 100;
export function coopFigures(db, c, vatOn, ix){
  const r = c.rentalId ? (ix ? ix.rentals.get(String(c.rentalId)) : db.rentals.find(x => String(x.id) === String(c.rentalId))) || null : null;
  const v = r ? (ix ? ix.vehicles.get(String(r.vehicleId)) : db.vehicles.find(x => String(x.id) === String(r.vehicleId))) : null;
  const fuel = r ? rentalFuel(db, r, ix) : num(c.fuel);
  const driver = r ? (num(r.driverRate) ? rentalDriver(r) : num(c.driverPay)) : num(c.driverPay);   // a rental with no sub-hire driver pay keeps the driver amount the coop line already had
  const allowance = r ? num(r.allowance) : num(c.allowance);
  const base = num(c.amount), charge = vatOn ? r2(base * (1 + VAT)) : base;
  return { rental: r, vehicle: v ? ((v.reg || '') + (v.model ? ' ' + v.model : '')).trim() : '', fuel, driver, allowance, base, charge, km: num(c.kmIn) > num(c.kmOut) && num(c.kmOut) > 0 ? num(c.kmIn) - num(c.kmOut) : 0,
    total: r2(charge + fuel + driver + allowance) };
}
/* "01-03/09/2026" style dates of the client's schedule */
export function dateRangeText(a, b){
  if(!isDate(a)) return ''; if(!isDate(b) || b === a) return a.slice(8) + '/' + a.slice(5, 7) + '/' + a.slice(0, 4);
  if(a.slice(0, 7) === b.slice(0, 7)) return a.slice(8) + '-' + b.slice(8) + '/' + a.slice(5, 7) + '/' + a.slice(0, 4);
  return a.slice(8) + '/' + a.slice(5, 7) + '-' + b.slice(8) + '/' + b.slice(5, 7) + '/' + b.slice(0, 4);
}
/* pick an existing coop rental and type what the client's sheet needs: staff, department, KMs, contract no */
export function saveFromRental(db, uid, f){
  const r = db.rentals.find(x => String(x.id) === String(f.rentalId)); if(!r) return { ok: false, why: 'Pick the coop rental' };
  let c = coopForRental(db, r.id);
  const staff = up(f.name), contract = String(f.contract || '').trim();
  if(!c){
    const cl = db.clients.find(x => String(x.id) === String(r.clientId));
    c = { id: uid(), name: staff || up(cl ? cl.name : ''), clientId: r.clientId, start: r.pickup || '', end: r.return || r.pickup || '', days: num(r.days), amount: num(r.amount), driverPay: 0, allowance: num(r.allowance), fuel: num(r.fuel),
      contract: r.contract || '', department: '', kmOut: 0, kmIn: 0, withVat: 0, note: '', rentalId: r.id, status: 'done', xlRef: '' };
    (db.coops = db.coops || []).push(c);
  } else if(staff) c.name = staff;
  if(f.department !== undefined && f.department !== '') c.department = up(f.department);
  if(f.kmOut !== '' && f.kmOut != null) c.kmOut = num(f.kmOut);
  if(f.kmIn !== '' && f.kmIn != null) c.kmIn = num(f.kmIn);
  if(contract){ c.contract = contract; r.contract = contract; }
  if(num(c.kmIn) > num(c.kmOut) && num(c.kmOut) > 0) r.mileage = num(c.kmIn) - num(c.kmOut);
  return { ok: true, coop: c };
}

/* ---------- screen ---------- */
export function initCoop(ctx){
  const root = document.getElementById('panel-coop'); if(!root) return { render(){}, focus(){} };
  const db = () => ctx.getDb(); const registry = {};
  const st = { month: '', status: '', q: '', form: {}, flash: null, vat: false, rform: {} };
  const months = () => [...new Set((db().coops || []).map(c => String(c.start || '').slice(0, 7)).filter(Boolean))].sort();
  const F = [['name', 'Name', 'text'], ['start', 'Date taken', 'date'], ['end', 'Date returned', 'date'], ['days', 'Days (blank = worked out)', 'number'], ['amount', 'Amount', 'number'], ['driverPay', 'Driver', 'number'],
    ['allowance', 'Allowance', 'number'], ['fuel', 'Fuel', 'number'], ['contract', 'Cont no', 'text'], ['department', 'Department', 'text'], ['kmOut', 'KM out', 'number'], ['kmIn', 'KM in', 'number']];
  const visible = () => {
    const d = db(), q = st.q.trim().toLowerCase();
    const list = (d.coops || []).filter(c => (st.month === 'all' || String(c.start || '').slice(0, 7) === st.month) && (!st.status || coopStatus(c) === st.status) &&
      (!q || [c.name, c.contract, c.department].some(x => String(x || '').toLowerCase().includes(q))));
    return newestFirstByMonth(list, c => String(c.start || '').slice(0, 7));
  };

  function render(){
    const d = db(), ms = months(); if(!st.month) st.month = ms.length ? (ms.includes(new Date().toISOString().slice(0, 7)) ? new Date().toISOString().slice(0, 7) : ms[ms.length - 1]) : '';
    const list = visible(), vat = st.vat;
    const ix = fuelIndex(d), rows = list.map(c => { const g = coopFigures(d, c, vat, ix); return Object.assign({}, c, { _g: g }); });
    const todo = (d.coops || []).filter(c => !c.rentalId).length;
    Object.keys(registry).forEach(k => delete registry[k]);
    const fig = k => ({ compute: r => r._g[k] });
    registry.coop = { id: 'coop', title: '', fmt: n => Number(n).toLocaleString(), formats: (d.settings.rowFormats || {}).coop, label: 'TOTAL', rows, rowOpen: id => { const c = (db().coops || []).find(x => String(x.id) === String(id)); if(!c) return; if(c.rentalId) ctx.nav.openRecord({ panel: 'rentals', id: c.rentalId }); else ctx.completeCoop(c.id); },
      rowOpenLabel: 'Open its rental (or, if still to complete, open Rentals filled in)',
      columns: [{ key: 'name', label: 'Name of staff served', type: 'text' }, { key: 'department', label: 'Branch Department', type: 'text' }, { key: 'days', label: 'No of hire days', type: 'number' },
        { key: 'kmOut', label: 'KMs OUT', type: 'number' }, { key: 'kmIn', label: 'KMs IN', type: 'number' }, Object.assign({ key: 'kmTot', label: 'Total KMs', type: 'number' }, fig('km')),
        { key: 'contract', label: 'Job card / Contract No', type: 'text' }, { key: 'start', label: 'From', type: 'date' }, { key: 'end', label: 'To', type: 'date' },
        vat ? Object.assign({ key: 'amount', label: 'Vehicle charge (VAT incl)', type: 'money' }, fig('charge')) : { key: 'amount', label: 'Vehicle charge', type: 'money' },
        Object.assign({ key: 'vehicle', label: 'Type of vehicle hired', type: 'text' }, fig('vehicle')),
        Object.assign({ key: 'fuel', label: 'Fuel', type: 'money' }, fig('fuel')), Object.assign({ key: 'driver', label: 'Driver', type: 'money' }, fig('driver')), Object.assign({ key: 'allowance', label: 'Allowance', type: 'money' }, fig('allowance')),
        Object.assign({ key: 'total', label: 'Total', type: 'money' }, fig('total')),
        { key: 'status', label: 'In Rentals', type: 'text', compute: c => (c.rentalId ? '✓ ' + ((c._g.rental && d.vehicles.find(v => String(v.id) === String(c._g.rental.vehicleId)) || {}).reg || 'linked') : '○ to complete') }],
      totals: { days: 'sum', kmTot: 'sum', amount: 'sum', fuel: 'sum', driver: 'sum', allowance: 'sum', total: 'sum' },
      onSet: (id, k, v) => { const c = (db().coops || []).find(x => String(x.id) === String(id)); if(c) setCoopField(db(), ctx.uid, c, k, v); },
      onRemove: id => { const c = (db().coops || []).find(x => String(x.id) === String(id)); if(!c) return; removeCoop(db(), id); } };
    const sum = k => rows.reduce((s, r) => s + num(r._g[k]), 0), baseSum = rows.reduce((s, r) => s + r._g.base, 0), extra = sum('fuel') + sum('driver') + sum('allowance');
    const vatBox = vat ? `<div class="subtitle" style="margin:8px 0;"><b>VAT view is on</b> (display only; amounts are kept without VAT). Vehicle charge ${ctx.fmt(baseSum)} + VAT ${ctx.fmt(r2(baseSum * VAT))} = <b>${ctx.fmt(r2(baseSum * (1 + VAT)))}</b>. With fuel, driver and allowance (${ctx.fmt(extra)}): TOTAL excl VAT <b>${ctx.fmt(r2(baseSum + extra))}</b> · TOTAL incl VAT <b>${ctx.fmt(r2(baseSum * (1 + VAT) + extra))}</b></div>` : '';
    const monthRentals = (d.rentals || []).filter(r => r.type === 'coop' && r.status !== 'Cancelled' && (st.month === 'all' || String(r.pickup || '').slice(0, 7) === st.month)).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? -1 : 1);
    const rf = st.rform, pickRental = monthRentals.find(r => String(r.id) === String(rf.rentalId)), pickCoop = pickRental ? coopForRental(d, pickRental.id) : null;
    const rLabel = r => { const cl = d.clients.find(x => String(x.id) === String(r.clientId)) || {}, v = d.vehicles.find(x => String(x.id) === String(r.vehicleId)) || {}; return `${cl.name || '—'} · ${v.reg || '—'} · ${r.pickup || ''}${r.return && r.return !== r.pickup ? ' → ' + r.return : ''}${r.contract ? ' · ' + r.contract : ''}`; };
    const rform = `<details ${st.rOpen ? 'open' : ''} id="co_rwrap" style="margin:10px 0;"><summary><b>+ Add from a coop rental</b> (pick the rental, type staff, department, KMs and contract no)</summary>
      <div class="form-grid" style="margin-top:8px;"><div class="ph-wide" style="grid-column:1/-1;"><label>Coop rental</label><select id="co_rrental"><option value="">— pick —</option>${monthRentals.map(r => `<option value="${esc(r.id)}" ${String(rf.rentalId) === String(r.id) ? 'selected' : ''}>${esc(rLabel(r))}${coopForRental(d, r.id) ? ' ✓' : ''}</option>`).join('')}</select></div>
        ${[['name', 'Name of staff served', 'text', pickCoop && pickCoop.name], ['department', 'Branch Department', 'text', pickCoop && pickCoop.department], ['kmOut', 'KMs OUT', 'number', pickCoop && pickCoop.kmOut], ['kmIn', 'KMs IN', 'number', pickCoop && pickCoop.kmIn], ['contract', 'Job card / Contract No', 'text', (pickCoop && pickCoop.contract) || (pickRental && pickRental.contract)]]
          .map(([k, l, t, dv]) => `<div><label>${l}</label><input id="co_r_${k}" type="${t}" ${t === 'number' ? 'step="any"' : ''} value="${esc(rf[k] !== undefined ? rf[k] : (dv || ''))}"></div>`).join('')}</div>
      <button class="btn primary" id="co_radd" style="width:auto;padding:8px 16px;">Save</button><span class="subtitle"> Fuel, driver and allowance are read from the rental. A ✓ means the rental already has its line.</span></details>`;
    const form = `<details ${st.formOpen ? 'open' : ''} id="co_formwrap" style="margin:10px 0;"><summary><b>+ Add a coop not yet in Rentals</b> (every field of the Excel sheet)</summary>
      <div class="form-grid" style="margin-top:8px;">${F.map(([k, l, t]) => `<div><label>${l}</label><input id="co_${k}" type="${t}" value="${esc(st.form[k] || '')}" ${t === 'number' ? 'step="any"' : ''}></div>`).join('')}</div>
      <button class="btn primary" id="co_add" style="width:auto;padding:8px 16px;">Save coop</button>
      <span class="subtitle"> After saving, press ↗ on the line to finish it in Rentals (car, times, billing).</span></details>`;
    root.innerHTML = `<h1>Coop</h1><p class="subtitle">Your COOP sheet as a table. ${todo ? `<b style="color:var(--amber)">${todo} line${todo === 1 ? '' : 's'} still to complete in Rentals</b> (press ↗ on the line).` : 'Every line is in Rentals.'} Fuel, Driver and Allowance come from the rental (Fuel table fills and the rental's driver pay), so nothing is entered twice. Total = charge + fuel + driver + allowance.</p>${rform}${form}
      <div class="filter-bar"><label style="margin:0;">Month</label><select id="co_month"><option value="all" ${st.month === 'all' ? 'selected' : ''}>All months</option>${ms.map(m => `<option value="${m}" ${st.month === m ? 'selected' : ''}>${monthName(m)}</option>`).join('')}</select>
        <select id="co_status"><option value="">Any</option><option value="todo" ${st.status === 'todo' ? 'selected' : ''}>To complete</option><option value="done" ${st.status === 'done' ? 'selected' : ''}>In Rentals</option></select>
        <input id="co_q" placeholder="name, cont no, department" value="${esc(st.q)}" style="max-width:240px;">
        <button type="button" class="btn ${vat ? 'primary' : ''}" id="co_vat" style="width:auto;padding:6px 12px;" title="Shows the vehicle charge with VAT (16%). View only: nothing is changed in your data.">VAT view: ${vat ? 'ON' : 'off'}</button>
        <button type="button" class="btn ${st.extras !== false ? 'primary' : ''}" id="co_extras" style="width:auto;padding:6px 12px;" title="Add Fuel, Driver and Total (grey, for you) after the client's columns in the Excel schedule. Switch off to give the client only their own columns.">Excel: office columns ${st.extras !== false ? 'ON' : 'off'}</button>
        <button type="button" class="btn" id="co_export" style="width:auto;padding:6px 12px;" title="Download the schedule in the client's layout, with Fuel, Driver and Allowance">⬇ Excel schedule</button></div>${vatBox}${gridHtml(registry.coop)}`;
    if(st.flash){ const el = root.querySelector(`[data-r="${st.flash}"]`); if(el){ const tr = el.closest('tr'); if(tr){ tr.style.outline = '2px solid var(--amber)'; tr.scrollIntoView({ block: 'center' }); } } st.flash = null; }
  }

  /* the client's schedule, laid out exactly like their Car_hire_schedule sheet: Trebuchet MS 12, blue heading, thin borders,
     one-day dates as real dates (d-mmm-yy), ranges as "01-03/09/2026", charge as =rate*days*1.16, a totals line, then TOTAL.
     Fuel, Driver and Total (for the office) follow in grey after the client's columns, and can be switched off. */
  async function exportXlsx(){
    const X = window.ExcelJS; if(!X){ ctx.toast('Excel export is not available in this window'); return; }
    const d = db(), vat = st.vat, extras = st.extras !== false, list = visible(), ix = fuelIndex(d), figs = list.map(c => coopFigures(d, c, vat, ix));
    const wb = new X.Workbook(), mn = (st.month === 'all' ? 'ALL' : monthName(st.month).split(' ')[0].toUpperCase());
    const ws = wb.addWorksheet((mn === 'SEPTEMBER' ? 'SEPT.' : mn).slice(0, 28));
    const FONT = { name: 'Trebuchet MS', size: 12 }, thin = { style: 'thin' }, BOX = { top: thin, left: thin, bottom: thin, right: thin };
    const BLUE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8EA9DB' } }, GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    const head = ['Name of staff served', 'Branch Department', 'No of hire days', 'KMs OUT', 'KMs IN', 'Total KMs', 'Job Card/contract No', 'Job card/Contract Dates',
      vat ? 'Vehicle Total charge(VAT InCl)' : 'Vehicle Total charge(VAT Excl)', "Driver's Allowance(If any)", 'Type of vehicle hired'];
    if(extras) head.push('Fuel', 'Driver', 'Total');
    const NC = head.length, hr = ws.addRow(head); hr.height = 31;
    for(let c = 1; c <= NC; c++){ const k = hr.getCell(c); k.font = FONT; k.fill = c > 11 ? GREY : BLUE; k.border = BOX; k.alignment = { wrapText: true, vertical: 'middle' }; }
    const toDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    const mult = (1 + VAT).toFixed(2);
    list.forEach((c, i) => { const g = figs[i], n = i + 2, days = num(c.days) || 1, base = num(c.amount), rate = base / days;
      const oneDay = isDate(c.start) && (!isDate(c.end) || c.end === c.start);
      const chargeF = Number.isInteger(rate) && days > 1 ? `${rate}*${days}` : `${base}`;
      const row = [c.name, c.department || '', num(c.days), num(c.kmOut) || null, num(c.kmIn) || null,
        { formula: `E${n}-D${n}`, result: num(c.kmIn) - num(c.kmOut) }, c.contract || '', oneDay ? toDate(c.start) : dateRangeText(c.start, c.end),
        { formula: vat ? `${chargeF}*${mult}` : chargeF, result: g.charge }, g.allowance || null, g.vehicle];
      if(extras) row.push(g.fuel || null, g.driver || null, { formula: `I${n}+J${n}+L${n}+M${n}`, result: g.total });
      const r = ws.addRow(row);
      for(let k = 1; k <= NC; k++){ const cell = r.getCell(k); cell.font = FONT; cell.border = BOX; }
      if(oneDay) r.getCell(8).numFmt = 'd-mmm-yy';
      [9, 10, 12, 13, 14].forEach(k => { if(k <= NC) r.getCell(k).numFmt = '#,##0.00'; });
    });
    const last = list.length + 1;
    ws.addRow([]);
    const sum = col => ({ formula: `SUM(${col}2:${col}${last})`, result: 0 });
    const t = ['', '', '', '', '', '', '', '', sum('I'), sum('J')]; while(t.length < 11) t.push('');
    if(extras) t.push(sum('L'), sum('M'), sum('N'));
    const tr = ws.addRow(t), tn = last + 2;
    const gr = ws.addRow(['', '', '', '', '', '', '', 'TOTAL', { formula: `I${tn}+J${tn}`, result: 0 }]);
    [tr, gr].forEach(r => { for(let k = 1; k <= NC; k++){ const cell = r.getCell(k); cell.font = { ...FONT, bold: true }; if(k >= 8 && (k === 8 || r.getCell(k).value !== '')) cell.border = BOX; if(k >= 9) cell.numFmt = '#,##0.00'; } });
    if(vat){
      const base = figs.reduce((s, g) => s + g.base, 0), extra = figs.reduce((s, g) => s + g.fuel + g.driver + g.allowance, 0);
      [['TOTAL excl VAT (charge + allowance + fuel + driver)', r2(base + extra)], ['TOTAL incl VAT (charge incl VAT + allowance + fuel + driver)', r2(base * (1 + VAT) + extra)]].forEach(([lab, v]) => {
        const r = ws.addRow([lab]); r.getCell(9).value = v; r.getCell(9).numFmt = '#,##0.00'; r.font = { ...FONT, bold: true }; });
    }
    [22.6, 23.9, 11.4, 12, 12.3, 12.8, 19, 18.3, 19.7, 18, 15.9, 15.5, 15.5, 15.5].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const buf = await wb.xlsx.writeBuffer(), blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Car_hire_schedule_' + (st.month === 'all' ? 'all' : st.month) + (vat ? '_VAT' : '') + '.xlsx'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    ctx.toast('Schedule downloaded' + (vat ? ' (with both totals)' : ''));
  }

  bindGrid(root, registry, { settings: () => db().settings, changed: () => { ctx.markDirty(); render(); }, confirm: m => ctx.confirm(m) });
  root.addEventListener('click', e => {
    if(e.target.id === 'co_vat'){ st.vat = !st.vat; render(); return; }
    if(e.target.id === 'co_extras'){ st.extras = st.extras === false; render(); return; }
    if(e.target.id === 'co_export'){ exportXlsx(); return; }
    if(e.target.id === 'co_radd'){
      const g = k => document.getElementById('co_r_' + k).value; st.rform = { rentalId: document.getElementById('co_rrental').value, name: g('name'), department: g('department'), kmOut: g('kmOut'), kmIn: g('kmIn'), contract: g('contract') }; st.rOpen = true;
      const res = saveFromRental(db(), ctx.uid, st.rform);
      if(!res.ok){ ctx.toast(res.why); render(); return; }
      st.rform = {}; st.rOpen = false; st.flash = res.coop.id; ctx.markDirty(); render(); ctx.toast('Saved. Fuel, driver and allowance come from the rental.'); return;
    }
    if(e.target.id === 'co_add'){
      const f = {}; F.forEach(([k]) => { f[k] = document.getElementById('co_' + k).value; }); st.form = f; st.formOpen = true;
      const res = addCoop(db(), ctx.uid, f);
      if(!res.ok){ ctx.toast(res.why + (res.dup ? ' (' + res.dup.name + ', ' + res.dup.start + ')' : '')); render(); return; }
      st.form = {}; st.formOpen = false; st.month = String(res.coop.start).slice(0, 7); st.status = ''; st.flash = res.coop.id; ctx.markDirty(); render(); ctx.toast('Coop saved. Press ↗ on its line to complete it in Rentals.');
    }
  });
  root.addEventListener('change', e => { const t = e.target; if(t.id === 'co_month'){ st.month = t.value; st.rform = {}; render(); } else if(t.id === 'co_status'){ st.status = t.value; render(); }
    else if(t.id === 'co_rrental'){ st.rform = { rentalId: t.value }; st.rOpen = true; render(); } });
  root.addEventListener('input', e => { if(e.target.id === 'co_q'){ st.q = e.target.value; const p = e.target.selectionStart; render(); const el = document.getElementById('co_q'); el.focus(); el.setSelectionRange(p, p); } });
  return { render, focus: id => { const c = (db().coops || []).find(x => String(x.id) === String(id)); if(c){ st.month = String(c.start || '').slice(0, 7) || 'all'; st.status = ''; st.q = ''; st.flash = c.id; } render(); } };
}
