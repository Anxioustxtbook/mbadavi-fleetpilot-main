/* CAR PERFORMANCE (the rentals), SUBHIRE (what is owed to car owners) and the per-car monthly sheets.
   The parsers only READ the workbook. All fixes are applied afterwards as overrides, so the original
   Excel values are never lost and a re-import can replay the admin's earlier decisions. */
import {
  plain, isNum, isStr, isDate, num, dateOf, timeOf, normReg, normName, parseDayRange, monthIndex,
  addDays, diffDays, monthKey, REG_RE, suggestReg, sum, makeReview
} from './util.js';

export const REPORT_YEAR = 2026;

/* ---------- CAR PERFORMANCE ---------- */
export function parseCarPerformance(rows){
  const hdrIdx = rows.findIndex(r => r[0] === 'CLIENT');
  if(hdrIdx < 0) return { rentals: [], monthTotals: [], ownPlates: [], found: false };
  const header = rows[hdrIdx];
  const ownPlates = [];
  for(let c = 13; c < header.length; c++){ const p = normReg(header[c]); if(p) ownPlates.push({ col: c, reg: p }); }
  const rentals = [], monthTotals = [];
  for(let i = hdrIdx + 1; i < rows.length; i++){
    const r = rows[i];
    if(!r || r.every(c => c === null)) continue;
    if(r[0] === 'CLIENT') continue;                                  // repeated header row
    const isTotal = !r[0] && !r[1] && !r[3] && (isNum(r[10]) || isNum(r[11]) || isNum(r[12]));
    if(isTotal){ monthTotals.push({ row: i + 1, fuel: num(r[10]) || 0, amount: num(r[11]) || 0, subhire: num(r[12]) || 0, firstRental: rentals.length }); continue; }
    if(!(r[0] || r[1] || r[3] || isNum(r[11]))) continue;
    const own = {};
    const isTaxi = isStr(r[9]) && r[9].trim().toUpperCase() === 'TAXI';   // short same-day job, DAYS cell holds the word TAXI
    ownPlates.forEach(p => { if(isNum(r[p.col])) own[p.reg] = r[p.col]; });
    rentals.push({
      key: 'R' + (i + 1), xlRow: i + 1, sheet: 'CAR PERFORMANCE',
      client: normName(r[0]), reg: normReg(r[1]), driver: isStr(r[2]) ? r[2] : '',
      pickup: dateOf(r[3]), pickupRaw: r[3], pickupTime: timeOf(r[4]), mileageOut: num(r[5]),
      return: dateOf(r[6]), returnRaw: r[6], returnTime: timeOf(r[7]), mileageIn: num(r[8]),
      type: isTaxi ? 'taxi' : 'hire',
      days: isTaxi ? ((dateOf(r[3]) && dateOf(r[3]) === dateOf(r[6])) ? 1 : null) : num(r[9]), daysRaw: r[9], fuel: num(r[10]) || 0, amount: num(r[11]),
      subhireCost: num(r[12]) || 0, hasSubhireCell: isNum(r[12]), ownCols: own,
      excluded: false, notes: []
    });
  }
  return { rentals, monthTotals, ownPlates: ownPlates.map(p => p.reg), found: true };
}

/* ---------- SUBHIRE (one block per month; a REGISTRATION header starts each block) ---------- */
export function parseSubhire(rows, year = REPORT_YEAR){
  const lines = [], blockTotals = [], stray = [];
  let block = -1;
  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    if(!r || r.every(c => c === null)) continue;
    if(r[1] === 'REGISTRATION'){ block++; continue; }
    if(block < 0) continue;
    const reg = normReg(r[1]);
    if(!reg && isNum(r[5]) && r.every((c, k) => k === 5 || c === null)){ blockTotals.push({ row: i + 1, block, total: r[5] }); continue; }
    if(!reg){ if(r.some(c => c !== null)) stray.push({ row: i + 1, block, cells: r.filter(c => c !== null) }); continue; }
    const month = block;                                            // block 0 = January
    let start = dateOf(r[3]), end = start;
    if(!start){ const pr = parseDayRange(r[3], year, month); if(pr){ start = pr.start; end = pr.end; } }
    lines.push({
      key: 'S' + (i + 1), row: i + 1, block, reg, job: isStr(r[2]) ? r[2].toUpperCase() : '',
      datesRaw: r[3], start, end, days: num(r[4]), amount: num(r[5]) || 0,
      status: isStr(r[6]) ? r[6].toUpperCase() : '', paidDate: dateOf(r[7]), matched: null
    });
  }
  return { lines, blockTotals, stray };
}

