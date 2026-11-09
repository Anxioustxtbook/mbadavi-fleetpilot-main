/* Fuel (main menu, below Performance): every fuel fill with its account (Ola / Outside) and the rental it was bought for,
   plus the fuel audit per rental. The money comes from the same expenses everything else uses (see fuelCore.js), so nothing is entered twice.
   A fill tied to a rental that is still running counts on that rental at once, in Performance, Coop, Sub-hire and the audit. */
import { newestFirst, newestFirstByMonth } from './order.js';
import { ACCOUNTS, SOURCES, fillAccount, fillsOf, rentalForFill, addFill, fuelAudit, rentalFuel } from './fuelCore.js';
import { olaFills, outsideFills, untaggedFills, openingBalance, topups } from './fuelAccount.js';
import { applyFacets, facetCounts, chipsHtml, chipTap, ensureChipStyles } from './chips.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
const today = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };   // local date, not UTC
const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

export function initFuel(ctx){
  const root = document.getElementById('panel-fuel'); if(!root) return { render(){} };
  const db = () => ctx.getDb(), fmt = n => ctx.fmt(n);
  ensureChipStyles();
  const st = { mixed: false, month: '', account: '', car: '', rental: '', src: '', rtype: '', from: '', to: '', q: '', form: { date: today(), account: 'Ola' }, open: false };
  const carName = (d, id) => { const v = d.vehicles.find(x => String(x.id) === String(id)); return v ? (v.reg || [v.make, v.model].filter(Boolean).join(' ') || '—') : '—'; };
  const rentalLabel = (d, r) => { const c = d.clients.find(x => String(x.id) === String(r.clientId)) || {}; return (c.name || '—') + ' · ' + (r.pickup || '') + (r.return && r.return !== r.pickup ? ' → ' + r.return : '') + (r.status === 'Active' ? ' · running' : ''); };
  const months = d => [...new Set(fillsOf(d).map(x => String(x.date || '').slice(0, 7)).concat(d.rentals.map(r => String(r.pickup || '').slice(0, 7))).filter(Boolean))].sort();
  const sumOf = list => list.reduce((s, x) => s + num(x.amount), 0);

  function render(){
    const d = db(), cm = today().slice(0, 7), ms = months(d);
    if(!ms.includes(cm)) ms.push(cm);                               // the current month is always in the list, even before its first fill
    if(!st.month) st.month = cm;                                    // the screen opens on the current month
    const custom = !!(st.from || st.to);
    const inMonth = x => custom ? ((!st.from || String(x.date || '') >= st.from) && (!st.to || String(x.date || '') <= st.to)) : (st.month === 'all' || String(x.date || '').slice(0, 7) === st.month);
    const periodText = custom ? ((st.from || '…') + ' to ' + (st.to || '…')) : (st.month === 'all' ? 'all months' : monthName(st.month));
    const q = st.q.trim().toLowerCase();
    /* Mixed = the fill belongs to a rental that was filled on Ola AND outside. Those fills stay in their own account too, so the Ola / Outside chips match the cards above. */
    const mixedIds = new Set(fuelAudit(d, '', '').filter(a => a.source === 'Mixed').map(a => String(a.rentalId)));
    const isMixedFill = x => x.rentalId != null && x.rentalId !== '' && mixedIds.has(String(x.rentalId));
    const baseFills = fillsOf(d).filter(x => inMonth(x) && (!st.car || String(x.vehicleId) === String(st.car)) && (!st.rental || String(x.rentalId) === String(st.rental)) &&
      (!q || [carName(d, x.vehicleId), x.desc].some(v => String(v || '').toLowerCase().includes(q))));
    const viewGroup = { id: 'view', label: 'Show', options: [{ key: 'Ola', label: 'Ola' }, { key: 'Outside', label: 'Outside' }, { key: 'Mixed', label: 'Mixed' }, { key: 'none', label: 'Untagged' }],
      test: (x, k) => k === 'Mixed' ? isMixedFill(x) : fillAccount(x) === (k === 'none' ? '' : k) };
    const viewActive = { view: st.mixed ? 'Mixed' : st.account };
    const viewCounts = facetCounts(baseFills, [viewGroup], {}).view;
    const fills = newestFirstByMonth(applyFacets(baseFills, [viewGroup], viewActive), x => String(x.date || '').slice(0, 7));
    const ola = olaFills(d), out = outsideFills(d), un = untaggedFills(d), bal = openingBalance(d) + sumOf(topups(d)) - sumOf(ola);
    const mOla = sumOf(ola.filter(inMonth)), mOut = sumOf(out.filter(inMonth));
    const untied = fills.filter(x => x.source !== 'rental' && !x.rentalId);
    const card = (l, v, s, c, go, scope) => `<div class="table-wrap" style="padding:10px 14px;min-width:170px;flex:1;"><div class="subtitle" style="margin:0;">${l}</div><div style="font-size:20px;font-weight:700;${c ? 'color:var(--' + c + ');' : ''}">${go ? `<button type="button" class="pg-fig" data-card="${go}" ${scope ? `data-scope="${scope}"` : ''} title="Show the records behind this figure">${v}</button>` : v}</div><div class="subtitle" style="margin:0;">${s}</div></div>`;
    /* Summary: the current calendar month (whatever month is picked below) and all-time totals */
    const inCm = x => String(x.date || '').slice(0, 7) === cm, inPm = x => String(x.date || '').slice(0, 7) === prevMonth(cm);
    const allFills = fillsOf(d), tops = topups(d), opening = openingBalance(d);
    const cmFills = allFills.filter(inCm), cmTotal = sumOf(cmFills), pmTotal = sumOf(allFills.filter(inPm));
    const cmOla = ola.filter(inCm), cmOut = out.filter(inCm), cmUn = un.filter(inCm), cmTops = tops.filter(inCm);
    const cmMixed = fuelAudit(d, cm + '-01', cm + '-31').filter(a => a.source === 'Mixed').length;
    const cmCars = new Set(cmFills.map(x => String(x.vehicleId || '')).filter(Boolean)).size;
    const change = cmTotal - pmTotal, changeText = pmTotal ? (change >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(change)) + ' vs ' + monthName(prevMonth(cm)) : 'nothing in ' + monthName(prevMonth(cm));
    const n = (list, w) => list.length + ' ' + w + (list.length === 1 ? '' : 's');
    const summary = `
      <div class="dash-section-title" style="margin:4px 0 6px;">This month · ${monthName(cm)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        ${card('Total fuel', fmt(cmTotal), n(cmFills, 'fill') + ' · ' + cmCars + ' car' + (cmCars === 1 ? '' : 's') + ' · ' + changeText, '', 'all', 'month')}
        ${card('Ola fills', fmt(sumOf(cmOla)), n(cmOla, 'fill') + ' · tap to see them', '', 'Ola', 'month')}
        ${card('Outside fills', fmt(sumOf(cmOut)), n(cmOut, 'fill') + ' · tap to see them', '', 'Outside', 'month')}
        ${card('Untagged', fmt(sumOf(cmUn)), n(cmUn, 'fill') + ' without an account', cmUn.length ? 'amber' : '', 'none', 'month')}
        ${card('Paid in to Ola (top-ups)', fmt(sumOf(cmTops)), n(cmTops, 'top-up') + ' this month', 'green')}
        ${card('Mixed rentals', cmMixed, 'filled on Ola and outside in the same rental', cmMixed ? 'amber' : '', 'Mixed', 'month')}</div>
      <div class="dash-section-title" style="margin:4px 0 6px;">All time</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        ${card('Ola account balance', fmt(bal), bal < 0 ? 'the office is behind with the station' : 'opening + paid in − Ola fills', bal < 0 ? 'red' : 'green', 'Ola', 'all')}
        ${card('Total fuel', fmt(sumOf(allFills)), n(allFills, 'fill') + ' · tap to see them', '', 'all', 'all')}
        ${card('Ola fills', fmt(sumOf(ola)), n(ola, 'fill'), '', 'Ola', 'all')}
        ${card('Outside fills', fmt(sumOf(out)), n(out, 'fill'), '', 'Outside', 'all')}
        ${card('Untagged (old fills)', fmt(sumOf(un)), n(un, 'fill') + ' not counted in Ola or Outside: tap, then set the account', un.length ? 'amber' : '', 'none', 'all')}
        ${card('Paid in to Ola (top-ups)', fmt(sumOf(tops)), n(tops, 'top-up') + ' · opening balance ' + fmt(opening), 'green')}</div>`;
    const f = st.form, sugg = f.vehicleId ? rentalForFill(d, f.vehicleId, f.date) : '';
    const rentalsOfCar = f.vehicleId ? d.rentals.filter(r => String(r.vehicleId) === String(f.vehicleId) && r.status !== 'Cancelled').sort((a, b) => (b.pickup || '') < (a.pickup || '') ? -1 : 1).slice(0, 40) : [];
    const chosenRental = f.rentalId === undefined ? sugg : f.rentalId;
    const form = `<details id="fu_formwrap" ${st.open ? 'open' : ''} style="margin:10px 0;"><summary><b>+ Add a fill</b></summary>
      <div class="form-grid" style="margin-top:8px;">
        <div><label>Date</label><input type="date" id="fu_date" value="${esc(f.date || '')}"></div>
        <div><label>Car</label><select id="fu_car"><option value="">— pick —</option>${d.vehicles.map(v => `<option value="${esc(v.id)}" ${String(f.vehicleId) === String(v.id) ? 'selected' : ''}>${esc(v.reg || [v.make, v.model].filter(Boolean).join(' ') || '—')}${v.oneOff ? ' (one-off)' : ''}</option>`).join('')}</select></div>
        <div><label>Rental (the one it is for)</label><select id="fu_rental"><option value="">— none —</option>${rentalsOfCar.map(r => `<option value="${esc(r.id)}" ${String(chosenRental) === String(r.id) ? 'selected' : ''}>${esc(rentalLabel(d, r))}</option>`).join('')}</select></div>
        <div><label>Account</label><select id="fu_account">${ACCOUNTS.map(a => `<option ${f.account === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div><label>Amount</label><input type="number" step="any" id="fu_amount" value="${esc(f.amount || '')}"></div>
        <div><label>Note</label><input id="fu_desc" value="${esc(f.desc || '')}"></div></div>
      <button class="btn primary" id="fu_add" style="width:auto;padding:8px 16px;">Save fill</button>
      <span class="subtitle"> The car's rental for that date (or the one still running) is picked for you. A fill tied to a rental counts on that rental straight away.</span></details>`;
    const aFrom = custom ? st.from : (st.month === 'all' ? '' : st.month + '-01'), aTo = custom ? st.to : (st.month === 'all' ? '' : st.month + '-31');
    const subOf = r => { const v = d.vehicles.find(x => String(x.id) === String(r.vehicleId)) || {}; return v.ownership === 'subhire' || v.oneOff || num(r.subhireCost) > 0; };
    const typeOf = r => r.type === 'coop' ? 'Coop' : subOf(r) ? 'Sub-hire' : r.type === 'taxi' ? 'Taxi' : r.type === 'self' ? 'Self-drive' : 'Walk-in';
    const auditAll = fuelAudit(d, aFrom, aTo).filter(a => (!st.car || String(a.vehicleId) === String(st.car)) && (!st.rental || String(a.rentalId) === String(st.rental)));
    const mixedN = auditAll.filter(a => a.source === 'Mixed').length;
    const auditTyped = auditAll.map(a => Object.assign(a, { rtype: typeOf(d.rentals.find(y => String(y.id) === String(a.rentalId)) || {}) }));
    const auditGroups = [{ id: 'src', label: 'Fuel source', options: SOURCES.map(k => ({ key: k, label: k })), test: (a, k) => a.source === k },
      { id: 'rtype', label: 'Rental type', options: ['Walk-in', 'Coop', 'Sub-hire', 'Taxi', 'Self-drive'].map(k => ({ key: k, label: k })), test: (a, k) => a.rtype === k }];
    const auditActive = { src: st.src, rtype: st.rtype }, auditCounts = facetCounts(auditTyped, auditGroups, auditActive);
    const audit = applyFacets(auditTyped, auditGroups, auditActive).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? 1 : -1);
    const flagsOf = a => a.flags.concat(a.fills.some(x => num(x.amount) === a.carried && a.carried > 0) ? ['a fill equals the fuel already carried: the same money?'] : []);
    root.innerHTML = `<h1>Fuel</h1><p class="subtitle">Every fill, the account it was paid from, and the rental it is for. Ola = the fuel station account (its balance is below); Outside = paid somewhere else. Old fills have no account yet: they are not counted in Ola until you tag them.</p>
      ${summary}
      ${custom || st.month !== cm ? `<p class="subtitle" style="margin:0 0 10px;">Picked below: <b>${esc(periodText)}</b> · fuel ${fmt(sumOf(fillsOf(d).filter(inMonth)))} (Ola ${fmt(mOla)} · Outside ${fmt(mOut)} · Untagged ${fmt(sumOf(un.filter(inMonth)))}) · ${mixedN} mixed rental${mixedN === 1 ? '' : 's'}</p>` : ''}${form}
      <div class="filter-bar">${st.rental ? `<span class="view-banner show" style="margin:0;">One rental only <button type="button" class="btn" id="fu_clearrental" style="width:auto;margin:0;padding:3px 10px;">Show all</button></span>` : ''}${custom ? `<span class="view-banner show" style="margin:0;">Dates ${esc(periodText)} <button type="button" class="btn" id="fu_clearrange" style="width:auto;margin:0;padding:3px 10px;">Back to months</button></span>` : ''}<label style="margin:0;">Month</label><select id="fu_month"><option value="all" ${st.month === 'all' ? 'selected' : ''}>All months</option>${ms.map(m => `<option value="${m}" ${st.month === m ? 'selected' : ''}>${monthName(m)}</option>`).join('')}</select>
        <select id="fu_acc"><option value="">All accounts</option>${ACCOUNTS.map(a => `<option ${st.account === a ? 'selected' : ''}>${a}</option>`).join('')}<option value="none" ${st.account === 'none' ? 'selected' : ''}>Untagged</option></select>
        <select id="fu_fcar"><option value="">All cars</option>${d.vehicles.map(v => `<option value="${esc(v.id)}" ${String(st.car) === String(v.id) ? 'selected' : ''}>${esc(carName(d, v.id))}</option>`).join('')}</select>
        <select id="fu_src"><option value="">Rentals: any fuel source</option>${SOURCES.map(a => `<option ${st.src === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <select id="fu_rtype"><option value="">Rentals: all types</option>${['Walk-in', 'Coop', 'Sub-hire', 'Taxi', 'Self-drive'].map(a => `<option ${st.rtype === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <input id="fu_q" placeholder="car or note" value="${esc(st.q)}" style="max-width:220px;"></div>
      ${chipsHtml('fuel', viewGroup, viewCounts, viewActive)}
      <div class="table-wrap"><div class="table-scroll"><table id="fu_table"><thead><tr><th>Date</th><th>Car</th><th>Account</th><th>Rental</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead><tbody>
        ${fills.slice(0, 500).map(x => { const r = x.rentalId ? d.rentals.find(y => String(y.id) === String(x.rentalId)) : null;
          return `<tr data-id="${esc(x.id)}"><td><input type="date" data-k="date" value="${esc(x.date || '')}"></td><td>${esc(carName(d, x.vehicleId))}</td>
            <td><select data-k="account"><option value="" ${fillAccount(x) === '' ? 'selected' : ''}>Untagged</option>${ACCOUNTS.map(a => `<option ${fillAccount(x) === a ? 'selected' : ''}>${a}</option>`).join('')}</select></td>
            <td>${r ? `<button type="button" class="row-edit" data-open="${esc(r.id)}" title="Open the rental">${esc(rentalLabel(d, r))} ↗</button>${isMixedFill(x) ? ' <span class="tag" title="This rental was filled on Ola and outside">mixed</span>' : ''}` : (x.source === 'rental' ? '<span class="subtitle">entered on the rental</span>' : '<span class="subtitle">—</span>')}</td>
            <td class="num"><input type="number" step="any" data-k="amount" value="${esc(x.amount)}" style="width:110px;text-align:right;"></td><td><input data-k="desc" value="${esc(x.desc || '')}" style="min-width:160px;"></td>
            <td><button type="button" class="row-del" data-del="${esc(x.id)}" title="Remove this fill">✕</button></td></tr>`; }).join('') || '<tr class="empty-row"><td colspan="7">No fills for this choice.</td></tr>'}</tbody>
        <tfoot><tr><th>TOTAL</th><th>${fills.length} fills</th><th></th><th></th><th class="num">${fmt(sumOf(fills))}</th><th></th><th></th></tr></tfoot></table></div></div>
      ${fills.length > 500 ? `<p class="subtitle">Showing 500 of ${fills.length}. Pick a month to see the rest. The total counts all of them.</p>` : ''}
      <h3 id="fu_audit_h" style="margin:18px 0 6px;">Fuel audit per rental · ${periodText}</h3>
      <p class="subtitle">Fuel on a rental = the fuel carried on the rental + the fills tied to it. This is the one figure Performance, Coop, Sub-hire and the Overview use (they show the total; the Ola / Outside / Mixed split is shown here). Mixed = filled on Ola and outside during the same rental.</p>
      ${chipsHtml('fuelaudit', auditGroups[0], auditCounts.src, auditActive)}${chipsHtml('fuelaudit', auditGroups[1], auditCounts.rtype, auditActive)}
      <div class="table-wrap"><div class="table-scroll"><table id="fu_audit"><thead><tr><th>Car</th><th>Client</th><th>Type</th><th>Dates</th><th>Status</th><th>Source</th><th class="num">Ola</th><th class="num">Outside</th><th class="num">Carried on rental</th><th class="num">Fills tied</th><th class="num">Fuel on the rental</th><th>Check</th></tr></thead><tbody>
        ${audit.slice(0, 400).map(a => { const r = d.rentals.find(y => String(y.id) === String(a.rentalId)) || {}, c = d.clients.find(x => String(x.id) === String(r.clientId)) || {}, fl = flagsOf(a);
          return `<tr data-open="${esc(a.rentalId)}" style="cursor:pointer;" title="Open the rental"><td>${esc(carName(d, a.vehicleId))}</td><td>${esc(c.name || '—')}</td><td>${esc(a.rtype)}</td><td>${esc(a.pickup)}${a.return && a.return !== a.pickup ? ' → ' + esc(a.return) : ''}</td><td>${esc(a.status || '')}</td><td><b style="${a.source === 'Mixed' ? 'color:var(--amber);' : ''}">${esc(a.source === 'None' ? '—' : a.source)}</b></td><td class="num">${a.ola ? fmt(a.ola) : '—'}</td><td class="num">${a.outside ? fmt(a.outside) : '—'}</td>
            <td class="num">${a.carried ? fmt(a.carried) : '—'}</td><td class="num">${a.extra ? fmt(a.extra) + ' (' + a.fills.length + ')' : '—'}</td><td class="num"><b>${fmt(a.total)}</b></td><td style="color:var(--amber);">${esc(fl.join('; '))}</td></tr>`; }).join('') || '<tr class="empty-row"><td colspan="11">No rentals with fuel in this choice.</td></tr>'}</tbody>
        <tfoot><tr><th>TOTAL</th><th></th><th></th><th></th><th></th><th></th><th class="num">${fmt(audit.reduce((s, a) => s + a.ola, 0))}</th><th class="num">${fmt(audit.reduce((s, a) => s + a.outside, 0))}</th><th class="num">${fmt(audit.reduce((s, a) => s + a.carried, 0))}</th><th class="num">${fmt(audit.reduce((s, a) => s + a.extra, 0))}</th><th class="num">${fmt(audit.reduce((s, a) => s + a.total, 0))}</th><th></th></tr></tfoot></table></div></div>`;
  }

  const refresh = () => { ctx.markDirty(); if(ctx.renderAll) ctx.renderAll(); render(); };
  const readForm = () => { const g = id => document.getElementById(id).value; st.form = { date: g('fu_date'), vehicleId: g('fu_car'), rentalId: g('fu_rental'), account: g('fu_account'), amount: g('fu_amount'), desc: g('fu_desc') }; st.open = true; };
  root.addEventListener('change', e => {
    const t = e.target;
    if(t.id === 'fu_month'){ st.month = t.value; st.from = st.to = ''; render(); return; }
    if(t.id === 'fu_acc'){ st.account = t.value; st.mixed = false; render(); return; }
    if(t.id === "fu_fcar"){ st.car = t.value; render(); return; }
    if(t.id === 'fu_src'){ st.src = t.value; render(); return; }
    if(t.id === 'fu_rtype'){ st.rtype = t.value; render(); return; }
    if(t.id === 'fu_car' || t.id === 'fu_date'){ readForm(); delete st.form.rentalId; render(); return; }       // the rental is suggested again for the new car / date
    const tr = t.closest('#fu_table tr[data-id]'); if(!tr || !t.dataset.k) return;
    const x = (db().expenses || []).find(e2 => String(e2.id) === tr.dataset.id); if(!x) return;
    const k = t.dataset.k, v = t.value, oldDate = x.date;
    if(k === 'amount' && !(num(v) > 0)){ ctx.toast('The amount must be more than 0'); render(); return; }
    ctx.guard(oldDate, 'change this fuel line', () => { if(k === 'amount') x.amount = num(v); else if(k === 'date') x.date = v; else if(k === 'account') x.account = v === 'Outside' ? 'Outside' : (v === 'Ola' ? 'Ola' : ''); else x.desc = v; refresh(); });
    render();
  });
  root.addEventListener('input', e => { if(e.target.id === 'fu_q'){ st.q = e.target.value; const p = e.target.selectionStart; render(); const el = document.getElementById('fu_q'); el.focus(); el.setSelectionRange(p, p); } });
  root.addEventListener('click', e => {
    if(e.target.id === 'fu_add'){
      readForm(); const f = st.form;
      const res = addFill(db(), ctx.uid, { date: f.date, vehicleId: f.vehicleId, rentalId: f.rentalId === undefined ? (f.vehicleId ? rentalForFill(db(), f.vehicleId, f.date) : '') : f.rentalId, account: f.account, amount: f.amount, desc: f.desc });
      if(!res.ok){ ctx.toast(res.why); render(); return; }
      st.form = { date: f.date, account: f.account }; st.open = false; st.month = String(res.fill.date).slice(0, 7);
      refresh(); ctx.toast('Fill saved' + (res.fill.rentalId ? ' and added to its rental' : '') + '.'); return;
    }
    const ct = chipTap(e, 'fuel', { view: st.mixed ? 'Mixed' : st.account });
    if(ct){ if(ct.key === 'Mixed'){ st.mixed = true; st.account = ''; } else { st.mixed = false; st.account = ct.key; } render(); return; }
    const ca = chipTap(e, 'fuelaudit', { src: st.src, rtype: st.rtype });
    if(ca){ if(ca.group === 'src') st.src = ca.key; else st.rtype = ca.key; render(); return; }
    if(e.target.id === 'fu_clearrental'){ st.rental = ''; render(); return; }
    if(e.target.id === 'fu_clearrange'){ st.from = st.to = ''; render(); return; }
    const cd = e.target.closest('[data-card]');
    if(cd){ const k = cd.dataset.card, scope = cd.dataset.scope;
      const period = scope === 'month' ? { month: today().slice(0, 7), from: '', to: '' } : scope === 'all' ? { month: 'all', from: '', to: '' } : {};
      if(k === 'Mixed'){ show(Object.assign({ src: 'Mixed', keep: true, target: 'fu_audit_h' }, period)); }
      else show(Object.assign({ account: k === 'all' ? '' : k, keep: true, target: 'fu_table' }, period));
      return; }
    const del = e.target.closest('[data-del]'); if(del){ ctx.removeExpense(del.dataset.del, () => { ctx.markDirty(); render(); }); return; }
    const op = e.target.closest('[data-open]'); if(op && !e.target.closest('input,select')){ ctx.nav.openRecord({ panel: 'rentals', id: op.dataset.open }); }
  });
  /* Open the Fuel table already filtered (from the cards here, and from Performance, the Overview and reports): { account, car, src, rtype, month, from, to, rentalId, target } */
  function show(o){
    o = o || {};
    if(!o.keep){ st.mixed = false; st.rental = ''; st.account = ''; st.car = ''; st.src = ''; st.rtype = ''; st.from = st.to = ''; st.q = ''; }
    if(o.account !== undefined){ st.account = o.account; st.mixed = false; }
    if(o.car !== undefined) st.car = o.car ? String(o.car) : '';
    if(o.rentalId !== undefined) st.rental = o.rentalId ? String(o.rentalId) : '';
    if(o.src !== undefined) st.src = o.src;
    if(o.rtype !== undefined) st.rtype = o.rtype;
    if(o.month){ st.month = o.month; st.from = st.to = ''; }
    if(o.from !== undefined || o.to !== undefined){ st.from = o.from || ''; st.to = o.to || ''; }
    render();
    const id = o.target || (o.src ? 'fu_audit_h' : 'fu_table');
    setTimeout(() => { const el = document.getElementById(id); if(!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('fp-flash'); setTimeout(() => el.classList.remove('fp-flash'), 2600); }, 80);
  }
  return { render, show };
}
