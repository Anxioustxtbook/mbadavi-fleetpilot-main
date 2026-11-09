/* Payments router (pure, no screen code).
   One "Add payment" form, one list. Every payment is written into the place that already feeds the totals, so nothing is kept twice
   and nothing is counted twice:
     money IN   rental / invoice / coop / client  -> db.payments (one line per rental it pays)
                OCHWADA                           -> db.accounts   (a payment lowers what he owes)
                individual lent / returned        -> db.individuals (+ line)
                other                             -> db.payments, not linked to a rental yet
     money OUT  airport, garage, carwash ...      -> db.expenses   (category = what you picked)
                rent                              -> db.expenses   (category Rent, replaces the standing rent for that month)
                fuel top-up                       -> db.fuelAccount (money to the station, not an expense)
                fuel fill                         -> db.expenses   (category Fuel, drawn from the station account)
                sub-hire driver / owner           -> the rental's status becomes Paid, with the date (the cost is already counted from the rental)
                loan                              -> the instalment's paid amount and date inside db.loans
                individual repaid                 -> db.individuals (- line)
                insurance                         -> db.insurance
                chama                             -> the slot is ticked paid, with the date
                allowance                         -> the rental's allowance and allowanceDate
                OCHWADA                           -> db.accounts   (a charge raises what he owes)
   The date is always saved on the record it lands in, and shown there.
   check() lists what is unclear; the screen turns each into a pop-up question; the answer goes into spec.ans and check() runs again. */
import { scheduleOf, paidOf, loanName, monthName } from './loans.js';
import { ownerRows, driverRows, setOwnerStatus, setDriverStatus, driverAmount, ownerStatus, driverStatus, STATUS_LABEL } from './subhireCore.js';

const num = v => Number(v) || 0;
const r2 = x => Math.round(x * 100) / 100;
const up = s => String(s == null ? '' : s).trim().toUpperCase();
const ymOf = d => String(d || '').slice(0, 7);
const money = n => 'KSh ' + Math.round(num(n)).toLocaleString('en-KE');

export const EXPENSE_TYPES = [['Airport', 'Airport fee'], ['Garage', 'Garage'], ['Cleaning', 'Carwash / cleaning'], ['Transport', 'Transport'], ['Maintenance', 'Maintenance'],
  ['Parking', 'Parking'], ['Salaries', 'Salaries'], ['Utilities', 'Utilities'], ['Bank Charges', 'Bank charges'], ['Other', 'Other expense']];
import { rentalForFill } from './fuelCore.js';
export const IN_CATS = [['rental', 'Rental (a client pays a rental)'], ['invoice', 'Invoice'], ['coop', 'Coop / contract'], ['client', 'Client (their unpaid rentals, oldest first)'],
  ['ochwada', 'OCHWADA / client statement'], ['individual', 'Loan: individual (lent to us / returned to us)'], ['other', 'Other money received (link it later)']];
export const OUT_CATS = EXPENSE_TYPES.map(([id, l]) => ['x:' + id, l]).concat([['rent', 'Rent'], ['fuel', 'Fuel'], ['driver', 'Sub-hire driver'], ['owner', 'Sub-hire car owner'],
  ['loan', 'Loan (instalment on a loan)'], ['individual', 'Loan: individual (LAWYER, WIN, SAM ...)'], ['insurance', 'Insurance'], ['allowance', 'Driver allowance'], ['ochwada', 'OCHWADA / client statement']]);

/* the payments list: the fixed categories plus any expense type added in Expenses (Edit types) */
export function outCats(db){
  const have = new Set(EXPENSE_TYPES.map(x => x[0].toLowerCase()).concat(['fuel', 'rent', 'other']));
  const custom = ((db && db.settings && db.settings.expenseTypes) || []).filter(n => n && !have.has(String(n).toLowerCase())).map(n => ['x:' + n, n]);
  return custom.length ? OUT_CATS.slice(0, EXPENSE_TYPES.length).concat(custom, OUT_CATS.slice(EXPENSE_TYPES.length)) : OUT_CATS;
}

/* ---------- looking things up ---------- */
const rentalById = (db, id) => (db.rentals || []).find(r => String(r.id) === String(id));
const vehicleReg = (db, id) => ((db.vehicles || []).find(v => String(v.id) === String(id)) || {}).reg || '';
const clientName = (db, id) => ((db.clients || []).find(c => String(c.id) === String(id)) || {}).name || '';
export const paidOn = (db, rid) => (db.payments || []).filter(p => String(p.rentalId) === String(rid)).reduce((s, p) => s + num(p.amount), 0);
export const owedOn = (db, r) => Math.max(0, num(r.amount) - paidOn(db, r.id));
const live = r => r.status !== 'Cancelled';
export const rentalLabel = (db, r) => `${vehicleReg(db, r.vehicleId) || '—'} · ${clientName(db, r.clientId) || '—'}${r.contract ? ' (' + r.contract + ')' : ''} · ${r.pickup || ''} · owed ${money(owedOn(db, r))}`;
export const unpaidRentals = (db, clientId) => (db.rentals || []).filter(r => live(r) && owedOn(db, r) > 0 && (!clientId || String(r.clientId) === String(clientId))).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? -1 : 1);
export const invoiceRentals = (db, no) => (db.rentals || []).filter(r => live(r) && r.invoice && String(r.invoice) === String(no)).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? -1 : 1);
export const invoiceOwed = (db, no) => invoiceRentals(db, no).reduce((s, r) => s + owedOn(db, r), 0);
export const coopRentals = (db, coop) => (db.rentals || []).filter(r => live(r) && (String(r.id) === String(coop.rentalId) || (coop.contract && String(r.contract) === String(coop.contract)))).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? -1 : 1);
export function peopleNames(db){ return [...new Set((db.individuals || []).map(x => x.person).filter(Boolean))]; }
export function unclearedDriverJobs(db, driverName){ return driverRows(db).filter(r => r.driver === driverName && r.status === 'notcleared'); }
export function unclearedOwnerJobs(db, ownerKey){ return ownerRows(db).filter(r => r.ownerKey === ownerKey && r.status === 'notcleared'); }
export function chamaSlots(db){ return (db.chama || []).filter(c => !c.paid).sort((a, b) => (a.dueDate || '') < (b.dueDate || '') ? -1 : 1); }
export function loanLeft(db, loanId, month){ const l = (db.loans || []).find(x => String(x.id) === String(loanId)); if(!l) return null; const s = scheduleOf(l).find(x => x.month === month); return s ? Math.max(0, num(s.amount) - paidOf(s)) : null; }