/* ---------- per-car monthly sheets (KDQ 652A, KDU 834B, ...) ----------
   One block per month: a heading ("DECEMBER - JANUARY", "FEBRUARY"), the car's hires, then his TOTAL line. */
export function parsePerCarSheet(rows){
  const blocks = [];
  let cur = null;
  rows.forEach((r, i) => {
    if(!r || r.every(c => c === null)) return;
    const strs = r.filter(c => isStr(c));
    const hasNum = r.some(c => isNum(c));
    // headings may be "DECEMBER - JANUARY", "JANUARY FEBUARY" (no dash), "MARCH, APRIL" ...
    const parts = strs.length ? strs[0].toUpperCase().split(/[\s,&\/-]+/).filter(Boolean) : [];
    // a heading may carry stray numbers from a side table ("FEB MARCH" row); it never carries PAID or a date
    const hasDate = r.some(c => isDate(c));
    if(!hasDate && strs.length === 1 && strs[0].trim().toUpperCase() !== 'PAID' && parts.length && parts.every(p => monthIndex(p) >= 0)){
      cur = { heading: strs[0], month: monthIndex(parts[parts.length - 1]), row: i + 1, lines: [], total: null };
      blocks.push(cur); return;
    }
    if(!cur) return;
    if(r[1] === 'TOTAL'){
      const n = r.slice(2).filter(c => isNum(c)).slice(0, 2);     // first two numbers only: later ones belong to a side table
      cur.total = { row: i + 1, days: n.length > 1 ? Math.min(...n) : null, amount: n.length ? Math.max(...n) : null };
      return;
    }
    const client = isStr(r[1]) ? r[1] : null;
    if(!client) return;
    const nums = [];
    for(let c = 2; c < r.length; c++){ if(isNum(r[c])) nums.push(r[c]); if(nums.length === 2) break; }
    if(nums.length < 2) return;
    const pi = r.findIndex(c => c === 'PAID'); const paidDate = pi >= 0 ? (r.slice(pi + 1).map(c => dateOf(c)).find(Boolean) || '') : '';
    cur.lines.push({ row: i + 1, client: client.toUpperCase(), amount: Math.max(...nums), days: Math.min(...nums), status: pi >= 0 ? 'PAID' : '', paidDate });
  });
  return blocks;
}

/* ---------- validation of the rentals ---------- */
function inclusiveDays(a, b){ return diffDays(a, b) + 1; }

