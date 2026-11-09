/* FleetPilot Excel importer - analysis engine.

   analyze(sheets, options) reads the workbook rows, applies the admin's earlier decisions
   (options.overrides / options.ignores), and returns:
     data    - clean records ready to be merged into the database
     review  - every line that needs the admin (each with one-click fixes)
     checks  - his own totals compared with what was imported
   It never touches the database and never changes Excel. Decisions are stored as overrides
   keyed by the Excel line, so running it again on a newer workbook replays them. */
import {
  plainRows, isNum, isStr, isDate, dateOf, normReg, normName, REG_RE, suggestReg, sum, mode, monthIndex,
  monthKey, makeReview, plain
} from './util.js';
import { parseCarPerformance, parseSubhire, parsePerCarSheet, validateRentals, reconcileSubhire, REPORT_YEAR } from './rentals.js';
import { parseFuel, parseSimpleList, parseGarage, parseAirportFee, parseAllowance, parseSubhireDriver } from './expenses.js';
import { parseLoans, parseInsurance, parseChama, parseIndividuals } from './admin.js';
import { parseCoopSheet, matchCoopHires, parseWalkinTable, parseOchwada, parseStandingRent } from './clients.js';
import { parseInvoices, invoiceChecks } from './invoices.js';
import { allocatePayments } from './payments.js';
import { matchDriverJobs } from './driverjobs.js';
import { statement } from '../statement.js';
import { MONTH_NAMES } from './util.js';

export { REPORT_YEAR };
export const IMPORT_VERSION = 1;

function findSheet(sheets, name){
  const k = Object.keys(sheets).find(n => n.trim().toUpperCase() === name.toUpperCase());
  return k ? sheets[k] : null;
}

function applyOverrides(records, overrides){
  records.forEach(r => {
    const o = overrides[r.key]; if(!o) return;
    if(o.set) Object.assign(r, o.set);
    if(o.remove) r.excluded = true;
  });
}

const monthLabel = ym => { const [y, m] = ym.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + ' ' + y; };