function allocate(rentals, db, amount){
  let left = r2(amount); const out = [];
  for(const r of rentals){ if(left <= 0) break; const o = owedOn(db, r); if(o <= 0) continue; const a = Math.min(o, left); out.push({ r, amt: r2(a) }); left = r2(left - a); }
  return { parts: out, left };
}
const similar = (a, b) => { a = up(a).replace(/\s+/g, ''); b = up(b).replace(/\s+/g, ''); return a && b && a !== b && (a.startsWith(b) || b.startsWith(a)); };

/* ---------- what is needed before anything is written ---------- */
export function validate(db, s){
  const need = t => t;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) return need('Choose the date of the payment');
  const y = Number(s.date.slice(0, 4)); if(y < 2015 || y > new Date().getFullYear() + 2) return 'That date does not look right. Check it.';
  if(!(num(s.amount) > 0)) return 'Type the amount (a positive number)';
  const c = s.cat;
  if(s.dir === 'in'){
    if(c === 'rental' && !rentalById(db, s.rentalId)) return 'Choose the rental';
    if(c === 'invoice' && !s.invoiceNo) return 'Choose the invoice';
    if(c === 'coop' && !s.coopId) return 'Choose the coop line';
    if(c === 'client' && !s.clientId) return 'Choose the client';
    if(c === 'individual' && !(s.person || '').trim()) return 'Choose or type the person';
    if(c === 'other' && !(s.note || '').trim()) return 'Say who paid in the note, so it can be linked later';
  } else {
    if(c === 'rent' && !/^\d{4}-\d{2}$/.test(s.month || '')) return 'Choose the month the rent is for';
    if(c === 'driver' && !(s.jobIds || []).length) return 'Tick the job(s) this payment is for';
    if(c === 'owner' && !(s.jobIds || []).length) return 'Tick the job(s) this payment is for';
    if(c === 'loan' && !(db.loans || []).some(l => String(l.id) === String(s.loanId))) return 'Choose the loan';
    if(c === 'loan' && !/^\d{4}-\d{2}$/.test(s.month || '')) return 'Choose the month of the instalment';
    if(c === 'insurance' && !s.vehicleId) return 'Choose the car';
    if(c === 'chama' && !(db.chama || []).some(x => String(x.id) === String(s.chamaId))) return 'Choose the chama slot';
    if(c === 'allowance' && !rentalById(db, s.rentalId)) return 'Choose the rental the allowance is for';
    if(c === 'individual' && !(s.person || '').trim()) return 'Choose or type the person';
  }
  return '';
}

