/* COOP sheet (who hired under COOP), the walk-in client table on Sheet2, the OCHWADA statement, and the standing rent on Sheet1.
   Read only: nothing here changes the workbook. Dates such as "9TH-11TH" become real start and end dates. */
import { isNum, isStr, num, dateOf, parseDayRange, monthIndex, normReg, normName, makeReview } from './util.js';
import { REPORT_YEAR } from './rentals.js';

/* ---------- COOP: one block per month, header NAME | DATE | DAYS | AMOUNT | DRIVER | ALLOWANCE | FUEL | CONT NO ---------- */
export function parseCoopSheet(rows){
  const hires = []; let month = null;
  rows.forEach((r, i) => {
    if(!r) return;
    const filled = r.filter(c => c !== null);
    if(filled.length === 1 && isStr(filled[0]) && monthIndex(filled[0]) >= 0){ month = monthIndex(filled[0]); return; }
    if(r[1] === 'NAME' || month === null || !isStr(r[1]) || !isNum(r[3]) || !isNum(r[4])) return;
    let start = dateOf(r[2]), end = start;
    if(!start){ const pr = parseDayRange(r[2], REPORT_YEAR, month); if(pr){ start = pr.start; end = pr.end; } }
    else if(Number(start.slice(0, 4)) !== REPORT_YEAR){ start = REPORT_YEAR + start.slice(4); end = start; }
    /* column J is DEPARTMENT in the newest blocks; in the older ones an unlabelled number sits there: a repeat of the contract number,
       or the amount with 16% VAT added. Neither is lost: VAT-inclusive amounts are kept, repeats are dropped. */
    const dept = isStr(r[9]) ? r[9].trim() : '';
    let withVat = 0, note = '';
    if(isNum(r[9])){ if(String(r[9]) === String(r[8])) { /* repeat of the contract number */ } else if(Math.abs(r[9] - r[4] * 1.16) <= 1.5) withVat = r[9]; else note = 'Unlabelled figure beside CONT NO: ' + r[9]; }
    hires.push({ key: 'CO' + (i + 1), xlRow: i + 1, month, name: normName(r[1]), start: start || '', end: end || '', days: r[3], amount: r[4],
      driverPay: num(r[5]) || 0, allowance: num(r[6]) || 0, fuel: num(r[7]) || 0, contract: r[8] === null ? '' : String(r[8]),
      department: dept, kmOut: isNum(r[10]) ? r[10] : 0, kmIn: isNum(r[11]) ? r[11] : 0, withVat, note });
  });
  return hires;
}

/* Give each CAR PERFORMANCE "COOP" rental the person's name and contract number from the COOP sheet.
   Same start date, amount and days first; then same start date and amount. One to one, in sheet order. */
export function matchCoopHires(rentals, hires, review){
  const pool = rentals.filter(r => !r.excluded && String(r.client).toUpperCase() === 'COOP');
  /* CAR PERFORMANCE bills the COOP rate plus the driver's pay, so AMOUNT + DRIVER on the COOP sheet = AMOUNT there.
     Passes run from strictest to loosest; a rental is only ever used once. */
  const passes = [
    [h => [h.start, h.days, h.amount + h.driverPay].join('|'), r => [r.pickup, r.days, r.amount].join('|')],
    [h => [h.start, h.days, h.amount].join('|'),               r => [r.pickup, r.days, r.amount].join('|')],
    [h => [h.start, h.amount + h.driverPay].join('|'),         r => [r.pickup, r.amount].join('|')],
    [h => [h.start, h.amount].join('|'),                       r => [r.pickup, r.amount].join('|')]
  ];
  passes.forEach(([hk, rk]) => hires.forEach(h => {
    if(h.matched) return;
    const r = pool.find(x => !x.coopHire && rk(x) === hk(h));
    if(r){ r.coopHire = h.key; r.coopName = h.name; r.contract = h.contract; h.matched = r.key; }
  }));
  /* last resort: same start date and same days, and only one rental left that fits */
  hires.forEach(h => {
    if(h.matched) return;
    const c = pool.filter(x => !x.coopHire && x.pickup === h.start && x.days === h.days);
    if(c.length === 1){ c[0].coopHire = h.key; c[0].coopName = h.name; c[0].contract = h.contract; h.matched = c[0].key; }
  });
  hires.filter(h => !h.matched).forEach(h => makeReview(review, { code: 'COOP_UNMATCHED', recKey: h.key, sheet: 'COOP', row: h.xlRow, severity: 'medium',
    problem: 'COOP line has no matching rental in CAR PERFORMANCE', detail: `${h.name} ${h.start} ${h.days} day(s), ${h.amount}, contract ${h.contract}.`,
    who: h.name, pickup: h.start, return: h.end, days: h.days, amount: h.amount, choices: [{ label: 'Noted, leave out', keep: true }] }));
  pool.filter(r => !r.coopHire).forEach(r => makeReview(review, { code: 'COOP_NO_NAME', recKey: r.key, sheet: 'CAR PERFORMANCE', row: r.xlRow, severity: 'medium',
    problem: 'COOP rental has no matching line on the COOP sheet', detail: `${r.reg} ${r.pickup}, ${r.days} day(s), ${r.amount}: the person is unknown.`,
    who: 'COOP', reg: r.reg, pickup: r.pickup, return: r.return, days: r.days, amount: r.amount, choices: [] }));
  return { matched: hires.filter(h => h.matched).length, hires: hires.length, rentals: pool.length };
}

