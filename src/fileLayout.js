/* The saved Excel file: the sheets that mirror your own workbook (SUBHIRE, SUBHIRE DRIVER, LOAN) and the
   "how should my file look" choices: which tabs are shown, in which order, and which columns are visible.
   Hidden tabs and hidden columns are still saved inside the file, so Open always restores everything. */
import { ownerRows, driverRows, STATUS_LABEL } from './subhireCore.js';
import { OWNER_SHEETS } from './ownerSheets.js';
import { loanTotals, loanMonths, getCell, persons, loanName, monthName } from './loans.js';

const num = v => Number(v) || 0;
const lab = s => STATUS_LABEL[s] || s || '';

/* columns of the two single-table sheets: key, heading, value from a row */
export const SUBHIRE_COLS = [
  ['month', 'MONTH'], ['reg', 'CAR'], ['owner', 'OWNER'], ['job', 'JOB'], ['client', 'CLIENT'], ['dates', 'DATES'], ['days', 'DAYS'],
  ['billed', 'BILLED'], ['cost', 'AMOUNT TO OWNER'], ['status', 'STATUS'], ['statusDate', 'DATE'], ['driver', 'DRIVER']
];
export const SUBHIRE_DRIVER_COLS = [
  ['month', 'MONTH'], ['driver', 'DRIVER'], ['client', 'CLIENT'], ['clientType', 'CLIENT TYPE'], ['reg', 'CAR'], ['dates', 'DATES'], ['days', 'DAYS'],
  ['rate', 'PER DAY'], ['amount', 'AMOUNT'], ['status', 'STATUS'], ['statusDate', 'DATE']
];
const MONEY = new Set(['billed', 'cost', 'rate', 'amount']);

/* sheets that exist only in the saved file and are drawn from the live data */
export const EXTRA_SHEETS = [
  ...OWNER_SHEETS.map(([key, name, , sub]) => ({ key, name, sub, cols: null })),
  { key: 'subhire', name: 'SUBHIRE', sub: 'Sub-hired cars: owner, job, days, amount, paid or not, date (like your SUBHIRE sheet)', cols: SUBHIRE_COLS },
  { key: 'subhireDriver', name: 'SUBHIRE DRIVER', sub: 'Sub-hire drivers: client, car, days, amount, status, date (like your SUBHIRE DRIVER sheet)', cols: SUBHIRE_DRIVER_COLS },
  { key: 'loanSheet', name: 'LOAN', sub: 'Loans, monthly instalments and the individuals (LAWYER, WIN, SAM...) together, like your LOAN sheet', cols: null }
];

const THIN = { style: 'thin', color: { argb: 'FFBFBFBF' } };
function head(ws, r, c) { const cell = ws.getCell(r, c); cell.font = { bold: true }; cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; }

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const monthTitle = ym => /^\d{4}-\d{2}$/.test(ym) ? MONTH_NAMES[Number(ym.slice(5)) - 1] + ' ' + ym.slice(0, 4) : 'NO DATE';