/* ---------- the unclear things: the first one found is asked; its answer goes into spec.ans ---------- */
export function check(db, s){
  const ans = s.ans || {}, amount = num(s.amount), c = s.cat;
  const ask = (code, title, text, options) => ({ code, title, text, options });
  const dupKey = () => dupFind(db, s);
  /* ---- money in ---- */
  if(s.dir === 'in'){
    if(c === 'rental'){
      const r = rentalById(db, s.rentalId), o = owedOn(db, r);
      if(o <= 0 && !ans.over) return ask('paid-already', 'This rental is already fully paid', `${rentalLabel(db, r)}. This ${money(amount)} would be extra money.`, [{ label: 'Keep it as money received, not linked to a rental yet', ans: { over: 'advance' } }]);
      if(amount > o && o > 0 && !ans.over) return ask('over', 'More than the rental owes', `The rental owes ${money(o)} and you are recording ${money(amount)}. The extra ${money(amount - o)} could be an advance, a tip or a mistake.`,
        [{ label: `Pay the rental ${money(o)} and keep ${money(amount - o)} as money received, not linked`, ans: { over: 'advance' } }, { label: `Record only ${money(o)} on the rental`, ans: { over: 'cap' } }]);
    }
    if(c === 'invoice'){
      const rs = invoiceRentals(db, s.invoiceNo), o = invoiceOwed(db, s.invoiceNo);
      if(!rs.length && !ans.unlinkedInv) return ask('invoice-no-rentals', 'No rentals carry invoice ' + s.invoiceNo, 'The payment can still be kept against the invoice number and linked to rentals later.', [{ label: 'Keep it as money received for this invoice, not linked', ans: { unlinkedInv: true } }]);
      if(rs.length && amount !== o && !ans.invoiceAmt) return ask('invoice-amount', 'The amount is different from what the invoice still owes', `Invoice ${s.invoiceNo} still owes ${money(o)} over ${rs.length} rental(s) and you are recording ${money(amount)}.`,
        amount < o ? [{ label: 'Part payment: pay the oldest rentals on it first', ans: { invoiceAmt: 'oldest' } }] : [{ label: `Pay the invoice ${money(o)} and keep ${money(amount - o)} as money received, not linked`, ans: { invoiceAmt: 'oldest' } }, { label: `Record only ${money(o)}`, ans: { invoiceAmt: 'cap' } }]);
    }
    if(c === 'coop'){
      const coop = (db.coops || []).find(x => String(x.id) === String(s.coopId)), rs = coop ? coopRentals(db, coop) : [];
      if(!rs.length && !ans.coopLoose) return ask('coop-no-rental', 'This coop has no rental yet', `${coop ? coop.name : 'The coop'} is still "to complete" (no rental made from it). The money is not lost: it is kept as received and can be linked when the rental exists.`, [{ label: 'Keep it as money received for this coop, not linked yet', ans: { coopLoose: true } }]);
      const o = rs.reduce((t, r) => t + owedOn(db, r), 0);
      if(rs.length && amount > o && !ans.over) return ask('over', 'More than the coop rental owes', `It owes ${money(o)} and you are recording ${money(amount)}.`, [{ label: `Pay ${money(o)} and keep ${money(amount - o)} as money received, not linked`, ans: { over: 'advance' } }, { label: `Record only ${money(o)}`, ans: { over: 'cap' } }]);
      if(rs.length && rs.filter(r => owedOn(db, r) > 0).length > 1 && !ans.alloc) return ask('coop-several', 'Several rentals are owing on this contract', 'Which one does it pay?', [{ label: 'Oldest first', ans: { alloc: 'oldest' } }].concat(rs.filter(r => owedOn(db, r) > 0).slice(0, 8).map(r => ({ label: rentalLabel(db, r), ans: { alloc: String(r.id) } }))));
    }
    if(c === 'client'){
      const rs = unpaidRentals(db, s.clientId), o = rs.reduce((t, r) => t + owedOn(db, r), 0);
      if(!rs.length && !ans.over) return ask('client-nothing-owed', 'This client owes nothing', `${clientName(db, s.clientId)} has no unpaid rentals.`, [{ label: 'Keep it as money received (an advance), not linked', ans: { over: 'advance' } }]);
      if(rs.length > 1 && !ans.alloc) return ask('client-several', `${clientName(db, s.clientId)} has ${rs.length} unpaid rentals (${money(o)})`, 'Which should this payment go to?', [{ label: 'Oldest first (spread over as many as it covers)', ans: { alloc: 'oldest' } }].concat(rs.slice(0, 8).map(r => ({ label: rentalLabel(db, r), ans: { alloc: String(r.id) } }))));
      if(rs.length && amount > o && !ans.over) return ask('over', 'More than this client owes', `They owe ${money(o)} and you are recording ${money(amount)}.`, [{ label: `Pay ${money(o)} and keep ${money(amount - o)} as an advance, not linked`, ans: { over: 'advance' } }, { label: `Record only ${money(o)}`, ans: { over: 'cap' } }]);
    }
    if(c === 'individual'){
      const names = peopleNames(db), n = (s.person || '').trim();
      if(!names.some(x => up(x) === up(n))){ const near = names.find(x => similar(x, n));
        if(!ans.person) return ask('new-person', near ? `"${n}" looks like ${near}` : `"${n}" is a new person`, near ? 'Is it the same person?' : 'There is no one with that name yet.', (near ? [{ label: 'Yes, use ' + near, ans: { person: near } }] : []).concat([{ label: 'No, add ' + n + ' as a new person', ans: { person: n } }])); }
    }
  }
  /* ---- money out ---- */
  if(s.dir === 'out'){
    if(c.startsWith('x:') || c === 'fuel'){
      if(c === 'fuel' && !ans.fuelKind) return ask('fuel-kind', 'Fuel: which one is this?', 'Money paid to the fuel station, or fuel put into a car?', [{ label: 'Top-up: money paid into the station account (not an expense)', ans: { fuelKind: 'topup' } }, { label: 'Fill: fuel taken by a car (an expense, drawn from the station account)', ans: { fuelKind: 'fill' } }]);
      const isCar = c.startsWith('x:') && ['Airport', 'Garage', 'Cleaning', 'Maintenance', 'Parking'].includes(c.slice(2)) || (c === 'fuel' && ans.fuelKind === 'fill');
      if(isCar && !s.vehicleId && !ans.noCar) return ask('no-car', 'No car chosen', 'Is this a cost for the office, or did you forget the car?', [{ label: 'Office cost, no car', ans: { noCar: true } }]);
    }
    if(c === 'rent'){
      const se = (db.settings && db.settings.standingExpenses || []).find(x => x.category === 'Rent');
      if(se && se.fromMonth <= s.month && num(se.amount) !== amount && !ans.rentOk) return ask('rent-differs', 'The standing rent is different', `Standing rent is ${money(se.amount)} a month and this payment is ${money(amount)}. Recording it makes ${monthName(s.month)} use ${money(amount)}.`, [{ label: `Yes, ${monthName(s.month)} rent is ${money(amount)}`, ans: { rentOk: true } }]);
    }
    if(c === 'driver' || c === 'owner'){
      const rows = (c === 'driver' ? driverRows(db) : ownerRows(db)).filter(r => (s.jobIds || []).map(String).includes(String(r.id)));
      const total = rows.reduce((t, r) => t + (c === 'driver' ? r.amount : r.cost), 0);
      if(c === 'driver' && rows.some(r => !r.rate) && !ans.rate) return ask('no-rate', `${rows.filter(r => !r.rate).length} ticked job(s) have no amount per day`, 'The amount per day is typed on the Sub-hire driver sheet. What should I do?', [{ label: 'Work out the amount per day from this payment and save it on the job(s)', ans: { rate: 'fromPayment' } }]);
      if(c === 'owner' && rows.some(r => !r.cost) && !ans.rate) return ask('no-cost', `${rows.filter(r => !r.cost).length} ticked job(s) have no amount`, 'The amount for the owner is typed on the Sub-hire sheet.', [{ label: 'Save this payment as the amount of the job(s)', ans: { rate: 'fromPayment' } }]);
      if(!ans.rate && total > 0 && r2(total) !== r2(amount) && !ans.sum) return ask('sum-differs', 'The amount is different from the ticked jobs', `The ticked jobs add up to ${money(total)} and you are recording ${money(amount)}.`,
        [{ label: `Use ${money(total)} (the jobs)`, ans: { sum: 'jobs' } }, { label: `Mark the jobs paid and keep ${money(amount)} as the amount actually paid (note the difference)`, ans: { sum: 'paid' } }]);
    }
    if(c === 'loan'){
      const l = (db.loans || []).find(x => String(x.id) === String(s.loanId)), sch = scheduleOf(l), cell = sch.find(x => x.month === s.month);
      if(!cell && !ans.loanMonth) return ask('loan-no-month', `${loanName(l)} has no instalment in ${monthName(s.month)}`, 'Should I add the instalment to its schedule?', [{ label: `Add ${monthName(s.month)} with this amount`, ans: { loanMonth: 'add' } }].concat(sch.filter(x => paidOf(x) < num(x.amount)).slice(0, 1).map(x => ({ label: `Pay the earliest unpaid month instead (${monthName(x.month)})`, ans: { loanMonth: x.month } }))));
      if(cell){ const left = Math.max(0, num(cell.amount) - paidOf(cell));
        if(left <= 0 && !ans.loanOver) return ask('loan-paid', `${monthName(s.month)} is already fully paid on ${loanName(l)}`, 'The money has nowhere to go in that month.', [{ label: 'Put it on the next month(s) that are still unpaid', ans: { loanOver: 'next' } }]);
        if(amount > left && left > 0 && !ans.loanOver) return ask('loan-over', 'More than the instalment', `${monthName(s.month)} has ${money(left)} left and you are paying ${money(amount)}.`, [{ label: `Pay ${money(left)} and put the rest on the next unpaid month(s)`, ans: { loanOver: 'next' } }, { label: 'Keep everything on this month (it will show as more than due)', ans: { loanOver: 'keep' } }]);
        if(amount < left && !ans.loanPart) return ask('loan-part', 'Part payment', `${monthName(s.month)} has ${money(left)} left and you are paying ${money(amount)}.`, [{ label: `Yes, part payment (${money(left - amount)} stays due)`, ans: { loanPart: true } }]); }
    }
    if(c === 'insurance' && !s.expiryDate && !ans.noExpiry) return ask('no-expiry', 'No expiry date', 'The expiry date lets the app warn you before it runs out.', [{ label: 'Record it now and add the expiry date later (Pilot > Insurance)', ans: { noExpiry: true } }]);
    if(c === 'chama'){
      const slot = (db.chama || []).find(x => String(x.id) === String(s.chamaId));
      if(slot && num(slot.amount) !== amount && !ans.slotAmt) return ask('chama-amount', 'The amount is different from the slot', `${slot.scheme} ${slot.slot || slot.dueDate} is ${money(slot.amount)} and you are recording ${money(amount)}.`, [{ label: `Mark the slot paid with ${money(amount)}`, ans: { slotAmt: 'typed' } }, { label: `Mark the slot paid with ${money(slot.amount)}`, ans: { slotAmt: 'slot' } }]);
    }
    if(c === 'allowance'){
      const r = rentalById(db, s.rentalId);
      if(r && num(r.allowance) > 0 && num(r.allowance) !== amount && !ans.allow) return ask('allowance-has', 'This rental already has an allowance', `It has ${money(r.allowance)} and you are recording ${money(amount)}.`, [{ label: `Replace it with ${money(amount)}`, ans: { allow: 'replace' } }, { label: `Add them together (${money(num(r.allowance) + amount)})`, ans: { allow: 'add' } }]);
    }
    if(c === 'individual'){
      const names = peopleNames(db), n = (s.person || '').trim();
      if(!names.some(x => up(x) === up(n))){ const near = names.find(x => similar(x, n));
        if(!ans.person) return ask('new-person', near ? `"${n}" looks like ${near}` : `"${n}" is a new person`, near ? 'Is it the same person?' : 'There is no one with that name yet.', (near ? [{ label: 'Yes, use ' + near, ans: { person: near } }] : []).concat([{ label: 'No, add ' + n + ' as a new person', ans: { person: n } }])); }
    }
  }
  if(!ans.dup){ const d = dupKey(); if(d) return ask('duplicate', 'This looks like one already recorded', `${d.what} on ${d.date} for ${money(d.amount)} is already in the list.`, [{ label: 'Record it again, it is a different payment', ans: { dup: true } }]); }
  return null;
}