export function validateRentals(rentals, ctx, review){
  const { knownRegs, subhirePlates, ownPlates, ignores } = ctx;
  const active = rentals.filter(r => !r.excluded);
  const add = (r, code, item) => {
    if(ignores && ignores.has(r.key + '|' + code)) return null;
    return makeReview(review, Object.assign({ code, recKey: r.key, sheet: r.sheet, row: r.xlRow,
      who: r.client, reg: r.reg, pickup: r.pickup, return: r.return, days: r.days, amount: r.amount }, item));
  };

  active.forEach(r => {
    if(!r.reg){
      add(r, 'NO_REG', { severity: 'high', problem: 'Missing registration', detail: 'No car registration on this line, so it cannot be attached to a vehicle.' });
    } else if(!REG_RE.test(r.reg)){
      const s = suggestReg(r.reg, knownRegs);
      add(r, 'BAD_REG', { severity: 'medium', problem: 'Registration not recognised', detail: `"${r.reg}" is not a normal registration.`,
        choices: s ? [{ label: `Use ${s}`, set: { reg: s } }] : [] });
    }

    // dates
    ['pickup', 'return'].forEach(f => {
      if(!r[f]){
        const raw = r[f + 'Raw'];
        add(r, 'DATE_' + f.toUpperCase(), { severity: 'high', problem: 'Date is text or missing',
          detail: `${f === 'pickup' ? 'Date out' : 'Date in'} is ${raw === null ? 'empty' : '"' + raw + '"'}.`, field: f });
      }
    });
    ['pickup', 'return'].forEach(f => {
      if(r[f] && Number(r[f].slice(0, 4)) !== REPORT_YEAR){
        const fixed = REPORT_YEAR + r[f].slice(4);
        add(r, 'YEAR_' + f.toUpperCase(), { severity: 'high', problem: 'Year is not ' + REPORT_YEAR,
          detail: `${f === 'pickup' ? 'Date out' : 'Date in'} is ${r[f]}.`,
          choices: [{ label: `Change to ${fixed}`, set: { [f]: fixed } }] });
      }
    });
    if(r.pickup && r.return && Number(r.pickup.slice(0, 4)) === REPORT_YEAR && Number(r.return.slice(0, 4)) === REPORT_YEAR){
      const span = diffDays(r.pickup, r.return);
      if(span < 0){
        const choices = [];
        if(isNum(r.days) && r.days >= 1) choices.push({ label: `Date in = ${addDays(r.pickup, r.days - 1)} (date out + ${r.days} days, counting the first day)`, set: { return: addDays(r.pickup, r.days - 1) } });
        choices.push({ label: `Date in = date out (${r.pickup})`, set: { return: r.pickup } });
        add(r, 'RETURN_BEFORE_OUT', { severity: 'high', problem: 'Return date before out date', detail: `Out ${r.pickup}, in ${r.return}.`, choices });
      } else if(isNum(r.days)){
        const incl = inclusiveDays(r.pickup, r.return);
        if(r.days !== incl){
          if(r.days === span && span >= 1){
            add(r, 'DAYCOUNT', { severity: 'low', group: 'daycount', problem: 'Days = date difference (not counting the first day)',
              detail: `Out ${r.pickup}, in ${r.return}: the sheet says ${r.days} day(s). Counting both dates would be ${incl}. Probably billed by return time.`,
              choices: [{ label: 'Keep days as in Excel', keep: true }, { label: `Change days to ${incl}`, set: { days: incl } }] });
          } else {
            add(r, 'DAYS_MISMATCH', { severity: 'medium', problem: 'Days do not match dates',
              detail: `Out ${r.pickup}, in ${r.return} is ${incl} day(s) counting both dates, but the sheet says ${r.days}.`,
              choices: [{ label: `Use the dates (days = ${incl})`, set: { days: incl } },
                        { label: `Use the days (date in = ${addDays(r.pickup, Math.max(r.days, 1) - 1)})`, set: { return: addDays(r.pickup, Math.max(r.days, 1) - 1) } }] });
          }
        }
      }
    }
    if(!isNum(r.days) && r.pickup && r.return){
      const incl = inclusiveDays(r.pickup, r.return);
      add(r, 'NO_DAYS', { severity: 'medium', problem: 'Days is not a number', detail: `The days cell says ${r.daysRaw === null ? 'nothing' : '"' + r.daysRaw + '"'}.`,
        choices: incl >= 1 ? [{ label: `Use the dates (days = ${incl})`, set: { days: incl } }] : [] });
    }
    if(!isNum(r.amount) || r.amount <= 0){
      add(r, 'NO_AMOUNT', { severity: 'high', problem: 'Amount missing', detail: 'No amount billed on this line.' });
    }
    if(isNum(r.amount) && r.subhireCost > r.amount && r.amount > 0){
      add(r, 'NEGATIVE_MARGIN', { severity: 'medium', problem: 'Sub-hire cost is higher than the amount billed',
        detail: `Billed ${r.amount}, sub-hire cost ${r.subhireCost}.` });
    }
    if(r.subhireCost > 0 && r.reg && !subhirePlates.has(r.reg) && !ownPlates.has(r.reg)){
      const s = suggestReg(r.reg, [...subhirePlates]);
      add(r, 'SUBHIRE_PLATE_UNKNOWN', { severity: 'medium', problem: 'Sub-hire cost on a car that is not on the SUBHIRE sheet',
        detail: `${r.reg} has a sub-hire figure of ${r.subhireCost} but no lines on the SUBHIRE sheet.` + (s ? ` Looks like ${s}.` : ''),
        choices: s ? [{ label: `Use ${s}`, set: { reg: s } }] : [] });
    }
  });

  // exact duplicates: same client, car and dates
  const seen = new Map();
  active.forEach(r => {
    if(!r.reg || !r.pickup || !r.return) return;
    const k = [r.client, r.reg, r.pickup, r.return].join('|');
    if(seen.has(k)){
      add(r, 'DUPLICATE', { severity: 'medium', problem: 'Possible duplicate rental (same client, car, dates)',
        detail: `Same as line ${seen.get(k)}. Amount ${r.amount}.`, choices: [{ label: 'Remove this line', remove: true }, { label: 'Keep both', keep: true }] });
    } else seen.set(k, r.xlRow);
  });

  // double-booked cars (different bookings overlapping)
  const byReg = new Map();
  active.forEach(r => { if(r.reg && r.pickup && r.return && r.return >= r.pickup && Number(r.pickup.slice(0, 4)) === REPORT_YEAR && Number(r.return.slice(0, 4)) === REPORT_YEAR){ (byReg.get(r.reg) || byReg.set(r.reg, []).get(r.reg)).push(r); } });
  byReg.forEach(list => {
    list.sort((a, b) => a.pickup < b.pickup ? -1 : a.pickup > b.pickup ? 1 : 0);
    for(let i = 0; i < list.length; i++){
      for(let j = i + 1; j < list.length; j++){
        if(list[j].pickup >= list[i].return) break;
        const a = list[i], b = list[j];
        if(a.client === b.client && a.pickup === b.pickup && a.return === b.return) continue;   // reported as duplicate
        add(b, 'DOUBLE_BOOKED', { severity: 'high', problem: 'Car double-booked (overlapping dates)',
          detail: `Overlaps line ${a.xlRow} (${a.client}, ${a.pickup} to ${a.return}).` });
      }
    }
  });
}

