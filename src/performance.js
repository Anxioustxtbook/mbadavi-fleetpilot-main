/* "Performance" view (the old CAR PERFORMANCE sheet): every rental with the columns you choose, filters and totals.
   Drawn live from the rentals, so there is nothing to type twice. The chosen columns are saved with the database. */
import { rentalFuel, rentalDriver, carPerformance, rentalSource, fuelIndex } from './fuelCore.js';
import { applyFacets, facetCounts, chipsHtml, chipTap, ensureChipStyles } from './chips.js';
import { carPerfHtml } from './carPerf.js';
import { balanceHtml } from './balance.js';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = v => Number(v) || 0;
const TYPE = { walkin: 'Walk-in', coop: 'Coop', taxi: 'Taxi', self: 'Self-drive' };
const coopOf = (d, r) => (d.coops || []).find(c => String(c.rentalId) === String(r.id)) || null;

export function initPerformance(ctx){
  const root = document.getElementById('panel-performance');
  const db = () => ctx.getDb();
  const veh = (d, r) => d.vehicles.find(v => v.id == r.vehicleId) || {};
  const cli = (d, r) => d.clients.find(c => c.id == r.clientId) || {};
  const drv = (d, r) => d.drivers.find(x => x.id == r.driverId) || {};
  const COLUMNS = [
    { key: 'reg', label: 'Car (reg / description)', get: (r, d) => veh(d, r).reg || '—' },
    { key: 'client', label: 'Client', get: (r, d) => cli(d, r).name || '—' },
    { key: 'type', label: 'Client type', get: r => TYPE[r.type] || 'Walk-in' },
    { key: 'driver', label: 'Driver', get: (r, d) => drv(d, r).name || '—' },
    { key: 'pickup', label: 'Pickup', get: r => (r.pickup || '') + (r.pickupTime ? ' ' + r.pickupTime : '') },
    { key: 'return', label: 'Return', get: r => (r.return || '') + (r.returnTime ? ' ' + r.returnTime : '') },
    { key: 'duration', label: 'Duration', get: r => window.fleetBilling ? window.fleetBilling.durationText(r) : '' },
    { key: 'days', label: 'Days', num: true, get: r => n(r.days) },
    { key: 'rate', label: 'Rate', num: true, get: r => n(r.rate) },
    { key: 'amount', label: 'Amount', num: true, money: true, get: r => n(r.amount) },
    { key: 'fuel', label: 'Fuel', num: true, money: true, get: (r, d) => rentalFuel(d, r) },
    { key: 'allowance', label: 'Allowance', num: true, money: true, get: r => n(r.allowance) },
    { key: 'subhire', label: 'Sub-hire cost', num: true, money: true, get: r => n(r.subhireStatus === 'cancelled' ? 0 : r.subhireCost) },
    { key: 'subhirePaid', label: 'Sub-hire status', get: r => r.subhireCost ? (({ paid: 'Paid', notcleared: 'Not cleared', cancelled: 'Cancelled' })[r.subhireStatus] || (r.subhirePaid ? 'Paid' : 'Not cleared')) : '—' },
    { key: 'driverPay', label: 'Sub-hire driver pay', num: true, money: true, get: r => rentalDriver(r) },
    { key: 'net', label: 'Net (amount − fuel − allowance − sub-hire − driver)', num: true, money: true, get: (r, d) => n(r.amount) - rentalFuel(d, r) - n(r.allowance) - n(r.subhireStatus === 'cancelled' ? 0 : r.subhireCost) - rentalDriver(r) },
    { key: 'paid', label: 'Paid', num: true, money: true, get: (r, d) => ctx.paidForRental(r.id) },
    { key: 'owed', label: 'Owed', num: true, money: true, get: (r, d) => ctx.owedForRental(r) },
    { key: 'contract', label: 'Contract No', get: r => r.contract || '—' },
    { key: 'mileage', label: 'Mileage', num: true, get: r => n(r.mileage) },
    { key: 'status', label: 'Status', get: r => r.status || '' },
    { key: 'department', label: 'Department (coop)', get: (r, d) => (coopOf(d, r) || {}).department || '—' },
    { key: 'kmOut', label: 'KM out (coop)', num: true, get: (r, d) => n((coopOf(d, r) || {}).kmOut) },
    { key: 'kmIn', label: 'KM in (coop)', num: true, get: (r, d) => n((coopOf(d, r) || {}).kmIn) },
    { key: 'source', label: 'Excel row', get: r => r.xlRef || '—' }
  ];
  const DEFAULT = ['reg', 'client', 'type', 'driver', 'pickup', 'return', 'days', 'amount', 'fuel', 'allowance', 'subhire', 'driverPay', 'net'];
  const isSub = (d, r) => { const v = veh(d, r); return v.ownership === 'subhire' || n(r.subhireCost) > 0; };
  let f = { from: '', to: '', type: '', vehicle: '', q: '', src: '', hire: '' };
  ensureChipStyles();
  const chosen = () => { const s = db().settings.perfColumns; return (Array.isArray(s) && s.length ? s : DEFAULT).filter(k => COLUMNS.some(c => c.key === k)); };

  /* one fuel total per car (the whole fuel used, no account split). Tap a figure to see where it is traced in the Fuel table. */
  function carFuelHtml(d, f){
    const range = { from: f.from, to: f.to };
    const list = carPerformance(d, f.from, f.to).filter(o => (!f.vehicle || String(o.vehicleId) === String(f.vehicle)) && (o.fuel || o.rentals));
    const t = k => list.reduce((s, o) => s + o[k], 0), btn = (v, extra) => `<button type="button" class="pg-fig" data-fuelgo='${esc(JSON.stringify(Object.assign({}, range, extra)))}' title="Show where this fuel is traced">${ctx.fmt(v)}</button>`;
    return `<h3 style="margin:18px 0 6px;">Fuel used per car</h3><p class="subtitle">The total fuel each car used on its rentals in the dates chosen. Tap a figure to see the fills and rentals behind it (Ola, outside or mixed shows there).</p>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>Car</th><th class="num">Rentals</th><th class="num">Fuel used</th></tr></thead><tbody>
      ${list.map(o => `<tr><td>${esc(o.reg)}${o.sub ? ' <span class="tag">sub-hire</span>' : ''}</td><td class="num">${o.rentals}</td><td class="num">${o.fuel ? btn(o.fuel, { car: o.vehicleId }) : ctx.fmt(0)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="3">No fuel.</td></tr>'}</tbody>
      <tfoot><tr><th>TOTAL</th><th class="num">${t('rentals')}</th><th class="num">${btn(t('fuel'), f.vehicle ? { car: f.vehicle } : {})}</th></tr></tfoot></table></div></div>
      ${carPerfHtml(d, f, ctx)}
      ${balanceHtml(d, ctx)}`;
  }

  function render(){
    const d = db(), cols = chosen().map(k => COLUMNS.find(c => c.key === k));
    const q = f.q.trim().toLowerCase();
    const base = d.rentals.filter(r =>
      (!f.from || r.pickup >= f.from) && (!f.to || r.pickup <= f.to) && (!f.vehicle || r.vehicleId == f.vehicle) &&
      (!q || [veh(d, r).reg, cli(d, r).name, drv(d, r).name, r.contract].some(x => String(x || '').toLowerCase().includes(q))));
    /* category chips: client type, where the fuel came from, own car or sub-hire. The count on each chip follows the other chips chosen. */
    const ix = fuelIndex(d), srcOf = new Map(base.map(r => [r.id, rentalSource(d, r, ix).source]));
    const groups = [
      { id: 'type', label: 'Client type', options: Object.entries(TYPE).map(([k, l]) => ({ key: k, label: l })), test: (r, k) => (r.type || 'walkin') === k },
      { id: 'src', label: 'Fuel source', options: [{ key: 'Ola', label: 'Ola' }, { key: 'Outside', label: 'Outside' }, { key: 'Mixed', label: 'Mixed' }, { key: 'Untagged', label: 'Untagged' }, { key: 'None', label: 'No fuel' }], test: (r, k) => srcOf.get(r.id) === k },
      { id: 'hire', label: 'Car', options: [{ key: 'own', label: 'Own cars' }, { key: 'sub', label: 'Sub-hire' }], test: (r, k) => (k === 'sub') === isSub(d, r) }];
    const active = { type: f.type, src: f.src, hire: f.hire }, counts = facetCounts(base, groups, active);
    const chipRows = groups.map(g => chipsHtml('perf', g, counts[g.id], active)).join('');
    const rows = applyFacets(base, groups, active).sort((a, b) => (b.pickup || '') < (a.pickup || '') ? -1 : 1);
    const tot = {}; cols.filter(c => c.num).forEach(c => { tot[c.key] = rows.reduce((s, r) => s + n(c.get(r, d)), 0); });
    const cell = (c, r) => { const v = c.get(r, d);
      if(c.key === 'fuel') return `<td class="num">${v ? `<button type="button" class="pg-fig" data-fuelgo='${esc(JSON.stringify({ rentalId: r.id }))}' title="Show where this fuel is traced">${ctx.fmt(v)}</button>` : ctx.fmt(0)}</td>`; if(c.key === 'reg') return `<td>${esc(v)}${isSub(d, r) ? ' <span class="tag">sub-hire</span>' : ''}</td>`; return `<td class="${c.num ? 'num' : ''}">${c.money ? ctx.fmt(v) : esc(c.num ? (v ? v.toLocaleString() : (c.key === 'days' ? 0 : '—')) : v)}</td>`; };
    root.innerHTML = `<h1>Performance</h1><p class="subtitle">Every rental, with the columns you pick. Totals are for the rows shown.</p>
      <div class="form-grid">
        <div><label>From (pickup)</label><input type="date" id="pf_from" value="${f.from}"></div><div><label>To (pickup)</label><input type="date" id="pf_to" value="${f.to}"></div>
        <div><label>Client type</label><select id="pf_type"><option value="">All</option>${Object.entries(TYPE).map(([k, l]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>Vehicle</label><select id="pf_vehicle"><option value="">All</option>${d.vehicles.map(v => `<option value="${v.id}" ${f.vehicle == v.id ? 'selected' : ''}>${esc(v.reg)}</option>`).join('')}</select></div>
        <div><label>Search</label><input id="pf_q" value="${esc(f.q)}" placeholder="reg, client, driver, contract"></div></div>
      ${chipRows}
      <details style="margin:8px 0 12px;"><summary><b>Columns</b> (${cols.length} shown)</summary><div style="display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 0;">${COLUMNS.map(c => `<label class="fm-check"><input type="checkbox" data-col="${c.key}" ${chosen().includes(c.key) ? 'checked' : ''}><span>${esc(c.label)}</span></label>`).join('')}</div>
        <button class="btn" id="pf_reset" style="width:auto;padding:6px 12px;">Reset columns</button></details>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows.slice(0, 600).map(r => `<tr data-rid="${esc(r.id)}" style="cursor:pointer;" title="Open this rental">${cols.map(c => cell(c, r)).join('')}<td style="white-space:nowrap;">${coopOf(d, r) ? `<button type="button" class="row-edit" data-coopid="${esc(coopOf(d, r).id)}" title="Open the Coop line">Coop ↗</button>` : ''}</td></tr>`).join('') || `<tr class="empty-row"><td colspan="${cols.length}">No rentals match.</td></tr>`}</tbody>
        <tfoot><tr>${cols.map((c, i) => `<th class="${c.num ? 'num' : ''}">${i === 0 ? rows.length + ' rentals' : (c.num && tot[c.key] !== undefined ? (c.key === 'fuel' && tot[c.key] ? `<button type="button" class="pg-fig" data-fuelgo='${esc(JSON.stringify({ from: f.from, to: f.to, car: f.vehicle || '' }))}'>${ctx.fmt(tot[c.key])}</button>` : c.money ? ctx.fmt(tot[c.key]) : tot[c.key].toLocaleString()) : '')}</th>`).join('')}</tr></tfoot></table></div></div>
      ${carFuelHtml(d, f)}
      ${rows.length > 600 ? `<p class="subtitle">Showing the 600 most recent of ${rows.length}. Narrow the dates to see the rest. Totals include all ${rows.length}.</p>` : ''}`;
  }
  root.addEventListener('change', e => {
    const t = e.target;
    if(t.dataset.col){ const set = new Set(chosen()); t.checked ? set.add(t.dataset.col) : set.delete(t.dataset.col); db().settings.perfColumns = COLUMNS.map(c => c.key).filter(k => set.has(k)); ctx.markDirty(); render(); return; }
    const map = { pf_from: 'from', pf_to: 'to', pf_type: 'type', pf_vehicle: 'vehicle' };
    if(map[t.id]){ f[map[t.id]] = t.value; render(); }
  });
  root.addEventListener('input', e => { if(e.target.id === 'pf_q'){ f.q = e.target.value; const pos = e.target.selectionStart; render(); const el = document.getElementById('pf_q'); el.focus(); el.setSelectionRange(pos, pos); } });
  root.addEventListener('click', e => {
    const ct = chipTap(e, 'perf', { type: f.type, src: f.src, hire: f.hire }); if(ct){ f[ct.group] = ct.key; render(); return; }
    if(e.target.id === 'pf_reset'){ db().settings.perfColumns = null; ctx.markDirty(); render(); return; }
    const fg = e.target.closest('[data-fuelgo]'); if(fg){ e.stopPropagation(); try{ ctx.nav.openFuel(JSON.parse(fg.dataset.fuelgo)); }catch(err){} return; }
    const cb = e.target.closest('[data-coopid]'); if(cb){ ctx.nav.openRecord({ panel: 'coop', id: cb.dataset.coopid }); return; }
    const tr = e.target.closest('tr[data-rid]'); if(tr && !e.target.closest('button,input,select,a,summary')) ctx.nav.openRecord({ panel: 'rentals', id: tr.dataset.rid });   // a row opens the record where it is kept
  });
  return { render };
}