function dupFind(db, s){
  const c = s.cat, a = num(s.amount), d = s.date;
  const same = x => num(x.amount) === a && x.date === d;
  if(s.dir === 'in'){
    if(c === 'rental'){ const p = (db.payments || []).find(x => String(x.rentalId) === String(s.rentalId) && same(x)); if(p) return { what: 'A payment on this rental', date: d, amount: a }; }
    else if(c === 'invoice'){ const p = (db.payments || []).find(x => String(x.invoiceNo) === String(s.invoiceNo) && same(x)); if(p) return { what: 'A payment on invoice ' + s.invoiceNo, date: d, amount: a }; }
    else if(c === 'ochwada'){ const p = (db.accounts || []).find(x => x.account === 'OCHWADA' && x.kind === 'payment' && x.date === d && Math.abs(num(x.amount)) === a); if(p) return { what: 'An OCHWADA payment', date: d, amount: a }; }
    else if(c === 'other'){ const p = (db.payments || []).find(x => !x.rentalId && same(x)); if(p) return { what: 'Money received, not linked', date: d, amount: a }; }
  } else {
    if(c.startsWith('x:') || c === 'rent' || (c === 'fuel' && s.ans && s.ans.fuelKind === 'fill')){
      const cat = c === 'rent' ? 'Rent' : c === 'fuel' ? 'Fuel' : c.slice(2);
      const p = (db.expenses || []).find(x => x.category === cat && same(x) && String(x.vehicleId || '') === String(s.vehicleId || '')); if(p) return { what: cat + ' expense', date: d, amount: a };
    } else if(c === 'fuel'){ const p = (db.fuelAccount || []).find(x => x.kind !== 'opening' && same(x)); if(p) return { what: 'A fuel top-up', date: d, amount: a }; }
    else if(c === 'insurance'){ const p = (db.insurance || []).find(x => String(x.vehicleId) === String(s.vehicleId) && num(x.amount) === a && x.paidDate === d); if(p) return { what: 'An insurance payment', date: d, amount: a }; }
    else if(c === 'ochwada'){ const p = (db.accounts || []).find(x => x.account === 'OCHWADA' && x.kind === 'charge' && x.date === d && num(x.amount) === a); if(p) return { what: 'An OCHWADA charge', date: d, amount: a }; }
  }
  return null;
}

