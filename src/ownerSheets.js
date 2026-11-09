/* The saved Excel file, readable the way YOUR workbook (PERFOMANCE_2026) is read: CAR PERFORMANCE, COOP, FUEL, CARWASH, TRANSPORT,
   GARAGE, AIRPORT FEE, ALLOWANCE, INVOICE, INSURANCE, OCHWADA, WALK-IN and the monthly OVERVIEW (your Sheet1).
   Every sheet is drawn from the database at the moment of Save, so it always matches the app. Month by month, a heading band
   for each month ("JANUARY 2026") with its total under it, dates as real dates, ranges in your style (8TH-9TH), money with
   thousands separators. These sheets are for reading; Open restores from the data tabs, which are always saved too. */
import { rentalFuel, fillsOf, fillAccount, fuelIndex } from './fuelCore.js';
import { coopFigures } from './coop.js';
import { monthlySummary, SUMMARY_COLUMNS } from './summary.js';

const num = v => Number(v) || 0;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const monthTitle = ym => /^\d{4}-\d{2}$/.test(ym) ? MONTHS[Number(ym.slice(5)) - 1] + ' ' + ym.slice(0, 4) : 'NO DATE';
const toDate = s => isDate(s) ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))) : '';
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH'));
/* one day = a real date; more = "8TH-9TH" (your style) */
export function datesCell(a, b){
  if(!isDate(a)) return '';
  if(!isDate(b) || b === a) return toDate(a);
  return ord(+a.slice(8)) + '-' + ord(+b.slice(8));
}
/* lookups are built once per sheet (a Map per list), so a sheet costs the same per row however many records there are */
const mapOf = list => { const m = new Map(); (list || []).forEach(x => m.set(String(x.id), x)); return m; };
const lookups = db => ({ v: mapOf(db.vehicles), c: mapOf(db.clients), d: mapOf(db.drivers), r: mapOf(db.rentals), ix: fuelIndex(db) });
const reg = (L, id) => { const v = L.v.get(String(id)); return v ? (v.reg || [v.make, v.model].filter(Boolean).join(' ')) : ''; };
const clientOf = (L, id) => L.c.get(String(id)) || null;
const driverName = (L, id) => { const d = L.d.get(String(id)); return d ? d.name : ''; };

const THIN = { style: 'thin', color: { argb: 'FFBFBFBF' } };

/* generic month-by-month sheet.
   cols: [{ h: 'HEADING', w: width, money?: true, date?: true }]; rows: [{ ym, cells: [...] }]; every date cell may be a Date or text */
function monthSheet(wb, name, cols, rows, opts = {}){
  const ws = wb.addWorksheet(name), n = cols.length, first = opts.firstCol || 1;
  const put = (r, c, v, o = {}) => { const k = ws.getCell(r, first + c); if(v !== '' && v != null) k.value = v; if(o.bold) k.font = { bold: true }; if(o.fmt) k.numFmt = o.fmt; if(o.border) k.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; return k; };
  let r = 1;
  cols.forEach((c, i) => { put(r, i, c.h, { bold: true, border: true }); ws.getColumn(first + i).width = c.w || 14; });
  const headRow = r; r++;
  const by = new Map(); rows.forEach(x => { const k = /^\d{4}-\d{2}$/.test(x.ym || '') ? x.ym : 'zzzz'; (by.get(k) || by.set(k, []).get(k)).push(x); });
  const lab = Math.max(0, cols.findIndex(c => !c.money));   // the label goes in the first column that is not money
  const sums = cols.map((c, i) => c.money ? i : -1).filter(i => i >= 0);
  const grand = sums.map(() => 0);
  [...by.keys()].sort().forEach(k => {
    const list = by.get(k);
    for(let i = 0; i < n; i++) put(r, i, i === lab ? monthTitle(k) + '  (' + list.length + ')' : '', { bold: true, border: true });
    r++;
    const tot = sums.map(() => 0);
    list.forEach(x => {
      cols.forEach((c, i) => { const v = x.cells[i]; const cell = put(r, i, v, { border: true }); if(c.money) cell.numFmt = '#,##0'; else if(v instanceof Date) cell.numFmt = 'dd/mm/yyyy'; });
      sums.forEach((ci, j) => { tot[j] += num(x.cells[ci]); });
      r++;
    });
    for(let i = 0; i < n; i++) put(r, i, i === lab ? monthTitle(k) + ' total' : '', { bold: true });
    sums.forEach((ci, j) => { put(r, ci, tot[j], { bold: true, fmt: '#,##0' }); grand[j] += tot[j]; });
    r += 1;
  });
  for(let i = 0; i < n; i++) put(r, i, i === lab ? 'TOTAL' : '', { bold: true, border: true });
  sums.forEach((ci, j) => put(r, ci, grand[j], { bold: true, border: true, fmt: '#,##0' }));
  ws.views = [{ state: 'frozen', ySplit: headRow }];
  return ws;
}
const ymOf = s => String(s || '').slice(0, 7);
const live = db => (db.rentals || []).filter(r => r.status !== 'Cancelled' && r.pickup).sort((a, b) => a.pickup < b.pickup ? -1 : a.pickup > b.pickup ? 1 : 0);
const exp = (db, cat) => (db.expenses || []).filter(x => x.category === cat && x.source !== 'rental').sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);

