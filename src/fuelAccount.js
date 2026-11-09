/* Fuel account: how the FUEL sheet works.
   The FUEL sheet is a running account with the fuel station, not a list of expenses.
     TOP-UP  = money paid into the account (db.fuelAccount, kind 'topup'). It is not an expense and has no car.
     FILL    = fuel actually put into a car (db.expenses, category 'Fuel'). This is the real fuel cost, already in every report.
     OPENING = balance carried in from last year (db.fuelAccount, kind 'opening'). Negative means owed to the station.
   balance = opening + top-ups paid - fills taken.   Negative = the office is behind with the station.
   Everything here is pure (no screen code) so the Pages screen and the tests use the same figures. */

const num = v => Number(v) || 0;
const ymOf = d => String(d || '').slice(0, 7);
const idNum = v => Number(v) || 0;

export const isTopup = f => f && f.kind !== 'opening';

export function fuelFills(db){ return (db.expenses || []).filter(x => x.category === 'Fuel'); }
/* only fills tagged Ola draw the balance down. 'Outside' fills (paid elsewhere) never touch it, and old fills with no tag are not counted until they are tagged. */
export const olaFills = db => fuelFills(db).filter(x => x.account === 'Ola');
export const outsideFills = db => fuelFills(db).filter(x => x.account === 'Outside');
export const untaggedFills = db => fuelFills(db).filter(x => x.account !== 'Ola' && x.account !== 'Outside');
export function topups(db){ return (db.fuelAccount || []).filter(isTopup); }
export function openingBalance(db){ return (db.fuelAccount || []).filter(f => f.kind === 'opening').reduce((s, f) => s + num(f.amount), 0); }

function nextMonth(ym){ let [y, m] = ym.split('-').map(Number); m++; if(m > 12){ m = 1; y++; } return y + '-' + String(m).padStart(2, '0'); }

/* Overall position: paid in, taken, and what is left (or owed). Fills with no date still count here. */
export function fuelPosition(db){
  const t = topups(db), f = olaFills(db), open = openingBalance(db), out = outsideFills(db), un = untaggedFills(db);
  const paidIn = t.reduce((s, x) => s + num(x.amount), 0), taken = f.reduce((s, x) => s + num(x.amount), 0);
  const undated = f.filter(x => !ymOf(x.date));
  return { opening: open, paidIn, nTop: t.length, outside: out.reduce((s, x) => s + num(x.amount), 0), nOutside: out.length, untagged: un.reduce((s, x) => s + num(x.amount), 0), nUntagged: un.length, taken, nFill: f.length, balance: open + paidIn - taken,
           undatedCount: undated.length, undatedAmount: undated.reduce((s, x) => s + num(x.amount), 0) };
}

/* One row per month, from the first month with anything to `toMonth` (default: this month).
   opening/closing are the account balance at the start and end of the month. */
export function fuelAccountMonths(db, toMonth){
  const t = topups(db).filter(x => ymOf(x.date)), f = olaFills(db).filter(x => ymOf(x.date));
  const all = t.map(x => ymOf(x.date)).concat(f.map(x => ymOf(x.date))).sort();
  if(!all.length) return [];
  const today = toMonth || new Date().toISOString().slice(0, 7);
  const last = all[all.length - 1] > today ? all[all.length - 1] : today;
  const rows = []; let bal = openingBalance(db);
  for(let ym = all[0]; ym <= last; ym = nextMonth(ym)){
    const tm = t.filter(x => ymOf(x.date) === ym), fm = f.filter(x => ymOf(x.date) === ym);
    const paidIn = tm.reduce((s, x) => s + num(x.amount), 0), taken = fm.reduce((s, x) => s + num(x.amount), 0);
    rows.push({ month: ym, topups: paidIn, nTop: tm.length, fills: taken, nFill: fm.length, net: paidIn - taken, opening: bal, closing: bal + paidIn - taken });
    bal += paidIn - taken;
  }
  return rows;
}

/* The month as the Excel sheet shows it: every top-up and every fill in date order, with the balance after each line. */
export function fuelLedger(db, ym){
  const months = fuelAccountMonths(db);
  const row = months.find(r => r.month === ym) || { opening: openingBalance(db), topups: 0, fills: 0, closing: openingBalance(db) };
  const entries = [];
  topups(db).filter(x => ymOf(x.date) === ym).forEach(x => entries.push({ type: 'topup', id: x.id, date: x.date, amount: num(x.amount), note: x.note || '' }));
  olaFills(db).filter(x => ymOf(x.date) === ym).forEach(x => entries.push({ type: 'fill', id: x.id, date: x.date, amount: num(x.amount), vehicleId: x.vehicleId, desc: x.desc || '' }));
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.type === b.type ? idNum(a.id) - idNum(b.id) : (a.type === 'topup' ? -1 : 1)));
  let bal = row.opening;
  entries.forEach(e => { bal += e.type === 'topup' ? e.amount : -e.amount; e.balance = bal; });
  return { month: ym, opening: row.opening, paidIn: row.topups, taken: row.fills, closing: row.closing, entries };
}

/* Fuel lines that look like the same fill entered twice (same car, same date, same amount).
   Nothing is removed automatically: the Fuel page lists them and asks first. */
export function fuelRepeats(db){
  const groups = new Map();
  fuelFills(db).forEach(x => { if(!x.date || !x.vehicleId) return; const k = x.vehicleId + '|' + x.date + '|' + num(x.amount); (groups.get(k) || groups.set(k, []).get(k)).push(x); });
  return [...groups.values()].filter(g => g.length > 1).map(g => g.slice().sort((a, b) => idNum(a.id) - idNum(b.id)));
}
