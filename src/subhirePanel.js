/* Sub-hire (main menu, below Performance): the sub-hire table.
   One line per sub-hire rental (a car from an owner, one-off cars included). Pick the sub-hire driver of a rental right here and view that driver's jobs.
   Everything is drawn from the rentals (subhireCore.js); fuel is the same figure used everywhere (fuelCore.js). Nothing is typed twice. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { applyFacets, facetCounts, chipsHtml, chipTap, ensureChipStyles } from './chips.js';
import { STATUSES, STATUS_LABEL, monthLabel, todayISO, ownerRows, driverRows, monthsOf, ownerSummary, driverSummary, setOwnerStatus, setDriverStatus, driverStatus, driverAmount } from './subhireCore.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const r2 = x => Math.round(x * 100) / 100;

export function initSubhirePanel(ctx){
  const root = document.getElementById('panel-subhire'); if(!root) return { render(){} };
  const db = () => ctx.getDb(), fmt = n => ctx.fmt(n);
  ensureChipStyles();
  const st = { month: '', owner: '', driver: '', q: '', fStatus: '', fKind: '', fDriver: '' };

  function render(){
    const d = db(), all = ownerRows(d), months = monthsOf(all);
    if(!all.length){ root.innerHTML = '<h1>Sub-hire</h1><p class="subtitle">No sub-hire rentals yet. A rental is a sub-hire line when its car is a sub-hire car (or a one-off sub-hire car added in Rentals), or a sub-hire cost is entered on it.</p>'; return; }
    if(!st.month || (st.month !== 'all' && !months.includes(st.month))) st.month = months[months.length - 1];
    const sel = st.month === 'all' ? '' : st.month, span = sel ? monthLabel(sel) : 'All months';
    const owners = ownerSummary(d, sel), q = st.q.trim().toLowerCase();
    let rows = all.filter(r => !sel || r.month === sel);
    if(st.owner && owners.some(o => o.key === st.owner)) rows = rows.filter(r => r.ownerKey === st.owner); else st.owner = '';
    if(q) rows = rows.filter(r => [r.reg, r.owner, r.client, r.job, r.driver].some(x => String(x || '').toLowerCase().includes(q)));
    rows = newestFirstByMonth(rows, r => r.month);
    const drvById = new Map(driverRows(d).map(r => [r.id, r]));
    const rentalOf = id => d.rentals.find(x => String(x.id) === String(id)) || {};
    const subDrivers = d.drivers.filter(x => x.kind === 'subhire');
    /* category chips: owner payment status, owner car or one-off car, driver picked or not. Counts follow the other chips; cards and totals follow the rows shown. */
    const isOneOff = r => !!(d.vehicles.find(v => String(v.id) === String(r.vehicleId)) || {}).oneOff;
    const groups = [
      { id: 'fStatus', label: 'Owner pay', options: STATUSES.map(s => ({ key: s.value, label: s.label })), test: (r, k) => r.status === k },
      { id: 'fKind', label: 'Car', options: [{ key: 'owner', label: 'Owner cars' }, { key: 'oneoff', label: 'One-off cars' }], test: (r, k) => (k === 'oneoff') === isOneOff(r) },
      { id: 'fDriver', label: 'Driver', options: [{ key: 'with', label: 'Driver picked' }, { key: 'without', label: 'No driver yet' }], test: (r, k) => (k === 'with') === drvById.has(r.id) }];
    const active = { fStatus: st.fStatus, fKind: st.fKind, fDriver: st.fDriver }, counts = facetCounts(rows, groups, active);
    const chipRows = groups.map(g => chipsHtml('subhire', g, counts[g.id], active)).join('');
    rows = applyFacets(rows, groups, active);
    const live = rows.filter(r => r.status !== 'cancelled' && !r.rentalCancelled);
    const net = r => { const dr = drvById.get(r.id); return r2(r.billed - (r.status === 'cancelled' ? 0 : r.cost) - (dr && dr.status !== 'cancelled' ? dr.amount : 0) - r.fuel - r.allowance); };
    const tot = { billed: rows.reduce((s, r) => s + r.billed, 0), cost: live.reduce((s, r) => s + r.cost, 0), fuel: rows.filter(r => !r.rentalCancelled).reduce((s, r) => s + r.fuel, 0), allowance: rows.filter(r => !r.rentalCancelled).reduce((s, r) => s + r.allowance, 0),
      driver: rows.reduce((s, r) => { const dr = drvById.get(r.id); return s + (dr && dr.status !== 'cancelled' ? dr.amount : 0); }, 0) };
    tot.net = rows.reduce((s, r) => s + net(r), 0);
    const paid = live.filter(r => r.status === 'paid').reduce((s, r) => s + r.cost, 0), notc = live.filter(r => r.status === 'notcleared').reduce((s, r) => s + r.cost, 0);
    const card = (l, v, s, c) => `<div class="table-wrap" style="padding:10px 14px;min-width:160px;flex:1;"><div class="subtitle" style="margin:0;">${l}</div><div style="font-size:20px;font-weight:700;${c ? 'color:var(--' + c + ');' : ''}">${v}</div><div class="subtitle" style="margin:0;">${s}</div></div>`;
    const chip = (m, l, extra) => `<button type="button" class="btn ${m === (sel || 'all') ? 'primary' : ''}" data-month="${m}" style="width:auto;padding:6px 12px;">${l}${extra ? '<br><small>' + extra + '</small>' : ''}</button>`;
    const drvOptions = r => { const cur = rentalOf(r.id).driverId, list = subDrivers.slice(); if(cur && !list.some(x => String(x.id) === String(cur))){ const x = d.drivers.find(y => String(y.id) === String(cur)); if(x) list.push(x); }
      return `<option value="">— none —</option>` + list.map(x => `<option value="${esc(x.id)}" ${String(cur) === String(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join(''); };
    const body = rows.map(r => { const rt = rentalOf(r.id), dr = drvById.get(r.id), isOne = (d.vehicles.find(v => String(v.id) === String(r.vehicleId)) || {}).oneOff;
      return `<tr data-id="${esc(r.id)}" ${r.rentalCancelled ? 'style="opacity:.55;"' : ''}>
        <td>${esc(r.reg)} <span class="tag">sub-hire</span>${isOne ? ' <span class="tag">one-off</span>' : ''}</td><td>${esc(r.owner)}</td><td><input data-k="job" value="${esc(r.jobTyped || r.client)}" style="min-width:120px;"></td>
        <td>${esc(r.dates)}</td><td class="num">${r.days}</td><td class="num">${fmt(r.billed)}</td>
        <td class="num"><input type="number" step="any" data-k="cost" value="${esc(r.cost)}" style="width:100px;text-align:right;"></td>
        <td><select data-k="status">${STATUSES.map(s => `<option value="${s.value}" ${r.status === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}</select></td>
        <td><input type="date" data-k="statusDate" value="${esc(r.statusDate)}"></td>
        <td><select data-k="driverId">${drvOptions(r)}</select></td>
        <td class="num"><input type="number" step="any" data-k="driverRate" value="${esc(rt.driverRate || '')}" placeholder="per day" style="width:80px;text-align:right;" ${dr ? '' : 'disabled title="Pick a driver first"'}></td>
        <td>${dr ? `<select data-k="driverStatus">${STATUSES.map(s => `<option value="${s.value}" ${dr.status === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}</select>` : '—'}</td>
        <td class="num">${dr ? fmt(dr.amount) : '—'}</td>
        <td class="num">${r.fuel ? fmt(r.fuel) : '—'}</td><td class="num">${r.allowance ? fmt(r.allowance) : '—'}</td>
        <td class="num" style="color:var(--${net(r) >= 0 ? 'green' : 'red'});"><b>${fmt(net(r))}</b></td>
        <td style="white-space:nowrap;">${dr ? `<button type="button" class="row-edit" data-showdrv="${esc(dr.driver)}" title="View this driver's jobs">Driver jobs</button>` : ''}<button type="button" class="row-edit" data-open="${esc(r.id)}" title="Open the rental">↗</button></td></tr>`; }).join('')
      || '<tr class="empty-row"><td colspan="17">Nothing in this choice.</td></tr>';
    const dsum = driverSummary(d, sel).find(x => x.driver === st.driver);
    const dJobs = st.driver ? driverRows(d).filter(r => r.driver === st.driver && (!sel || r.month === sel)) : [];
    const detail = st.driver ? `<h3 style="margin:18px 0 6px;">Driver jobs · ${esc(st.driver)} · ${esc(span)} <button type="button" class="btn" id="sh_closedrv" style="width:auto;padding:3px 10px;">✕ close</button></h3>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>Client</th><th>Car</th><th>Dates</th><th class="num">Days</th><th class="num">Per day</th><th class="num">Amount</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
      ${dJobs.map(j => `<tr><td>${esc(j.client)}</td><td>${esc(j.reg)}</td><td>${esc(j.dates)}</td><td class="num">${j.days}</td><td class="num">${j.rate ? fmt(j.rate) : '—'}</td><td class="num">${fmt(j.amount)}</td><td>${esc(STATUS_LABEL[j.status])}</td><td>${esc(j.statusDate)}</td><td><button type="button" class="row-edit" data-open="${esc(j.id)}">↗</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="9">No jobs.</td></tr>'}</tbody>
      <tfoot><tr><th>TOTAL</th><th></th><th></th><th class="num">${dJobs.reduce((s, j) => s + j.days, 0)}</th><th></th><th class="num">${fmt(dJobs.filter(j => j.status !== 'cancelled').reduce((s, j) => s + j.amount, 0))}</th><th>${dsum ? 'Paid ' + fmt(dsum.paid) + ' · Not cleared ' + fmt(dsum.notcleared) : ''}</th><th></th><th></th></tr></tfoot></table></div></div>` : '';
    root.innerHTML = `<h1>Sub-hire</h1><p class="subtitle">Every sub-hire rental: what the owner is paid, who drove it, and what was left. Pick the driver in the table and press <b>Driver jobs</b> to see all of that driver's jobs. Cancelled lines cost nothing. One-off cars have their own line.</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${chip('all', 'All months')}${months.map(m => chip(m, monthLabel(m).slice(0, 3) + ' ' + m.slice(2, 4), Math.round(ownerSummary(d, m).reduce((s, o) => s + o.cost, 0) / 1000) + 'k')).join(' ')}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">${card('Paid to owners · ' + span, fmt(paid), 'owner cost', 'green')}${card('Not cleared', fmt(notc), 'still to pay owners', notc ? 'red' : '')}${card('Driver pay', fmt(tot.driver), 'on these jobs')}${card('Left over', fmt(tot.net), 'billed − owner − driver − fuel − allowance', tot.net < 0 ? 'red' : 'green')}</div>
      ${chipRows}
      <div class="filter-bar"><select id="sh_owner"><option value="">All owners</option>${owners.map(o => `<option value="${esc(o.key)}" ${o.key === st.owner ? 'selected' : ''}>${esc(o.owner)}</option>`).join('')}</select><input id="sh_q" placeholder="car, owner, client, driver" value="${esc(st.q)}" style="max-width:240px;"></div>
      <div class="table-wrap"><div class="table-scroll"><table id="sh_table"><thead><tr><th>Car</th><th>Owner</th><th>Job</th><th>Dates</th><th class="num">Days</th><th class="num">Billed</th><th class="num">Owner cost</th><th>Status</th><th>Date</th><th>Sub-hire driver</th><th class="num">Driver / day</th><th>Driver status</th><th class="num">Driver pay</th><th class="num">Fuel</th><th class="num">Allowance</th><th class="num">Left over</th><th></th></tr></thead><tbody>${body}</tbody>
        <tfoot><tr><th>TOTAL</th><th></th><th></th><th></th><th class="num">${rows.reduce((s, r) => s + r.days, 0)}</th><th class="num">${fmt(tot.billed)}</th><th class="num">${fmt(tot.cost)}</th><th></th><th></th><th></th><th></th><th></th><th class="num">${fmt(tot.driver)}</th><th class="num">${fmt(tot.fuel)}</th><th class="num">${fmt(tot.allowance)}</th><th class="num">${fmt(tot.net)}</th><th></th></tr></tfoot></table></div></div>${detail}`;
  }

  const refresh = () => { ctx.markDirty(); if(ctx.renderAll) ctx.renderAll(); render(); };
  root.addEventListener('change', e => {
    const t = e.target;
    if(t.id === 'sh_owner'){ st.owner = t.value; render(); return; }
    const tr = t.closest('#sh_table tr[data-id]'); if(!tr || !t.dataset.k) return;
    const r = db().rentals.find(x => String(x.id) === tr.dataset.id); if(!r) return;
    const k = t.dataset.k, v = t.value;
    if(k === 'job') r.job = v.trim();
    else if(k === 'cost') r.subhireCost = num(v);
    else if(k === 'status') setOwnerStatus(r, v, v === 'notcleared' ? '' : todayISO());
    else if(k === 'statusDate') r.subhirePaidDate = v;
    else if(k === 'driverId'){ r.driverId = v ? (Number(v) || v) : null; if(!v){ r.driverRate = 0; r.driverStatus = ''; r.driverStatusDate = ''; } }
    else if(k === 'driverRate') r.driverRate = num(v);
    else if(k === 'driverStatus') setDriverStatus(r, v, v === 'notcleared' ? '' : todayISO());
    refresh();
  });
  root.addEventListener('input', e => { if(e.target.id === 'sh_q'){ st.q = e.target.value; const p = e.target.selectionStart; render(); const el = document.getElementById('sh_q'); el.focus(); el.setSelectionRange(p, p); } });
  root.addEventListener('click', e => {
    const ct = chipTap(e, 'subhire', { fStatus: st.fStatus, fKind: st.fKind, fDriver: st.fDriver }); if(ct){ st[ct.group] = ct.key; render(); return; }
    const m = e.target.closest('[data-month]'); if(m){ st.month = m.dataset.month; st.owner = ''; st.driver = ''; render(); return; }
    const dv = e.target.closest('[data-showdrv]'); if(dv){ st.driver = dv.dataset.showdrv; render(); const el = root.querySelector('#sh_closedrv'); if(el) el.scrollIntoView({ block: 'center' }); return; }
    if(e.target.id === 'sh_closedrv'){ st.driver = ''; render(); return; }
    const op = e.target.closest('[data-open]'); if(op) ctx.nav.openRecord({ panel: 'rentals', id: op.dataset.open });
  });
  return { render };
}