/* CAR PERFORMANCE: one line per rental, like the sheet (client, car, driver, out/in, days, fuel, amount, sub-hire) */
export function addCarPerformance(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'CLIENT', w: 22 }, { h: 'CAR REGISTRATION', w: 18 }, { h: 'DRIVER', w: 16 }, { h: 'DATE OUT', w: 12 }, { h: 'TIME', w: 9 }, { h: 'MILEAGE OUT', w: 12 },
    { h: 'DATE IN', w: 12 }, { h: 'TIME IN', w: 9 }, { h: 'MILEAGE IN', w: 12 }, { h: 'DAYS', w: 7 }, { h: 'FUEL', w: 11, money: true }, { h: 'AMOUNT', w: 12, money: true },
    { h: 'SUBHIRE', w: 12, money: true }, { h: 'ALLOWANCE', w: 12, money: true }, { h: 'CLIENT TYPE', w: 12 }];
  const coopBy = new Map(); (db.coops || []).forEach(x => { if(x.rentalId != null && x.rentalId !== '' && !coopBy.has(String(x.rentalId))) coopBy.set(String(x.rentalId), x); });
  const rows = live(db).map(r => { const c = clientOf(L, r.clientId) || {}, co = coopBy.get(String(r.id));
    return { ym: ymOf(r.pickup), cells: [c.name || '', reg(L, r.vehicleId), driverName(L, r.driverId) || 'SELF', toDate(r.pickup), r.pickupTime || '', co && num(co.kmOut) ? num(co.kmOut) : '',
      toDate(r.return || r.pickup), r.returnTime || '', co && num(co.kmIn) ? num(co.kmIn) : '', num(r.days), rentalFuel(db, r, L.ix), num(r.amount),
      r.subhireStatus === 'cancelled' ? 0 : num(r.subhireCost), num(r.allowance), c.type || 'walkin'] }; });
  return monthSheet(wb, 'CAR PERFORMANCE', cols, rows);
}

/* COOP: the columns of your COOP sheet, then department and KMs */
export function addCoopSheet(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'NAME', w: 24 }, { h: 'DATE', w: 14 }, { h: 'DAYS', w: 7 }, { h: 'AMOUNT', w: 12, money: true }, { h: 'DRIVER', w: 11, money: true }, { h: 'ALLOWANCE', w: 12, money: true },
    { h: 'FUEL', w: 11, money: true }, { h: 'CONT NO', w: 12 }, { h: 'DEPARTMENT', w: 26 }, { h: 'KM OUT', w: 11 }, { h: 'KM IN', w: 11 }];
  const rows = (db.coops || []).slice().sort((a, b) => String(a.start) < String(b.start) ? -1 : 1).map(c => { const g = coopFigures(db, c, false, L.ix);
    return { ym: ymOf(c.start), cells: [c.name || '', datesCell(c.start, c.end), num(c.days), num(c.amount), g.driver, g.allowance, g.fuel, c.contract || '', c.department || '', num(c.kmOut) || '', num(c.kmIn) || ''] }; });
  return monthSheet(wb, 'COOP', cols, rows);
}

/* FUEL SHEET: every fill with its account, plus the money paid in to the fuel account */
export function addFuelSheet(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'DATE', w: 12 }, { h: 'CAR', w: 16 }, { h: 'FILL', w: 12, money: true }, { h: 'PAID IN', w: 12, money: true }, { h: 'ACCOUNT', w: 12 }, { h: 'CLIENT / RENTAL', w: 24 }, { h: 'NOTE', w: 30 }];
  const rows = [];
  fillsOf(db).forEach(x => { const r = x.rentalId != null && x.rentalId !== '' ? L.r.get(String(x.rentalId)) : null, c = r ? clientOf(L, r.clientId) : null;
    rows.push({ ym: ymOf(x.date), d: x.date, cells: [toDate(x.date), reg(L, x.vehicleId), num(x.amount), '', fillAccount(x), c ? c.name : '', x.desc || ''] }); });
  (db.fuelAccount || []).filter(x => x.kind === 'topup').forEach(x => rows.push({ ym: ymOf(x.date), d: x.date, cells: [toDate(x.date), 'TOP-UP', '', num(x.amount), '', '', x.note || ''] }));
  rows.sort((a, b) => String(a.d) < String(b.d) ? -1 : a.d > b.d ? 1 : 0);
  return monthSheet(wb, 'FUEL SHEET', cols, rows);
}

