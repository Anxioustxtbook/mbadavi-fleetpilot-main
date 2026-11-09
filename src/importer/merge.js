/* Put the importer's clean data (analyze().data) into the app database.
   Safe to run again: every imported rental and expense carries xlRef ("CAR PERFORMANCE!R15"), and a
   record whose xlRef is already in the database is skipped, never added twice. Vehicles, clients, drivers and
   coops are matched by name or registration, so the same one is never created twice. */
import { duration } from '../billing.js';
import { markImported, isEdited } from '../importMarks.js';

const up = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
const CAT = { Fuel: 'Fuel', Carwash: 'Cleaning', Transport: 'Transport', Garage: 'Garage', Airport: 'Airport', Other: 'Other', 'Sub-hire driver': 'Sub-hire driver', Rent: 'Rent' };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function mergeImport(db, res, opts = {}){
  const today = opts.today || res.today || new Date().toISOString().slice(0, 10);
  const data = res.data;
  const log = { added: {}, skipped: {}, unmatchedAllowances: [], notes: [] };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let nextId = Math.max(db.nextId || 1, 1);
  const startId = nextId;                       // a record with an id from here up was added by this import
  const newId = () => nextId++;
  /* a record a person has edited is never changed or removed by an import (a record added by this very import is not "edited") */
  const editedByUser = (list, r) => !(Number(r.id) >= startId) && isEdited(db, list, r);
  ['vehicles', 'drivers', 'clients', 'rentals', 'expenses', 'payments', 'invoices', 'accounts', 'loans', 'insurance', 'chama', 'fuelAccount', 'coops', 'individuals'].forEach(k => { if(!Array.isArray(db[k])) db[k] = []; });

  /* vehicles, matched by registration */
  const vByReg = new Map(db.vehicles.map(v => [up(v.reg), v]));
  const vehicleFor = reg => {
    const k = up(reg); if(!k) return null;
    if(vByReg.has(k)) return vByReg.get(k);
    const v = { id: newId(), reg: k, make: '', model: '', year: '', rate: 0, owner: '', status: 'Available', billMode: 'auto', billHours: 12, hourRate: 0, ownership: 'own', ownerCost: 0 };
    db.vehicles.push(v); vByReg.set(k, v); bump(log.added, 'vehicles'); return v;
  };
  (data.vehicles || []).forEach(x => {
    const known = vByReg.has(up(x.reg));
    const v = vehicleFor(x.reg);
    if(!v) return;
    if(!known){   // fill a newly created vehicle from the sheets; an existing one keeps what the user typed
      v.rate = x.rate || 0; v.owner = x.owner || ''; v.model = x.model || '';
      v.ownership = x.ownership === 'subhire' || x.ownership === 'other' ? 'subhire' : 'own';
      v.ownerCost = x.dailyCost || 0;
    }
  });

  /* clients, drivers, coops */
  const cByName = new Map(db.clients.map(c => [up(c.name), c]));
  const clientFor = (name, type) => {
    const k = up(name); if(!k) return null;
    if(cByName.has(k)){ const c = cByName.get(k); if(!c.type) c.type = type || 'walkin'; return c; }
    const c = { id: newId(), name: k, phone: '', idnum: '', dl: '', type: type || 'walkin', area: '', usualReg: '', driverName: '', driverPhone: '' };
    db.clients.push(c); cByName.set(k, c); bump(log.added, 'clients'); return c;
  };
  const dByName = new Map(db.drivers.map(d => [up(d.name), d]));
  const driverFor = (name, reg) => {
    const k = up(name); if(!k || k === 'SELF') return null;
    if(dByName.has(k)) return dByName.get(k);
    const v = reg ? vByReg.get(up(reg)) : null;
    const d = { id: newId(), name: k, phone: '', license: '', vehicleId: v ? v.id : '', allowance: 0, status: 'Active', kind: 'own' }; db.drivers.push(d); dByName.set(k, d); bump(log.added, 'drivers'); return d;
  };
  (data.drivers || []).forEach(x => { const d = driverFor(x.name, x.reg); if(d && x.phone && !d.phone) d.phone = String(x.phone); });
  /* Sheet2 walk-in client table: name, phone, area, usual car, driver */
  (data.walkins || []).forEach(w => {
    const c = clientFor(w.name, 'walkin');
    if(!c.phone) c.phone = w.phone; if(!c.area) c.area = w.area; if(!c.usualReg) c.usualReg = w.reg;
    if(!c.driverName) c.driverName = w.driverName; if(!c.driverPhone) c.driverPhone = w.driverPhone;
  });

  /* rentals */
  const haveRef = new Set(db.rentals.map(r => r.xlRef).filter(Boolean));
  const added = [];
  (data.rentals || []).forEach(x => {
    if(x.excluded) return;
    const ref = 'CAR PERFORMANCE!' + x.key;
    if(haveRef.has(ref)){ bump(log.skipped, 'rentals'); return; }
    const v = vehicleFor(x.reg);
    const isCoop = up(x.client) === 'COOP';
    const ctype = x.type === 'taxi' ? 'taxi' : (isCoop ? 'coop' : (up(x.driver) === 'SELF' ? 'self' : 'walkin'));   // SELF in the DRIVER column = the client drives
    const who = isCoop ? (x.coopName ? clientFor(x.coopName, 'coop') : null) : clientFor(x.client, ctype);
    const r = {
      id: newId(), vehicleId: v ? v.id : '', clientId: who ? who.id : '',
      contract: x.contract || '', invoice: '', receipt: '', pickup: x.pickup || '', pickupTime: x.pickupTime || '', return: x.return || '', returnTime: x.returnTime || '',
      rate: x.rate || 0, days: x.days || 0, mileage: x.mileage || 0, amount: x.amount || 0,
      status: (x.return && x.return < today) ? 'Completed' : 'Active',
      fuel: x.fuel || 0, fuelCharge: 0,                                   // fuel is a cost the owner carried, not charged on top
      type: ctype,
      driverId: (driverFor(x.driver, x.reg) || {}).id || null,
      billMode: '', hours: null, allowance: 0,
      subhireCost: x.subhireCost || 0, subhirePaid: !!x.subhirePaid, subhirePaidDate: x.subhirePaidDate || '',
      paid: false, paidDate: '', xlRef: ref, notes: ''
    };
    const d = duration(r); if(d.ok) r.hours = d.hours;
    if(isCoop && !who) bump(log.skipped, 'coopNoName');
    if(v && r.status === 'Active') v.status = 'Rented';
    db.rentals.push(r); added.push(r); haveRef.add(ref); bump(log.added, 'rentals');
  });

  /* SELF-drive: rentals imported earlier as walk-in whose DRIVER cell says SELF become "self"; a client whose rentals are all self becomes a self-drive client */
  const selfKeys = new Set((data.rentals || []).filter(x => !x.excluded && up(x.driver) === 'SELF' && x.type !== 'taxi' && up(x.client) !== 'COOP').map(x => 'CAR PERFORMANCE!' + x.key));
  let retyped = 0;
  db.rentals.forEach(r => { if(r.type === 'walkin' && !r.driverId && selfKeys.has(r.xlRef)){ if(editedByUser('rentals', r)){ bump(log.skipped, 'editedKept'); return; } r.type = 'self'; retyped++; } });
  if(retyped) log.added.retypedSelf = retyped;
  db.clients.forEach(c => { if((c.type || 'walkin') !== 'walkin') return; const mine = db.rentals.filter(r => r.clientId === c.id); if(mine.length && mine.every(r => r.type === 'self')) c.type = 'self'; });

  /* SUBHIRE DRIVER lines tied to rentals: the rental carries amount per day, status and date. Never overwrites what was already typed on the rental. */
  const rentalByXl = new Map(db.rentals.map(r => [r.xlRef, r]));
  const movedLines = new Set(), perDriver = new Map();
  (data.driverJobs || []).forEach(j => {
    const r = rentalByXl.get('CAR PERFORMANCE!' + j.rentalKey); if(!r){ return; }
    movedLines.add('SUBHIRE DRIVER!' + j.line);
    if(!r.driverRate && !r.driverStatus){ r.driverRate = j.rate; r.driverStatus = j.status; r.driverStatusDate = j.statusDate || ''; bump(log.added, 'driverJobs'); }
    else bump(log.skipped, 'driverJobs');
    perDriver.set(j.driver, (perDriver.get(j.driver) || 0) + 1);
  });
  perDriver.forEach((n, name) => { const d = dByName.get(name); if(d && n >= 3 && d.kind !== 'subhire'){ d.kind = 'subhire'; bump(log.added, 'subhireDrivers'); } });
  if(movedLines.size){ const before = db.expenses.length; let kept = 0;
    db.expenses = db.expenses.filter(x => { if(!movedLines.has(x.xlRef)) return true; if(editedByUser('expenses', x)){ kept++; return true; } return false; });
    if(before !== db.expenses.length) log.added.driverCostsMoved = before - db.expenses.length;
    if(kept){ log.skipped.editedKept = (log.skipped.editedKept || 0) + kept; log.notes.push(kept + ' expense line' + (kept > 1 ? 's' : '') + ' you edited were kept, although the same driver job is now on its rental. Check them so a cost is not counted twice.'); } }

  /* COOP sheet: one line per hire with every column the sheet has. Linked to its rental when the importer matched one;
     a line with no rental yet stays "todo" (to complete in Rentals). Same coop line is never added twice. */
  const rentalByHire = new Map();
  (data.rentals || []).forEach(x => { if(x.coopHire){ const r = db.rentals.find(y => y.xlRef === 'CAR PERFORMANCE!' + x.key); if(r) rentalByHire.set(x.coopHire, r); } });
  const haveCo = new Set(db.coops.map(c => c.xlRef).filter(Boolean));
  (data.coopHires || []).forEach(h => {
    const ref = 'COOP!' + h.key; if(haveCo.has(ref)){ bump(log.skipped, 'coops'); return; }
    const r = rentalByHire.get(h.key), who = clientFor(h.name, 'coop');
    db.coops.push({ id: newId(), name: h.name, clientId: who ? who.id : '', start: h.start || '', end: h.end || '', days: h.days || 0, amount: h.amount || 0, driverPay: h.driverPay || 0, allowance: h.allowance || 0,
      fuel: h.fuel || 0, contract: h.contract || '', department: h.department || '', kmOut: h.kmOut || 0, kmIn: h.kmIn || 0, withVat: h.withVat || 0, note: h.note || '',
      rentalId: r ? r.id : '', status: r ? 'done' : 'todo', xlRef: ref });
    haveCo.add(ref); bump(log.added, 'coops');
  });

  /* LOAN sheet, individuals table (LAWYER, WIN, SAM ...): every line, in the sheet's order */
  const haveInd = new Set(db.individuals.map(x => x.xlRef).filter(Boolean));
  let indOrder = db.individuals.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0);
  (data.individuals || []).forEach(p => p.lines.forEach((l, i) => {
    const ref = 'LOAN!' + l.key; if(haveInd.has(ref)){ bump(log.skipped, 'individuals'); return; }
    db.individuals.push({ id: newId(), person: p.name, date: '', amount: l.amount, note: i === 0 ? 'Opening' : '', order: ++indOrder, xlRef: ref });
    haveInd.add(ref); bump(log.added, 'individuals');
  }));

  /* allowances belong to the rental: same driver, date inside the hire (a day either side), same client preferred */
  const dayOf = (r, d) => d >= r.pickup && d <= addDays(r.return || r.pickup, 1);
  const driverName = id => { const d = db.drivers.find(x => x.id === id); return d ? up(d.name) : ''; };
  const clientName = id => { const c = db.clients.find(x => x.id === id); return c ? up(c.name) : (id === null ? 'COOP' : ''); };
  (data.allowances || []).forEach(a => {
    if(a.excluded) return;
    const ref = 'ALLOWANCE!' + a.key;
    if(db.rentals.some(r => (r.allowanceRefs || '').split(',').includes(ref))){ bump(log.skipped, 'allowances'); return; }
    const dn = up(a.driver), cn = up(a.client);
    const cands = added.concat(db.rentals.filter(r => !added.includes(r))).filter(r => r.pickup && dayOf(r, a.date) && driverName(r.driverId) === dn);
    const best = cands.find(r => (r.type === 'coop' ? 'COOP' : clientName(r.clientId)) === cn) || cands[0];
    if(best){ best.allowance = (best.allowance || 0) + (a.amount || 0); best.allowanceRefs = ((best.allowanceRefs || '') + ',' + ref).replace(/^,/, ''); bump(log.added, 'allowances'); }
    else log.unmatchedAllowances.push({ key: a.key, row: a.xlRow, driver: a.driver, client: a.client, date: a.date, amount: a.amount });
  });

  /* expenses (fuel, carwash, transport, garage, airport fee, sub-hire driver, other) */
  const haveX = new Set(db.expenses.map(x => x.xlRef).filter(Boolean));
  (data.expenses || []).forEach(x => {
    if(x.excluded) return;
    const ref = x.sheet + '!' + x.key;
    if(movedLines.has(ref)) return;                                  // a sub-hire driver line now held by its rental
    if(haveX.has(ref)){ bump(log.skipped, 'expenses'); return; }
    const v = vehicleFor(x.reg);
    db.expenses.push({ id: newId(), vehicleId: v ? v.id : '', date: x.date || '', category: CAT[x.category] || 'Other', desc: x.desc || x.category || '', qty: 1,
      amount: x.amount || 0, billable: false, billClientId: null, chargeAmount: 0, source: 'manual', rentalId: null, xlRef: ref });
    haveX.add(ref); bump(log.added, 'expenses');
  });

  /* fuel account: top-ups paid to the station and the opening balance (the fills themselves are the Fuel expenses above) */
  const haveFA = new Set(db.fuelAccount.map(x => x.xlRef).filter(Boolean));
  const fa = data.fuelAccount || {};
  if(fa.opening && !db.fuelAccount.some(x => x.kind === 'opening')){
    db.fuelAccount.push({ id: newId(), date: '2026-01-01', kind: 'opening', amount: fa.opening.amount, note: 'Balance carried from last year (FUEL row ' + fa.opening.row + ')', xlRef: 'FUEL!' + fa.opening.key });
    haveFA.add('FUEL!' + fa.opening.key); bump(log.added, 'fuelOpening');
  }
  (fa.topups || []).forEach(t => {
    const ref = 'FUEL!' + t.key; if(haveFA.has(ref)){ bump(log.skipped, 'fuelTopups'); return; }
    db.fuelAccount.push({ id: newId(), date: t.date || '', kind: 'topup', amount: t.amount || 0, note: '', xlRef: ref });
    haveFA.add(ref); bump(log.added, 'fuelTopups');
  });

  /* invoices (INVOICE sheet): one line each, with the rental invoice numbers filled in where an invoice matches a set of rentals exactly */
  const haveInv = new Set(db.invoices.map(i => i.xlRef).filter(Boolean));
  (data.invoices || []).forEach(i => {
    const ref = 'INVOICE!' + i.key; if(haveInv.has(ref)){ bump(log.skipped, 'invoices'); return; }
    const c = cByName.get(up(i.client));
    db.invoices.push({ id: newId(), clientId: c ? c.id : '', client: i.client, no: String(i.no), date: i.date, month: i.month, amount: i.amount, vat: i.vat || 0,
      status: i.paid ? 'PAID' : '', note: i.garbled ? 'Client name looks garbled in the Excel' : '', xlRef: ref });
    haveInv.add(ref); bump(log.added, 'invoices');
  });
  const rentalByRef = new Map(db.rentals.map(r => [r.xlRef, r]));
  Object.keys(data.rentalInvoice || {}).forEach(k => { const r = rentalByRef.get('CAR PERFORMANCE!' + k); if(r && !r.invoice) r.invoice = data.rentalInvoice[k]; });

  /* payments: everything the files list as PAID. A payment never takes a rental past what it is billed (so running the import again cannot over-pay). */
  const haveP = new Set(db.payments.map(p => p.xlRef).filter(Boolean));
  const paidNow = new Map(); db.payments.forEach(p => { if(p.rentalId !== '' && p.rentalId != null) paidNow.set(p.rentalId, (paidNow.get(p.rentalId) || 0) + (Number(p.amount) || 0)); });
  (data.payments || []).forEach(p => {
    if(haveP.has(p.ref)){ bump(log.skipped, 'payments'); return; }
    let rentalId = '', amount = p.amount, kind = p.linkKind, note = p.note;
    if(p.rentalKey){
      const r = rentalByRef.get('CAR PERFORMANCE!' + p.rentalKey);
      if(!r){ bump(log.skipped, 'paymentsNoRental'); return; }
      const room = Math.max(0, (Number(r.amount) || 0) - (paidNow.get(r.id) || 0));
      if(room <= 0){ bump(log.skipped, 'paymentsAlreadyPaid'); return; }
      amount = Math.min(amount, room); rentalId = r.id; paidNow.set(r.id, (paidNow.get(r.id) || 0) + amount);
    }
    db.payments.push({ id: newId(), rentalId, date: p.date, amount, method: p.method, note, xlRef: p.ref, source: p.source, invoiceNo: p.invoiceNo || '', linkKind: kind });
    haveP.add(p.ref); bump(log.added, rentalId === '' ? 'paymentsNotLinked' : 'payments');
  });
  db.rentals.forEach(r => { const paid = paidNow.get(r.id) || 0;
    if(paid > 0){ r.paid = paid >= (Number(r.amount) || 0); if(r.paid){ const last = db.payments.filter(p => p.rentalId === r.id).map(p => p.date).sort().pop(); r.paidDate = last || r.paidDate || ''; } } });

  /* admin: loans, insurance, chama (kept apart from the front view) */
  const haveL = new Set(db.loans.map(l => l.xlRef).filter(Boolean));
  (data.loans || []).forEach(l => {
    const ref = 'LOAN!' + l.key; if(haveL.has(ref)){ bump(log.skipped, 'loans'); return; }
    const sch = l.schedule || [], paid = sch.filter(s => s.paid);
    db.loans.push({ id: newId(), lender: l.lender || l.label || '', item: l.vehicleReg || l.label || '', borrowed: l.principal || 0,
      instalment: sch.length ? sch[0].amount : (l.dueAmount || 0), dueDay: l.dueDay || 0, startDate: sch.length ? sch[0].month : '', endDate: sch.length ? sch[sch.length - 1].month : '',
      paidThrough: paid.length ? paid[paid.length - 1].month : '', note: '', schedule: JSON.stringify(sch), xlRef: ref });
    bump(log.added, 'loans');
  });
  const haveI = new Set(db.insurance.map(i => i.xlRef).filter(Boolean));
  (data.insurance || []).forEach(i => {
    const ref = 'INSURANCE!' + i.key; if(haveI.has(ref)){ bump(log.skipped, 'insurance'); return; }
    const v = vehicleFor(i.reg);
    db.insurance.push({ id: newId(), vehicleId: v ? v.id : '', kind: '', amount: i.amount || 0, paidDate: i.date || '', expiryDate: '', note: '', xlRef: ref });
    bump(log.added, 'insurance');
  });
  /* Chama is no longer part of the app: CHAMA lines in the Excel are ignored, and rows already saved in a file are kept untouched. */

  /* client statements (OCHWADA): BF, charges and payments, one line each */
  const haveA = new Set(db.accounts.map(a => a.xlRef).filter(Boolean));
  (data.ochwada || []).forEach(b => {
    const ym = b.month === null ? '' : '2026-' + String(b.month + 1).padStart(2, '0');
    const put = (kind, date, amount, label, row) => { const ref = 'OCHWADA!' + row; if(haveA.has(ref)) return; haveA.add(ref);
      db.accounts.push({ id: newId(), account: 'OCHWADA', month: ym, date: date || '', kind, amount, label: label || '', note: '', xlRef: ref }); bump(log.added, 'accountLines'); };
    if(b.bf !== null) put('bf', ym + '-01', b.bf, 'BF', b.rowFrom + 1);
    b.entries.forEach(e => put(e.kind, e.date, e.amount, e.label, e.xlRow));
  });

  /* standing monthly rent (Sheet1): kept as a setting the user can edit, not as 12 typed lines */
  if(data.standingRent){
    db.settings = db.settings || {}; db.settings.standingExpenses = db.settings.standingExpenses || [];
    if(!db.settings.standingExpenses.some(x => x.category === 'Rent')){ db.settings.standingExpenses.push({ category: 'Rent', amount: data.standingRent.amount, fromMonth: '2025-11' }); bump(log.added, 'standingRent'); }
  }

  db.nextId = nextId;
  /* remember how each record added now looked, so a later import can tell it from one you edited */
  ['rentals', 'expenses', 'payments'].forEach(list => db[list].forEach(r => { if(Number(r.id) >= startId && r.xlRef) markImported(db, list, r, today); }));
  return log;
}
