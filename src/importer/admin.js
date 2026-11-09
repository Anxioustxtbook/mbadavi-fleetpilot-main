/* Admin sheets: LOAN, INSURANCE, CHAMA. These feed the PIN-protected Admin area. */
import { isNum, isStr, isDate, num, dateOf, normReg, monthIndex, addDays, REG_RE } from './util.js';
import { REPORT_YEAR } from './rentals.js';

const plateish = v => isStr(v) && /^K[A-Z]{2}\s?\d{3}[A-Z]$/i.test(v.trim());

/* LOAN: loan names sit on one row (a lender, or the car the loan was taken for), the amount borrowed on the next,
   then one row per month with the instalment as a negative number. The first month row is February of the
   report year and the year rolls over whenever the month number goes backwards. */
export function parseLoans(rows){
  const hdr = rows.findIndex(r => r.filter(c => isStr(c)).length >= 4 && r.some(c => isStr(c) && /^(NCBA|JUHUDI|MOMENTUM)$/i.test(c)));
  if(hdr < 0 || !rows[hdr + 1]) return { loans: [], dueList: [], found: false, firstMonth: null, lastMonth: null, other: [] };
  const names = rows[hdr], amounts = rows[hdr + 1];
  const cols = [];
  for(let c = 2; c < names.length; c++) if(isStr(names[c]) && isNum(amounts[c])) cols.push(c);
  const loans = cols.map(c => {
    const label = names[c].toUpperCase();
    const isPlate = plateish(label);
    return { key: 'LN' + (c + 1), col: c, label, lender: isPlate ? '' : label, vehicleReg: isPlate ? normReg(label) : '',
      principal: amounts[c], schedule: [], dueDay: null, dueAmount: null };
  });
  // monthly schedule
  let year = REPORT_YEAR, prev = -1, firstMonth = null, lastMonth = null, r = hdr + 2, lastRow = hdr + 1;
  for(; r < rows.length; r++){
    const row = rows[r]; if(!row) continue;
    const m = monthIndex(row[1]);
    if(m < 0){
      if(row.every(c => c === null)) { if(lastRow > hdr + 1 && r - lastRow > 1) break; continue; }
      break;
    }
    if(m <= prev) year++;
    prev = m; lastRow = r;
    const ym = year + '-' + String(m + 1).padStart(2, '0');
    if(!firstMonth) firstMonth = ym; lastMonth = ym;
    loans.forEach(l => { const v = row[l.col]; if(isNum(v) && v < 0) l.schedule.push({ month: ym, amount: -v, paid: false }); });
  }
  // "due this month" table: [no, name or car, due amount, day of month, paid so far]
  const dueList = [], other = [];
  for(let i = r; i < rows.length; i++){
    const row = rows[i]; if(!row) continue;
    if(isNum(row[1]) && isStr(row[2]) && isNum(row[3]) && isStr(row[4]) && /^\d{1,2}(ST|ND|RD|TH)$/i.test(row[4]))
      dueList.push({ row: i + 1, name: row[2].toUpperCase(), due: row[3], day: parseInt(row[4], 10), paid: num(row[5]) || 0 });
  }
  const strRow = rows.findIndex((x, i) => i > r && x && x.filter(c => isStr(c)).length >= 4 && !x.includes('DRIVER'));
  if(strRow >= 0) other.push({ row: strRow + 1, note: 'Running balances for ' + rows[strRow].filter(c => isStr(c)).join(', ') + ' (rows ' + (strRow + 1) + '-' + rows.length + ')' });
  // attach the due day to the matching loan
  dueList.forEach(d => {
    let l = loans.find(x => x.vehicleReg && x.label === d.name);
    if(!l) l = loans.find(x => !x.dueDay && x.schedule.some(s => s.month === '2026-10' && s.amount === d.due));
    if(l && !l.dueDay){ l.dueDay = d.day; l.dueAmount = d.due; if(!l.lender && !/^K/.test(d.name)) l.lender = d.name === 'MOMENT' ? 'MOMENTUM' : d.name; }
  });
  return { loans, dueList, found: true, firstMonth, lastMonth, other };
}

/* INSURANCE: [no, registration, amount, date] until the first blank, then a TOTAL row. The sheet continues with
   trip lists (SIAYA, MIGORI...) that are not insurance and are left alone. */
export function parseInsurance(rows){
  const items = [];
  let started = false, total = null;
  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    if(!r || r.every(c => c === null)){ if(started) break; continue; }
    if(isNum(r[0]) && plateish(r[1])){
      started = true;
      items.push({ key: 'IN' + (i + 1), xlRow: i + 1, reg: normReg(r[1]), amount: num(r[2]), date: dateOf(r[3]) });
    } else if(started){ if(!r[0] && !r[1] && isNum(r[2])) total = r[2]; break; }
  }
  // the TOTAL sits two rows below; pick it up even after a blank
  if(total === null){ const t = rows.find((r, i) => r && !r[0] && !r[1] && isNum(r[2]) && i > items.length && i < items.length + 5); if(t) total = t[2]; }
  return { items, total };
}

