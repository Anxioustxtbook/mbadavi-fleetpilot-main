/* Fuel and driver figures for a rental: ONE source, used by Performance, Coop, Sub-hire, the Fuel table and the fuel audit.
   Nothing is typed twice, so nothing is counted twice.

   FILL      = an expense with category 'Fuel' (db.expenses). Tagged with an account: 'Ola' (the fuel station account) or 'Outside' (paid elsewhere).
               Old fills with no tag are NOT counted as Ola (or Outside): they show as 'Untagged' until you choose. A fill may carry rentalId (the rental it was bought for).
   RENTAL FUEL = the fuel carried on the rental itself (rental.fuel, typed in Rentals or read from the Excel)
               + every fill tied to that rental in the Fuel table.
               (The expense that Rentals writes for rental.fuel is marked source 'rental'; it is the same money as rental.fuel, so it is left out here.)
   So a fill paid today for a rental that is still running counts at once, and a rental's old fuel is never added twice.
   RENTAL DRIVER = the sub-hire driver pay on the rental (rate per day x days), nothing when that job is cancelled. */

export const ACCOUNTS = ['Ola', 'Outside'];
const num = v => Number(v) || 0;
const r2 = x => Math.round(x * 100) / 100;

export const fillAccount = x => (x && x.account === 'Ola' ? 'Ola' : (x && x.account === 'Outside' ? 'Outside' : ''));
export const isFill = x => !!x && x.category === 'Fuel';
export const fillsOf = db => (db.expenses || []).filter(isFill);
/* fills tied to this rental that are NOT the mirror of rental.fuel */
/* An index of the fills of every rental, built ONCE by a list that visits many rentals (Performance, Coop, Sub-hire, the Excel sheets): looking each rental up in it is instant,
   where scanning every expense per rental slows down the more records there are. Pass it as the last argument; without it the old scan is used, with the same result. */
export function fuelIndex(db){
  const m = new Map(); m.rentals = new Map(); m.vehicles = new Map();
  (db.expenses || []).forEach(x => { if(isFill(x) && x.source !== 'rental' && x.rentalId != null && x.rentalId !== ''){ const k = String(x.rentalId); (m.get(k) || m.set(k, []).get(k)).push(x); } });
  (db.rentals || []).forEach(r => m.rentals.set(String(r.id), r)); (db.vehicles || []).forEach(v => m.vehicles.set(String(v.id), v));
  return m;
}
export const rentalFills = (db, r, ix) => ix ? (ix.get(String(r.id)) || []) : (db.expenses || []).filter(x => isFill(x) && x.source !== 'rental' && x.rentalId != null && x.rentalId !== '' && String(x.rentalId) === String(r.id));
export const rentalFuel = (db, r, ix) => r2(num(r.fuel) + rentalFills(db, r, ix).reduce((s, x) => s + num(x.amount), 0));

/* sub-hire driver pay of a rental (same rule as the Sub-hire driver sheet) */
export function rentalDriver(r){
  const cancelled = r.driverStatus === 'cancelled' || (!r.driverStatus && r.status === 'Cancelled');
  return cancelled ? 0 : r2(num(r.driverRate) * num(r.days));
}

/* which rental does a fill belong to? The car's rental that covers the date, else the one still running. '' when none. */
export function rentalForFill(db, vehicleId, date){
  if(!vehicleId) return '';
  const rs = (db.rentals || []).filter(r => String(r.vehicleId) === String(vehicleId) && r.status !== 'Cancelled');
  const hit = date ? rs.find(r => r.pickup && r.pickup <= date && (!r.return || date <= r.return)) : null;
  if(hit) return hit.id;
  const live = rs.filter(r => r.status === 'Active').sort((a, b) => (b.pickup || '') < (a.pickup || '') ? -1 : 1)[0];
  return live ? live.id : '';
}

/* add a fill. rentalId blank = not for a rental. A rental decides the car when no car is given. */
export function addFill(db, uid, f){
  const amount = num(f.amount); if(!(amount > 0)) return { ok: false, why: 'Enter the amount' };
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(f.date || ''))) return { ok: false, why: 'Enter the date' };
  const r = f.rentalId ? (db.rentals || []).find(x => String(x.id) === String(f.rentalId)) : null;
  const vehicleId = f.vehicleId || (r ? r.vehicleId : '');
  if(!vehicleId) return { ok: false, why: 'Pick the car' };
  const e = { id: uid(), vehicleId, date: f.date, category: 'Fuel', desc: String(f.desc || '').trim() || ('Fuel' + (r && r.contract ? ' — ' + r.contract : '')), qty: 1, amount,
    billable: false, billClientId: null, chargeAmount: 0, source: 'fuel', rentalId: r ? r.id : null, xlRef: '', account: f.account === 'Outside' ? 'Outside' : 'Ola' };
  (db.expenses = db.expenses || []).push(e);
  return { ok: true, fill: e };
}

