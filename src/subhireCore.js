/* Sub-hire, the pure part (no screen): what is paid to car owners and to sub-hire drivers, worked out from the rentals.
   Nothing is typed twice. A rental already knows its car, client, dates, days and driver. The only things typed here are:
     - for a sub-hire CAR (owner): the amount, the status (paid / not cleared / cancelled) and the date of that status, and the job (where it worked)
     - for a sub-hire DRIVER: the amount per day, the status and the date of that status
   They are kept on the rental itself, so deleting a rental removes them, and Save / Open and the Excel import carry them.
     owner:   rental.subhireCost, rental.subhireStatus, rental.subhirePaidDate, rental.job            (rental.subhirePaid stays in step: true when paid)
     driver:  rental.driverRate (per day), rental.driverStatus, rental.driverStatusDate               (driver.kind === 'subhire' puts a driver on the sheet)  */

export const STATUSES = [{ value: 'paid', label: 'Paid' }, { value: 'notcleared', label: 'Not cleared' }, { value: 'cancelled', label: 'Cancelled' }];
export const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.value, s.label]));
import { rentalFuel } from './fuelCore.js';
const num = v => Number(v) || 0;
const r2 = x => Math.round(x * 100) / 100;
const up = s => String(s == null ? '' : s).trim().toUpperCase();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
export const todayISO = () => new Date().toISOString().slice(0, 10);

const vehicleOf = (db, r) => (db.vehicles || []).find(v => v.id == r.vehicleId) || null;
const clientOf = (db, r) => (db.clients || []).find(c => c.id == r.clientId) || null;
const driverOf = (db, r) => r.driverId ? (db.drivers || []).find(d => d.id == r.driverId) || null : null;

/* ---------------- owner side (the SUBHIRE sheet) ---------------- */
export function ownerStatus(r){
  if(r.subhireStatus === 'paid' || r.subhireStatus === 'notcleared' || r.subhireStatus === 'cancelled') return r.subhireStatus;
  return r.subhirePaid ? 'paid' : (r.status === 'Cancelled' ? 'cancelled' : 'notcleared');
}
/* a rental is a sub-hire line when its car belongs to an owner, or a sub-hire cost was recorded on it */
export const isOwnerLine = (db, r) => num(r.subhireCost) > 0 || (vehicleOf(db, r) || {}).ownership === 'subhire';
/* what the line costs: nothing when cancelled */
export const ownerCost = r => ownerStatus(r) === 'cancelled' ? 0 : num(r.subhireCost);
export function setOwnerStatus(r, status, date){
  r.subhireStatus = status; r.subhirePaid = status === 'paid';
  if(date !== undefined) r.subhirePaidDate = date;
  else if(status === 'paid' && !r.subhirePaidDate) r.subhirePaidDate = todayISO();
}
/* the rental form's "Owner paid" tick keeps the status in step */
export function syncOwnerFromTick(r){
  if(r.subhirePaid && r.subhireStatus !== 'paid') setOwnerStatus(r, 'paid');
  else if(!r.subhirePaid && r.subhireStatus === 'paid') setOwnerStatus(r, 'notcleared', '');
}
export function ownerKey(db, r){ const v = vehicleOf(db, r) || {}; return up(v.owner) || ('CAR ' + up(v.reg)); }
export function ownerName(db, r){ const v = vehicleOf(db, r) || {}; return (v.owner || '').trim() || '(owner not set)'; }

/* ---------------- driver side (the SUBHIRE DRIVER sheet) ---------------- */
export function driverStatus(r){
  if(r.driverStatus === 'paid' || r.driverStatus === 'notcleared' || r.driverStatus === 'cancelled') return r.driverStatus;
  return r.status === 'Cancelled' ? 'cancelled' : 'notcleared';
}
/* a rental is on the driver sheet when its driver is a sub-hire driver, or a rate/status was already recorded on it */
export function isDriverLine(db, r){
  if(r.driverRate || r.driverStatus) return true;
  const d = driverOf(db, r); return !!d && d.kind === 'subhire';
}
/* amount = rate per day × days of the rental */
export const driverAmount = r => r2(num(r.driverRate) * num(r.days));
export const driverCost = r => driverStatus(r) === 'cancelled' ? 0 : driverAmount(r);
export function setDriverStatus(r, status, date){
  r.driverStatus = status;
  if(date !== undefined) r.driverStatusDate = date;
  else if(status === 'paid' && !r.driverStatusDate) r.driverStatusDate = todayISO();
}
export const datesText = r => (r.pickup || '') + (r.return && r.return !== r.pickup ? ' to ' + r.return : '');