/* ---------- Sheet2: the client table (CARS REGISTRATION | DRIVER | NUMBER | CLIENT | NUMBER | AREA) ---------- */
export function parseWalkinTable(rows){
  const h = rows.findIndex(r => r && r[2] === 'CARS REGISTRATION');
  if(h < 0) return [];
  const out = [];
  for(let i = h + 1; i < rows.length; i++){
    const r = rows[i]; if(!r || !isStr(r[5]) || !r[5].trim()) continue;
    out.push({ key: 'WI' + (i + 1), xlRow: i + 1, reg: normReg(r[2]), driverName: isStr(r[3]) ? r[3].trim().toUpperCase() : '', driverPhone: r[4] === null ? '' : String(r[4]),
      name: normName(r[5]), phone: r[6] === null ? '' : String(r[6]), area: isStr(r[7]) ? r[7].trim().toUpperCase() : '' });
  }
  return out;
}

/* ---------- OCHWADA: month blocks. AMOUNT | DATES. First line BF (balance brought forward), then charges (+) and payments (-), then TOTAL ---------- */
export function parseOchwada(rows){
  const blocks = []; let month = null, cur = null;
  rows.forEach((r, i) => {
    if(!r) return;
    if(isStr(r[1]) && monthIndex(r[1]) >= 0){ month = monthIndex(r[1]); return; }
    if(r[1] === 'AMOUNT' && r[2] === 'DATES'){ cur = { month, rowFrom: i + 1, bf: null, entries: [], sheetTotal: null, rowTo: null }; blocks.push(cur); return; }
    if(!cur || !isNum(r[1])) return;
    const label = r[2];
    if(label === 'BF'){ cur.bf = r[1]; return; }
    if(label === 'TOTAL'){ cur.sheetTotal = r[1]; cur.rowTo = i + 1; return; }
    let date = dateOf(label), end = date;
    if(!date && month !== null){ const pr = parseDayRange(label, REPORT_YEAR, month); if(pr){ date = pr.start; end = pr.end; } }
    cur.entries.push({ xlRow: i + 1, date: date || '', end: end || '', amount: r[1], kind: r[1] < 0 ? 'payment' : 'charge', label: isStr(r[3]) ? r[3] : (isStr(label) ? label : '') });
  });
  return blocks.filter(b => b.bf !== null || b.entries.length);
}

/* ---------- Sheet1: the standing RENT figure (same every month) ---------- */
export function parseStandingRent(rows){
  const h = rows.findIndex(r => r && r[0] === 'MONTH');
  if(h < 0) return null;
  const c = rows[h].indexOf('RENT'); if(c < 0) return null;
  const vals = []; const months = [];
  for(let i = h + 1; i < rows.length && rows[i] && isStr(rows[i][0]) && rows[i][0] !== 'TOTAL'; i++){ if(isNum(rows[i][c])){ vals.push(rows[i][c]); months.push(rows[i][0]); } }
  if(!vals.length || new Set(vals).size !== 1) return null;
  return { amount: vals[0], months: vals.length, firstMonth: months[0] };
}