/* one line per car: total fuel (all fills) split by account, and what the car's rentals carry */
export function fuelByCar(db, from, to){
  const by = new Map();
  const slot = id => { const k = String(id == null ? '' : id); let o = by.get(k); if(!o){ o = { vehicleId: k, ola: 0, outside: 0, untagged: 0, n: 0 }; by.set(k, o); } return o; };
  fillsOf(db).filter(x => (!from || x.date >= from) && (!to || x.date <= to)).forEach(x => { const o = slot(x.vehicleId); const a = fillAccount(x); if(a === 'Outside') o.outside += num(x.amount); else if(a === 'Ola') o.ola += num(x.amount); else o.untagged += num(x.amount); o.n++; });
  return [...by.values()].map(o => Object.assign(o, { total: r2(o.ola + o.outside + o.untagged), ola: r2(o.ola), outside: r2(o.outside), untagged: r2(o.untagged) }));
}

/* Where a rental's fuel came from. 'Mixed' = the car was filled on the Ola account AND somewhere outside during the same rental.
   Fuel carried on the rental (typed in Rentals) has no account, so it counts as untagged. */
function sourceOf(fills, carried){
  let ola = 0, outside = 0, untagged = num(carried);
  fills.forEach(x => { const a = fillAccount(x); if(a === 'Ola') ola += num(x.amount); else if(a === 'Outside') outside += num(x.amount); else untagged += num(x.amount); });
  const kind = ola && outside ? 'Mixed' : ola ? 'Ola' : outside ? 'Outside' : untagged ? 'Untagged' : 'None';
  return { ola: r2(ola), outside: r2(outside), untagged: r2(untagged), source: kind };
}
export const rentalSource = (db, r, ix) => sourceOf(rentalFills(db, r, ix), num(r.fuel));
export const SOURCES = ['Ola', 'Outside', 'Mixed', 'Untagged'];

/* Performance of each car: one line per car, from the rentals picked up in the dates chosen. Fuel = the one fuel figure (carried + tied fills). */
export function carPerformance(db, from, to){
  const by = new Map(), ix = fuelIndex(db);
  (db.vehicles || []).forEach(v => by.set(String(v.id), { vehicleId: String(v.id), reg: v.reg || [v.make, v.model].filter(Boolean).join(' ') || '—', sub: v.ownership === 'subhire' || !!v.oneOff, rentals: 0, days: 0, billed: 0, fuel: 0, allowance: 0, subhire: 0, driver: 0, mixed: 0 }));
  (db.rentals || []).filter(r => r.status !== 'Cancelled' && r.pickup && (!from || r.pickup >= from) && (!to || r.pickup <= to)).forEach(r => {
    const o = by.get(String(r.vehicleId)); if(!o) return;
    o.rentals++; o.days += num(r.days); o.billed += num(r.amount); o.fuel += rentalFuel(db, r, ix); o.allowance += num(r.allowance);
    o.subhire += r.subhireStatus === 'cancelled' ? 0 : num(r.subhireCost); o.driver += rentalDriver(r);
    if(rentalSource(db, r, ix).source === 'Mixed') o.mixed++;
  });
  return [...by.values()].map(o => Object.assign(o, { billed: r2(o.billed), fuel: r2(o.fuel), net: r2(o.billed - o.fuel - o.allowance - o.subhire - o.driver) }))
    .map(o => Object.assign(o, { perDay: o.days ? r2(o.net / o.days) : 0 })).sort((a, b) => b.net - a.net);
}

/* the audit: each rental with the fuel it carries, the fills tied to it, the total, and anything odd */
export function fuelAudit(db, from, to){
  const ix = fuelIndex(db);
  return (db.rentals || []).filter(r => r.pickup && (!from || r.pickup >= from) && (!to || r.pickup <= to)).map(r => {
    const fills = rentalFills(db, r, ix), extra = r2(fills.reduce((s, x) => s + num(x.amount), 0)), carried = num(r.fuel), flags = [];
    fills.forEach(x => {
      if(String(x.vehicleId) !== String(r.vehicleId)) flags.push('a fill is for another car');
      if(x.date && (x.date < r.pickup || (r.return && x.date > r.return && r.status !== 'Active'))) flags.push('a fill is dated outside the rental');
    });
    const src = sourceOf(fills, carried);
    return Object.assign(src, { rentalId: r.id, vehicleId: r.vehicleId, month: String(r.pickup).slice(0, 7), pickup: r.pickup, return: r.return, status: r.status, carried, fills, extra, total: r2(carried + extra), flags: [...new Set(flags)] });
  }).filter(a => a.total > 0 || a.fills.length);
}