/* ---------------- rows for the tables ---------------- */
export function ownerRows(db){
  return (db.rentals || []).filter(r => r.pickup && isOwnerLine(db, r)).map(r => {
    const v = vehicleOf(db, r) || {}, c = clientOf(db, r) || {};
    return { id: r.id, month: String(r.pickup).slice(0, 7), reg: v.reg || '—', owner: ownerName(db, r), ownerKey: ownerKey(db, r), job: r.job || c.name || '', jobTyped: r.job || '', client: c.name || '',
      pickup: r.pickup, dates: datesText(r), days: num(r.days), billed: r.status === 'Cancelled' ? 0 : num(r.amount), cost: num(r.subhireCost), status: ownerStatus(r), statusDate: r.subhirePaidDate || '',
      fuel: rentalFuel(db, r), allowance: num(r.allowance), driver: (driverOf(db, r) || {}).name || '', vehicleId: r.vehicleId, rentalCancelled: r.status === 'Cancelled' };
  }).sort((a, b) => a.pickup < b.pickup ? -1 : (a.pickup > b.pickup ? 1 : a.reg < b.reg ? -1 : 1));
}
export function driverRows(db){
  return (db.rentals || []).filter(r => r.pickup && isDriverLine(db, r)).map(r => {
    const v = vehicleOf(db, r) || {}, c = clientOf(db, r) || {}, d = driverOf(db, r) || {};
    return { id: r.id, month: String(r.pickup).slice(0, 7), driver: d.name || '(no driver)', client: c.name || '', clientType: c.type || r.type || '', reg: v.reg || '—', pickup: r.pickup, dates: datesText(r), days: num(r.days),
      rate: num(r.driverRate), amount: driverAmount(r), status: driverStatus(r), statusDate: r.driverStatusDate || '' };
  }).sort((a, b) => a.pickup < b.pickup ? -1 : (a.pickup > b.pickup ? 1 : a.driver < b.driver ? -1 : 1));
}
export const monthsOf = rows => [...new Set(rows.map(r => r.month))].sort();

/* ---------------- the Sub-hire page: per owner, per vehicle, per driver, for a month ('' = every month) ---------------- */
export function ownerSummary(db, month){
  const rows = ownerRows(db).filter(r => !month || r.month === month), by = new Map();
  rows.forEach(r => {
    const o = by.get(r.ownerKey) || { key: r.ownerKey, owner: r.owner, cars: new Set(), jobs: 0, days: 0, billed: 0, cost: 0, paid: 0, notcleared: 0, cancelled: 0 };
    o.cars.add(r.reg); o.jobs++; o.days += r.days; o.billed += r.billed;
    if(r.status === 'cancelled') o.cancelled += r.cost; else { o.cost += r.cost; if(r.status === 'paid') o.paid += r.cost; else o.notcleared += r.cost; }
    by.set(r.ownerKey, o);
  });
  return [...by.values()].map(o => Object.assign(o, { cars: [...o.cars].sort() })).sort((a, b) => b.cost - a.cost);
}
/* how each sub-hire car performed: what it earned, what it cost, what was left */
export function vehiclePerformance(db, month){
  const rows = ownerRows(db).filter(r => (!month || r.month === month) && !r.rentalCancelled), by = new Map();
  const drvByRental = new Map(driverRows(db).map(r => [r.id, r]));
  rows.forEach(r => {
    const o = by.get(r.vehicleId) || { vehicleId: r.vehicleId, reg: r.reg, owner: r.owner, jobs: 0, days: 0, billed: 0, ownerCost: 0, driverPay: 0, fuel: 0, allowance: 0 };
    const dr = drvByRental.get(r.id);
    o.jobs++; o.days += r.days; o.billed += r.billed; o.fuel += r.fuel; o.allowance += r.allowance;
    if(r.status !== 'cancelled') o.ownerCost += r.cost;
    if(dr && dr.status !== 'cancelled') o.driverPay += dr.amount;
    by.set(r.vehicleId, o);
  });
  return [...by.values()].map(o => Object.assign(o, { net: o.billed - o.ownerCost - o.driverPay - o.fuel - o.allowance })).sort((a, b) => b.net - a.net);
}
export function driverSummary(db, month){
  const rows = driverRows(db).filter(r => !month || r.month === month), by = new Map();
  rows.forEach(r => {
    const o = by.get(r.driver) || { driver: r.driver, jobs: 0, days: 0, amount: 0, paid: 0, notcleared: 0, cancelled: 0 };
    o.jobs++; o.days += r.days;
    if(r.status === 'cancelled') o.cancelled += r.amount; else { o.amount += r.amount; if(r.status === 'paid') o.paid += r.amount; else o.notcleared += r.amount; }
    by.set(r.driver, o);
  });
  return [...by.values()].sort((a, b) => b.amount - a.amount);
}