const expSheet = (name, cat, withItem) => (wb, db) => {
  const L = lookups(db);
  const cols = withItem ? [{ h: 'REGISTRATION', w: 16 }, { h: 'ITEM', w: 30 }, { h: 'AMOUNT', w: 12, money: true }, { h: 'DATE', w: 12 }] : [{ h: 'NAME / REGISTRATION', w: 28 }, { h: 'AMOUNT', w: 12, money: true }, { h: 'DATE', w: 12 }];
  const rows = exp(db, cat).map(x => { const car = reg(L, x.vehicleId);
    return { ym: ymOf(x.date), cells: withItem ? [car, x.desc || '', num(x.amount), toDate(x.date)] : [car || x.desc || '', num(x.amount), toDate(x.date)] }; });
  return monthSheet(wb, name, cols, rows);
};
export const addCarwash = expSheet('CARWASH', 'Cleaning', false);
export const addTransport = expSheet('TRANSPORT', 'Transport', false);
export const addGarage = expSheet('GARAGE', 'Garage', true);
export const addAirport = expSheet('AIRPORT FEE', 'Airport', true);

/* ALLOWANCE: drawn from the rentals that carried one */
export function addAllowance(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'DRIVER', w: 20 }, { h: 'CLIENT', w: 24 }, { h: 'AMOUNT', w: 12, money: true }, { h: 'DATES', w: 14 }];
  const rows = live(db).filter(r => num(r.allowance) > 0).map(r => ({ ym: ymOf(r.pickup), cells: [driverName(L, r.driverId), (clientOf(L, r.clientId) || {}).name || '', num(r.allowance), datesCell(r.pickup, r.return)] }));
  return monthSheet(wb, 'ALLOWANCE', cols, rows);
}

/* INVOICE: client, amount, invoice no, date, status, VAT */
export function addInvoice(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'CLIENT', w: 24 }, { h: 'AMOUNT', w: 13, money: true }, { h: 'INVOICE', w: 10 }, { h: 'DATE', w: 12 }, { h: 'STATUS', w: 10 }, { h: 'VAT', w: 11, money: true }];
  const rows = (db.invoices || []).slice().sort((a, b) => String(a.date) < String(b.date) ? -1 : 1).map(i => ({ ym: ymOf(i.date) || String(i.month || ''), cells: [i.client || (clientOf(L, i.clientId) || {}).name || '', num(i.amount), i.no || '', toDate(i.date), String(i.status || '').toUpperCase(), num(i.vat)] }));
  return monthSheet(wb, 'INVOICE', cols, rows);
}

/* INSURANCE SHEET: car, amount, paid date, expiry (when entered) */
export function addInsurance(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'NO', w: 6 }, { h: 'REGISTRATION', w: 16 }, { h: 'KIND', w: 14 }, { h: 'AMOUNT', w: 12, money: true }, { h: 'PAID DATE', w: 12 }, { h: 'EXPIRY DATE', w: 12 }, { h: 'NOTE', w: 28 }];
  const rows = (db.insurance || []).slice().sort((a, b) => String(a.paidDate) < String(b.paidDate) ? -1 : 1).map((i, n) => ({ ym: ymOf(i.paidDate), cells: [n + 1, reg(L, i.vehicleId), i.kind || '', num(i.amount), toDate(i.paidDate), toDate(i.expiryDate), i.note || ''] }));
  return monthSheet(wb, 'INSURANCE SHEET', cols, rows);
}

/* OCHWADA: what was paid to him, BF (carried) first, then charges and payments */
export function addOchwada(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'AMOUNT', w: 13, money: true }, { h: 'DATES / DETAIL', w: 22 }, { h: 'KIND', w: 11 }];
  const rows = (db.accounts || []).filter(a => String(a.account || '').toUpperCase() === 'OCHWADA').sort((a, b) => String(a.date || a.month) < String(b.date || b.month) ? -1 : 1)
    .map(a => ({ ym: ymOf(a.date) || String(a.month || ''), cells: [num(a.amount), a.kind === 'bf' ? 'BF' : (isDate(a.date) ? toDate(a.date) : (a.label || '')), a.kind === 'bf' ? 'BF' : a.kind === 'payment' ? 'PAID' : 'CHARGE'] }));
  return monthSheet(wb, 'OCHWADA', cols, rows);
}

