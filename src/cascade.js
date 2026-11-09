/* Linked data: deleting or editing a vehicle, client, driver or rental must leave nothing behind that points at it,
   so no screen ever shows "unknown" or a value that belongs to nothing.
   Pure functions on the database object (no screen code) so test/cascade.test.mjs can check them.
   impact*() says what would go; remove*() does it; repair() sweeps up anything already orphaned (e.g. from older files). */

const same = (a, b) => a != null && b != null && String(a) === String(b);
const n = v => Number(v) || 0;
const arr = (db, k) => (Array.isArray(db[k]) ? db[k] : (db[k] = []));

/* ---- what is linked to what ---- */
function rentalIdsOfVehicle(db, id){ return arr(db, 'rentals').filter(r => same(r.vehicleId, id)).map(r => r.id); }
function rentalIdsOfClient(db, id){ return arr(db, 'rentals').filter(r => same(r.clientId, id)).map(r => r.id); }
const has = (set, v) => v != null && v !== '' && set.has(String(v));

export function impactVehicle(db, id){
  const rids = new Set(rentalIdsOfVehicle(db, id).map(String));
  return {
    rentals: rids.size,
    bookings: arr(db, 'bookings').filter(b => same(b.vehicleId, id)).length,
    expenses: arr(db, 'expenses').filter(x => same(x.vehicleId, id) || has(rids, x.rentalId)).length,
    payments: arr(db, 'payments').filter(p => has(rids, p.rentalId)).length,
    insurance: arr(db, 'insurance').filter(i => same(i.vehicleId, id)).length,
    coops: arr(db, 'coops').filter(c => has(rids, c.rentalId)).length,
    drivers: arr(db, 'drivers').filter(d => same(d.vehicleId, id)).length   // kept, only un-assigned
  };
}
export function impactClient(db, id){
  const rids = new Set(rentalIdsOfClient(db, id).map(String));
  return {
    rentals: rids.size,
    bookings: arr(db, 'bookings').filter(b => same(b.clientId, id)).length,
    expenses: arr(db, 'expenses').filter(x => has(rids, x.rentalId)).length,
    payments: arr(db, 'payments').filter(p => has(rids, p.rentalId)).length,
    invoices: arr(db, 'invoices').filter(i => same(i.clientId, id)).length,          // kept, only un-linked
    coops: arr(db, 'coops').filter(c => same(c.clientId, id) || has(rids, c.rentalId)).length
  };
}
export function impactRental(db, id){
  return {
    expenses: arr(db, 'expenses').filter(x => same(x.rentalId, id)).length,
    payments: arr(db, 'payments').filter(p => same(p.rentalId, id)).length,
    coops: arr(db, 'coops').filter(c => same(c.rentalId, id)).length                  // kept, goes back to "to complete"
  };
}
export function impactDriver(db, id){ return { rentals: arr(db, 'rentals').filter(r => same(r.driverId, id)).length, allowances: arr(db, 'driverAllowances').filter(a => same(a.driverId, id)).length }; }

/* one plain sentence for the confirm box */
export function impactText(kind, label, imp){
  const word = { rentals: 'rental(s)', bookings: 'booking(s)', expenses: 'expense line(s)', payments: 'payment(s) received', insurance: 'insurance line(s)', coops: 'coop line(s)', drivers: 'driver(s)', invoices: 'invoice(s)', allowances: 'allowance line(s)' };
  const gone = [], kept = [];
  Object.entries(imp).forEach(([k, v]) => { if(!v) return; const t = v + ' ' + word[k];
    if(kind === 'vehicle' && k === 'drivers') kept.push(t + ' stay, with no car');
    else if(kind === 'client' && k === 'invoices') kept.push(t + ' stay, no longer tied to this client');
    else if(kind === 'rental' && k === 'coops') kept.push(t + ' stays, back to "to complete"');
    else if(kind === 'driver' && k === 'rentals') kept.push(t + ' stay, with no driver');
    else if(kind === 'driver' && k === 'allowances') gone.push(t);
    else gone.push(t); });
  return 'Delete ' + label + '?' + (gone.length ? '\n\nThis also deletes: ' + gone.join(', ') + '.' : '') + (kept.length ? '\n\nKept: ' + kept.join('; ') + '.' : '') + '\n\nThis cannot be undone.';
}

