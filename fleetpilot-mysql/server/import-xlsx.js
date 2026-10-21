// Usage: node import-xlsx.js "path/to/Fleet Ledger.xlsx"
// Reads the app's data sheets (Vehicles, Drivers, ... Meta, Settings) and loads them into MySQL.
import ExcelJS from 'exceljs';
import { saveState } from './ledgerStore.js';
import { pool } from './db.js';

const SHEETS = {
  Vehicles: ['vehicles', ['id','reg','make','model','year','rate','owner','status']],
  Drivers: ['drivers', ['id','name','phone','license','vehicleId','allowance','status']],
  Clients: ['clients', ['id','name','phone','idnum','dl']],
  Bookings: ['bookings', ['id','vehicleId','clientId','bookedOn','pickup','return','deposit','status','reminderAck']],
  Rentals: ['rentals', ['id','vehicleId','clientId','contract','invoice','receipt','pickup','pickupTime','return','returnTime','rate','days','mileage','amount','status','fuel','fuelCharge']],
  Expenses: ['expenses', ['id','vehicleId','date','category','desc','qty','amount','billable','billClientId','chargeAmount','source','rentalId']],
  Payments: ['payments', ['id','rentalId','date','amount','method','note']],
  DriverAllowances: ['driverAllowances', ['id','driverId','weekStart','amount','note']]
};

function cellValue(c) {
  let v = c.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;
  }
  if (v instanceof Date) v = v.toISOString().slice(0, 10);
  return v === undefined || v === null ? '' : v;
}

function readSheet(wb, name, cols) {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const header = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, n) => { header[n] = String(cellValue(c)).trim(); });
  const rows = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const o = {}; let any = false;
    cols.forEach(k => { const idx = header.indexOf(k); if (idx > 0) { o[k] = cellValue(row.getCell(idx)); if (o[k] !== '') any = true; } });
    if (any) rows.push(o);
  });
  return rows;
}

const file = process.argv[2];
if (!file) { console.error('Usage: node import-xlsx.js <ledger.xlsx>'); process.exit(1); }

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const state = { settings: { adminPin: null, chartType: 'pie', includeStatement: true, includeExpenseReport: false, includeFuelReport: false, includeTotals: true }, nextId: 1, period: null, lastModified: null };
for (const [sheet, [key, cols]] of Object.entries(SHEETS)) state[key] = readSheet(wb, sheet, cols);

const meta = readSheet(wb, 'Meta', ['nextId'])[0];
if (meta && Number(meta.nextId) > 0) state.nextId = Number(meta.nextId);
const SETTINGS_COLS = ['adminPin','chartType','includeStatement','includeExpenseReport','includeFuelReport','includeTotals','periodStart','periodLabel','dashboardWidgets','lastModified'];
const s = readSheet(wb, 'Settings', SETTINGS_COLS)[0];
const isTrue = v => v === true || v === 'true' || v === 1 || v === '1';
const isFalse = v => v === false || v === 'false' || v === 0 || v === '0';
if (s) {
  if (s.adminPin) state.settings.adminPin = String(s.adminPin);
  if (s.chartType === 'pie' || s.chartType === 'bar') state.settings.chartType = s.chartType;
  state.settings.includeStatement = !isFalse(s.includeStatement);
  state.settings.includeExpenseReport = isTrue(s.includeExpenseReport);
  state.settings.includeFuelReport = isTrue(s.includeFuelReport);
  state.settings.includeTotals = !isFalse(s.includeTotals);
  if (s.periodStart) {
    const [y, m] = String(s.periodStart).split('-').map(Number);
    if (y && m) {
      const pad = n => String(n).padStart(2, '0');
      const last = new Date(y, m, 0).getDate();
      const label = s.periodLabel || new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      state.period = { year: y, month: m - 1, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}`, label };
    }
  }
  if (s.dashboardWidgets) { try { const w = JSON.parse(s.dashboardWidgets); if (Array.isArray(w)) state.settings.dashboardWidgets = w; } catch {} }
  state.lastModified = s.lastModified || null;
}
// If no period was stored the app infers one from the data on first load, so null is fine.

const result = await saveState(state, { fileName: file.split(/[\\/]/).pop(), workbookDirty: false, force: true });
for (const k of Object.keys(SHEETS).map(n => SHEETS[n][0])) console.log(k.padEnd(18), state[k].length);
if (result.warnings.length) { console.log('\nWarnings:'); result.warnings.forEach(w => console.log(' -', w)); }
console.log('\nImported. Revision', result.revision);
await pool.end();
