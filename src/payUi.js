/* Payments screen: one form, one list.
   Form: Money in / Money out, a category, the few fields that category needs, date, amount. "Record payment" writes it into the place that
   already feeds the totals (payRoute.js). When something is unclear a pop-up asks one question at a time.
   List: every payment from every place, with a filter. Click ↗ to open where it was recorded, ✕ to take it back. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { IN_CATS, OUT_CATS, outCats, validate, check, post, unified, removeEntry, money, rentalLabel, owedOn, paidOn, unpaidRentals, invoiceRentals, invoiceOwed, coopRentals, peopleNames,
  unclearedDriverJobs, unclearedOwnerJobs, loanLeft } from './payRoute.js';
import { scheduleOf, paidOf, loanName, monthName } from './loans.js';
import { driverRows, ownerRows } from './subhireCore.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const today = () => new Date().toISOString().slice(0, 10);
const METHODS = ['Cash', 'M-Pesa', 'Bank transfer', 'Card', 'Cheque', 'Other'];
const ymLabel = ym => ym ? monthName(ym) : '';

export function initPayHub(ctx){
  const root = document.getElementById('payHub');
  if(!root) return { render(){} };
  const db = () => ctx.getDb();
  const st = { dir: 'in', cat: 'rental', f: { date: today(), method: 'Cash', jobIds: [] }, fDir: '', fCat: '', fMonth: '', q: '', limit: 150, done: null, opts: {} };

  /* ---------- the form ---------- */
  const catList = () => st.dir === 'in' ? IN_CATS : outCats(db());
  function sel(name, opts, value, placeholder){
    st.opts[name] = opts;
    const big = opts.length > 12;
    return `${big ? `<input type="search" data-filter-for="${name}" placeholder="Type to find ..." style="margin-bottom:4px;">` : ''}<select data-f="${name}" id="ph_${name}">${selOptions(opts, value, placeholder)}</select>`;
  }
  const selOptions = (opts, value, placeholder) => `<option value="">${esc(placeholder || '— choose —')}</option>` + opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(value) ? 'selected' : ''}>${esc(o.l)}</option>`).join('');
  const vehOpts = () => db().vehicles.map(v => ({ v: v.id, l: v.reg })).sort((a, b) => a.l < b.l ? -1 : 1);

  function fieldsHtml(){
    const d = db(), f = st.f, c = st.cat; let h = '', hint = '';
    if(st.dir === 'in'){
      if(c === 'rental'){ const rs = unpaidRentals(d).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? 1 : -1);
        h += `<div class="ph-wide"><label>Rental (only rentals that still owe)</label>${sel('rentalId', rs.map(r => ({ v: r.id, l: rentalLabel(d, r) })), f.rentalId, 'Choose the rental')}</div>`;
        const r = d.rentals.find(x => String(x.id) === String(f.rentalId)); if(r) hint = `Charged ${money(r.amount)} · paid so far ${money(paidOn(d, r.id))} · owed ${money(owedOn(d, r))}`; }
      if(c === 'invoice'){ const list = d.invoices.map(i => ({ i, o: invoiceOwed(d, i.no) })).filter(x => x.o > 0).sort((a, b) => (a.i.date || '') < (b.i.date || '') ? 1 : -1);
        h += `<div class="ph-wide"><label>Invoice (only those still owing)</label>${sel('invoiceNo', list.map(x => ({ v: x.i.no, l: `${x.i.no} · ${x.i.client || ''} · ${x.i.month || ''} · owes ${money(x.o)}` })), f.invoiceNo, 'Choose the invoice')}</div>`;
        if(f.invoiceNo) hint = `${invoiceRentals(d, f.invoiceNo).length} rental(s) on this invoice · owes ${money(invoiceOwed(d, f.invoiceNo))}`; }
      if(c === 'coop'){ const list = (d.coops || []).slice().sort((a, b) => (a.start || '') < (b.start || '') ? 1 : -1);
        h += `<div class="ph-wide"><label>Coop line</label>${sel('coopId', list.map(x => ({ v: x.id, l: `${x.name} · ${x.contract || 'no contract no'} · ${x.start || ''} · ${money(x.amount)}${coopRentals(d, x).length ? '' : ' · to complete'}` })), f.coopId, 'Choose the coop')}</div>`;
        const cp = (d.coops || []).find(x => String(x.id) === String(f.coopId)); if(cp){ const rs = coopRentals(d, cp); hint = rs.length ? `${rs.length} rental(s) · owes ${money(rs.reduce((t, r) => t + owedOn(d, r), 0))}` : 'No rental made from this coop yet'; } }
      if(c === 'client'){ const by = {}; unpaidRentals(d).forEach(r => { by[r.clientId] = (by[r.clientId] || 0) + owedOn(d, r); });
        const list = Object.keys(by).map(id => ({ v: id, l: `${(d.clients.find(x => String(x.id) === String(id)) || {}).name || '—'} · owes ${money(by[id])} (${unpaidRentals(d, id).length} rentals)` })).sort((a, b) => a.l < b.l ? -1 : 1);
        h += `<div class="ph-wide"><label>Client (only those who owe)</label>${sel('clientId', list, f.clientId, 'Choose the client')}</div>`; }
      if(c === 'individual') h += personField();
      if(c === 'ochwada') hint = 'Money OCHWADA paid you: it is taken off the balance he owes on his statement.';
      if(c === 'other') hint = 'Say who paid in the note. It stays "not linked" until you link it to a rental.';
    } else {
      if(c.startsWith('x:') || c === 'fuel') h += `<div><label>Car ${c === 'fuel' ? '(blank for a top-up)' : '(blank = office)'}</label>${sel('vehicleId', vehOpts(), f.vehicleId, '— Office / no car —')}</div><div class="ph-wide"><label>Description</label><input data-f="desc" value="${esc(f.desc || '')}" placeholder="optional"></div>`;
      if(c === 'fuel'){ const rs = f.vehicleId ? d.rentals.filter(r => String(r.vehicleId) === String(f.vehicleId) && r.status !== 'Cancelled').sort((a, b) => (a.pickup || '') < (b.pickup || '') ? 1 : -1).slice(0, 40) : [];
        h += `<div><label>Account (for a fill)</label><select data-f="account"><option value="Ola" ${f.account !== 'Outside' ? 'selected' : ''}>Ola</option><option value="Outside" ${f.account === 'Outside' ? 'selected' : ''}>Outside</option></select></div>`
          + `<div class="ph-wide"><label>Rental the fill is for (blank = the car's rental for that date)</label>${sel('rentalId', rs.map(r => ({ v: r.id, l: `${r.pickup} · ${((d.clients.find(x => x.id == r.clientId) || {}).name || '')}${r.status === 'Active' ? ' · running' : ''}` })), f.rentalId, '— automatic —')}</div>`; }
      if(c === 'rent') h += `<div><label>Rent for month</label><input type="month" data-f="month" value="${esc(f.month || (f.date || '').slice(0, 7))}"></div>`;
      if(c === 'driver'){ const names = [...new Set(driverRows(d).filter(r => r.status === 'notcleared').map(r => r.driver))].sort();
        h += `<div class="ph-wide"><label>Sub-hire driver (with jobs not cleared)</label>${sel('driver', names.map(n => ({ v: n, l: `${n} · ${unclearedDriverJobs(d, n).length} job(s) not cleared · ${money(unclearedDriverJobs(d, n).reduce((t, r) => t + r.amount, 0))}` })), f.driver, 'Choose the driver')}</div>`;
        h += jobsHtml(f.driver ? unclearedDriverJobs(d, f.driver).map(r => ({ id: r.id, l: `${r.pickup} · ${r.reg} · ${r.client || ''} · ${r.days} day(s) · ${r.rate ? money(r.amount) : 'no amount per day yet'}` })) : null); }
      if(c === 'owner'){ const keys = new Map(); ownerRows(d).filter(r => r.status === 'notcleared').forEach(r => keys.set(r.ownerKey, r.owner));
        const opts = [...keys.entries()].map(([k, n]) => ({ v: k, l: `${n} · ${unclearedOwnerJobs(d, k).length} job(s) not cleared · ${money(unclearedOwnerJobs(d, k).reduce((t, r) => t + r.cost, 0))}` })).sort((a, b) => a.l < b.l ? -1 : 1);
        h += `<div class="ph-wide"><label>Car owner (with jobs not cleared)</label>${sel('owner', opts, f.owner, 'Choose the owner')}</div>`;
        h += jobsHtml(f.owner ? unclearedOwnerJobs(d, f.owner).map(r => ({ id: r.id, l: `${r.pickup} · ${r.reg} · ${r.job || ''} · ${r.days} day(s) · ${r.cost ? money(r.cost) : 'no amount yet'}` })) : null); }
      if(c === 'loan'){ const month = f.month || (f.date || '').slice(0, 7);
        h += `<div class="ph-wide"><label>Loan</label>${sel('loanId', d.loans.map(l => ({ v: l.id, l: loanName(l) })), f.loanId, 'Choose the loan')}</div><div><label>Instalment month</label><input type="month" data-f="month" value="${esc(month)}"></div>`;
        const left = f.loanId ? loanLeft(d, f.loanId, month) : null; if(f.loanId) hint = left == null ? `No instalment in ${ymLabel(month)} on this loan` : `${ymLabel(month)}: ${money(left)} still due`; }
      if(c === 'individual') h += personField();
      if(c === 'insurance') h += `<div><label>Car</label>${sel('vehicleId', vehOpts(), f.vehicleId, 'Choose the car')}</div><div><label>Expires on</label><input type="date" data-f="expiryDate" value="${esc(f.expiryDate || '')}"></div>`;
      if(c === 'allowance'){ const rs = d.rentals.filter(r => r.status !== 'Cancelled').sort((a, b) => (a.pickup || '') < (b.pickup || '') ? 1 : -1).slice(0, 600);
        h += `<div class="ph-wide"><label>Rental the allowance is for</label>${sel('rentalId', rs.map(r => ({ v: r.id, l: `${r.pickup} · ${(d.vehicles.find(v => v.id == r.vehicleId) || {}).reg || ''} · ${(d.clients.find(x => x.id == r.clientId) || {}).name || ''}${r.allowance ? ' · allowance ' + money(r.allowance) : ''}` })), f.rentalId, 'Choose the rental')}</div>`; }
      if(c === 'ochwada') hint = 'Money you paid for OCHWADA: it is added to the balance he owes on his statement.';
    }
    return { h, hint };
  }
  const personField = () => `<div class="ph-wide"><label>Person (LAWYER, WIN, SAM ...)</label><input data-f="person" list="ph_people" value="${esc(st.f.person || '')}" placeholder="choose or type a name"><datalist id="ph_people">${peopleNames(db()).map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
  function jobsHtml(list){
    if(list == null) return '<div class="ph-wide subtitle" style="margin:0;">Choose first, then tick the job(s) this pays.</div>';
    if(!list.length) return '<div class="ph-wide subtitle" style="margin:0;">Nothing is "not cleared" for this one.</div>';
    const ids = (st.f.jobIds || []).map(String);
    return `<div class="ph-wide"><label>Tick the job(s) this payment is for <button type="button" class="ph-link" data-act="tickall">tick all</button></label><div class="ph-jobs">${list.map(j => `<label><input type="checkbox" data-job="${esc(j.id)}" ${ids.includes(String(j.id)) ? 'checked' : ''}> ${esc(j.l)}</label>`).join('')}</div></div>`;
  }

  function drawForm(){
    const f = st.f, { h, hint } = fieldsHtml();
    root.querySelector('#ph_form').innerHTML = `
      <div class="ph-seg"><button type="button" data-dir="in" class="${st.dir === 'in' ? 'on in' : ''}">⬇ Money in</button><button type="button" data-dir="out" class="${st.dir === 'out' ? 'on out' : ''}">⬆ Money out</button></div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="ph-wide"><label>${st.dir === 'in' ? 'Received for' : 'Paid for'}</label><select id="ph_cat">${catList().map(([id, l]) => `<option value="${esc(id)}" ${id === st.cat ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        ${h}
        <div><label>Date</label><input type="date" data-f="date" value="${esc(f.date || '')}"></div>
        <div><label>Amount</label><input type="number" data-f="amount" min="0" step="any" value="${esc(f.amount == null ? '' : f.amount)}"></div>
        <div><label>Method</label><select data-f="method">${METHODS.map(m => `<option ${m === f.method ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div><label>Note</label><input data-f="note" value="${esc(f.note || '')}" placeholder="optional"></div>
      </div>
      <div class="hint" id="ph_hint" style="margin:6px 0 0;min-height:18px;">${esc(hint)}</div>
      <button class="btn primary" style="width:auto;padding:9px 18px;margin-top:8px;" id="ph_go">Record payment</button>
      <div id="ph_done" style="margin-top:8px;"></div>`;
    drawDone();
  }
  function drawDone(){
    const el = root.querySelector('#ph_done'); if(!el) return;
    el.innerHTML = st.done ? `<div class="ph-done">✓ ${esc(st.done.text)}${st.done.note ? ' (' + esc(st.done.note) + ')' : ''} <button type="button" class="ph-link" data-act="opendone">Open where it was recorded ↗</button></div>` : '';
  }

  /* ---------- amount follows the choice ---------- */
  function autoAmount(){
    const d = db(), f = st.f, c = st.cat; let a = null;
    if(st.dir === 'in'){
      if(c === 'rental'){ const r = d.rentals.find(x => String(x.id) === String(f.rentalId)); if(r) a = owedOn(d, r); }
      if(c === 'invoice' && f.invoiceNo) a = invoiceOwed(d, f.invoiceNo);
      if(c === 'coop'){ const cp = (d.coops || []).find(x => String(x.id) === String(f.coopId)); if(cp){ const rs = coopRentals(d, cp); a = rs.length ? rs.reduce((t, r) => t + owedOn(d, r), 0) : num(cp.amount); } }
      if(c === 'client' && f.clientId) a = unpaidRentals(d, f.clientId).reduce((t, r) => t + owedOn(d, r), 0);
    } else {
      if(c === 'driver' || c === 'owner'){ const rows = (c === 'driver' ? driverRows(d) : ownerRows(d)).filter(r => (f.jobIds || []).map(String).includes(String(r.id))); a = rows.reduce((t, r) => t + (c === 'driver' ? r.amount : r.cost), 0); }
      if(c === 'loan' && f.loanId){ const left = loanLeft(d, f.loanId, f.month || (f.date || '').slice(0, 7)); if(left) a = left; }
    }
    if(a != null && a > 0) f.amount = Math.round(a * 100) / 100;
  }

  /* ---------- events ---------- */
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-dir]'); if(b){ st.dir = b.dataset.dir; st.cat = catList()[0][0]; st.f = { date: st.f.date || today(), method: st.f.method || 'Cash', jobIds: [] }; drawForm(); return; }
    if(e.target.closest('#ph_go')){ submit(); return; }
    const a = e.target.closest('[data-act]');
    if(a){
      if(a.dataset.act === 'tickall'){ const boxes = [...root.querySelectorAll('[data-job]')]; const all = boxes.every(x => x.checked); boxes.forEach(x => { x.checked = !all; }); st.f.jobIds = boxes.filter(x => x.checked).map(x => x.dataset.job); autoAmount(); drawForm(); }
      if(a.dataset.act === 'opendone' && st.done) ctx.open(st.done.ref);
      if(a.dataset.act === 'more'){ st.limit += 200; drawList(); }
      if(a.dataset.act === 'open'){ const row = rowByKey(a.dataset.key); if(row) ctx.open(row.open); }
      if(a.dataset.act === 'edit') ctx.editRentalPayment(a.dataset.id);
      if(a.dataset.act === 'undo'){ const row = rowByKey(a.dataset.key); if(row) undo(row); }
      if(a.dataset.act === 'clearview') ctx.clearView();
      if(a.dataset.act === 'clear'){ st.fDir = st.fCat = st.fMonth = st.q = ''; st.limit = 150; drawList(); }
    }
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if(t.dataset.filterFor){ const name = t.dataset.filterFor, q = t.value.toLowerCase(), s = root.querySelector('#ph_' + name); s.innerHTML = selOptions((st.opts[name] || []).filter(o => !q || o.l.toLowerCase().includes(q) || String(o.v) === String(st.f[name])).slice(0, 300), st.f[name], '— choose —'); return; }
    if(t.dataset.f && t.tagName === 'INPUT' && t.type !== 'checkbox') st.f[t.dataset.f] = t.value;
    if(t.id === 'ph_q'){ st.q = t.value; st.limit = 150; drawList(); }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if(t.id === 'ph_cat'){ st.cat = t.value; st.f = { date: st.f.date, method: st.f.method, jobIds: [] }; drawForm(); return; }
    if(t.dataset.job !== undefined){ st.f.jobIds = [...root.querySelectorAll('[data-job]')].filter(x => x.checked).map(x => x.dataset.job); autoAmount(); drawForm(); return; }
    if(t.dataset.f){
      st.f[t.dataset.f] = t.value;
      if(['driver', 'owner'].includes(t.dataset.f)) st.f.jobIds = [];
      if(['rentalId', 'invoiceNo', 'coopId', 'clientId', 'driver', 'owner', 'loanId', 'month', 'vehicleId'].includes(t.dataset.f)){ autoAmount(); drawForm(); }
      else if(t.dataset.f === 'date' && st.cat === 'loan' && !st.f.month){ drawForm(); }
    }
    if(t.id === 'ph_fdir'){ st.fDir = t.value; st.limit = 150; drawList(); }
    if(t.id === 'ph_fcat'){ st.fCat = t.value; st.limit = 150; drawList(); }
    if(t.id === 'ph_fmonth'){ st.fMonth = t.value; st.limit = 150; drawList(); }
  });

  /* ---------- recording, with the pop-up questions ---------- */
  function buildSpec(){ const f = st.f; return { dir: st.dir, cat: st.cat, date: f.date, amount: num(f.amount), method: f.method, note: f.note, ans: {}, rentalId: f.rentalId, invoiceNo: f.invoiceNo, coopId: f.coopId, clientId: f.clientId,
    person: f.person, vehicleId: f.vehicleId, desc: f.desc, month: f.month || (st.cat === 'rent' || st.cat === 'loan' ? (f.date || '').slice(0, 7) : ''), loanId: f.loanId, account: f.account, expiryDate: f.expiryDate, jobIds: (f.jobIds || []).slice() }; }
  function submit(){
    const spec = buildSpec(), err = validate(db(), spec); if(err){ ctx.toast(err); return; }
    step(spec);
  }
  function step(spec){
    const q = check(db(), spec);
    if(q){ ask(q, ans => { spec.ans = Object.assign({}, spec.ans, ans); step(spec); }); return; }
    ctx.guardMonth(spec.date, 'record this payment', () => {
      const res = post(db(), spec, ctx.uid);
      if(!res.ok){ ctx.toast(res.text); return; }
      st.done = res; st.f.amount = ''; st.f.note = ''; st.f.jobIds = []; st.f.rentalId = st.f.invoiceNo = st.f.coopId = st.f.clientId = st.f.driver = st.f.owner = st.f.chamaId = '';
      ctx.markDirty(); ctx.renderAll(); ctx.toast('Recorded: ' + res.text); drawForm(); drawList();
    });
  }
  function ask(q, answer){
    let ov = document.getElementById('phAsk'); if(ov) ov.remove();
    ov = document.createElement('div'); ov.id = 'phAsk'; ov.className = 'modal-overlay show';
    ov.innerHTML = `<div class="modal-box" style="max-width:560px;"><div class="modal-head"><div><h2>${esc(q.title)}</h2><p>${esc(q.text)}</p></div></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">${q.options.map((o, i) => `<button type="button" class="btn" data-i="${i}" style="text-align:left;margin:0;">${esc(o.label)}</button>`).join('')}
      <button type="button" class="btn" data-cancel style="margin:0;color:var(--ink-dim);">Cancel, let me change it</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { const b = e.target.closest('button'); if(!b) { if(e.target === ov) ov.remove(); return; } ov.remove(); if(b.dataset.cancel !== undefined) return; answer(q.options[Number(b.dataset.i)].ans); });
  }
  const undoText = { payment: 'This takes the payment off the rental (it will owe again).', expense: 'This deletes the expense.', fuelAccount: 'This deletes the top-up.', loan: 'This clears the paid amount and date on that instalment.', chama: 'This unticks the slot.', insurance: 'This deletes the insurance line.',
    driver: 'This sets the job back to Not cleared and clears its date.', owner: 'This sets the job back to Not cleared and clears its date.', allowance: 'This removes the allowance from the rental.', individual: 'This deletes that line from their balance.', account: 'This deletes the line from the statement.' };
  function undo(row){
    if(!window.confirm(`Take this back?\n${row.cat} · ${row.who || ''} · ${money(row.amount)}${row.date ? ' · ' + row.date : ''}\n\n${undoText[row.kind] || ''}`)) return;
    ctx.guard(row.date, 'take this payment back', () => { if(removeEntry(db(), row)){ ctx.markDirty(); ctx.renderAll(); ctx.toast('Taken back'); drawList(); } else ctx.toast('Could not take it back'); });
  }

  /* ---------- the list ---------- */
  let cache = null;
  const rowByKey = k => (cache || []).find(r => r.key === k);
  function drawList(){
    cache = newestFirstByMonth(unified(db()), r => r.month);
    const months = [...new Set(cache.map(r => r.month).filter(Boolean))].sort().reverse(), cats = [...new Set(cache.map(r => r.cat))].sort();
    const q = st.q.trim().toLowerCase(), viewOn = ctx.viewActive && ctx.viewActive(), pById = new Map(db().payments.map(p => [String(p.id), p]));
    const rows = cache.filter(r => !viewOn || (r.kind === 'payment' && ctx.paymentPasses(pById.get(String(r.id))))).filter(r => (!st.fDir || r.dir === st.fDir) && (!st.fCat || r.cat === st.fCat) && (!st.fMonth || r.month === st.fMonth) && (!q || [r.cat, r.who, r.detail, r.note, r.date, r.status, String(r.amount)].join(' ').toLowerCase().includes(q)));
    const inT = rows.filter(r => r.dir === 'in' && !r.memo).reduce((t, r) => t + r.amount, 0), outT = rows.filter(r => r.dir === 'out' && !r.memo).reduce((t, r) => t + r.amount, 0);
    const shown = rows.slice(0, st.limit);
    const dateCell = r => r.date ? esc(r.date) : (r.month ? `<span title="no exact date recorded">${esc(ymLabel(r.month))}</span>` : '—');
    root.querySelector('#ph_list').innerHTML = `
      ${viewOn ? '<div class="view-banner show" style="display:flex;gap:10px;align-items:center;margin-top:14px;">Showing a filtered view of received payments. <button type="button" class="btn" data-act="clearview" style="width:auto;margin:0;padding:5px 12px;">Show everything</button></div>' : ''}
      <div class="filter-bar" style="margin:16px 0 8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <select id="ph_fdir" style="width:auto;"><option value="">Money in and out</option><option value="in" ${st.fDir === 'in' ? 'selected' : ''}>Money in</option><option value="out" ${st.fDir === 'out' ? 'selected' : ''}>Money out</option></select>
        <select id="ph_fcat" style="width:auto;"><option value="">All categories</option>${cats.map(c => `<option ${c === st.fCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="ph_fmonth" style="width:auto;"><option value="">All months</option>${months.map(m => `<option value="${m}" ${m === st.fMonth ? 'selected' : ''}>${esc(ymLabel(m))}</option>`).join('')}</select>
        <input id="ph_q" type="search" placeholder="Search name, car, note ..." value="${esc(st.q)}" style="width:220px;">
        <button type="button" class="btn" data-act="clear" style="width:auto;margin:0;padding:7px 12px;">Clear</button></div>
      <div class="ph-tot"><span>In <b class="green">${money(inT)}</b></span><span>Out <b class="red">${money(outT)}</b></span><span>Net <b>${money(inT - outT)}</b></span><span class="subtitle" style="margin:0;">${rows.length} line${rows.length === 1 ? '' : 's'}. Fuel taken from the station account is listed but not added to Out (the top-up is).</span></div>
      <div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>Date</th><th></th><th>Category</th><th>Who / what</th><th>Details</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${shown.map(r => `<tr class="${r.memo ? 'ph-memo' : ''}"><td>${dateCell(r)}</td><td><span class="ph-badge ${r.dir}">${r.dir === 'in' ? 'IN' : 'OUT'}</span></td><td>${esc(r.cat)}</td><td>${esc(r.who || '')}</td><td>${esc(r.detail || '')}${r.note && r.kind === 'payment' ? ' <span class="subtitle">' + esc(r.note) + '</span>' : ''}</td><td>${esc(r.status || '')}</td>
        <td class="num"><span class="${r.dir === 'in' ? 'green' : 'red'}">${r.dir === 'in' ? '+' : '−'}${money(r.amount).replace('KSh ', '')}</span></td>
        <td style="white-space:nowrap;"><button class="row-edit" data-act="open" data-key="${esc(r.key)}" title="Open where it is recorded">↗</button>${r.kind === 'payment' ? `<button class="row-edit" data-act="edit" data-id="${esc(r.id)}" title="Edit this payment">✎</button>` : ''}<button class="row-del" data-act="undo" data-key="${esc(r.key)}" title="Take it back">✕</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="8">Nothing matches.</td></tr>'}
      </tbody></table></div></div>${rows.length > shown.length ? `<button type="button" class="btn" data-act="more" style="width:auto;padding:8px 16px;">Show ${Math.min(200, rows.length - shown.length)} more (${rows.length - shown.length} left)</button>` : ''}`;
  }

  function render(){
    if(!root.querySelector('#ph_form')){ root.innerHTML = '<div id="ph_form" class="ph-card"></div><div id="ph_list"></div>'; drawForm(); }
    drawList();
  }
  function prefill(o){
    st.dir = o.dir || 'in'; st.cat = o.cat || catList()[0][0]; st.f = Object.assign({ date: today(), method: 'Cash', jobIds: [] }, o.f || {});
    ['rentalId', 'invoiceNo', 'coopId', 'clientId', 'person', 'vehicleId', 'loanId'].forEach(k => { if(o[k] != null) st.f[k] = o[k]; });
    if(o.amount != null) st.f.amount = o.amount; else autoAmount();
    st.done = null; render(); drawForm();
    const el = document.getElementById('ph_form'); if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return { render, prefill, setFilter(o){ Object.assign(st, o); drawList(); } };
}