/* ---- removal ---- */
function dropRentals(db, rids){
  const set = new Set([...rids].map(String)); if(!set.size) return;
  db.rentals = arr(db, 'rentals').filter(r => !set.has(String(r.id)));
  db.expenses = arr(db, 'expenses').filter(x => !has(set, x.rentalId));
  db.payments = arr(db, 'payments').filter(p => !has(set, p.rentalId));
  arr(db, 'coops').forEach(c => { if(has(set, c.rentalId)){ c.rentalId = ''; c.status = 'todo'; } });
}
export function removeRental(db, id){ dropRentals(db, [id]); return db; }
export function removeVehicle(db, id){
  dropRentals(db, rentalIdsOfVehicle(db, id));
  db.vehicles = arr(db, 'vehicles').filter(v => !same(v.id, id));
  db.bookings = arr(db, 'bookings').filter(b => !same(b.vehicleId, id));
  db.expenses = arr(db, 'expenses').filter(x => !same(x.vehicleId, id));
  db.insurance = arr(db, 'insurance').filter(i => !same(i.vehicleId, id));
  arr(db, 'drivers').forEach(d => { if(same(d.vehicleId, id)) d.vehicleId = ''; });
  return db;
}
export function removeClient(db, id){
  dropRentals(db, rentalIdsOfClient(db, id));
  db.clients = arr(db, 'clients').filter(c => !same(c.id, id));
  db.bookings = arr(db, 'bookings').filter(b => !same(b.clientId, id));
  arr(db, 'invoices').forEach(i => { if(same(i.clientId, id)) i.clientId = ''; });
  arr(db, 'coops').forEach(c => { if(same(c.clientId, id)) c.clientId = ''; });
  return db;
}
export function removeDriver(db, id){
  db.drivers = arr(db, 'drivers').filter(d => !same(d.id, id));
  db.driverAllowances = arr(db, 'driverAllowances').filter(a => !same(a.driverId, id));
  arr(db, 'rentals').forEach(r => { if(same(r.driverId, id)) r.driverId = null; });
  return db;
}
export function removeExpense(db, id){ db.expenses = arr(db, 'expenses').filter(x => !same(x.id, id)); return db; }
export function removePayment(db, id){ db.payments = arr(db, 'payments').filter(p => !same(p.id, id)); return db; }

/* ---- edits that other places copy from ---- */
/* A client's name is copied onto its invoices (the Excel INVOICE sheet lists names). Keep them in step. */
export function syncClientName(db, client){
  if(!client) return 0; let k = 0;
  arr(db, 'invoices').forEach(i => { if(same(i.clientId, client.id) && i.client !== client.name){ i.client = client.name; k++; } });
  arr(db, 'coops').forEach(c => { if(same(c.clientId, client.id) && c.name !== client.name){ c.name = client.name; k++; } });
  return k;
}
/* After a rental is saved in Rentals, its linked coop line follows: dates, days, amount, contract, fuel, allowance. (Only the rental just saved; never a blanket pass.) */
export function syncCoopFromRental(db, rental){
  if(!rental) return 0; let k = 0;
  arr(db, 'coops').forEach(c => { if(!same(c.rentalId, rental.id)) return;
    const billed = n(rental.amount), fits = billed === n(c.amount) || billed === n(c.amount) + n(c.driverPay);   // the sheet bills AMOUNT, or AMOUNT + DRIVER: both already agree
    const next = { start: rental.pickup || c.start, end: rental.return || c.end, days: n(rental.days) || c.days, amount: fits || !billed ? c.amount : Math.max(0, billed - n(c.driverPay)), contract: rental.contract || c.contract, fuel: n(rental.fuel), allowance: n(rental.allowance) };
    Object.keys(next).forEach(f => { if(c[f] !== next[f]){ c[f] = next[f]; k++; } }); });
  return k;
}

