/* Cost sheets: FUEL, CARWASH, TRANSPORT, GARAGE, AIRPORT FEE, ALLOWANCE, SUBHIRE DRIVER.
   Each parser returns plain records; checking and fixing happen in index.js. */
import { isNum, isStr, num, dateOf, normReg, normName, monthIndex, parseDayRange, REG_RE } from './util.js';
import { REPORT_YEAR } from './rentals.js';

const exp = (key, sheet, row, o) => Object.assign({ key, sheet, xlRow: row, category: 'Other', reg: '', desc: '', date: null, amount: 0, excluded: false }, o);

/* Registration-like text in a cell (rejects names such as WILLICE or OFFICE). */
const plateish = v => isStr(v) && /^K[A-Z]{2}\s?\d{2,3}[A-Z]{0,2}$/i.test(v.trim());

/* FUEL is a running account with the fuel station.
   - Blue figures with no plate (col B, with a date) are TOP-UPS: money paid into the account. They are not expenses.
   - Figures with a plate (col D) are FILLS: the real fuel expense per car (col F, or the negative in col C).
   - The first undated negative figure in col C is the OPENING balance carried from last year (negative = owed to the station).
   - A plate line with only a POSITIVE col C is the same fill listed again in a later block. It is still read as a fill
     (nothing is dropped here) but is marked `repeat`, and the importer asks the owner whether to keep it.
   Closing rows and carried figures are only used to check the totals. */
export function parseFuel(rows){
  const out = [], closings = [], carries = [], topups = [], repeats = [];
  let opening = null;
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    const date = dateOf(r[4]);
    if(plateish(r[3])){
      const hasF = isNum(r[5]);
      const amount = hasF ? r[5] : (isNum(r[2]) ? Math.abs(r[2]) : null);
      if(amount === null) return;
      const e = exp('FU' + (i + 1), 'FUEL', i + 1, { category: 'Fuel', reg: normReg(r[3]), date, amount, desc: 'Fuel' });
      if(!hasF && isNum(r[2]) && r[2] > 0){ e.repeat = true; repeats.push(e); }
      out.push(e);
      return;
    }
    if(isNum(r[1]) && r[1] > 0 && !r[3] && !isNum(r[5])){        // a top-up: money paid into the fuel account
      topups.push({ key: 'FT' + (i + 1), sheet: 'FUEL', xlRow: i + 1, date, amount: r[1], excluded: false });
      return;
    }
    if(!opening && !r[1] && !r[3] && !r[4] && !isNum(r[5]) && isNum(r[2]) && r[2] < 0){ opening = { key: 'FO' + (i + 1), row: i + 1, amount: r[2] }; return; }
    if(!r[3] && !r[4] && isNum(r[5]) && !isNum(r[1]) && !isNum(r[2])){ carries.push({ row: i + 1, amount: r[5] }); return; }
    if(!r[3] && !r[4] && isNum(r[5]) && (isNum(r[1]) || isNum(r[2]))) closings.push({ row: i + 1, spent: r[5], topups: num(r[1]) || 0, balance: num(r[2]), after: out.length, topupsAfter: topups.length });
  });
  return { expenses: out, closings, carries, topups, opening, repeats };
}

/* CARWASH / TRANSPORT: [ ,name or plate, amount, date ]; rows without a name are monthly totals. */
export function parseSimpleList(rows, sheet, category, prefix){
  const out = [], totals = [];
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    if(!r[1] && isNum(r[2])){ totals.push({ row: i + 1, total: r[2], after: out.length }); return; }
    if(!r[1] || !isNum(r[2])) return;
    const asReg = plateish(r[1]) ? normReg(r[1]) : '';
    out.push(exp(prefix + (i + 1), sheet, i + 1, { category, reg: asReg, date: dateOf(r[3]), amount: r[2],
      desc: asReg ? category : category + ' - ' + r[1] }));
  });
  return { expenses: out, totals };
}