export function analyze(rawSheets, options = {}){
  const today = options.today || new Date().toISOString().slice(0, 10);
  const overrides = options.overrides || {};
  const ignores = new Set(options.ignores || []);
  const sheets = {};
  Object.keys(rawSheets || {}).forEach(n => { sheets[n] = plainRows(rawSheets[n]); });
  const review = [], checks = [], skipped = [], notes = [];
  const check = (group, label, excel, imported, extra) => {
    if(excel === null || excel === undefined || imported === null || imported === undefined) return;
    checks.push(Object.assign({ group, label, excel, imported, diff: imported - excel, ok: Math.abs(imported - excel) < 1 }, extra || {}));
  };

  /* ---- read ---- */
  const cpRows = findSheet(sheets, 'CAR PERFORMANCE');
  if(!cpRows) return { ok: false, error: 'This workbook has no CAR PERFORMANCE sheet, so there are no rentals to import.', review, checks, data: null };
  const cp = parseCarPerformance(cpRows);
  if(!cp.found) return { ok: false, error: 'Could not find the header row (CLIENT, CAR REGISTRATION, ...) on CAR PERFORMANCE.', review, checks, data: null };
  const subRows = findSheet(sheets, 'SUBHIRE');
  const sub = subRows ? parseSubhire(subRows) : { lines: [], blockTotals: [], stray: [] };
  const raw = cp.rentals.map(r => ({ amount: r.amount || 0, fuel: r.fuel || 0, subhireCost: r.subhireCost || 0 }));   // untouched, for the totals check

  const fuelRows = findSheet(sheets, 'FUEL');
  const fuel = fuelRows ? parseFuel(fuelRows) : { expenses: [], closings: [] };
  const carwash = findSheet(sheets, 'CARWASH') ? parseSimpleList(findSheet(sheets, 'CARWASH'), 'CARWASH', 'Carwash', 'CW') : { expenses: [], totals: [] };
  const transport = findSheet(sheets, 'TRANSPORT') ? parseSimpleList(findSheet(sheets, 'TRANSPORT'), 'TRANSPORT', 'Transport', 'TR') : { expenses: [], totals: [] };
  const garage = findSheet(sheets, 'GARAGE') ? parseGarage(findSheet(sheets, 'GARAGE')) : { expenses: [] };
  const airport = findSheet(sheets, 'AIRPORT FEE') ? parseAirportFee(findSheet(sheets, 'AIRPORT FEE')) : { expenses: [], totals: [] };
  const subDrivers = findSheet(sheets, 'SUBHIRE DRIVER') ? parseSubhireDriver(findSheet(sheets, 'SUBHIRE DRIVER')) : [];
  const allowances = findSheet(sheets, 'ALLOWANCE') ? parseAllowance(findSheet(sheets, 'ALLOWANCE')) : [];
  const individuals = findSheet(sheets, 'LOAN') ? parseIndividuals(findSheet(sheets, 'LOAN')) : { people: [], found: false };
  const loanInfo = findSheet(sheets, 'LOAN') ? parseLoans(findSheet(sheets, 'LOAN')) : { loans: [], dueList: [], other: [] };
  const insInfo = findSheet(sheets, 'INSURANCE') ? parseInsurance(findSheet(sheets, 'INSURANCE')) : { items: [], total: null };
  const chamaInfo = findSheet(sheets, 'CHAMA') ? parseChama(findSheet(sheets, 'CHAMA')) : { schemes: [], unparsedRows: null };

  const coopHires = findSheet(sheets, 'COOP') ? parseCoopSheet(findSheet(sheets, 'COOP')) : [];
  const walkins = findSheet(sheets, 'Sheet2') ? parseWalkinTable(findSheet(sheets, 'Sheet2')) : [];
  const ochwada = findSheet(sheets, 'OCHWADA') ? parseOchwada(findSheet(sheets, 'OCHWADA')) : [];
  const standingRent = findSheet(sheets, 'Sheet1') ? parseStandingRent(findSheet(sheets, 'Sheet1')) : null;
  const invoiceInfo = findSheet(sheets, 'INVOICE') ? parseInvoices(findSheet(sheets, 'INVOICE')) : { invoices: [], blocks: [] };

  const expenses = [...fuel.expenses, ...carwash.expenses, ...transport.expenses, ...garage.expenses, ...airport.expenses, ...subDrivers];

  /* ---- the admin's earlier decisions ---- */
  applyOverrides(cp.rentals, overrides);
  applyOverrides(expenses, overrides);
  applyOverrides(fuel.topups || [], overrides);
  applyOverrides(allowances, overrides);
  cp.rentals.forEach(r => { if(r.reg) r.reg = normReg(r.reg); });

  /* ---- vehicles we can trust ---- */
  const ownPlates = new Set(cp.ownPlates);
  const subhirePlates = new Set(sub.lines.map(l => l.reg).filter(p => REG_RE.test(p)));
  const countByReg = new Map();
  cp.rentals.forEach(r => { if(!r.excluded && r.reg) countByReg.set(r.reg, (countByReg.get(r.reg) || 0) + 1); });
  const knownRegs = new Set([...ownPlates, ...subhirePlates, ...[...countByReg].filter(([p, n]) => n >= 2 && REG_RE.test(p)).map(([p]) => p)]);

  /* ---- rentals ---- */
  validateRentals(cp.rentals, { knownRegs, subhirePlates, ownPlates, ignores }, review);
  reconcileSubhire(cp.rentals, sub.lines, review, ignores);
  cp.rentals.forEach(r => {
    if(r.excluded) return;
    r.rate = (isNum(r.amount) && isNum(r.days) && r.days > 0) ? Math.round(r.amount / r.days * 100) / 100 : (r.amount || 0);
    r.subhireKind = r.subhireCost > 0 ? (ownPlates.has(r.reg) ? 'own-column' : 'subhire') : '';
    r.mileage = (isNum(r.mileageIn) && isNum(r.mileageOut) && r.mileageIn >= r.mileageOut) ? r.mileageIn - r.mileageOut : 0;
    r.margin = (r.amount || 0) - (r.subhireCost || 0);
  });
  const rentals = cp.rentals.filter(r => !r.excluded);

  /* ---- costs ---- */
  const allRegs = new Set([...knownRegs, ...countByReg.keys()]);
  const addExp = (e, code, item) => {
    if(ignores.has(e.key + '|' + code)) return;
    makeReview(review, Object.assign({ code, recKey: e.key, sheet: e.sheet, row: e.xlRow, who: e.desc, reg: e.reg, pickup: e.date, amount: e.amount }, item));
  };
  expenses.forEach(e => {
    if(e.excluded) return;
    if(e.reg){
      e.reg = normReg(e.reg);
      if(!REG_RE.test(e.reg) || !allRegs.has(e.reg)){
        const s = suggestReg(e.reg, [...allRegs]);
        if(s || !REG_RE.test(e.reg)) addExp(e, 'BAD_REG', { severity: 'medium', problem: 'Registration not recognised', detail: `"${e.reg}" is not a car on the rentals or sub-hire sheets.`, choices: s ? [{ label: `Use ${s}`, set: { reg: s } }, { label: 'Keep as written', keep: true }] : [{ label: 'Keep as written', keep: true }] });
        else addExp(e, 'UNKNOWN_CAR', { severity: 'low', problem: 'Car has no rentals', detail: `${e.reg} appears here but on no rental line.`, choices: [{ label: 'Fine, keep', keep: true }] });
      }
    }
    if(!e.date){
      addExp(e, 'NO_DATE', { severity: 'medium', problem: 'Date missing', detail: `${e.desc} (${e.amount}) has no date.` });
    } else if(Number(e.date.slice(0, 4)) !== REPORT_YEAR){
      const fixed = REPORT_YEAR + e.date.slice(4);
      addExp(e, 'YEAR', { severity: 'high', problem: 'Year is not ' + REPORT_YEAR, detail: `${e.desc}: date is ${e.date}.`, choices: [{ label: `Change to ${fixed}`, set: { date: fixed } }] });
    }
  });
  allowances.forEach(a => {
    if(a.excluded) return;
    const add = (code, item) => { if(!ignores.has(a.key + '|' + code)) makeReview(review, Object.assign({ code, recKey: a.key, sheet: a.sheet, row: a.xlRow, who: a.driver + ' / ' + a.client, amount: a.amount, pickup: a.date }, item)); };
    if(!a.date) add('NO_DATE', { severity: 'medium', problem: 'Date missing', detail: `${a.driver} for ${a.client}: dates "${a.datesRaw}" could not be read.` });
    else if(Number(a.date.slice(0, 4)) !== REPORT_YEAR){
      const fixed = REPORT_YEAR + a.date.slice(4);
      add('YEAR', { severity: 'high', problem: 'Year is not ' + REPORT_YEAR, detail: `${a.driver}: date is ${a.date}.`, choices: [{ label: `Change to ${fixed}`, set: { date: fixed } }] });
    }
  });
  const liveExpenses = expenses.filter(e => !e.excluded);
  /* SUBHIRE DRIVER lines tied to the rental they belong to (the rental then carries the amount per day, status and date); the rest stay plain costs */
  const driverJobs = matchDriverJobs(rentals, subDrivers);
  driverJobs.unmatched.forEach(e => addExp(e, 'SD_NO_RENTAL', { severity: 'low', problem: 'Sub-hire driver line matches no rental',
    detail: `${e.driver} for ${e.client || '?'} on ${e.date || '?'}${e.days ? ' (' + e.days + ' days)' : ''}, ${e.amount}: no rental of ${e.driver} fits that client and day. It stays as a Sub-hire driver cost under Expenses; fix the driver or client on the rental, or leave it.`,
    choices: [{ label: 'Fine, keep as a cost', keep: true }] }));
  /* FUEL: a plate line listed again as a positive figure. Nothing is removed here; the owner decides. */
  (fuel.repeats || []).forEach(e => {
    if(e.excluded || ignores.has(e.key + '|FUEL_REPEAT')) return;
    const twin = fuel.expenses.find(x => x !== e && !x.repeat && !x.excluded && x.reg === e.reg && x.date === e.date && x.amount === e.amount);
    makeReview(review, { code: 'FUEL_REPEAT', recKey: e.key, sheet: 'FUEL', row: e.xlRow, who: 'Fuel', reg: e.reg, pickup: e.date, amount: e.amount,
      severity: twin ? 'high' : 'medium', problem: 'Fuel line listed again as a positive figure',
      detail: twin ? `Same car, date and amount as FUEL row ${twin.xlRow}, so it is counted twice unless you remove this one.`
                   : 'A positive figure with a plate and no matching fill earlier in the sheet. It is read as a fill (KSh ' + e.amount + ').',
      choices: twin ? [{ label: 'Remove this repeat', remove: true }, { label: 'Keep both', keep: true }]
                    : [{ label: 'Keep it (it is a fill)', keep: true }, { label: 'Remove this line', remove: true }] });
  });
  const liveAllowances = allowances.filter(a => !a.excluded);

  // link fuel lines to the rental they were fronted for
  const usedFuel = new Set();
  liveExpenses.filter(e => e.category === 'Fuel' && e.reg && e.date).forEach(e => {
    const r = rentals.find(x => x.reg === e.reg && x.fuel === e.amount && x.pickup && x.return && x.pickup <= e.date && e.date <= x.return && !usedFuel.has(x.key));
    if(r){ usedFuel.add(r.key); e.rentalKey = r.key; }
  });

  /* ---- vehicles, clients, drivers ---- */
  const fleetRows = findSheet(sheets, 'Sheet3');
  const fleetInfo = new Map();
  (fleetRows || []).forEach(r => {
    if(isNum(r[0]) && isStr(r[1]) && isStr(r[2]) && REG_RE.test(normReg(r[2]))){
      fleetInfo.set(normReg(r[2]), { owner: r[1], driver: isStr(r[3]) ? r[3].trim() : '', phone: r[4] ? String(r[4]) : '', model: isStr(r[5]) ? r[5] : '' });
    }
  });
  const regsInUse = new Set([...countByReg.keys(), ...ownPlates, ...subhirePlates, ...liveExpenses.map(e => e.reg).filter(Boolean)]);
  const vehicles = [...regsInUse].filter(p => REG_RE.test(p)).sort().map(reg => {
    const rs = rentals.filter(r => r.reg === reg);
    const info = fleetInfo.get(reg) || {};
    return {
      reg, owner: info.owner || '', model: info.model || '', ownership: ownPlates.has(reg) ? 'own-column' : (subhirePlates.has(reg) ? 'subhire' : 'other'),
      rate: mode(rs.filter(r => r.rate > 0).map(r => r.rate)) || 0,
      dailyCost: mode(rs.filter(r => r.subhireCost > 0 && r.days > 0).map(r => Math.round(r.subhireCost / r.days))) || 0,
      rentals: rs.length, driver: info.driver || '', phone: info.phone || ''
    };
  });
  const clients = [...new Set(rentals.map(r => r.client).filter(Boolean))].sort();
  const drivers = [];
  fleetInfo.forEach((v, reg) => { if(v.driver) drivers.push({ name: v.driver, phone: v.phone, reg }); });
  [...new Set(liveAllowances.map(a => a.driver))].forEach(n => {
    const first = n.split(' ')[0];
    const hits = drivers.filter(d => d.name.toUpperCase().split(' ')[0] === first);
    if(!drivers.some(d => d.name.toUpperCase() === n) && hits.length !== 1) drivers.push({ name: n, phone: '', reg: '' });
  });

  /* ---- admin ---- */
  const paidThrough = options.paidThrough || (() => { const [y, m] = today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); })();
  loanInfo.loans.forEach(l => {
    l.schedule.forEach(s => { s.paid = s.month <= paidThrough; });
    l.scheduled = sum(l.schedule, s => s.amount);
    if(Math.abs(l.scheduled - l.principal) > 1){
      makeReview(review, { code: 'LOAN_TOTAL', recKey: l.key, sheet: 'LOAN', row: 7, severity: 'medium', who: l.lender || l.label, amount: l.principal,
        problem: 'Loan instalments do not add up to the amount borrowed',
        detail: `${l.lender || l.label}${l.vehicleReg ? ' (' + l.vehicleReg + ')' : ''}: borrowed ${l.principal.toLocaleString('en-US')}, instalments listed ${l.scheduled.toLocaleString('en-US')} (difference ${(l.principal - l.scheduled).toLocaleString('en-US')}).`,
        choices: [{ label: 'Noted', keep: true }] });
    }
  });
  const missingIns = insInfo.items.filter(i => !i.amount || !i.date);
  missingIns.forEach(i => makeReview(review, { code: 'INSURANCE_BLANK', recKey: i.key, sheet: 'INSURANCE', row: i.xlRow, severity: 'low', who: 'Insurance', reg: i.reg,
    problem: 'Insurance line has no amount or date', detail: `${i.reg} is listed with no ${!i.amount ? 'amount' : 'date'}.`, choices: [{ label: 'Noted', keep: true }] }));
  chamaInfo.schemes.forEach(s => { s.paidCount = s.entries.filter(e => e.paid).length; s.paidTotal = sum(s.entries.filter(e => e.paid), e => e.amount); });

  individuals.people.forEach(p => { if(p.sheetTotal !== null) check('Loans', 'LOAN individuals - ' + p.name + ' balance', p.sheetTotal, p.balance, { sheet: 'LOAN', row: individuals.totalRow }); });

  /* ---- his own totals against what we imported ---- */
  cp.monthTotals.forEach((t, k) => {
    const from = k === 0 ? 0 : cp.monthTotals[k - 1].firstRental, to = t.firstRental;
    const label = 'CAR PERFORMANCE total, row ' + t.row;
    check('Rentals', label + ' - billed', t.amount, sum(raw.slice(from, to), x => x.amount), { sheet: 'CAR PERFORMANCE', row: t.row });
    check('Rentals', label + ' - sub-hire cost', t.subhire, sum(raw.slice(from, to), x => x.subhireCost), { sheet: 'CAR PERFORMANCE', row: t.row });
    check('Rentals', label + ' - fuel', t.fuel, sum(raw.slice(from, to), x => x.fuel), { sheet: 'CAR PERFORMANCE', row: t.row });
  });
  sub.blockTotals.forEach(t => check('Sub-hire', 'SUBHIRE block ' + (t.block + 1) + ' total (' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t.block] + ')', t.total, sum(sub.lines.filter(l => l.block === t.block), l => l.amount), { sheet: 'SUBHIRE', row: t.row }));
  const subTotal = sum(sub.lines, l => l.amount);
  const cpSubhired = sum(rentals.filter(r => r.subhireKind === 'subhire'), r => r.subhireCost);
  check('Sub-hire', 'Sub-hire cost on rentals vs the SUBHIRE sheet', subTotal, cpSubhired, { sheet: 'SUBHIRE' });
  const perCar = [];
  Object.keys(sheets).filter(n => REG_RE.test(normReg(n))).forEach(n => {
    const reg = normReg(n), blocks = parsePerCarSheet(sheets[n]);
    perCar.push({ reg, sheet: n, blocks });
    check('Vehicle sheets', n + ' sheet: his block totals vs his hires', sum(blocks.filter(b => b.total), b => b.total.amount), sum(blocks.filter(b => b.total), b => sum(b.lines, l => l.amount)), { sheet: n });
    check('Vehicle sheets', n + ' sheet vs SUBHIRE lines for this car', sum(blocks, b => sum(b.lines, l => l.amount)), sum(sub.lines.filter(l => l.reg === reg), l => l.amount), { sheet: n });
  });
  fuel.closings.forEach((c, k) => {
    const from = k === 0 ? 0 : fuel.closings[k - 1].after;
    const carried = sum(fuel.carries.filter(x => x.row < c.row && (k === 0 || x.row > fuel.closings[k - 1].row)), x => x.amount);
    check('Fuel', 'FUEL closing row ' + c.row + ' - spent', c.spent, sum(fuel.expenses.slice(from, c.after).filter(e => !e.excluded), e => e.amount) + carried, { sheet: 'FUEL', row: c.row });
    const tFrom = k === 0 ? 0 : fuel.closings[k - 1].topupsAfter;
    if(c.topups) check('Fuel', 'FUEL closing row ' + c.row + ' - top-ups', c.topups, sum(fuel.topups.slice(tFrom, c.topupsAfter).filter(t => !t.excluded), t => t.amount), { sheet: 'FUEL', row: c.row });
  });
  [[carwash, 'CARWASH'], [transport, 'TRANSPORT']].forEach(([res, name]) => res.totals.forEach((t, k) => {
    const from = k === 0 ? 0 : res.totals[k - 1].after;
    check(name === 'CARWASH' ? 'Carwash' : 'Transport', name + ' total row ' + t.row, t.total, sum(res.expenses.slice(from, t.after), e => e.amount), { sheet: name, row: t.row });
  }));
  // his Sheet1 monthly summary
  const s1 = findSheet(sheets, 'Sheet1');
  if(s1){
    const hdr = s1.findIndex(r => r[0] === 'MONTH');
    if(hdr >= 0){
      const cols = {}; s1[hdr].forEach((c, i) => { if(isStr(c)) cols[c] = i; });
      const byMonth = (list, f, pred) => { const m = new Map(); list.filter(pred || (() => true)).forEach(x => { const d = f(x); if(d){ m.set(monthKey(d), (m.get(monthKey(d)) || 0) + (x.amount || 0)); } }); return m; };
      const sources = {
        'FUEL': byMonth(liveExpenses, e => e.date, e => e.category === 'Fuel'),
        'CARWASH': byMonth(liveExpenses, e => e.date, e => e.category === 'Carwash'),
        'AIRPORT FEE': byMonth(liveExpenses, e => e.date, e => e.sheet === 'AIRPORT FEE'),
        'GARAGE': byMonth(liveExpenses, e => e.date, e => e.category === 'Garage'),
        'SUBHIRE DR': byMonth(liveExpenses, e => e.date, e => e.category === 'Sub-hire driver'),
        'ALLOWANCE': byMonth(liveAllowances, a => a.date)
      };
      for(let i = hdr + 1; i < s1.length; i++){
        const r = s1[i]; const m = monthIndex(r[0]); if(m < 0) { if(r[0] === 'TOTAL') break; continue; }
        if(!r.some(isNum)) continue;
        if(m >= 10) continue;                       // Nov/Dec: the previous year, not in this workbook's detail sheets
        const ym = REPORT_YEAR + '-' + String(m + 1).padStart(2, '0');
        Object.keys(sources).forEach(k => { if(cols[k] !== undefined && isNum(r[cols[k]])) check('Monthly summary (Sheet1)', k + ' - ' + monthLabel(ym), r[cols[k]], sources[k].get(ym) || 0, { sheet: 'Sheet1', row: i + 1, info: true }); });
      }
    }
  }

  /* ---- what we could not read ---- */
  const known = ['CAR PERFORMANCE','SUBHIRE','INVOICE','FUEL','CARWASH','TRANSPORT','GARAGE','AIRPORT FEE','ALLOWANCE','SUBHIRE DRIVER','LOAN','INSURANCE','CHAMA','SHEET1','SHEET3'];
  Object.keys(sheets).forEach(n => {
    if(known.includes(n.trim().toUpperCase()) || REG_RE.test(normReg(n))) return;
    skipped.push({ sheet: n, rows: sheets[n].length, why: ({ 'INVOICE': 'client invoices (amounts, VAT, paid status)', 'COOP': 'client statement for COOP', 'OCHWADA': 'client statement for OCHWADA', 'SHEET2': 'event hire summary (RAV4 / saloon counts)' })[n.trim().toUpperCase()] || 'not read yet' });
  });
  if(loanInfo.other.length && !individuals.found) loanInfo.other.forEach(o => notes.push({ sheet: 'LOAN', row: o.row, text: o.note + ' - not imported, please confirm what these are.' }));
  if(chamaInfo.unparsedRows) notes.push({ sheet: 'CHAMA', row: chamaInfo.unparsedRows.from, text: `CHAMA rows ${chamaInfo.unparsedRows.from}-${chamaInfo.unparsedRows.to} hold other figures (lump sums and balances) that were not imported - please confirm what they are.` });
  if(sub.stray.length) sub.stray.forEach(s => notes.push({ sheet: 'SUBHIRE', row: s.row, text: 'SUBHIRE line with no registration: ' + s.cells.join(' | ') }));

  /* ---- summary numbers ---- */
  const fuelAccount = { opening: fuel.opening || null, topups: (fuel.topups || []).filter(t => !t.excluded) };
  const stats = {
    rentals: rentals.length,
    billed: sum(rentals, r => r.amount),
    subhireCost: sum(rentals, r => r.subhireCost),
    subhireCostSubhired: cpSubhired,
    subhireCostOwnCols: sum(rentals.filter(r => r.subhireKind === 'own-column'), r => r.subhireCost),
    subhireUnpaid: sum(rentals.filter(r => r.subhireKind === 'subhire' && !r.subhirePaid), r => r.subhireCost),
    expenses: liveExpenses.length, expensesTotal: sum(liveExpenses, e => e.amount),
    fuelTopups: fuelAccount.topups.length, fuelTopupsTotal: sum(fuelAccount.topups, t => t.amount),
    allowances: liveAllowances.length, allowancesTotal: sum(liveAllowances, a => a.amount),
    vehicles: vehicles.length, clients: clients.length, drivers: drivers.length,
    loans: loanInfo.loans.length, insurance: insInfo.items.length, chamaSchemes: chamaInfo.schemes.length,
    invoices: invoiceInfo.invoices.length, invoicesTotal: sum(invoiceInfo.invoices, i => i.amount), invoicesUnpaid: sum(invoiceInfo.invoices.filter(i => !i.paid), i => i.amount),
    review: review.length, checksOff: checks.filter(c => !c.ok && !c.info).length, summaryOff: checks.filter(c => !c.ok && c.info).length, checks: checks.filter(c => !c.info).length
  };
  review.forEach(r => { if(r.code === 'DAYCOUNT') r.groupKey = 'daycount'; else if(r.code === 'BAD_REG' || r.code === 'UNKNOWN_CAR' || r.code === 'SUBHIRE_PLATE_UNKNOWN') r.groupKey = r.code + ':' + r.reg; });
  review.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity] || (a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : 0) || a.row - b.row);
  const coopMatch = matchCoopHires(cp.rentals, coopHires, review);
  const ochwadaRows = statement(ochwada, { carryBF: true });
  ochwada.forEach((b, i) => { if(ochwadaRows[i].totalDiff !== null) check('OCHWADA', 'OCHWADA ' + (b.month === null ? '' : MONTH_NAMES[b.month]) + ' closing total (row ' + b.rowTo + ')', b.sheetTotal, ochwadaRows[i].closing, { sheet: 'OCHWADA', row: b.rowTo }); });
  invoiceChecks(invoiceInfo).forEach(c => checks.push(c));
  invoiceInfo.invoices.filter(i => i.garbled).forEach(i => makeReview(review, { code: 'INVOICE_NAME', recKey: i.key, sheet: 'INVOICE', row: i.xlRow, severity: 'low',
    problem: 'Invoice client name looks garbled', detail: `Invoice ${i.no} (${i.amount}) has the client "${i.client.slice(0, 30)}". It is kept as typed; rename it on the Invoices page once you know who it is.`,
    who: i.client.slice(0, 30), pickup: i.date, amount: i.amount, choices: [{ label: 'Noted', keep: true }] }));
  const pay = allocatePayments({ rentals, invoices: invoiceInfo.invoices, ochwada });
  review.forEach((r, i) => { r.id = 'RV' + (i + 1); });

  return {
    ok: true, today, paidThrough,
    data: { perCar, vehicles, clients, drivers, rentals, expenses: liveExpenses, allowances: liveAllowances, subhireLines: sub.lines, driverJobs: driverJobs.matched,
            loans: loanInfo.loans, loanDue: loanInfo.dueList, loanMonths: { first: loanInfo.firstMonth, last: loanInfo.lastMonth },
            insurance: insInfo.items, insuranceTotal: insInfo.total, chama: chamaInfo.schemes,
            coopHires, coopMatch, individuals: individuals.people, walkins, ochwada, standingRent, fuelAccount,
            invoices: invoiceInfo.invoices, payments: pay.payments, rentalInvoice: Object.fromEntries(pay.rentalInvoice), paymentStats: pay.stats },
    review, checks, skipped, notes, stats
  };
}

/* One click on a review item's choice -> the new state of the admin's decisions. Pure. */
export function decide(state, item, choice){
  const overrides = JSON.parse(JSON.stringify(state.overrides || {}));
  const ignores = new Set(state.ignores || []);
  const key = item.recKey;
  if(choice === 'ignore' || (choice && choice.keep)){
    ignores.add(key + '|' + item.code);
  } else if(choice && choice.remove){
    overrides[key] = Object.assign({}, overrides[key], { remove: true });
  } else if(choice && choice.set){
    overrides[key] = Object.assign({}, overrides[key], { set: Object.assign({}, (overrides[key] || {}).set, choice.set) });
  }
  return { overrides, ignores: [...ignores] };
}