/* one table, with a band before each month ("▼ OCTOBER 2026 (n)") and a total after it, like the data sheets of the database */
function tableSheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name);
  ws.addRow(cols.map(c => c[1]));
  cols.forEach((c, i) => head(ws, 1, i + 1));
  const SUM = new Set(['days', 'billed', 'cost', 'amount']);
  const sumRow = (label, list) => cols.map(([k], i) => i === 0 ? label : SUM.has(k) ? list.reduce((t, r) => t + (((k === 'cost' || k === 'amount') && r.status === 'cancelled') ? 0 : num(r[k])), 0) : '');
  const by = new Map(); rows.forEach(r => { const k = /^\d{4}-\d{2}$/.test(String(r.month || '')) ? r.month : 'zzzz'; (by.get(k) || by.set(k, []).get(k)).push(r); });
  [...by.keys()].sort().forEach(k => {
    const list = by.get(k), t = monthTitle(k);
    const band = ws.addRow(cols.map((c, i) => i === 0 ? '\u25BC ' + t + '  (' + list.length + ')' : ''));
    band.font = { bold: true }; for (let c = 1; c <= cols.length; c++) band.getCell(c).border = { bottom: THIN };
    list.forEach(r => { ws.addRow(cols.map(([key]) => key === 'status' ? lab(r[key]) : (r[key] == null ? '' : r[key]))).outlineLevel = 1; });
    const mt = ws.addRow(sumRow(t + ' total', list)); mt.font = { bold: true, italic: true }; mt.outlineLevel = 1;
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  const tr = ws.addRow(sumRow('TOTAL', rows)); tr.font = { bold: true };
  cols.forEach(([k], i) => { ws.getColumn(i + 1).width = k === 'job' || k === 'client' || k === 'dates' || k === 'owner' ? 26 : 14; if (MONEY.has(k)) ws.getColumn(i + 1).numFmt = '#,##0'; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

/* Sub-hire driver costs keyed under Expenses (category "Sub-hire driver", e.g. "Sub-hire driver DENIS - VF 7TH-9TH") that are not
   tied to a rental: they were paid, so they are listed here too and the sheet matches the Sub-hire driver page and the database. */
function expenseDriverRows(db) {
  const reg = id => ((db.vehicles || []).find(v => String(v.id) === String(id)) || {}).reg || '';
  return (db.expenses || []).filter(x => x.category === 'Sub-hire driver' && x.source !== 'rental').map(x => {
    const text = String(x.desc || '').replace(/^\s*sub-?hire driver\s*/i, '').trim(), m = text.match(/^(.*?)\s+[-\u2013]\s+(.*)$/);
    return { id: 'x' + x.id, month: String(x.date || '').slice(0, 7), driver: (m ? m[1] : text) || '(not named)', client: '', clientType: 'from Expenses', reg: reg(x.vehicleId), pickup: x.date || '', dates: m ? m[2] : (x.date || ''), days: '', rate: '', amount: num(x.amount), status: 'paid', statusDate: x.date || '' };
  });
}

export function addSubhireSheet(wb, db) { return tableSheet(wb, 'SUBHIRE', SUBHIRE_COLS, ownerRows(db)); }
export function addSubhireDriverSheet(wb, db) { return tableSheet(wb, 'SUBHIRE DRIVER', SUBHIRE_DRIVER_COLS, driverRows(db).concat(expenseDriverRows(db)).sort((a, b) => (a.pickup || '') < (b.pickup || '') ? -1 : (a.pickup || '') > (b.pickup || '') ? 1 : 0)); }

/* LOAN: three blocks one under the other, like the sheet: the loans, the months, then each individual */
export function addLoanSheet(wb, db) {
  const ws = wb.addWorksheet('LOAN'), loans = db.loans || [];
  let r = 1;
  const title = t => { ws.getCell(r, 1).value = t; ws.getCell(r, 1).font = { bold: true, size: 13 }; r++; };
  const row = (vals, bold) => { vals.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; if (bold) c.font = { bold: true }; if (typeof v === 'number') c.numFmt = '#,##0'; }); r++; };
  const headRow = vals => { vals.forEach((v, i) => { ws.getCell(r, i + 1).value = v; head(ws, r, i + 1); }); r++; };

  title('LOANS');
  headRow(['NAME', 'FOR', 'BORROWED', 'DUE DAY', 'SCHEDULED', 'PAID', 'BALANCE', 'NOTE']);
  let b = 0, s = 0, p = 0, bal = 0;
  loans.forEach(l => { const t = loanTotals(l); b += num(l.borrowed); s += t.scheduled; p += t.paid; bal += t.balance; row([l.lender || '', l.item || '', num(l.borrowed), num(l.dueDay) || '', t.scheduled, t.paid, t.balance, l.note || '']); });
  row(['TOTAL', '', b, '', s, p, bal, ''], true);
  r++;

  title('MONTHLY INSTALMENTS');
  headRow(['MONTH'].concat(loans.map(loanName), ['ALL LOANS']));
  const colTot = loans.map(() => 0); let all = 0;
  loanMonths(db).forEach(m => { const vals = loans.map(l => getCell(l, m)); vals.forEach((v, i) => { colTot[i] += v; }); const t = vals.reduce((a, v) => a + v, 0); all += t; row([monthName(m)].concat(vals, [t])); });
  row(['TOTAL'].concat(colTot, [all]), true);
  r++;

  title('INDIVIDUALS');
  const people = persons(db);
  if (!people.length) row(['(none)']);
  people.forEach(pp => {
    row([pp.name, '', pp.balance === 0 ? 'cleared' : pp.balance], true);
    pp.lines.forEach(x => row([x.date || '', num(x.amount), x.note || '']));
    r++;
  });
  [30, 24, 16, 14, 14, 14, 14, 24].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return ws;
}

/* ---------------- layout choices ---------------- */
/* a hidden data tab still restores: Individuals is shown inside LOAN, so its own tab starts hidden */
export const DEFAULT_HIDDEN = { Individuals: true };

export function normalizeLayout(raw) {
  const has = raw && typeof raw === 'object' && !Array.isArray(raw);
  const out = { order: [], hiddenSheets: Object.assign({}, DEFAULT_HIDDEN), hiddenCols: {} };
  if (!has) return out;
  if (Array.isArray(raw.order)) out.order = [...new Set(raw.order.filter(x => typeof x === 'string' && x))];
  if (raw.hiddenSheets && typeof raw.hiddenSheets === 'object') { out.hiddenSheets = {}; Object.keys(raw.hiddenSheets).forEach(k => { if (raw.hiddenSheets[k] === true || raw.hiddenSheets[k] === 'true') out.hiddenSheets[k] = true; }); }
  if (raw.hiddenCols && typeof raw.hiddenCols === 'object') Object.keys(raw.hiddenCols).forEach(sh => {
    const m = raw.hiddenCols[sh]; if (!m || typeof m !== 'object') return;
    const keep = {}; Object.keys(m).forEach(k => { if (m[k] === true || m[k] === 'true') keep[k] = true; }); if (Object.keys(keep).length) out.hiddenCols[sh] = keep;
  });
  return out;
}

/* Preserve chosen order while keeping restore-critical tables together and metadata at the end. */
export function orderedNames(normal, layout) {
  const known = new Set(normal), first = (layout.order || []).filter(n => known.has(n));
  const ordered = first.concat(normal.filter(n => !first.includes(n)));
  const coreTables = ['Vehicles', 'Drivers', 'Clients', 'Bookings', 'Rentals'].filter(n => known.has(n));
  const finalTabs = ['Meta', 'Settings'].filter(n => known.has(n));
  const fixed = new Set([...coreTables, ...finalTabs]);
  const movable = ordered.filter(n => !fixed.has(n));
  const fuelIndex = movable.indexOf('FuelAccount');
  if (fuelIndex < 0) return movable.concat(coreTables, finalTabs);
  return movable.slice(0, fuelIndex + 1).concat(coreTables, movable.slice(fuelIndex + 1), finalTabs);
}

/* colKeys: { sheetName: [column keys in file order] } for the sheets whose columns can be hidden */
export function applyLayout(wb, layout, colKeys, normalOrder) {
  const names = orderedNames(normalOrder, layout), sheets = {};
  wb.worksheets.forEach(ws => { sheets[ws.name] = ws; });
  names.forEach((n, i) => { if (sheets[n]) sheets[n].orderNo = i + 1; });
  let shown = 0;
  names.forEach(n => { const ws = sheets[n]; if (!ws) return; if (layout.hiddenSheets[n]) ws.state = 'hidden'; else shown++; });
  if (!shown) names.some(n => { if (sheets[n]) { sheets[n].state = 'visible'; return true; } return false; });   // never a file with every tab hidden
  Object.keys(layout.hiddenCols || {}).forEach(n => {
    const ws = sheets[n], keys = colKeys[n]; if (!ws || !keys) return;
    const hide = layout.hiddenCols[n]; if (keys.every(k => hide[k])) return;                                      // never hide every column
    keys.forEach((k, i) => { if (hide[k]) ws.getColumn(i + 1).hidden = true; });
  });
}