/* ---------- writing ---------- */
export function post(db, s, uid){
  const ans = s.ans || {}, amount = r2(num(s.amount)), c = s.cat, date = s.date, note = (s.note || '').trim(), method = s.method || 'Cash';
  const result = (text, ref, extra) => Object.assign({ ok: true, text, ref }, extra || {});
  const addPayment = (rid, amt, extraNote, invoiceNo) => { const p = { id: uid(), rentalId: rid ? (Number(rid) || rid) : '', date, amount: amt, method, note: [note, extraNote].filter(Boolean).join(' · '), xlRef: '', source: 'Payments screen', invoiceNo: invoiceNo || '', linkKind: 'manual' }; (db.payments = db.payments || []).push(p); return p; };
  const spread = (rentals, total, invNo) => {
    const al = allocate(rentals, db, total); al.parts.forEach(({ r, amt }) => addPayment(r.id, amt, '', invNo || r.invoice || ''));
    return al;
  };
  const finishLeft = (al, label) => { if(al.left > 0 && ans.over !== 'cap' && ans.invoiceAmt !== 'cap'){ addPayment('', al.left, label); } };
  if(s.dir === 'in'){
    if(c === 'rental'){
      const r = rentalById(db, s.rentalId), o = owedOn(db, r);
      const onRental = ans.over === 'cap' ? Math.min(amount, o) : Math.min(amount, o);
      if(onRental > 0) addPayment(r.id, onRental, '', r.invoice || '');
      if(amount > o && ans.over === 'advance') addPayment('', r2(amount - o), 'extra on ' + vehicleReg(db, r.vehicleId) + ' ' + (r.contract || ''));
      const left = owedOn(db, r);
      return result(`${vehicleReg(db, r.vehicleId)} rental ${left <= 0 ? 'is now Paid' : 'still owes ' + money(left)}`, { panel: 'rentals', id: r.id });
    }
    if(c === 'invoice'){
      const rs = invoiceRentals(db, s.invoiceNo);
      if(!rs.length){ addPayment('', amount, 'invoice ' + s.invoiceNo, s.invoiceNo); return result('Kept for invoice ' + s.invoiceNo + ', not linked to rentals', { panel: 'payments' }); }
      const al = spread(rs, ans.invoiceAmt === 'cap' ? Math.min(amount, invoiceOwed(db, s.invoiceNo)) : amount, s.invoiceNo); finishLeft(al, 'extra on invoice ' + s.invoiceNo);
      return result(`Invoice ${s.invoiceNo}: ${invoiceOwed(db, s.invoiceNo) <= 0 ? 'fully paid' : 'still owes ' + money(invoiceOwed(db, s.invoiceNo))}`, { panel: 'pilot', tab: 'pages', page: 'invoices' });
    }
    if(c === 'coop'){
      const coop = (db.coops || []).find(x => String(x.id) === String(s.coopId)), rs = coopRentals(db, coop);
      if(!rs.length){ addPayment('', amount, 'coop ' + coop.name + (coop.contract ? ' ' + coop.contract : '')); return result('Kept for coop ' + coop.name + ' until its rental is made', { panel: 'coop', id: coop.id }); }
      let list = rs; if(ans.alloc && ans.alloc !== 'oldest'){ const first = rs.filter(r => String(r.id) === ans.alloc); list = first.concat(rs.filter(r => String(r.id) !== ans.alloc)); }
      const al = spread(list, ans.over === 'cap' ? Math.min(amount, rs.reduce((t, r) => t + owedOn(db, r), 0)) : amount); finishLeft(al, 'extra on coop ' + coop.name);
      return result(`Coop ${coop.name}: ${rs.reduce((t, r) => t + owedOn(db, r), 0) <= 0 ? 'fully paid' : 'still owes ' + money(rs.reduce((t, r) => t + owedOn(db, r), 0))}`, { panel: 'coop', id: coop.id });
    }
    if(c === 'client'){
      let rs = unpaidRentals(db, s.clientId);
      if(!rs.length){ addPayment('', amount, 'advance from ' + clientName(db, s.clientId)); return result('Kept as an advance from ' + clientName(db, s.clientId), { panel: 'payments' }); }
      if(ans.alloc && ans.alloc !== 'oldest') rs = rs.filter(r => String(r.id) === ans.alloc).concat(rs.filter(r => String(r.id) !== ans.alloc));
      const tot = rs.reduce((t, r) => t + owedOn(db, r), 0);
      const al = spread(rs, ans.over === 'cap' ? Math.min(amount, tot) : amount); finishLeft(al, 'extra from ' + clientName(db, s.clientId));
      return result(`${clientName(db, s.clientId)} now owes ${money(unpaidRentals(db, s.clientId).reduce((t, r) => t + owedOn(db, r), 0))}`, { panel: 'payments' });
    }
    if(c === 'ochwada'){ (db.accounts = db.accounts || []).push({ id: uid(), account: 'OCHWADA', month: ymOf(date), date, kind: 'payment', amount: -amount, label: note || 'Payment received', note: method, xlRef: '' }); return result('OCHWADA statement: payment of ' + money(amount) + ' taken off his balance', { panel: 'pilot', tab: 'ochwada' }); }
    if(c === 'individual'){ const n = (ans.person || s.person).trim(); (db.individuals = db.individuals || []).push({ id: uid(), person: n, date, amount, note: note || 'Received', order: (db.individuals || []).reduce((m, x) => Math.max(m, num(x.order)), 0) + 1, xlRef: '' }); return result(`${n}: +${money(amount)} added to their balance`, { panel: 'pilot', tab: 'loans' }); }
    if(c === 'other'){ addPayment('', amount); return result('Money received kept, not linked to a rental yet', { panel: 'payments' }); }
  } else {
    const expense = (cat, vehicleId, desc, extra) => { const x = Object.assign({ id: uid(), vehicleId: vehicleId ? (Number(vehicleId) || vehicleId) : '', date, category: cat, desc: desc || note, qty: 1, amount, billable: false, billClientId: '', chargeAmount: 0, source: 'Payments screen', rentalId: '', xlRef: '' }, extra || {}); (db.expenses = db.expenses || []).push(x); return x; };
    if(c.startsWith('x:')){ const cat = c.slice(2), x = expense(cat, s.vehicleId, s.desc || note); return result(`${cat} ${money(amount)} recorded${s.vehicleId ? ' on ' + vehicleReg(db, s.vehicleId) : ' (office)'}`, { panel: 'expenses', id: x.id }); }
    if(c === 'rent'){ const x = expense('Rent', '', 'Rent ' + monthName(s.month) + (note ? ' · ' + note : '')); return result(`Rent for ${monthName(s.month)}: ${money(amount)}`, { panel: 'expenses', id: x.id }); }
    if(c === 'fuel'){
      if(ans.fuelKind === 'topup'){ (db.fuelAccount = db.fuelAccount || []).push({ id: uid(), date, kind: 'topup', amount, note: note || 'Top-up', xlRef: '' }); return result('Fuel account: ' + money(amount) + ' paid to the station', { panel: 'pilot', tab: 'pages', page: 'fuel' }); }
      const rid = s.rentalId || (s.vehicleId ? rentalForFill(db, s.vehicleId, date) : ''); const x = expense('Fuel', s.vehicleId, s.desc || note, { account: s.account === 'Outside' ? 'Outside' : 'Ola', rentalId: rid || null, source: 'fuel' }); return result(`Fuel ${money(amount)} taken${s.vehicleId ? ' by ' + vehicleReg(db, s.vehicleId) : ''}`, { panel: 'expenses', id: x.id });
    }
    if(c === 'driver' || c === 'owner'){
      const ids = (s.jobIds || []).map(String), rows = ids.map(id => rentalById(db, id)).filter(Boolean);
      if(ans.rate === 'fromPayment'){   // spread the typed amount over the jobs by days
        const days = rows.reduce((t, r) => t + num(r.days), 0) || rows.length;
        rows.forEach(r => { if(c === 'driver'){ if(!num(r.driverRate)) r.driverRate = r2(amount / days); } else if(!num(r.subhireCost)) r.subhireCost = r2(amount * (num(r.days) || 1) / days); });
      }
      rows.forEach(r => { if(c === 'driver') setDriverStatus(r, 'paid', date); else setOwnerStatus(r, 'paid', date); });
      const names = rows.length + ' job' + (rows.length === 1 ? '' : 's');
      return result(`${names} marked Paid on ${date}`, { panel: 'pilot', tab: 'pages', page: c === 'driver' ? 'subhireDriver' : 'subhire' }, { note: ans.sum === 'paid' ? 'amount actually paid ' + money(amount) : '' });
    }
    if(c === 'loan'){
      const l = (db.loans || []).find(x => String(x.id) === String(s.loanId)); let sch = scheduleOf(l), month = ans.loanMonth && ans.loanMonth !== 'add' ? ans.loanMonth : s.month;
      if(!sch.find(x => x.month === month)) sch.push({ month, amount, paid: false });
      sch.sort((a, b) => a.month < b.month ? -1 : 1);
      let left = amount; const apply = cell => { const room = Math.max(0, num(cell.amount) - paidOf(cell)); const put = Math.min(room, left); if(put > 0){ cell.paidAmount = r2(paidOf(cell) + put); cell.paid = cell.paidAmount >= num(cell.amount); cell.paidDate = date; left = r2(left - put); } };
      const first = sch.find(x => x.month === month); apply(first);
      if(left > 0 && ans.loanOver === 'next') sch.filter(x => x.month > month).forEach(x => { if(left > 0) apply(x); });
      if(left > 0){ first.amount = r2(num(first.amount) + left); first.paidAmount = first.amount; first.paidDate = date; first.paid = true; left = 0; }   // more than due: the instalment becomes what was paid
      l.schedule = JSON.stringify(sch); const pd = sch.filter(x => paidOf(x) >= num(x.amount) && num(x.amount) > 0); l.paidThrough = pd.length ? pd[pd.length - 1].month : '';
      return result(`${loanName(l)}: ${money(amount)} paid on ${date}`, { panel: 'pilot', tab: 'loans' });
    }
    if(c === 'individual'){ const n = (ans.person || s.person).trim(); (db.individuals = db.individuals || []).push({ id: uid(), person: n, date, amount: -amount, note: note || 'Paid', order: (db.individuals || []).reduce((m, x) => Math.max(m, num(x.order)), 0) + 1, xlRef: '' }); return result(`${n}: ${money(amount)} paid, balance goes down`, { panel: 'pilot', tab: 'loans' }); }
    if(c === 'insurance'){ (db.insurance = db.insurance || []).push({ id: uid(), vehicleId: Number(s.vehicleId) || s.vehicleId, kind: '', amount, paidDate: date, expiryDate: s.expiryDate || '', note, xlRef: '' }); return result(`Insurance for ${vehicleReg(db, s.vehicleId)} ${money(amount)}`, { panel: 'pilot', tab: 'insurance' }); }
    if(c === 'chama'){ const slot = (db.chama || []).find(x => String(x.id) === String(s.chamaId)); slot.paid = true; slot.paidDate = date; if(ans.slotAmt === 'typed') slot.amount = amount; if(note) slot.note = note; return result(`${slot.scheme} ${slot.slot || slot.dueDate} ticked paid on ${date}`, { panel: 'pilot', tab: 'chama' }); }
    if(c === 'allowance'){ const r = rentalById(db, s.rentalId); r.allowance = ans.allow === 'add' ? r2(num(r.allowance) + amount) : amount; r.allowanceDate = date; return result(`Allowance on ${vehicleReg(db, r.vehicleId)}: ${money(r.allowance)}`, { panel: 'rentals', id: r.id }); }
    if(c === 'ochwada'){ (db.accounts = db.accounts || []).push({ id: uid(), account: 'OCHWADA', month: ymOf(date), date, kind: 'charge', amount, label: note || 'Paid for him', note: method, xlRef: '' }); return result('OCHWADA statement: ' + money(amount) + ' added to what he owes', { panel: 'pilot', tab: 'ochwada' }); }
  }
  return { ok: false, text: 'Nothing was recorded' };
}