/* CHAMA: tables of [slot number, then (date, amount) pairs]. A date with an amount beside it means that
   contribution was made; a date with no amount is still to come (or still to be recorded). */
export function parseChama(rows){
  const schemes = [];
  let i = 0;
  while(i < rows.length){
    const r = rows[i];
    if(r && isNum(r[1]) && r[1] === 1 && r.some(isDate)){
      const start = i;
      const slots = [];
      let j = i;
      while(j < rows.length && rows[j] && isNum(rows[j][1]) && rows[j].some(isDate)){ slots.push(rows[j]); j++; }
      const entries = [];
      slots.forEach((row, k) => {
        for(let c = 2; c < row.length; c++){
          if(!isDate(row[c])) continue;
          const d = dateOf(row[c]);
          const amt = isNum(row[c + 1]) ? row[c + 1] : null;
          entries.push({ slot: row[1], date: d, amount: amt, paid: amt !== null, xlRow: start + k + 1 });
        }
      });
      const amounts = entries.filter(e => e.amount).map(e => e.amount);
      const unit = amounts.length ? amounts.sort((a, b) => a - b)[Math.floor(amounts.length / 2)] : 0;
      entries.forEach(e => { if(!e.paid) e.amount = unit; });
      const gaps = []; const sorted = [...entries].sort((a, b) => a.date < b.date ? -1 : 1);
      for(let k = 1; k < Math.min(sorted.length, 40); k++) gaps.push((Date.parse(sorted[k].date) - Date.parse(sorted[k - 1].date)) / 86400000);
      const every = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
      schemes.push({ key: 'CH' + (start + 1), xlRow: start + 1, name: '', amount: unit, everyDays: Math.round(every), entries });
      i = j;
    } else i++;
  }
  // name them by what they are
  schemes.forEach((s, k) => { s.name = 'Chama ' + String.fromCharCode(65 + k) + ' - ' + s.amount.toLocaleString('en-US') + (s.everyDays ? ' every ' + (s.everyDays === 7 ? 'week' : s.everyDays + ' days') : ''); });
  const lastSchemeRow = schemes.length ? Math.max(...schemes.map(s => s.xlRow + 15)) : 0;
  const tail = [];
  rows.forEach((r, k) => {
    if(k < lastSchemeRow + 8) return;
    if(r && r.some(c => c !== null)) tail.push(k + 1);
  });
  return { schemes, unparsedRows: tail.length ? { from: tail[0], to: tail[tail.length - 1] } : null };
}


/* LOAN, bottom table: running balances for individuals (LAWYER, WIN, SAM, CHAMA ...). Header row of names, then one row per movement
   (first line is what was carried, later lines are +/- movements). The last row is the sheet's own total per person. */
export function parseIndividuals(rows){
  const isHdr = r => r && r.filter((c, i) => i > 0 && isStr(c)).length >= 4 && !r.some(c => isStr(c) && /^(NCBA|JUHUDI|MOMENTUM|NAME|DRIVER)$/i.test(c.trim())) && !r.some(c => isStr(c) && /^\d{1,2}(ST|ND|RD|TH)$/i.test(c.trim()));
  const h = rows.findIndex((r, i) => isHdr(r) && rows[i + 1] && rows[i + 1].some((c, k) => k > 0 && isNum(c)));
  if(h < 0) return { people: [], found: false };
  const names = []; const seen = new Map();
  rows[h].forEach((c, col) => { if(col === 0 || !isStr(c)) return; let n = c.trim().toUpperCase(); const k = (seen.get(n) || 0) + 1; seen.set(n, k); if(k > 1) n += ' ' + k; names.push({ col, name: n }); });
  let end = h + 1; while(end < rows.length && rows[end] && rows[end].some((c, k) => k > 0 && isNum(c))) end++;
  let body = rows.slice(h + 1, end), totalRow = null;
  if(body.length > 1){
    const last = body[body.length - 1], prev = body.slice(0, -1);
    const hits = names.filter(p => isNum(last[p.col]) && Math.abs(last[p.col] - prev.reduce((s, r) => s + (isNum(r && r[p.col]) ? r[p.col] : 0), 0)) < 0.5).length;
    if(hits >= Math.ceil(names.length / 2)){ totalRow = h + 1 + body.length; body = prev; }
  }
  const people = names.map(p => { const lines = [];
    body.forEach((r, i) => { const v = r && r[p.col]; if(isNum(v)) lines.push({ key: 'R' + (h + 2 + i) + 'C' + (p.col + 1), row: h + 2 + i, amount: v }); });
    return { key: 'P' + (p.col + 1), name: p.name, col: p.col, lines, balance: lines.reduce((s, l) => s + l.amount, 0), sheetTotal: totalRow && isNum(rows[totalRow - 1][p.col]) ? rows[totalRow - 1][p.col] : null }; });
  return { people, found: true, headerRow: h + 1, totalRow };
}