/* ---------- link CAR PERFORMANCE sub-hire costs to SUBHIRE lines ---------- */
export function reconcileSubhire(rentals, lines, review, ignores){
  const byReg = new Map();
  lines.forEach(l => { (byReg.get(l.reg) || byReg.set(l.reg, []).get(l.reg)).push(l); });
  const candidates = rentals.filter(r => !r.excluded && r.subhireCost > 0 && byReg.has(r.reg));
  const dist = (r, l) => (r.pickup && l.start) ? Math.abs(diffDays(r.pickup, l.start)) : 999;
  // every plausible pairing on the same car, best first: same amount close in time, or any amount very close in time
  const pairs = [];
  candidates.forEach(r => byReg.get(r.reg).forEach(l => {
    const d = dist(r, l), sameAmt = l.amount === r.subhireCost, sameDays = l.days === r.days;
    if((sameAmt && d <= 45) || d <= 3) pairs.push({ r, l, score: (sameAmt ? 0 : 1000) + (sameDays ? 0 : 100) + d, sameAmt });
  }));
  pairs.sort((a, b) => a.score - b.score);
  pairs.forEach(({ r, l, sameAmt }) => {
    if(r.subhireLine || l.matched) return;
    r.subhireLine = l.key; l.matched = r.key;
    if(!sameAmt && !(ignores && ignores.has(r.key + '|SUBHIRE_AMOUNT_DIFF'))){
      makeReview(review, { code: 'SUBHIRE_AMOUNT_DIFF', recKey: r.key, sheet: 'SUBHIRE', row: l.row, severity: 'medium',
        problem: 'Sub-hire amount differs between CAR PERFORMANCE and SUBHIRE',
        detail: `${r.reg} ${r.client} ${r.pickup}: CAR PERFORMANCE says ${r.subhireCost}; SUBHIRE line ${l.row} (${l.job}) says ${l.amount}.`,
        who: r.client, reg: r.reg, pickup: r.pickup, return: r.return, days: r.days, amount: r.amount,
        choices: [{ label: `Use SUBHIRE sheet (${l.amount})`, set: { subhireCost: l.amount } }, { label: `Keep CAR PERFORMANCE (${r.subhireCost})`, keep: true }] });
    }
  });
  // copy paid status onto the rentals
  const lineByKey = new Map(lines.map(l => [l.key, l]));
  rentals.forEach(r => {
    const l = r.subhireLine && lineByKey.get(r.subhireLine);
    if(l){ r.subhirePaid = l.status === 'PAID'; r.subhirePaidDate = l.paidDate || ''; }
    else { r.subhirePaid = false; r.subhirePaidDate = ''; }
  });
  // SUBHIRE lines nobody claims
  lines.forEach(l => {
    if(l.matched) return;
    if(ignores && ignores.has(l.key + '|SUBHIRE_ORPHAN')) return;
    makeReview(review, { code: 'SUBHIRE_ORPHAN', recKey: l.key, sheet: 'SUBHIRE', row: l.row, severity: 'medium',
      problem: 'SUBHIRE line has no matching rental in CAR PERFORMANCE',
      detail: `${l.reg} ${l.job} ${l.start || l.datesRaw || ''} ${l.days || ''} day(s), ${l.amount}${l.status ? ' (' + l.status + ')' : ' (not marked paid)'}.`,
      who: l.job, reg: l.reg, pickup: l.start, return: l.end, days: l.days, amount: l.amount,
      choices: [{ label: 'Noted, leave out', keep: true }] });
  });
}