/* ---- sweep: nothing may point at something that is not there ----
   Returns what it fixed and what it could only report. It NEVER deletes a record on its own (phone sync: nothing is removed without the owner):
   a booking, insurance line, rental expense or rental whose car, client or rental is gone is kept and listed in report for the owner to decide. */
export function repair(db){
  const out = { fixed: {}, report: [] };
  const bump = k => { out.fixed[k] = (out.fixed[k] || 0) + 1; };
  const vIds = new Set(arr(db, 'vehicles').map(v => String(v.id)));
  const cIds = new Set(arr(db, 'clients').map(c => String(c.id)));
  const dIds = new Set(arr(db, 'drivers').map(d => String(d.id)));
  const rIds = new Set(arr(db, 'rentals').map(r => String(r.id)));

  const keep = (key, test) => { const list = arr(db, key), kept = list.filter(test); if(kept.length !== list.length) db[key] = kept; };   // only reassign when something went
  const flag = (list, x, problem) => out.report.push({ list, id: x.id, problem });          // kept, only listed
  arr(db, 'bookings').forEach(b => { if(!(has(vIds, b.vehicleId) && has(cIds, b.clientId))) flag('bookings', b, (has(vIds, b.vehicleId) ? '' : 'car is missing') + (!has(vIds, b.vehicleId) && !has(cIds, b.clientId) ? ' and ' : '') + (has(cIds, b.clientId) ? '' : 'client is missing')); });
  arr(db, 'insurance').forEach(i => { if(!has(vIds, i.vehicleId)) flag('insurance', i, 'car is missing'); });
  keep('expenses', x => {
    if(x.source === 'rental' && !has(rIds, x.rentalId)){ flag('expenses', x, 'its rental is missing'); return true; }
    if(x.vehicleId !== '' && x.vehicleId != null && !has(vIds, x.vehicleId)){ x.vehicleId = ''; bump('expenses moved to Office'); }
    if(x.rentalId != null && x.rentalId !== '' && !has(rIds, x.rentalId)){ x.rentalId = null; bump('expenses un-linked'); }
    return true; });
  arr(db, 'payments').forEach(p => { if(p.rentalId != null && p.rentalId !== '' && !has(rIds, p.rentalId)){ p.rentalId = ''; p.linkKind = p.linkKind || 'unlinked'; bump('payments un-linked'); } });
  arr(db, 'drivers').forEach(d => { if(d.vehicleId !== '' && d.vehicleId != null && !has(vIds, d.vehicleId)){ d.vehicleId = ''; bump('drivers un-assigned'); } });
  arr(db, 'rentals').forEach(r => { if(r.driverId != null && r.driverId !== '' && !has(dIds, r.driverId)){ r.driverId = null; bump('rentals without driver'); } });
  arr(db, 'invoices').forEach(i => { if(i.clientId != null && i.clientId !== '' && !has(cIds, i.clientId)){ i.clientId = ''; bump('invoices un-linked'); } });
  arr(db, 'coops').forEach(c => {
    if(c.clientId != null && c.clientId !== '' && !has(cIds, c.clientId)){ c.clientId = ''; bump('coops un-linked from client'); }
    if(c.rentalId != null && c.rentalId !== '' && !has(rIds, c.rentalId)){ c.rentalId = ''; c.status = 'todo'; bump('coops back to "to complete"'); }
  });
  arr(db, 'rentals').forEach(r => {
    const noCar = !has(vIds, r.vehicleId), noClient = !has(cIds, r.clientId);
    if(noCar || noClient) out.report.push({ id: r.id, problem: (noCar ? 'car is missing' : '') + (noCar && noClient ? ' and ' : '') + (noClient ? 'client is missing' : ''), pickup: r.pickup, amount: r.amount });
  });
  return out;
}
export const repairedCount = out => Object.values(out.fixed).reduce((s, v) => s + v, 0);