/* GARAGE: a line with a registration starts a job; the lines under it (no registration) are more items of that job. */
export function parseGarage(rows){
  const out = [];
  let reg = '', date = null, datedFrom = 0;
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    if(r[1] === 'REGISTRATION') return;
    const item = isStr(r[2]) ? r[2] : '';
    if(!isNum(r[3]) && !item){ return; }
    if(r[1]){ reg = normReg(r[1]); date = dateOf(r[4]); datedFrom = i + 1; }
    else if(dateOf(r[4])) date = dateOf(r[4]);
    if(!isNum(r[3])) return;
    out.push(exp('GA' + (i + 1), 'GARAGE', i + 1, { category: 'Garage', reg, date, amount: r[3], desc: item || 'Garage',
      dateFromJob: !dateOf(r[4]) && !r[1] ? false : undefined, jobRow: datedFrom }));
  });
  return { expenses: out };
}

/* AIRPORT FEE: three side-by-side tables. A = [plate, amount, who, date], B and C = [item, amount, date]. */
export function parseAirportFee(rows){
  const out = [], totals = [];
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    if(r[1] === 'TOTAL'){ totals.push({ row: i + 1, a: num(r[2]), b: num(r[7]), c: num(r[11]) }); return; }
    if(r[1] && isNum(r[2])){
      const reg = plateish(r[1]) ? normReg(r[1]) : '';
      out.push(exp('AF' + (i + 1) + 'a', 'AIRPORT FEE', i + 1, { category: 'Airport', reg, date: dateOf(r[4]), amount: r[2], desc: 'Airport fee' + (isStr(r[3]) ? ' - ' + r[3] : '') }));
    }
    if(isStr(r[6]) && isNum(r[7])) out.push(exp('AF' + (i + 1) + 'b', 'AIRPORT FEE', i + 1, { category: 'Other', date: dateOf(r[8]), amount: r[7], desc: r[6] }));
    if(isStr(r[10]) && isNum(r[11])) out.push(exp('AF' + (i + 1) + 'c', 'AIRPORT FEE', i + 1, { category: 'Other', date: dateOf(r[12]), amount: r[11], desc: r[10] }));
  });
  return { expenses: out, totals };
}

/* Month heading rows: a single non-empty cell holding a month name. */
function headingMonth(r){
  const cells = r.filter(c => c !== null);
  if(cells.length !== 1 || !isStr(cells[0])) return -1;
  return monthIndex(cells[0]);
}

/* ALLOWANCE: [ ,driver, client, amount, dates ] under month headings. */
export function parseAllowance(rows){
  const out = []; let month = -1;
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    const h = headingMonth(r); if(h >= 0){ month = h; return; }
    if(r[1] === 'DRIVER' || r[1] === 'TOTAL') return;
    if(!isStr(r[1]) || !isNum(r[3])) return;
    let start = dateOf(r[4]); const raw = r[4];
    if(!start && month >= 0){ const pr = parseDayRange(raw, REPORT_YEAR, month); if(pr) start = pr.start; }
    out.push({ key: 'AL' + (i + 1), sheet: 'ALLOWANCE', xlRow: i + 1, driver: normName(r[1]), client: normName(r[2]), amount: r[3],
      datesRaw: isStr(raw) ? raw : '', date: start, month, excluded: false });
  });
  return out;
}

/* SUBHIRE DRIVER: [ ,driver, client, dates, days, amount, status, paid date ] under month headings. */
export function parseSubhireDriver(rows){
  const out = []; let month = -1;
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    const h = headingMonth(r); if(h >= 0){ month = h; return; }
    if(r[1] === 'DRIVER' || r[1] === 'TOTAL') return;
    if(!isStr(r[1]) || !isNum(r[5])) return;
    let start = dateOf(r[3]); const raw = r[3];
    if(!start && month >= 0){ const pr = parseDayRange(raw, REPORT_YEAR, month); if(pr) start = pr.start; }
    out.push(exp('SD' + (i + 1), 'SUBHIRE DRIVER', i + 1, { category: 'Sub-hire driver', date: start, amount: r[5],
      desc: 'Sub-hire driver ' + r[1] + (isStr(r[2]) ? ' - ' + r[2] : '') + (isStr(raw) ? ' ' + raw : ''),
      driver: normName(r[1]), client: isStr(r[2]) ? normName(r[2]) : '', days: isNum(r[4]) ? r[4] : null, statusRaw: r[6] === null ? '' : String(r[6]), month, paid: r[6] === 'PAID', paidDate: dateOf(r[7]) }));
  });
  return out;
}
