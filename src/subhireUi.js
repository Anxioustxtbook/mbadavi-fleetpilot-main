/* Pilot > Pages > Sub-hire and Sub-hire driver.
   Both are drawn from the rentals (see subhireCore.js). What is typed here: the amount, the status (paid / not cleared / cancelled) and the date of that status.
   Click a cell, type, Enter (the same editable sheets as Loans and Coop). Totals are worked out again after every change. */
import { gridHtml, figBtn } from './gridEdit.js';
import { STATUSES, STATUS_LABEL, monthLabel, todayISO, ownerRows, driverRows, monthsOf, ownerSummary, vehiclePerformance, driverSummary,
  setOwnerStatus, setDriverStatus, driverAmount } from './subhireCore.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const attr = o => esc(JSON.stringify(o));
const fg = (spec, n, text) => num(n) ? figBtn(spec, text) : text;      // a money figure that opens "how it was made" (nothing to open when it is 0)
export const subhireRegistry = {};     // grid descriptions, refilled on every draw; Pilot's grid binding looks tables up here

const pick = (st, key, months) => { const v = st[key]; if(v === 'all') return ''; if(v && months.includes(v)) return v; return months.length ? months[months.length - 1] : ''; };
function chips(st, key, action, months, sel, totalOf, f){
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;"><button type="button" class="btn ${sel === '' ? 'primary' : ''}" data-pg="${action}" data-month="all" style="width:auto;padding:6px 12px;">All months</button>
    ${months.map(m => `<button type="button" class="btn ${m === sel ? 'primary' : ''}" data-pg="${action}" data-month="${m}" style="width:auto;padding:6px 12px;">${monthLabel(m).slice(0, 3)} ${m.slice(2, 4)}<br><small>${Math.round(totalOf(m) / 1000)}k</small></button>`).join(' ')}</div>`;
}
const card = (label, val, sub, color) => `<div class="table-wrap" style="padding:10px 14px;min-width:160px;flex:1;"><div class="subtitle" style="margin:0;">${label}</div><div style="font-size:20px;font-weight:700;${color ? 'color:var(--' + color + ');' : ''}">${val}</div><div class="subtitle" style="margin:0;">${sub}</div></div>`;

/* ================= Sub-hire (cars from owners) ================= */
export function subhirePageHtml(db, st, ctx){
  const f = ctx.fmt, all = ownerRows(db), months = monthsOf(all);
  if(!all.length) return '<p class="subtitle">No sub-hire rentals yet. A rental is a sub-hire line when its car is a sub-hire car (Vehicles) or a sub-hire cost is entered on it.</p>';
  const sel = pick(st, 'shMonth', months), span = sel ? monthLabel(sel) : 'All months';
  const owners = ownerSummary(db, sel), cars = vehiclePerformance(db, sel), drivers = driverSummary(db, sel);
  let rows = all.filter(r => !sel || r.month === sel);
  const ownerFilter = st.shOwner && owners.some(o => o.key === st.shOwner) ? st.shOwner : '';
  if(ownerFilter) rows = rows.filter(r => r.ownerKey === ownerFilter);
  const drvStatus = new Map(driverRows(db).map(r => [r.id, r]));
  const sum = (list, k) => list.reduce((s, x) => s + num(x[k]), 0);
  const drv = (d, kind) => ({ col: 'shDriver', driver: d ? d.driver : '', month: sel, kind }), own = (o, kind) => ({ col: 'shOwner', key: o ? o.key : '', month: sel, kind }), car = (field, c) => ({ col: 'shCar', field, month: sel, vehicleId: c ? (c.vehicleId || 'none') : '' });
  const tot = { cost: sum(owners, 'cost'), paid: sum(owners, 'paid'), notcleared: sum(owners, 'notcleared'), cancelled: sum(owners, 'cancelled') };

  const cards = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
    ${card('Paid to owners · ' + span, fg(own(null, 'paid'), tot.paid, f(tot.paid)), owners.length + ' owner' + (owners.length === 1 ? '' : 's') + ' / cars', 'green')}
    ${card('Not cleared (still to pay)', fg(own(null, 'notcleared'), tot.notcleared, f(tot.notcleared)), 'cost of the cars not yet paid', tot.notcleared ? 'red' : '')}
    ${card('Cancelled', fg(own(null, 'cancelled'), tot.cancelled, f(tot.cancelled)), 'not counted as a cost')}
    ${card('Drivers on sub-hires', fg({ col: 'shDriver', month: sel, kind: 'paid' }, sum(drivers, 'paid'), f(sum(drivers, 'paid'))) + ' paid', fg({ col: 'shDriver', month: sel, kind: 'notcleared' }, sum(drivers, 'notcleared'), f(sum(drivers, 'notcleared'))) + ' not cleared')}</div>`;

  const ownerTable = `<h3 style="margin:16px 0 6px;">What each owner was paid · ${esc(span)}</h3><div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Owner</th><th>Cars</th><th class="num">Jobs</th><th class="num">Days</th><th class="num">Cost</th><th class="num">Paid</th><th class="num">Not cleared</th><th class="num">Cancelled</th></tr></thead><tbody>
    ${owners.map(o => `<tr${o.key === ownerFilter ? ' style="background:rgba(120,120,120,.12);"' : ''}><td><button type="button" class="btn ${o.key === ownerFilter ? 'primary' : ''}" data-pg="showner" data-key="${esc(o.key)}" title="Show only this owner's lines below" style="width:auto;padding:3px 10px;">${esc(o.owner)}</button></td><td>${esc(o.cars.join(', '))}</td><td class="num">${o.jobs}</td><td class="num">${o.days}</td><td class="num">${fg(own(o, 'cost'), o.cost, f(o.cost))}</td>
      <td class="num" style="color:var(--green);"><b>${fg(own(o, 'paid'), o.paid, f(o.paid))}</b></td><td class="num" style="${o.notcleared ? 'color:var(--red);' : ''}">${o.notcleared ? figBtn(own(o, 'notcleared'), f(o.notcleared)) : '—'}</td><td class="num">${o.cancelled ? figBtn(own(o, 'cancelled'), f(o.cancelled)) : '—'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="8">Nothing in this month.</td></tr>'}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${sum(owners, 'jobs')}</th><th class="num">${sum(owners, 'days')}</th><th class="num">${fg(own(null, 'cost'), tot.cost, f(tot.cost))}</th><th class="num">${fg(own(null, 'paid'), tot.paid, f(tot.paid))}</th><th class="num">${fg(own(null, 'notcleared'), tot.notcleared, f(tot.notcleared))}</th><th class="num">${fg(own(null, 'cancelled'), tot.cancelled, f(tot.cancelled))}</th></tr></tfoot></table></div></div>
    <p class="subtitle">Press an owner to list only their lines below. Owners are set on the car in Vehicles; a car with no owner is shown by its registration.</p>`;

  const perf = `<h3 style="margin:18px 0 6px;">How each sub-hire car performed · ${esc(span)}</h3><div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Car</th><th>Owner</th><th class="num">Jobs</th><th class="num">Days</th><th class="num">Billed</th><th class="num">Owner cost</th><th class="num">Driver pay</th><th class="num">Fuel</th><th class="num">Allowance</th><th class="num">Left over</th></tr></thead><tbody>
    ${cars.map(c => `<tr><td>${esc(c.reg)}</td><td>${esc(c.owner)}</td><td class="num">${c.jobs}</td><td class="num">${c.days}</td><td class="num">${fg(car('billed', c), c.billed, f(c.billed))}</td><td class="num">${fg(car('ownerCost', c), c.ownerCost, f(c.ownerCost))}</td><td class="num">${c.driverPay ? figBtn(car('driverPay', c), f(c.driverPay)) : '—'}</td><td class="num">${c.fuel ? figBtn(car('fuel', c), f(c.fuel)) : '—'}</td><td class="num">${c.allowance ? figBtn(car('allowance', c), f(c.allowance)) : '—'}</td>
      <td class="num" style="color:var(--${c.net >= 0 ? 'green' : 'red'});"><b>${fg(car('net', c), c.net, f(c.net))}</b></td></tr>`).join('') || '<tr class="empty-row"><td colspan="10">Nothing in this month.</td></tr>'}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${sum(cars, 'jobs')}</th><th class="num">${sum(cars, 'days')}</th><th class="num">${fg(car('billed'), sum(cars, 'billed'), f(sum(cars, 'billed')))}</th><th class="num">${fg(car('ownerCost'), sum(cars, 'ownerCost'), f(sum(cars, 'ownerCost')))}</th><th class="num">${fg(car('driverPay'), sum(cars, 'driverPay'), f(sum(cars, 'driverPay')))}</th><th class="num">${fg(car('fuel'), sum(cars, 'fuel'), f(sum(cars, 'fuel')))}</th><th class="num">${fg(car('allowance'), sum(cars, 'allowance'), f(sum(cars, 'allowance')))}</th><th class="num">${fg(car('net'), sum(cars, 'net'), f(sum(cars, 'net')))}</th></tr></tfoot></table></div></div>
    <p class="subtitle">Left over = billed − owner cost − driver pay − fuel − allowance, for the rentals of that car in the month (cancelled rentals are left out).</p>`;

  const drvTable = `<h3 style="margin:18px 0 6px;">Sub-hire drivers · ${esc(span)}</h3><div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Driver</th><th class="num">Jobs</th><th class="num">Days</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Not cleared</th><th class="num">Cancelled</th></tr></thead><tbody>
    ${drivers.map(d => `<tr><td>${esc(d.driver)}</td><td class="num">${d.jobs}</td><td class="num">${d.days}</td><td class="num">${fg(drv(d, 'amount'), d.amount, f(d.amount))}</td><td class="num" style="color:var(--green);">${fg(drv(d, 'paid'), d.paid, f(d.paid))}</td><td class="num" style="${d.notcleared ? 'color:var(--red);' : ''}">${d.notcleared ? figBtn(drv(d, 'notcleared'), f(d.notcleared)) : '—'}</td><td class="num">${d.cancelled ? figBtn(drv(d, 'cancelled'), f(d.cancelled)) : '—'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="7">No sub-hire drivers in this month.</td></tr>'}</tbody></table></div></div>
    <p class="subtitle">These come from the rentals. Type the amount per day and the status on <button type="button" class="btn" data-pg="page" data-page="subhireDriver" style="width:auto;padding:3px 10px;">Sub-hire driver ↗</button></p>`;

  const fm = (db.settings.rowFormats || {}).shOwner;
  subhireRegistry.shOwner = { id: 'shOwner', title: '', fmt: n => Number(n).toLocaleString(), formats: fm, label: 'TOTAL', rows: rows.map(r => Object.assign({}, r, { driverState: drvStatus.has(r.id) ? (r.driver + ' · ' + STATUS_LABEL[drvStatus.get(r.id).status]) : (r.driver || '') })),
    rowOpen: id => ctx.nav.openRecord({ panel: 'rentals', id }), rowOpenLabel: 'Open the rental',
    columns: [{ key: 'reg', label: 'Registration', type: 'text', readonly: true }, { key: 'owner', label: 'Owner', type: 'text', readonly: true }, { key: 'job', label: 'Job (where it worked)', type: 'text' },
      { key: 'dates', label: 'Dates', type: 'text', readonly: true }, { key: 'days', label: 'Days', type: 'number', readonly: true }, { key: 'cost', label: 'Amount', type: 'money' },
      { key: 'status', label: 'Status', type: 'select', options: STATUSES }, { key: 'statusDate', label: 'Date', type: 'date' }, { key: 'driverState', label: 'Driver · status', type: 'text', readonly: true }],
    totals: { days: 'sum', cost: rs => rs.filter(r => r.status !== 'cancelled').reduce((s, r) => s + num(r.cost), 0) },
    onSet: (id, k, v) => { const r = (ctx.db().rentals || []).find(x => String(x.id) === String(id)); if(!r) return;
      if(k === 'job') r.job = String(v).trim() === String(rows.find(x => String(x.id) === String(id)).client) ? '' : String(v).trim();
      else if(k === 'cost') r.subhireCost = num(v);
      else if(k === 'status') setOwnerStatus(r, v, v === 'notcleared' ? '' : todayISO());
      else if(k === 'statusDate') r.subhirePaidDate = v; } };
  const lines = `<h3 style="margin:18px 0 6px;">Sub-hire lines · ${esc(span)}${ownerFilter ? ' · ' + esc((owners.find(o => o.key === ownerFilter) || {}).owner) + ' <button type="button" class="btn" data-pg="showner" data-key="" style="width:auto;padding:3px 10px;">✕ all owners</button>' : ''}</h3>
    <p class="subtitle">Everything here comes from the rentals. Click the Job, Amount, Status or Date to change it (the status date is filled with today when you change the status; type another if it was different). ↗ opens the rental. The Amount total leaves cancelled lines out.</p>${gridHtml(subhireRegistry.shOwner)}`;

  return chips(st, 'shMonth', 'shmonth', months, sel, m => ownerSummary(db, m).reduce((s, o) => s + o.cost, 0), f) + cards + ownerTable + perf + drvTable + lines;
}

/* ================= Sub-hire driver (the SUBHIRE DRIVER sheet) ================= */
export function driverPageHtml(db, st, ctx){
  const f = ctx.fmt, all = driverRows(db), months = monthsOf(all);
  const hasExp = (db.expenses || []).some(x => x.category === 'Sub-hire driver');
  if(!all.length && !hasExp) return '<p class="subtitle">No sub-hire driver jobs yet. In Drivers, set a driver\'s type to "Sub-hire"; every rental that driver is on then appears here by itself.</p>';
  const sel = pick(st, 'sdMonth', months), span = sel ? monthLabel(sel) : 'All months';
  const names = [...new Set(all.map(r => r.driver))].sort();
  const dsel = st.sdDriver && names.includes(st.sdDriver) ? st.sdDriver : '';
  const inM = all.filter(r => !sel || r.month === sel);
  const rows = inM.filter(r => !dsel || r.driver === dsel);
  const live = rows.filter(r => r.status !== 'cancelled');
  const sum = (list, k) => list.reduce((s, x) => s + num(x[k]), 0);
  const paid = sum(live.filter(r => r.status === 'paid'), 'amount'), notc = sum(live.filter(r => r.status === 'notcleared'), 'amount'), canc = sum(rows.filter(r => r.status === 'cancelled'), 'amount');
  const missing = live.filter(r => !r.rate).length;
  const cards = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
    ${card('Paid · ' + span, fg({ col: 'shDriver', month: sel, kind: 'paid', driver: dsel }, paid, f(paid)), live.filter(r => r.status === 'paid').length + ' jobs', 'green')}${card('Not cleared', fg({ col: 'shDriver', month: sel, kind: 'notcleared', driver: dsel }, notc, f(notc)), live.filter(r => r.status === 'notcleared').length + ' jobs', notc ? 'red' : '')}${card('Cancelled', fg({ col: 'shDriver', month: sel, kind: 'cancelled', driver: dsel }, canc, f(canc)), 'not counted as a cost')}
    ${card('Jobs without an amount', String(missing), 'type the amount per day', missing ? 'amber' : '')}</div>`;
  const per = driverSummary(db, sel), dv = (d, kind) => ({ col: 'shDriver', driver: d.driver, month: sel, kind });
  const perTable = `<div class="table-wrap" style="margin-bottom:12px;"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Driver</th><th class="num">Jobs</th><th class="num">Days</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Not cleared</th></tr></thead><tbody>
    ${per.map(d => `<tr><td>${esc(d.driver)}</td><td class="num">${d.jobs}</td><td class="num">${d.days}</td><td class="num">${fg(dv(d, 'amount'), d.amount, f(d.amount))}</td><td class="num" style="color:var(--green);">${fg(dv(d, 'paid'), d.paid, f(d.paid))}</td><td class="num" style="${d.notcleared ? 'color:var(--red);' : ''}">${d.notcleared ? figBtn(dv(d, 'notcleared'), f(d.notcleared)) : '—'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">Nothing in this month.</td></tr>'}</tbody></table></div></div>`;

  const rowObjs = rows.map(r => Object.assign({}, r, { amount: r.amount }));
  subhireRegistry.sdDriver = { id: 'sdDriver', title: '', fmt: n => Number(n).toLocaleString(), formats: (db.settings.rowFormats || {}).sdDriver, label: 'TOTAL', rows: rowObjs,
    rowOpen: id => ctx.nav.openRecord({ panel: 'rentals', id }), rowOpenLabel: 'Open the rental',
    columns: [{ key: 'driver', label: 'Driver', type: 'text', readonly: true }, { key: 'client', label: 'Client', type: 'text', readonly: true }, { key: 'reg', label: 'Car', type: 'text', readonly: true },
      { key: 'dates', label: 'Dates', type: 'text', readonly: true }, { key: 'days', label: 'Days', type: 'number', readonly: true }, { key: 'rate', label: 'Amount per day', type: 'money' },
      { key: 'amount', label: 'Amount (per day × days)', type: 'money', compute: r => driverAmount({ driverRate: r.rate, days: r.days }) },
      { key: 'status', label: 'Status', type: 'select', options: STATUSES }, { key: 'statusDate', label: 'Date', type: 'date' }],
    totals: { days: 'sum', amount: rs => rs.filter(r => r.status !== 'cancelled').reduce((s, r) => s + driverAmount({ driverRate: r.rate, days: r.days }), 0) },
    onSet: (id, k, v) => { const r = (ctx.db().rentals || []).find(x => String(x.id) === String(id)); if(!r) return;
      if(k === 'rate') r.driverRate = num(v);
      else if(k === 'status') setDriverStatus(r, v, v === 'notcleared' ? '' : todayISO());
      else if(k === 'statusDate') r.driverStatusDate = v; } };
  const dropdown = `<select data-pg-set="sdDriver" style="width:auto;"><option value="">All drivers</option>${names.map(n => `<option value="${esc(n)}" ${n === dsel ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  const expLeft = (db.expenses || []).filter(x => x.category === 'Sub-hire driver');
  const expNote = expLeft.length ? `<p class="subtitle">Also ${expLeft.length} sub-hire driver cost${expLeft.length === 1 ? '' : 's'} (${f(expLeft.reduce((s, x) => s + num(x.amount), 0))}) keyed under Expenses that ${expLeft.length === 1 ? 'is' : 'are'} not tied to a rental. They count in Monthly progress too: <button type="button" class="pg-fig" data-pg="drill" data-spec="${attr({ col: 'subhireDriver', from: months.length ? months[0] : '0000-00', to: '9999-99', expOnly: true })}">see them</button></p>` : '';
  return chips(st, 'sdMonth', 'sdmonth', months, sel, m => all.filter(r => r.month === m && r.status !== 'cancelled').reduce((s, r) => s + r.amount, 0), f) + cards + perTable
    + `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0 8px;"><b>${esc(span)}</b>${dropdown}<span class="subtitle" style="margin:0;">Driver, client, car, dates and days come from the rental. Type the amount per day; change the status and its date. ↗ opens the rental.</span></div>`
    + gridHtml(subhireRegistry.sdDriver) + expNote;
}

/* clicks on the chips and owner buttons; returns true when the page must be redrawn */
export function subhireClick(t, st){
  const a = t.dataset.pg;
  if(a === 'shmonth'){ st.shMonth = t.dataset.month; st.shOwner = ''; return true; }
  if(a === 'sdmonth'){ st.sdMonth = t.dataset.month; return true; }
  if(a === 'showner'){ st.shOwner = t.dataset.key && st.shOwner !== t.dataset.key ? t.dataset.key : ''; return true; }
  return false;
}