/* ---------- the one list ---------- */
export function unified(db){
  const rows = []; const add = o => rows.push(Object.assign({ memo: false, sortKey: o.date || (o.month ? o.month + '-15' : ''), month: o.month || ymOf(o.date) }, o));
  const rentals = new Map((db.rentals || []).map(r => [String(r.id), r]));
  (db.payments || []).forEach(p => { const r = rentals.get(String(p.rentalId)); add({ key: 'pay:' + p.id, kind: 'payment', id: p.id, dir: 'in', cat: r ? 'Rental' : 'Not linked', date: p.date, amount: num(p.amount),
    who: r ? clientName(db, r.clientId) : '', detail: r ? [vehicleReg(db, r.vehicleId), r.contract].filter(Boolean).join(' · ') : (p.note || ''), note: p.note || '', method: p.method || '', status: r ? (owedOn(db, r) <= 0 ? 'Paid' : 'Owes ' + money(owedOn(db, r))) : 'not linked', open: r ? { panel: 'rentals', id: r.id } : { panel: 'payments' }, source: p.source || '' }); });
  (db.accounts || []).filter(a => a.account === 'OCHWADA' && (a.kind === 'payment' || a.kind === 'charge') && num(a.amount) !== 0).forEach(a => add({ key: 'acc:' + a.id, kind: 'account', id: a.id, dir: a.kind === 'payment' ? 'in' : 'out', cat: 'OCHWADA', date: a.date, amount: Math.abs(num(a.amount)), who: 'OCHWADA', detail: a.label || '', note: a.note || '', open: { panel: 'pilot', tab: 'ochwada' } }));
  (db.individuals || []).filter(x => x.date && num(x.amount) !== 0).forEach(x => add({ key: 'ind:' + x.id, kind: 'individual', id: x.id, dir: num(x.amount) > 0 ? 'in' : 'out', cat: 'Individual', date: x.date, amount: Math.abs(num(x.amount)), who: x.person, detail: x.note || '', open: { panel: 'pilot', tab: 'loans' } }));
  (db.expenses || []).forEach(x => { const fill = x.category === 'Fuel'; add({ key: 'exp:' + x.id, kind: 'expense', id: x.id, dir: 'out', cat: fill ? 'Fuel (taken)' : x.category, date: x.date, amount: num(x.amount), who: vehicleReg(db, x.vehicleId) || 'Office', detail: x.desc || '', memo: fill,
    status: fill ? 'from station account' : '', open: { panel: 'expenses', id: x.id } }); });
  (db.fuelAccount || []).filter(f => f.kind !== 'opening').forEach(f => add({ key: 'fua:' + f.id, kind: 'fuelAccount', id: f.id, dir: 'out', cat: 'Fuel top-up', date: f.date, amount: num(f.amount), who: 'Fuel station', detail: f.note || '', open: { panel: 'pilot', tab: 'pages', page: 'fuel', month: ymOf(f.date) } }));
  (db.loans || []).forEach(l => scheduleOf(l).forEach(s => { if(paidOf(s) > 0) add({ key: 'loan:' + l.id + ':' + s.month, kind: 'loan', id: l.id, month2: s.month, dir: 'out', cat: 'Loan', date: s.paidDate || '', month: s.paidDate ? ymOf(s.paidDate) : s.month, sortKey: s.paidDate || s.month + '-15', amount: paidOf(s), who: loanName(l), detail: monthName(s.month) + ' instalment', status: paidOf(s) >= num(s.amount) ? 'Paid' : 'Part paid', open: { panel: 'pilot', tab: 'loans' } }); }));
  (db.insurance || []).forEach(i => add({ key: 'ins:' + i.id, kind: 'insurance', id: i.id, dir: 'out', cat: 'Insurance', date: i.paidDate || '', amount: num(i.amount), who: vehicleReg(db, i.vehicleId), detail: i.expiryDate ? 'expires ' + i.expiryDate : '', open: { panel: 'pilot', tab: 'insurance' } }));
  driverRows(db).filter(r => r.status === 'paid').forEach(r => add({ key: 'drv:' + r.id, kind: 'driver', id: r.id, dir: 'out', cat: 'Sub-hire driver', date: r.statusDate || '', month: ymOf(r.statusDate || r.pickup), sortKey: r.statusDate || r.pickup, amount: r.amount, who: r.driver, detail: [r.reg, r.client, r.dates].filter(Boolean).join(' · '), status: 'Paid', open: { panel: 'pilot', tab: 'pages', page: 'subhireDriver' } }));
  ownerRows(db).filter(r => r.status === 'paid').forEach(r => add({ key: 'own:' + r.id, kind: 'owner', id: r.id, dir: 'out', cat: 'Sub-hire owner', date: r.statusDate || '', month: ymOf(r.statusDate || r.pickup), sortKey: r.statusDate || r.pickup, amount: r.cost, who: r.owner, detail: [r.reg, r.job, r.dates].filter(Boolean).join(' · '), status: 'Paid', open: { panel: 'pilot', tab: 'pages', page: 'subhire' } }));
  (db.rentals || []).filter(r => live(r) && num(r.allowance) > 0).forEach(r => add({ key: 'alw:' + r.id, kind: 'allowance', id: r.id, dir: 'out', cat: 'Driver allowance', date: r.allowanceDate || '', month: ymOf(r.allowanceDate || r.pickup), sortKey: r.allowanceDate || r.pickup, amount: num(r.allowance), who: ((db.drivers || []).find(d => String(d.id) === String(r.driverId)) || {}).name || '', detail: [vehicleReg(db, r.vehicleId), clientName(db, r.clientId)].filter(Boolean).join(' · '), open: { panel: 'rentals', id: r.id } }));
  return rows.sort((a, b) => a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0);
}

