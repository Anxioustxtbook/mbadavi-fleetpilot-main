/* Balance check: "does the database agree with itself?" Pure functions, drawn live from db, nothing is changed.
   Each check answers one question about money or links that, if wrong, makes a total untrustworthy.
   Result: { id, title, ok, summary, items:[ "what is wrong, where" ... ] }  (items are capped; "+N more" says the rest). */
import { fillsOf, fillAccount } from './fuelCore.js';

const num = v => Number(v) || 0;
const live = r => r && r.status !== 'Cancelled';
const money = n => 'KSh ' + Math.round(num(n)).toLocaleString('en-KE');
const has = v => v !== undefined && v !== null && v !== '';
const CAP = 12;
const LISTS = ['vehicles', 'drivers', 'clients', 'bookings', 'rentals', 'expenses', 'payments', 'invoices', 'accounts', 'loans', 'insurance', 'fuelAccount', 'coops', 'individuals'];

export function balanceChecks(db, today){
  const day = today || new Date().toISOString().slice(0, 10);
  const veh = new Map((db.vehicles || []).map(v => [String(v.id), v])), cli = new Map((db.clients || []).map(c => [String(c.id), c]));
  const rent = new Map((db.rentals || []).map(r => [String(r.id), r]));
  const rl = r => `${(veh.get(String(r.vehicleId)) || {}).reg || '—'} · ${(cli.get(String(r.clientId)) || {}).name || '—'} · ${r.pickup || 'no date'}`;
  const out = [];
  const add = (id, title, items, summary, okText) => out.push({ id, title, ok: !items.length, summary: items.length ? summary : okText, items: items.length > CAP ? items.slice(0, CAP).concat('+' + (items.length - CAP) + ' more') : items });

  /* 1. the money of rentals adds up: billed = paid + owed - overpaid */
  const liveR = (db.rentals || []).filter(live), paidBy = new Map();
  (db.payments || []).forEach(p => { if(has(p.rentalId)) paidBy.set(String(p.rentalId), (paidBy.get(String(p.rentalId)) || 0) + num(p.amount)); });
  let billed = 0, paid = 0, owed = 0, over = 0; const overItems = [];
  liveR.forEach(r => { const a = num(r.amount), p = paidBy.get(String(r.id)) || 0; billed += a; paid += p; owed += Math.max(0, a - p);
    if(p - a > 1){ over += p - a; overItems.push(`${rl(r)}: billed ${money(a)}, paid ${money(p)} (${money(p - a)} too much)`); } });
  const diff = Math.round(billed - paid - owed + over);
  add('rental-money', 'Rentals: billed = paid + owed', diff ? [`Billed ${money(billed)} − paid ${money(paid)} − owed ${money(owed)} + overpaid ${money(over)} is off by ${money(diff)}`] : [],
    'The rental totals do not add up', `Billed ${money(billed)} = paid ${money(paid)} + owed ${money(owed)}${over ? ' − overpaid ' + money(over) : ''}`);
  add('overpaid', 'No rental is paid more than it was billed', overItems, `${overItems.length} rental(s) hold more money than they were billed`, 'None overpaid');

  /* 2. every payment lands somewhere that exists */
  const orphan = [], toCancelled = [], odd = [], future = [];
  (db.payments || []).forEach(p => {
    const lab = `${p.date || 'no date'} · ${money(p.amount)}${p.note ? ' · ' + p.note : ''}`;
    if(has(p.rentalId)){ const r = rent.get(String(p.rentalId)); if(!r) orphan.push(lab + ' → rental no longer exists'); else if(!live(r)) toCancelled.push(lab + ' → ' + rl(r) + ' is cancelled'); }
    if(!has(p.date)) odd.push(lab + ' → no date'); else if(String(p.date) > day) future.push(lab + ' → dated in the future');
    if(num(p.amount) <= 0) odd.push(lab + ' → amount is zero or negative');
  });
  add('pay-orphan', 'Every payment points to a rental that exists', orphan, `${orphan.length} payment(s) point to a deleted rental`, 'All payments linked');
  add('pay-cancelled', 'No payment sits on a cancelled rental', toCancelled, `${toCancelled.length} payment(s) are on cancelled rentals (the money is not counted anywhere)`, 'None on cancelled rentals');
  add('pay-dates', 'Every payment has a date, an amount, and is not in the future', odd.concat(future), `${odd.length + future.length} payment(s) need a look`, 'Dates and amounts fine');

  /* 3. invoices */
  const invNos = new Map(); (db.invoices || []).forEach(i => { const k = String(i.no || ''); if(k) invNos.set(k, (invNos.get(k) || 0) + 1); });
  const dupInv = [...invNos].filter(([, n]) => n > 1).map(([k, n]) => `Invoice ${k} appears ${n} times`);
  add('inv-dup', 'No invoice number is used twice', dupInv, `${dupInv.length} invoice number(s) repeat`, 'Invoice numbers unique');
  const onRental = new Set(liveR.map(r => String(r.invoice || '')).filter(Boolean)), missing = [];
  onRental.forEach(k => { if(!invNos.has(k)) missing.push(`Rentals carry invoice ${k} but it is not in Invoices`); });
  add('inv-missing', 'Every invoice number on a rental is in Invoices', missing, `${missing.length} invoice number(s) are on rentals but not listed`, 'All invoice numbers listed');

  /* 4. links that must not dangle */
  const dang = [];
  (db.rentals || []).forEach(r => { if(!veh.has(String(r.vehicleId))) dang.push(`Rental ${r.pickup || ''} ${money(r.amount)}: car missing`); if(has(r.clientId) && !cli.has(String(r.clientId))) dang.push(`Rental ${rl(r)}: client missing`); });
  (db.expenses || []).forEach(x => { if(has(x.vehicleId) && !veh.has(String(x.vehicleId))) dang.push(`${x.category || 'Expense'} ${x.date || ''} ${money(x.amount)}: car missing`); });
  (db.insurance || []).forEach(i => { if(has(i.vehicleId) && !veh.has(String(i.vehicleId))) dang.push(`Insurance ${i.paidDate || ''} ${money(i.amount)}: car missing`); });
  (db.coops || []).forEach(c => { if(has(c.rentalId) && !rent.has(String(c.rentalId))) dang.push(`Coop ${c.name || ''} ${c.start || ''}: its rental is gone`); });
  add('links', 'No record points to a car, client or rental that is gone', dang, `${dang.length} broken link(s)`, 'All links good');

  /* 5. ids: a repeated id lets one record overwrite or hide another */
  const dupId = []; let maxId = 0;
  LISTS.forEach(k => { const seen = new Set(); (db[k] || []).forEach(x => { if(!x || !has(x.id)) return; const id = String(x.id); if(/^\d+$/.test(id) && Number(id) <= 999999999) maxId = Math.max(maxId, Number(id)); if(seen.has(id)) dupId.push(`${k}: id ${id} used twice`); seen.add(id); }); });
  if(maxId && num(db.nextId) <= maxId) dupId.push(`Next id (${db.nextId}) is not above the highest id in use (${maxId}): a new record could reuse an id`);
  add('ids', 'Every record has its own id', dupId, `${dupId.length} id problem(s)`, 'Ids unique');

  /* 6. rentals dates and amounts */
  const bad = [];
  liveR.forEach(r => { if(has(r.return) && r.return < r.pickup) bad.push(`${rl(r)}: returned before it was taken`); if(!num(r.amount)) bad.push(`${rl(r)}: amount is zero`); });
  add('rental-data', 'Rentals have sensible dates and an amount', bad, `${bad.length} rental(s) need a look`, 'Rentals fine');

  /* 7. coop lines agree with their rentals */
  const cdiff = [];
  (db.coops || []).forEach(c => { const r = has(c.rentalId) ? rent.get(String(c.rentalId)) : null; if(r && live(r) && Math.abs(num(c.amount) - num(r.amount)) > 1) cdiff.push(`${c.name || ''} ${c.start || ''}: coop ${money(c.amount)} vs rental ${money(r.amount)}`); });
  add('coop', 'Coop lines show the same amount as their rental', cdiff, `${cdiff.length} coop line(s) differ from their rental`, 'Coops agree');

  /* 8. fuel: every fill has a date and an account, so months and the station account add up */
  const fills = fillsOf(db), nodate = fills.filter(x => !has(x.date)), noacc = fills.filter(x => !fillAccount(x));
  add('fuel', 'Every fuel fill has a date and an account (Ola or Outside)', nodate.map(x => `Fill ${money(x.amount)}: no date`).concat(noacc.length ? [`${noacc.length} fill(s) not tagged Ola or Outside (${money(noacc.reduce((s, x) => s + num(x.amount), 0))})`] : []),
    `${nodate.length + (noacc.length ? 1 : 0)} fuel point(s) need a look`, 'Fuel fills complete');
  return out;
}

export function balanceHtml(db, ctx){
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const list = balanceChecks(db), bad = list.filter(c => !c.ok);
  return `<h3 style="margin:22px 0 6px;">Balance check</h3><p class="subtitle">${bad.length ? `<b style="color:var(--red);">${bad.length} of ${list.length} checks need a look.</b> Open a line to see exactly which records.` : `<b style="color:var(--green);">All ${list.length} checks balance.</b> Nothing in the database disagrees with itself.`} Read-only: it changes nothing.</p>
    <div class="table-wrap"><div class="table-scroll"><table class="pg-table" data-no-tools="1"><tbody>
    ${list.map(c => `<tr><td style="width:28px;text-align:center;"><b style="color:var(--${c.ok ? 'green' : 'red'});">${c.ok ? '✓' : '✗'}</b></td><td><b>${esc(c.title)}</b><br><span class="subtitle">${esc(c.summary)}</span>${c.items.length ? `<details style="margin-top:4px;"><summary>Show records</summary><ul style="margin:4px 0 0 18px;">${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