/* WALK-IN (your Sheet2): rentals of walk-in clients */
export function addWalkin(wb, db){
  const L = lookups(db);
  const cols = [{ h: 'CLIENT', w: 22 }, { h: 'CAR', w: 16 }, { h: 'DATES', w: 14 }, { h: 'DAYS', w: 7 }, { h: 'AMOUNT', w: 13, money: true }];
  const rows = live(db).filter(r => ((clientOf(L, r.clientId) || {}).type || 'walkin') === 'walkin').map(r => ({ ym: ymOf(r.pickup), cells: [(clientOf(L, r.clientId) || {}).name || '', reg(L, r.vehicleId), datesCell(r.pickup, r.return), num(r.days), num(r.amount)] }));
  return monthSheet(wb, 'WALK-IN', cols, rows);
}

/* OVERVIEW (your Sheet1): one line per month, a column per cost, then the total spent and a TOTAL line */
export function addOverview(wb, db){
  const L = lookups(db);
  const ws = wb.addWorksheet('OVERVIEW'), list = (db.rentals || []).map(r => ymOf(r.pickup)).concat((db.expenses || []).map(x => ymOf(x.date)), (db.insurance || []).map(i => ymOf(i.paidDate))).filter(Boolean).sort();
  const cols = SUMMARY_COLUMNS.map(c => c.label.toUpperCase().replace('SUB-HIRE DRIVER', 'SUBHIRE DR').replace('SUB-HIRE', 'SUBHIRE').replace('AIRPORT FEE', 'AIRPORT FEE'));
  const head = ['MONTH', ...cols, 'TOTAL SPENT', 'BILLED', 'DAYS'];
  head.forEach((h, i) => { const c = ws.getCell(1, i + 1); c.value = h; c.font = { bold: true }; c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; ws.getColumn(i + 1).width = i === 0 ? 18 : 13; });
  const tot = new Array(head.length - 1).fill(0);
  if(list.length){
    monthlySummary(db, list[0], list[list.length - 1]).forEach((m, n) => {
      const vals = SUMMARY_COLUMNS.map(c => num(m[c.key])), spent = vals.reduce((s, v) => s + v, 0), row = [...vals, spent, num(m.billed), num(m.days)];
      ws.getCell(n + 2, 1).value = monthTitle(m.month);
      row.forEach((v, i) => { const c = ws.getCell(n + 2, i + 2); c.value = v || null; c.numFmt = '#,##0'; tot[i] += v; });
    });
    const tr = list.length ? monthlySummary(db, list[0], list[list.length - 1]).length + 2 : 2;
    ws.getCell(tr, 1).value = 'TOTAL'; ws.getCell(tr, 1).font = { bold: true };
    tot.forEach((v, i) => { const c = ws.getCell(tr, i + 2); c.value = v; c.numFmt = '#,##0'; c.font = { bold: true }; });
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

/* what Save writes, in your workbook's order: [key, sheet name, builder, label] */
export const OWNER_SHEETS = [
  ['ownCarPerformance', 'CAR PERFORMANCE', addCarPerformance, 'Every rental: client, car, driver, out/in, days, fuel, amount, sub-hire (your CAR PERFORMANCE)'],
  ['ownCoop', 'COOP', addCoopSheet, 'Coop hires by month: name, dates, days, amount, driver, allowance, fuel, cont no (your COOP)'],
  ['ownFuel', 'FUEL SHEET', addFuelSheet, 'Every fuel fill with its account, and money paid in (your FUEL)'],
  ['ownCarwash', 'CARWASH', addCarwash, 'Carwash by month (your CARWASH)'],
  ['ownTransport', 'TRANSPORT', addTransport, 'Transport by month (your TRANSPORT)'],
  ['ownGarage', 'GARAGE', addGarage, 'Garage items by month (your GARAGE)'],
  ['ownAirport', 'AIRPORT FEE', addAirport, 'Airport fees by month (your AIRPORT FEE)'],
  ['ownAllowance', 'ALLOWANCE', addAllowance, 'Allowances drawn from the rentals (your ALLOWANCE)'],
  ['ownInvoice', 'INVOICE', addInvoice, 'Invoices by month with status and VAT (your INVOICE)'],
  ['ownInsurance', 'INSURANCE SHEET', addInsurance, 'Insurance paid, with expiry when entered (your INSURANCE)'],
  ['ownOchwada', 'OCHWADA', addOchwada, 'OCHWADA statement: BF, charges, payments (your OCHWADA)'],
  ['ownWalkin', 'WALK-IN', addWalkin, 'Walk-in client hires (your Sheet2)'],
  ['ownOverview', 'OVERVIEW', addOverview, 'Month by month totals per cost (your Sheet1)']
];