/* undo: take one line back out, restoring what it changed */
export function removeEntry(db, row){
  const id = String(row.id);
  switch(row.kind){
    case 'payment': db.payments = db.payments.filter(p => String(p.id) !== id); return true;
    case 'account': db.accounts = db.accounts.filter(a => String(a.id) !== id); return true;
    case 'individual': db.individuals = db.individuals.filter(a => String(a.id) !== id); return true;
    case 'expense': db.expenses = db.expenses.filter(a => String(a.id) !== id); return true;
    case 'fuelAccount': db.fuelAccount = db.fuelAccount.filter(a => String(a.id) !== id); return true;
    case 'insurance': db.insurance = db.insurance.filter(a => String(a.id) !== id); return true;
    case 'chama': { const c = db.chama.find(x => String(x.id) === id); if(c){ c.paid = false; c.paidDate = ''; } return !!c; }
    case 'loan': { const l = db.loans.find(x => String(x.id) === id); if(!l) return false; const sch = scheduleOf(l), s = sch.find(x => x.month === row.month2); if(!s) return false; delete s.paidAmount; delete s.paidDate; s.paid = false; l.schedule = JSON.stringify(sch); const pd = sch.filter(x => paidOf(x) >= num(x.amount) && num(x.amount) > 0); l.paidThrough = pd.length ? pd[pd.length - 1].month : ''; return true; }
    case 'driver': { const r = (db.rentals || []).find(x => String(x.id) === id); if(!r) return false; setDriverStatus(r, 'notcleared', ''); return true; }
    case 'owner': { const r = (db.rentals || []).find(x => String(x.id) === id); if(!r) return false; setOwnerStatus(r, 'notcleared', ''); return true; }
    case 'allowance': { const r = (db.rentals || []).find(x => String(x.id) === id); if(!r) return false; r.allowance = 0; r.allowanceDate = ''; return true; }
  }
  return false;
}
export { money, STATUS_LABEL };
