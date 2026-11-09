/* "Pages" (admin, inside Pilot): the Excel sheets, drawn live from the database.
   Monthly progress (all vehicles or one), one page per cost (fuel, carwash, ...), Invoices by month, Payments by month.
   Every figure is a button: it lists the records the number was added up from, and each record opens where it is kept.
   The figures and the lists come from the same functions (monthlySummary and drillRecords), and test/pages.test.mjs checks they agree. */
import { monthlySummary, SUMMARY_COLUMNS, CAT_COL } from './summary.js';
import { fuelPosition, fuelAccountMonths, fuelLedger, fuelRepeats, openingBalance } from './fuelAccount.js';
import { explorerHtml, exState } from './expenseExplorer.js';
import { subhirePageHtml, driverPageHtml, subhireClick } from './subhireUi.js';
import { ownerCost, driverCost, isDriverLine, ownerStatus, driverStatus, STATUS_LABEL, ownerRows, driverRows } from './subhireCore.js';
import { scheduleOf, paidOf, loanName, persons } from './loans.js';
import { model as chamaModel } from './chama.js';
import { statement } from './statement.js';
import { applyFacets, facetCounts, chipsHtml, chipTap, ensureChipStyles } from './chips.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
const num = v => Number(v) || 0;
const attr = o => esc(JSON.stringify(o));

export const COSTS = [
  { id: 'fuel', label: 'Fuel', col: 'fuel' }, { id: 'carwash', label: 'Carwash', col: 'carwash' }, { id: 'transport', label: 'Transport', col: 'transport' },
  { id: 'garage', label: 'Garage', col: 'garage' }, { id: 'airport', label: 'Airport fee', col: 'airport' }, { id: 'subhireDriver', label: 'Sub-hire driver', col: 'subhireDriver' },
  { id: 'allowance', label: 'Allowance', col: 'allowance' }, { id: 'subhire', label: 'Sub-hire', col: 'subhire' }, { id: 'insurance', label: 'Insurance', col: 'insurance' },
  { id: 'rent', label: 'Rent', col: 'rent' }
];
export const PAGE_LIST = [{ id: 'progress', label: 'Monthly progress' }, { id: 'allexp', label: 'All expenses' }, ...COSTS.map(c => ({ id: c.id, label: c.label })), { id: 'invoices', label: 'Invoices' }, { id: 'payments', label: 'Payments received' }];

const COL_CATS = Object.entries(CAT_COL).reduce((o, [cat, col]) => { (o[col] = o[col] || []).push(cat); return o; }, {});   // fuel -> ['Fuel'], carwash -> ['Cleaning']

/* ---- the records behind a figure ----
   spec: { col, from, to, vehicleId }  (from/to are 'YYYY-MM'; the same month for one row, the whole range for a TOTAL).
   Returns { title, head:[...], rows:[{cells:[...], value, open:{panel,id}}], total, showAll:{panel, filter} } */
export function drillRecords(db, spec, ctx){
  const col = spec.col, vid = spec.vehicleId || null, from = spec.from, to = spec.to || spec.from;
  const inM = d => { const ym = String(d || '').slice(0, 7); return ym >= from && ym <= to; };
  const reg = id => { const v = (db.vehicles || []).find(v => v.id == id); return v ? v.reg : '—'; };
  const cli = id => { const c = (db.clients || []).find(c => c.id == id); return c ? c.name : '—'; };
  const money = n => ctx.fmt(n);
  const rows = []; let head = [], title = '', showAll = null;
  const span = from === to ? monthName(from) : monthName(from) + ' to ' + monthName(to);
  const carText = vid ? ' · ' + reg(vid) : '';
  const rentalsIn = () => (db.rentals || []).filter(r => r.status !== 'Cancelled' && inM(r.pickup) && (!vid || r.vehicleId == vid));

  if(COL_CATS[col] || col === 'other'){
    const cats = COL_CATS[col];
    const list = (db.expenses || []).filter(x => inM(x.date) && (!vid || x.vehicleId == vid) && (col === 'other' ? (!CAT_COL[x.category] && (!spec.cat || (x.category || 'Other') === spec.cat)) : cats.includes(x.category)));
    head = ['Date', 'Vehicle', 'Category', 'Description', 'Amount'];
    list.sort((a, b) => a.date < b.date ? -1 : 1).forEach(x => rows.push({ cells: [x.date, x.vehicleId ? reg(x.vehicleId) : 'Office', x.category, x.desc || '', money(x.amount)], value: num(x.amount), open: { panel: 'expenses', id: x.id } }));
    if(col === 'subhireDriver' && !spec.expOnly){      // sub-hire driver pay drawn from the rentals (amount per day x days)
      const drv = id => { const d = (db.drivers || []).find(d => d.id == id); return d ? d.name : '(no driver)'; };
      rentalsIn().filter(r => isDriverLine(db, r) && driverCost(r) > 0).sort((a, b) => a.pickup < b.pickup ? -1 : 1)
        .forEach(r => rows.push({ cells: [r.pickup, reg(r.vehicleId), 'Sub-hire driver', drv(r.driverId) + ' · ' + cli(r.clientId) + ' · ' + r.days + ' day' + (num(r.days) === 1 ? '' : 's') + ' · ' + STATUS_LABEL[driverStatus(r)], money(driverCost(r))], value: driverCost(r), open: { panel: 'rentals', id: r.id } }));
    }
    if(col === 'rent' && !vid){
      (db.settings && db.settings.standingExpenses || []).filter(se => se.category === 'Rent').forEach(se => {
        for(let ym = from; ym <= to; ym = ((y, m) => m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'))(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)))){
          if(se.fromMonth && ym < se.fromMonth) continue; if(se.toMonth && ym > se.toMonth) continue;
          if((db.expenses || []).some(x => x.category === 'Rent' && (x.date || '').slice(0, 7) === ym)) continue;
          rows.push({ cells: [ym + '-01', 'Office', 'Rent', 'Standing monthly rent (a setting, not a typed expense)', money(se.amount)], value: num(se.amount), open: { panel: 'pilot', tab: 'overview' } });
        }
      });
    }
    title = (SUMMARY_COLUMNS.find(c => c.key === col) || { label: 'Other costs' }).label + ' · ' + span + carText;
    showAll = { panel: 'expenses', filter: { cats: col === 'other' ? ['__other'] : cats, from: from + '-01', to: to + '-31', vehicleId: vid || '' } };
  } else if(col === 'fuelTopups'){        // money paid into the fuel account (not an expense; fills are the expense)
    head = ['Date', 'Note', 'Amount'];
    (db.fuelAccount || []).filter(x => x.kind !== 'opening' && inM(x.date)).sort((a, b) => a.date < b.date ? -1 : 1)
      .forEach(x => rows.push({ cells: [x.date, x.note || 'Top-up', money(x.amount)], value: num(x.amount), open: { panel: 'pilot', tab: 'pages', page: 'fuel', month: String(x.date).slice(0, 7) } }));
    title = 'Fuel top-ups paid in · ' + span;
  } else if(col === 'subhire' || col === 'allowance' || col === 'billed'){
    const f = col === 'subhire' ? 'subhireCost' : (col === 'allowance' ? 'allowance' : 'amount');
    const val = r => f === 'subhireCost' ? ownerCost(r) : num(r[f]);      // a cancelled sub-hire line costs nothing
    head = ['Pickup', 'Vehicle', 'Client', 'Days', f === 'subhireCost' ? 'Sub-hire cost' : (f === 'allowance' ? 'Allowance' : 'Billed')];
    rentalsIn().filter(r => val(r) > 0).sort((a, b) => a.pickup < b.pickup ? -1 : 1)
      .forEach(r => rows.push({ cells: [r.pickup, reg(r.vehicleId), cli(r.clientId), r.days, money(val(r))], value: val(r), open: { panel: 'rentals', id: r.id } }));
    title = { subhire: 'Sub-hire cost', allowance: 'Driver allowance', billed: 'Billed' }[col] + ' · ' + span + carText;
    showAll = { panel: 'rentals', filter: { from: from + '-01', to: to + '-31', vehicleId: vid || '' } };
  } else if(col === 'insurance'){
    head = ['Paid on', 'Vehicle', 'Kind', 'Amount'];
    (db.insurance || []).filter(i => inM(i.paidDate) && (!vid || i.vehicleId == vid)).sort((a, b) => a.paidDate < b.paidDate ? -1 : 1)
      .forEach(i => rows.push({ cells: [i.paidDate, reg(i.vehicleId), i.kind || '', money(i.amount)], value: num(i.amount), open: { panel: 'pilot', tab: 'insurance' } }));
    title = 'Insurance · ' + span + carText;
  } else if(col === 'collected'){
    head = ['Paid on', 'Vehicle', 'Client', 'Where listed', 'Amount'];
    const ids = new Set(rentalsIn().map(r => r.id));
    (db.payments || []).filter(p => ids.has(p.rentalId)).sort((a, b) => a.date < b.date ? -1 : 1).forEach(p => { const r = db.rentals.find(r => r.id == p.rentalId);
      rows.push({ cells: [p.date, reg(r.vehicleId), cli(r.clientId), p.source || p.method || '', money(p.amount)], value: num(p.amount), open: { panel: 'payments', id: p.id } }); });
    title = 'Collected (payments on rentals taken in) · ' + span + carText;
    showAll = { panel: 'payments', filter: { vehicleId: vid || '', from: from + '-01', to: to + '-31', byRentalMonth: true } };
  } else if(col === 'owed'){
    head = ['Pickup', 'Vehicle', 'Client', 'Billed', 'Paid', 'Owed'];
    rentalsIn().forEach(r => { const owed = Math.max(0, num(r.amount) - ctx.paidFor(r.id)); if(owed > 0) rows.push({ cells: [r.pickup, reg(r.vehicleId), cli(r.clientId), money(r.amount), money(ctx.paidFor(r.id)), money(owed)], value: owed, open: { panel: 'rentals', id: r.id } }); });
    rows.sort((a, b) => a.cells[0] < b.cells[0] ? -1 : 1);
    title = 'Still owed · ' + span + carText;
    showAll = { panel: 'rentals', filter: { pay: 'owing', from: from + '-01', to: to + '-31', vehicleId: vid || '' } };
  } else if(col === 'received'){
    head = ['Date', 'Where listed', 'Linked to', 'Amount'];
    (db.payments || []).filter(p => inM(p.date)).sort((a, b) => a.date < b.date ? -1 : 1).forEach(p => { const r = db.rentals.find(r => r.id == p.rentalId);
      rows.push({ cells: [p.date, p.source || p.method || '', r ? reg(r.vehicleId) + ' · ' + cli(r.clientId) : 'not linked to a rental', money(p.amount)], value: num(p.amount), open: { panel: 'payments', id: p.id } }); });
    title = 'Payments received · ' + span;
    showAll = { panel: 'payments', filter: { from: from + '-01', to: to + '-31' } };
  } else if(col === 'invoiceTotal' || col === 'invoiceUnpaid'){
    head = ['Invoice', 'Client', 'Date', 'Status', 'Amount'];
    (db.invoices || []).filter(i => i.month >= from && i.month <= to && (col === 'invoiceTotal' || i.status !== 'PAID')).sort((a, b) => a.date < b.date ? -1 : 1)
      .forEach(i => rows.push({ cells: [i.no, i.client, i.date, i.status || 'unpaid', money(i.amount)], value: num(i.amount), open: { panel: 'pilot', tab: 'pages', page: 'invoices', month: i.month } }));
    title = (col === 'invoiceTotal' ? 'Invoices' : 'Unpaid invoices') + ' · ' + span;
  } else if(col === 'invoice'){          // one invoice: the rentals it covers and the payments listed against it
    const inv = (db.invoices || []).find(i => i.id == spec.invoiceId); const no = inv ? inv.no : '';
    head = ['Pickup', 'Vehicle', 'Client', 'Billed (no VAT)'];
    (db.rentals || []).filter(r => String(r.invoice) === String(no)).forEach(r => rows.push({ cells: [r.pickup, reg(r.vehicleId), cli(r.clientId), money(r.amount)], value: num(r.amount), open: { panel: 'rentals', id: r.id } }));
    title = 'Invoice ' + no + (inv ? ' · ' + inv.client + ' · ' + money(inv.amount) + ' (VAT ' + money(inv.vat) + ')' : '');
    showAll = { panel: 'rentals', filter: { invoice: String(no) } };
  } else if(col === 'total'){            // Overview "Total spent": every cost column of the month, one after the other
    head = ['Cost', 'Date', 'Details', 'Amount'];
    SUMMARY_COLUMNS.map(c => ({ col: c.key, label: c.label })).concat([{ col: 'other', label: 'Other' }]).forEach(c => {
      const sub = drillRecords(db, Object.assign({}, spec, { col: c.col }), ctx);
      sub.rows.forEach(r => rows.push({ cells: [c.label, r.cells[0], r.cells.slice(1, -1).filter(x => x !== '' && x != null).join(' · '), r.cells[r.cells.length - 1]], value: r.value, open: r.open }));
    });
    title = 'Total spent · ' + span + carText;
  } else if(col === 'loan' || col === 'loanAll' || col === 'loanMonth'){      // the instalments a loan figure was added up from
    const kind = spec.kind || 'scheduled', one = col === 'loan', pick = (db.loans || []).filter(l => !spec.loanId || String(l.id) === String(spec.loanId));
    head = one ? ['Month', 'Due', 'Paid', 'Paid on', 'Left'] : ['Loan', 'Month', 'Due', 'Paid', 'Left'];
    pick.forEach(l => scheduleOf(l).forEach(s => {
      if(col === 'loanMonth' && s.month !== spec.month) return;
      const due = num(s.amount); if(!due) return; const paid = paidOf(s), left = due - paid;
      const v = kind === 'paid' ? paid : (kind === 'balance' || kind === 'left') ? left : due; if(kind !== 'scheduled' && kind !== 'due' && !v) return;
      const open = { panel: 'pilot', tab: 'loans', dueMonth: s.month, focus: '[data-t="loanmonthly"][data-r="' + s.month + '"]' };
      rows.push({ cells: one ? [monthName(s.month), money(due), money(paid), s.paidDate || (paid ? 'date not typed' : ''), money(left)] : [loanName(l), monthName(s.month), money(due), money(paid), money(left)], value: v, open });
    }));
    const l0 = pick.length === 1 ? loanName(pick[0]) : 'All loans';
    title = l0 + ' · ' + ({ scheduled: 'Scheduled (all instalments)', due: 'Due', paid: 'Paid so far', balance: 'Balance still to pay', left: 'Left to pay' }[kind] || 'Instalments') + (col === 'loanMonth' ? ' · ' + monthName(spec.month) : '');
  } else if(col === 'person'){            // one person's running lines under Loans > Individuals
    head = ['Date', 'Note', 'Amount'];
    const ps = persons(db), pi = ps.findIndex(p => p.name === spec.person), p = ps[pi];
    (p ? p.lines : []).forEach(x => rows.push({ cells: [x.date || '', x.note || '', money(x.amount)], value: num(x.amount), open: { panel: 'pilot', tab: 'loans', focus: '[data-t="ind' + pi + '"][data-r="' + x.id + '"]' } }));
    title = (spec.person || 'Person') + ' · balance = the lines below';
  } else if(col === 'insTab'){            // Pilot > Insurance: the policy lines behind a total, a vehicle or a month
    head = ['Paid on', 'Vehicle', 'Kind', 'Expires', 'Amount']; const today = new Date().toISOString().slice(0, 10);
    (db.insurance || []).filter(i => (!vid || (vid === 'none' ? !i.vehicleId : i.vehicleId == vid)) && (!spec.month || (spec.month === 'none' ? !(i.paidDate || '').slice(0, 7) : (i.paidDate || '').slice(0, 7) === spec.month)) && (!spec.expired || (i.expiryDate && i.expiryDate < today)))
      .sort((a, b) => (a.paidDate || '') < (b.paidDate || '') ? -1 : 1)
      .forEach(i => rows.push({ cells: [i.paidDate || '—', reg(i.vehicleId), i.kind || '', i.expiryDate || '—', money(i.amount)], value: num(i.amount), open: { panel: 'pilot', tab: 'insurance', focus: 'input[data-act="expiry"][data-id="' + i.id + '"]' } }));
    title = 'Insurance' + (spec.expired ? ' · expired' : '') + (spec.month ? ' · ' + (spec.month === 'none' ? 'no date' : monthName(spec.month)) : '') + carText;
  } else if(col === 'account'){           // OCHWADA statement: opening, charges, payments, closing for a month
    const accts = (db.accounts || []).filter(a => a.account === 'OCHWADA'), by = {};
    accts.forEach(a => { const b = by[a.month] = by[a.month] || { month: a.month, bf: null, entries: [], sheetTotal: null }; if(a.kind === 'bf') b.bf = num(a.amount); else b.entries.push(a); });
    const blocks = Object.values(by).sort((a, b) => a.month < b.month ? -1 : 1), carry = spec.carry !== false, st = statement(blocks, { carryBF: carry });
    const i = blocks.findIndex(b => b.month === spec.month), b = blocks[i], s = st[i], kind = spec.kind;
    const line = a => ({ cells: [a.date || '', a.label || a.note || '', money(a.amount)], value: num(a.amount), open: { panel: 'pilot', tab: 'ochwada', focus: '[data-m="' + a.month + '"]' } });
    head = ['Date', 'Note', 'Amount'];
    if(b){
      if(kind === 'charges') b.entries.filter(e => e.amount > 0).forEach(a => rows.push(line(a)));
      else if(kind === 'payments') b.entries.filter(e => e.amount < 0).forEach(a => rows.push(line(a)));
      else if(kind === 'opening'){
        if(carry && i > 0){ rows.push({ cells: ['', 'Brought forward typed at the start (' + monthName(blocks[0].month) + ')', money(st[0].opening)], value: st[0].opening, open: { panel: 'pilot', tab: 'ochwada', focus: '[data-m="' + blocks[0].month + '"]' } }); blocks.slice(0, i).forEach(x => x.entries.forEach(a => rows.push(line(a)))); }
        else rows.push({ cells: ['', 'Brought forward typed on the sheet for ' + monthName(b.month), money(s.opening)], value: s.opening, open: { panel: 'pilot', tab: 'ochwada', focus: '[data-m="' + b.month + '"]' } });
      } else if(kind === 'closing'){ rows.push({ cells: ['', 'Opening (brought forward)', money(s.opening)], value: s.opening, open: { panel: 'pilot', tab: 'ochwada', focus: '[data-m="' + b.month + '"]' } }); b.entries.forEach(a => rows.push(line(a))); }
    }
    title = 'OCHWADA · ' + ({ opening: 'Opening (BF)', charges: 'Charges', payments: 'Payments', closing: 'Closing' }[kind] || '') + ' · ' + (spec.month ? monthName(spec.month) : '');
  } else if(col === 'chama'){              // what a Chama figure was added up from
    const m = chamaModel(db, spec.scheme), kind = spec.kind, today = new Date().toISOString().slice(0, 10), roundOf = new Map();
    m.slots.forEach(k => m.by.get(k).forEach((e, ix) => roundOf.set(e.id, ix + 1)));
    head = ['Slot', 'Round', 'Due', 'Paid on', 'Amount'];
    (db.chama || []).filter(c => c.scheme === spec.scheme).filter(c => kind === 'behind' ? (!c.paid && c.dueDate && c.dueDate <= today) : kind === 'round' ? (c.paid && roundOf.get(c.id) === Number(spec.round)) : c.paid)
      .sort((a, b) => (a.dueDate || '') < (b.dueDate || '') ? -1 : 1)
      .forEach(c => rows.push({ cells: [String(c.slot), 'R' + roundOf.get(c.id), c.dueDate || '', c.paid ? (c.paidDate || c.dueDate || '') : 'not paid', money(c.amount)], value: num(c.amount), open: { panel: 'pilot', tab: 'chama', chamaView: { name: spec.scheme, v: String(roundOf.get(c.id)) }, focus: '[data-t="chama:' + String(spec.scheme).replace(/"/g, '') + '"][data-r="' + String(c.slot).replace(/"/g, '') + '"]' } }));
    title = spec.scheme + ' · ' + ({ saved: 'Saved so far (paid slots)', behind: 'Behind by (due, not paid)', round: 'Round ' + spec.round + ' paid' }[kind] || '');
  } else if(col === 'shOwner'){            // Sub-hire: what an owner (or all owners) is paid / still owed, from the rentals
    const k = spec.kind || 'cost', mo = spec.month || '';
    head = ['Dates', 'Car', 'Owner · job', 'Days', 'Amount'];
    ownerRows(db).filter(r => (!mo || r.month === mo) && (!spec.key || r.ownerKey === spec.key) && (!vid || r.vehicleId == vid)).forEach(r => {
      const live = r.status !== 'cancelled', v = k === 'cost' ? (live ? r.cost : 0) : k === 'paid' ? (r.status === 'paid' ? r.cost : 0) : k === 'notcleared' ? (r.status === 'notcleared' ? r.cost : 0) : k === 'cancelled' ? (r.status === 'cancelled' ? r.cost : 0)
        : k === 'billed' ? r.billed : k === 'fuel' ? r.fuel : k === 'allowance' ? r.allowance : 0;
      if(!v) return; if(r.rentalCancelled && (k === 'billed' || k === 'fuel' || k === 'allowance')) return;
      rows.push({ cells: [r.dates, r.reg, r.owner + ' · ' + (r.job || '—') + ' · ' + STATUS_LABEL[r.status], r.days, money(v)], value: v, open: { panel: 'rentals', id: r.id } });
    });
    title = 'Sub-hire · ' + ({ cost: 'Cost to owners', paid: 'Paid to owners', notcleared: 'Not cleared (still to pay)', cancelled: 'Cancelled (not a cost)', billed: 'Billed', fuel: 'Fuel', allowance: 'Allowance' }[k] || k) + ' · ' + (mo ? monthName(mo) : 'all months') + carText;
  } else if(col === 'shDriver'){           // Sub-hire drivers: amount per day × days, per job
    const k = spec.kind || 'amount', mo = spec.month || '';
    head = ['Dates', 'Car', 'Driver · client · status', 'Days', 'Amount'];
    driverRows(db).filter(r => (!mo || r.month === mo) && (!spec.driver || r.driver === spec.driver) && (!vid || r.vehicleId == vid)).forEach(r => {
      const v = k === 'amount' ? (r.status === 'cancelled' ? 0 : r.amount) : k === 'cancelled' ? (r.status === 'cancelled' ? r.amount : 0) : (r.status === k ? r.amount : 0); if(!v) return;
      rows.push({ cells: [r.dates, r.reg, r.driver + ' · ' + r.client + ' · ' + STATUS_LABEL[r.status], r.days, money(v)], value: v, open: { panel: 'rentals', id: r.id } });
    });
    title = 'Sub-hire drivers · ' + ({ amount: 'Amount', paid: 'Paid', notcleared: 'Not cleared', cancelled: 'Cancelled' }[k] || k) + ' · ' + (mo ? monthName(mo) : 'all months') + (spec.driver ? ' · ' + spec.driver : '');
  } else if(col === 'shCar'){              // Sub-hire car performance: one money column (or the left-over) for one car or all cars
    const f = spec.field, mo = spec.month || ''; const drv = new Map(driverRows(db).map(r => [r.id, r]));
    head = ['Dates', 'Car', 'Client · job', 'Days', f === 'net' ? 'Left over' : 'Amount'];
    ownerRows(db).filter(r => (!mo || r.month === mo) && !r.rentalCancelled && (!vid || (vid === 'none' ? !r.vehicleId : r.vehicleId == vid))).forEach(r => {
      const dr = drv.get(r.id), dp = dr && dr.status !== 'cancelled' ? dr.amount : 0, oc = r.status !== 'cancelled' ? r.cost : 0;
      const v = { billed: r.billed, ownerCost: oc, driverPay: dp, fuel: r.fuel, allowance: r.allowance, net: r.billed - oc - dp - r.fuel - r.allowance }[f]; if(!v) return;
      rows.push({ cells: [r.dates, r.reg, r.client + (r.job && r.job !== r.client ? ' · ' + r.job : ''), r.days, money(v)], value: v, open: { panel: 'rentals', id: r.id } });
    });
    title = 'Sub-hire car · ' + ({ billed: 'Billed', ownerCost: 'Owner cost', driverPay: 'Driver pay', fuel: 'Fuel', allowance: 'Allowance', net: 'Left over (billed − costs)' }[f] || f) + ' · ' + (mo ? monthName(mo) : 'all months') + carText;
  }
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { title, head, rows, total, showAll };
}

/* ---- the pages ---- */
function monthRange(db){
  const all = [];
  const add = s => { if(s && /^\d{4}-\d{2}/.test(s)) all.push(String(s).slice(0, 7)); };
  (db.rentals || []).forEach(r => add(r.pickup)); (db.expenses || []).forEach(x => add(x.date)); (db.insurance || []).forEach(i => add(i.paidDate));
  (db.invoices || []).forEach(i => add(i.date)); (db.payments || []).forEach(p => add(p.date));
  if(!all.length) return null;
  all.sort(); const today = new Date().toISOString().slice(0, 7);
  return [all[0], all[all.length - 1] > today ? all[all.length - 1] : today];
}
export const fig = (spec, text, cls) => `<button type="button" class="pg-fig ${cls || ''}" data-pg="drill" data-spec="${attr(spec)}">${text}</button>`;

function vehicleSelect(db, st){
  const opts = ['<option value="">All vehicles</option>'].concat([...(db.vehicles || [])].sort((a, b) => a.reg < b.reg ? -1 : 1).map(v => `<option value="${v.id}" ${String(st.vehicleId) === String(v.id) ? 'selected' : ''}>${esc(v.reg)}</option>`));
  return `<select data-pg-set="vehicleId" style="width:auto;">${opts.join('')}</select>`;
}

function progressPage(db, st, ctx){
  const rg = monthRange(db); if(!rg) return '<p class="subtitle">No data yet.</p>';
  const vid = st.vehicleId || null;
  const rows = monthlySummary(db, rg[0], rg[1], { vehicleId: vid, paidFor: ctx.paidFor });
  const costKeys = SUMMARY_COLUMNS.map(c => c.key).filter(k => !(vid && k === 'rent'));
  const costOf = r => costKeys.reduce((s, k) => s + num(r[k]), 0) + num(r.other);
  const f = ctx.fmt, blank = n => n ? f(n) : '—';
  const cell = (r, col, from, to) => r[col] ? fig({ col, from, to, vehicleId: vid }, f(r[col])) : '<span class="pg-nil">—</span>';
  const tot = {}; ['billed', 'collected', 'days', 'rentals', 'other'].concat(costKeys).forEach(k => { tot[k] = rows.reduce((s, r) => s + num(r[k]), 0); });
  const head = '<th>Month</th><th class="num">Rentals</th><th class="num">Days</th><th class="num">Billed</th><th class="num">Collected</th><th class="num">Owed</th>' + costKeys.map(k => `<th class="num">${esc(SUMMARY_COLUMNS.find(c => c.key === k).label)}</th>`).join('') + '<th class="num">Other</th><th class="num">Costs</th><th class="num">Net</th>';
  const body = rows.map(r => { const owed = Math.max(0, r.billed - r.collected), net = r.billed - costOf(r);
    return `<tr><td>${monthName(r.month)}</td><td class="num">${r.rentals || '—'}</td><td class="num">${r.days || '—'}</td><td class="num">${cell(r, 'billed', r.month, r.month)}</td><td class="num">${cell(r, 'collected', r.month, r.month)}</td>
      <td class="num">${owed ? fig({ col: 'owed', from: r.month, to: r.month, vehicleId: vid }, f(owed), 'pg-red') : '<span class="pg-nil">—</span>'}</td>
      ${costKeys.map(k => `<td class="num">${cell(r, k, r.month, r.month)}</td>`).join('')}<td class="num">${cell(r, 'other', r.month, r.month)}</td><td class="num"><b>${f(costOf(r))}</b></td><td class="num" style="color:var(--${net >= 0 ? 'green' : 'red'});">${f(net)}</td></tr>`; }).join('');
  const totCosts = costKeys.reduce((s, k) => s + tot[k], 0) + tot.other, a = rg[0], b = rg[1];
  const foot = `<tr><th>TOTAL</th><th class="num">${tot.rentals}</th><th class="num">${tot.days}</th><th class="num">${fig({ col: 'billed', from: a, to: b, vehicleId: vid }, f(tot.billed))}</th><th class="num">${fig({ col: 'collected', from: a, to: b, vehicleId: vid }, f(tot.collected))}</th>
    <th class="num">${fig({ col: 'owed', from: a, to: b, vehicleId: vid }, f(Math.max(0, tot.billed - tot.collected)), 'pg-red')}</th>${costKeys.map(k => `<th class="num">${tot[k] ? fig({ col: k, from: a, to: b, vehicleId: vid }, f(tot[k])) : '—'}</th>`).join('')}
    <th class="num">${tot.other ? fig({ col: 'other', from: a, to: b, vehicleId: vid }, f(tot.other)) : '—'}</th><th class="num">${f(totCosts)}</th><th class="num">${f(tot.billed - totCosts)}</th></tr>`;
  return `<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;"><label style="margin:0;">Vehicle</label>${vehicleSelect(db, st)}
      <span class="subtitle" style="margin:0;">${vid ? 'Costs shown are the ones keyed to this car. Office costs (rent) show under All vehicles.' : 'Every vehicle, every month.'} Click any figure to see the records behind it.</span></div>
    <div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div></div>`;
}

function costPage(db, st, ctx, cost){
  const rg = monthRange(db); if(!rg) return '<p class="subtitle">No data yet.</p>';
  const vid = st.vehicleId || null, f = ctx.fmt;
  const rows = monthlySummary(db, rg[0], rg[1], { vehicleId: vid }).filter(r => r[cost.col]);
  const count = r => drillRecords(db, { col: cost.col, from: r.month, to: r.month, vehicleId: vid }, ctx).rows.length;
  const total = rows.reduce((s, r) => s + r[cost.col], 0);
  const body = rows.map(r => `<tr><td>${monthName(r.month)}</td><td class="num">${count(r)}</td><td class="num">${fig({ col: cost.col, from: r.month, to: r.month, vehicleId: vid }, f(r[cost.col]))}</td></tr>`).join('');
  /* which cars: for the "all vehicles" view */
  let byCar = '';
  if(!vid){
    const all = drillRecords(db, { col: cost.col, from: rg[0], to: rg[1] }, ctx);
    const per = new Map();
    all.rows.forEach(r => { const k = r.cells[1]; const o = per.get(k) || { n: 0, sum: 0 }; o.n++; o.sum += r.value; per.set(k, o); });
    const regToId = new Map((db.vehicles || []).map(v => [v.reg, v.id]));
    byCar = `<h3 style="margin:18px 0 6px;">By vehicle, all months</h3><div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Vehicle</th><th class="num">Entries</th><th class="num">Total</th></tr></thead><tbody>
      ${[...per.entries()].sort((a, b) => b[1].sum - a[1].sum).map(([k, o]) => `<tr><td>${esc(k)}</td><td class="num">${o.n}</td><td class="num">${regToId.has(k) ? fig({ col: cost.col, from: rg[0], to: rg[1], vehicleId: regToId.get(k) }, f(o.sum)) : f(o.sum)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  return `<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;"><label style="margin:0;">Vehicle</label>${vehicleSelect(db, st)}<span class="subtitle" style="margin:0;">Click a month to see each entry; click an entry to open it where it is kept.</span></div>
    <div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Month</th><th class="num">Entries</th><th class="num">${esc(cost.label)}</th></tr></thead><tbody>${body || '<tr class="empty-row"><td colspan="3">Nothing recorded.</td></tr>'}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${fig({ col: cost.col, from: rg[0], to: rg[1], vehicleId: vid }, f(total))}</th></tr></tfoot></table></div></div>${byCar}`;
}

/* ---- Fuel: the account with the fuel station, as the FUEL sheet keeps it ---- */
const today10 = () => new Date().toISOString().slice(0, 10);
function fuelPage(db, st, ctx){
  const f = ctx.fmt, pos = fuelPosition(db), months = fuelAccountMonths(db);
  const sel = st.month && months.some(m => m.month === st.month) ? st.month : (months.length ? months[months.length - 1].month : '');
  const vname = id => { const v = (db.vehicles || []).find(v => v.id == id); return v ? v.reg : '—'; };
  const card = (label, val, sub, color) => `<div class="table-wrap" style="padding:10px 14px;min-width:170px;flex:1;"><div class="subtitle" style="margin:0;">${label}</div><div style="font-size:20px;font-weight:700;${color ? 'color:var(--' + color + ');' : ''}">${val}</div><div class="subtitle" style="margin:0;">${sub}</div></div>`;
  const behind = pos.balance < 0;
  const cards = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
    ${card('Balance with the station', f(Math.abs(pos.balance)), behind ? 'behind: the office owes the station' : 'in credit', behind ? 'red' : 'green')}
    ${card('Paid in (top-ups)', pos.paidIn ? fig({ col: 'fuelTopups', from: months.length ? months[0].month : '0000-00', to: months.length ? months[months.length - 1].month : '9999-99' }, f(pos.paidIn)) : f(0), pos.nTop + ' top-ups, not an expense')}
    ${card('Fuel taken (fills)', f(pos.taken), pos.nFill + ' fills, this is the fuel expense')}
    ${card('Opening balance', f(Math.abs(pos.opening)), pos.opening < 0 ? 'owed from last year' : (pos.opening ? 'credit from last year' : 'none recorded'))}</div>
    ${pos.undatedCount ? `<p class="subtitle">${pos.undatedCount} fuel line${pos.undatedCount === 1 ? ' has' : 's have'} no date (${f(pos.undatedAmount)}). They count in the balance above but cannot sit in a month until they get a date in Expenses.</p>` : ''}`;

  const monthRows = months.map(r => `<tr${r.month === sel ? ' style="background:rgba(120,120,120,.12);"' : ''}><td><button type="button" class="btn ${r.month === sel ? 'primary' : ''}" data-pg="fuelmonth" data-month="${r.month}" style="width:auto;padding:4px 10px;">${monthName(r.month)}</button></td>
    <td class="num">${r.topups ? fig({ col: 'fuelTopups', from: r.month, to: r.month }, f(r.topups)) : '<span class="pg-nil">—</span>'}</td>
    <td class="num">${r.fills ? fig({ col: 'fuel', from: r.month, to: r.month }, f(r.fills)) : '<span class="pg-nil">—</span>'}</td>
    <td class="num" style="color:var(--${r.net >= 0 ? 'green' : 'red'});">${f(r.net)}</td><td class="num" style="color:var(--${r.closing >= 0 ? 'green' : 'red'});"><b>${f(r.closing)}</b></td></tr>`).join('');
  const monthTable = `<div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Month</th><th class="num">Top-ups in</th><th class="num">Fuel taken</th><th class="num">Net</th><th class="num">Balance at month end</th></tr></thead>
    <tbody>${monthRows || '<tr class="empty-row"><td colspan="5">No fuel recorded yet.</td></tr>'}</tbody>
    <tfoot><tr><th>TOTAL</th><th class="num">${f(pos.paidIn)}</th><th class="num">${f(pos.taken)}</th><th class="num">${f(pos.paidIn - pos.taken)}</th><th class="num">${f(pos.balance)}</th></tr></tfoot></table></div></div>`;

  /* month navigator: previous / next, a month list, and "all months line by line" for any month, not only the current one */
  const mi = months.findIndex(m => m.month === sel);
  const navBar = months.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0 6px;">
      <button type="button" class="btn" data-pg="fuelprev" ${st.fuelAll || mi <= 0 ? 'disabled' : ''} style="width:auto;padding:6px 12px;">◀ Previous month</button>
      <select data-pg-set="month" aria-label="Choose a month" ${st.fuelAll ? 'disabled' : ''} style="width:auto;">${months.slice().reverse().map(r => `<option value="${r.month}" ${r.month === sel ? 'selected' : ''}>${monthName(r.month)}</option>`).join('')}</select>
      <button type="button" class="btn" data-pg="fuelnext" ${st.fuelAll || mi < 0 || mi >= months.length - 1 ? 'disabled' : ''} style="width:auto;padding:6px 12px;">Next month ▶</button>
      <button type="button" class="btn ${st.fuelAll ? 'primary' : ''}" data-pg="fuelall" style="width:auto;padding:6px 12px;">${st.fuelAll ? 'Back to one month' : 'Show all months, line by line'}</button></div>` : '';
  const lineRow = (e, L) => e.type === 'topup'
    ? `<tr><td>${esc(e.date)}</td><td class="num" style="color:var(--blue,#4a90e2);">${f(e.amount)}</td><td>${e.note ? esc(e.note) : '<span class="pg-nil">top-up</span>'}</td><td class="num"></td><td class="num" style="color:var(--${e.balance >= 0 ? 'green' : 'red'});">${f(e.balance)}</td>
        <td><button type="button" class="row-edit" data-pg="topupedit" data-id="${e.id}">Edit</button> <button type="button" class="row-del" data-pg="topupdel" data-id="${e.id}">Delete</button></td></tr>`
    : `<tr><td>${esc(e.date)}</td><td class="num"></td><td>${esc(vname(e.vehicleId))}</td><td class="num" style="color:var(--red);">−${f(e.amount)}</td><td class="num" style="color:var(--${e.balance >= 0 ? 'green' : 'red'});">${f(e.balance)}</td>
        <td><button type="button" class="row-edit" data-pg="open" data-open="${attr({ panel: 'expenses', id: e.id })}" title="Open where this is kept">Open ↗</button></td></tr>`;
  let allLedger = '';
  if(st.fuelAll && months.length){
    const Ls = months.map(r => fuelLedger(db, r.month)).filter(L => L.entries.length || L.opening !== L.closing);
    const body = Ls.map(L => `<tr class="pg-band"><td colspan="6" style="background:var(--panel-2);"><b>${monthName(L.month)}</b> · brought forward ${f(L.opening)}</td></tr>${L.entries.map(e => lineRow(e, L)).join('')}
      <tr class="pg-band"><td colspan="6" style="font-weight:600;border-bottom:2px solid var(--line);">${monthName(L.month)} total: paid in ${f(L.paidIn)} · fuel taken ${f(L.taken)} · balance ${f(L.closing)}</td></tr>`).join('');
    allLedger = `<h3 style="margin:10px 0 6px;">All months, line by line</h3><div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Date</th><th class="num">Paid in</th><th>Car / note</th><th class="num">Fuel taken</th><th class="num">Balance</th><th></th></tr></thead>
      <tbody>${body || '<tr class="empty-row"><td colspan="6">Nothing recorded.</td></tr>'}</tbody><tfoot><tr><th>ALL MONTHS</th><th class="num">${f(pos.paidIn)}</th><th></th><th class="num">${f(pos.taken)}</th><th class="num">${f(pos.balance)}</th><th></th></tr></tfoot></table></div></div>
      <p class="subtitle">Every top-up and fill in date order, month by month, with the running balance. To change a top-up press Edit and it opens in its month.</p>`;
  }

  let ledger = '';
  if(sel && !st.fuelAll){
    const L = fuelLedger(db, sel), editing = st.fuelEdit ? (db.fuelAccount || []).find(x => x.id == st.fuelEdit) : null;
    const rows = L.entries.map(e => lineRow(e, L)).join('');
    const defDate = editing ? editing.date : (sel === today10().slice(0, 7) ? today10() : sel + '-01');
    ledger = `<h3 style="margin:18px 0 6px;">${monthName(sel)}, line by line</h3>
      <div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Date</th><th class="num">Paid in</th><th>Car / note</th><th class="num">Fuel taken</th><th class="num">Balance</th><th></th></tr></thead>
      <tbody><tr><td colspan="4"><i>Balance brought forward</i></td><td class="num">${f(L.opening)}</td><td></td></tr>${rows || '<tr class="empty-row"><td colspan="6">Nothing in this month.</td></tr>'}</tbody>
      <tfoot><tr><th>${monthName(sel)}</th><th class="num">${f(L.paidIn)}</th><th></th><th class="num">${f(L.taken)}</th><th class="num">${f(L.closing)}</th><th></th></tr></tfoot></table></div></div>
      <div class="pg-fuelform" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:12px 0;">
        <div><label>${editing ? 'Editing top-up' : 'New top-up'}: date</label><input type="date" data-f="date" value="${esc(defDate)}"></div>
        <div><label>Amount paid in</label><input type="number" min="0" step="any" data-f="amount" value="${editing ? esc(editing.amount) : ''}" placeholder="5000"></div>
        <div><label>Note (optional)</label><input data-f="note" value="${editing ? esc(editing.note || '') : ''}"></div>
        <button type="button" class="btn primary" data-pg="topupsave" style="width:auto;padding:8px 16px;">${editing ? '✓ Save changes' : '+ Add top-up'}</button>
        ${editing ? '<button type="button" class="btn" data-pg="topupcancel" style="width:auto;padding:8px 16px;">Cancel</button>' : ''}</div>
      <p class="subtitle">A top-up is money paid to the station. It moves the balance but is never counted as fuel spent. Fuel taken is entered under Expenses (category Fuel) and shows here by itself.</p>`;
  }

  const opening = openingBalance(db);
  const openForm = `<details style="margin:10px 0;"><summary>Opening balance carried in (${f(opening)})</summary>
    <div class="pg-fuelform" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px;">
      <div><label>Balance at the start (negative = you owed the station)</label><input type="number" step="any" data-f="opening" value="${esc(opening)}"></div>
      <button type="button" class="btn" data-pg="openingsave" style="width:auto;padding:8px 16px;">Save opening balance</button></div></details>`;

  const reps = fuelRepeats(db);
  const repHtml = reps.length ? `<div class="table-wrap" style="padding:12px;margin:14px 0;border:1px solid var(--amber,#e8a33d);"><b>⚠ ${reps.length} fuel fill${reps.length === 1 ? '' : 's'} look entered twice</b>
    <div class="subtitle">Same car, same date, same amount. They are both counted as fuel taken. Nothing is removed unless you press Delete on the one that is wrong.</div>
    <table class="pg-table"><thead><tr><th>Date</th><th>Car</th><th class="num">Amount</th><th>Entries</th></tr></thead><tbody>${reps.map(g => `<tr><td>${esc(g[0].date)}</td><td>${esc(vname(g[0].vehicleId))}</td><td class="num">${f(g[0].amount)}</td>
      <td>${g.map((x, i) => `<span>#${i + 1}${x.xlRef ? ' (Excel ' + esc(x.xlRef) + ')' : ''} <button type="button" class="row-edit" data-pg="open" data-open="${attr({ panel: 'expenses', id: x.id })}">Open ↗</button>${i > 0 ? ` <button type="button" class="row-del" data-pg="fillremove" data-id="${x.id}">Delete</button>` : ''}</span>`).join(' &nbsp; ')}</td></tr>`).join('')}</tbody></table></div>` : '';

  return `${cards}${repHtml}${monthTable}${navBar}${st.fuelAll ? allLedger : ledger}${openForm}<h3 style="margin:22px 0 6px;">Fuel taken by car</h3>${costPage(db, st, ctx, COSTS[0])}`;
}

function invoicesPage(db, st, ctx){
  const f = ctx.fmt, inv = db.invoices || [];
  if(!inv.length) return '<p class="subtitle">No invoices yet. Import the Excel file (it has an INVOICE sheet) or they will fill as you issue them.</p>';
  const months = [...new Set(inv.map(i => i.month))].sort();
  const sel = st.month && months.includes(st.month) ? st.month : months[months.length - 1];
  const chips = months.map(m => { const t = inv.filter(i => i.month === m).reduce((s, i) => s + num(i.amount), 0);
    return `<button type="button" class="btn ${m === sel ? 'primary' : ''}" data-pg="month" data-month="${m}" style="width:auto;padding:6px 12px;">${monthName(m).slice(0, 3)} ${m.slice(2, 4)}<br><small>${Math.round(t / 1000)}k</small></button>`; }).join(' ');
  /* category chips: paid / unpaid, and whether the invoice is tied to rentals. Counts follow the other chip chosen. */
  ensureChipStyles();
  const monthInv = inv.filter(i => i.month === sel).sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : String(a.no) < String(b.no) ? -1 : 1));
  const rentalsOn = no => (db.rentals || []).filter(r => String(r.invoice) === String(no)).length;
  const groups = [{ id: 'invStatus', label: 'Status', options: [{ key: 'paid', label: 'Paid' }, { key: 'unpaid', label: 'Unpaid' }], test: (i, k) => (i.status === 'PAID') === (k === 'paid') },
    { id: 'invLink', label: 'Rentals', options: [{ key: 'linked', label: 'Tied to rentals' }, { key: 'unlinked', label: 'No rentals found' }], test: (i, k) => (rentalsOn(i.no) > 0) === (k === 'linked') }];
  const active = { invStatus: st.invStatus, invLink: st.invLink }, counts = facetCounts(monthInv, groups, active);
  const chipRows = groups.map(g => chipsHtml('inv', g, counts[g.id], active)).join('');
  const list = applyFacets(monthInv, groups, active);
  const amt = list.reduce((s, i) => s + num(i.amount), 0), vat = list.reduce((s, i) => s + num(i.vat), 0), unpaid = list.filter(i => i.status !== 'PAID').reduce((s, i) => s + num(i.amount), 0);
  const body = list.map(i => `<tr><td>${esc(i.client)}${i.note ? ' <span title="' + esc(i.note) + '">⚠</span>' : ''}</td><td class="num">${f(i.amount)}</td>
    <td>${rentalsOn(i.no) ? fig({ col: 'invoice', invoiceId: i.id, from: sel, to: sel }, esc(i.no)) : esc(i.no)}</td><td>${esc(i.date)}</td><td>${i.status === 'PAID' ? '<span class="status-paid">PAID</span>' : '<span class="status-unpaid">unpaid</span>'}</td><td class="num">${f(i.vat)}</td>
    <td class="num">${rentalsOn(i.no) || '—'}</td></tr>`).join('');
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${chips}</div>${chipRows}
    <div class="table-wrap"><div class="table-head"><h3>${monthName(sel)}</h3></div><div class="table-scroll"><table class="pg-table"><thead><tr><th>Client</th><th class="num">Amount</th><th>Invoice</th><th>Date</th><th>Status</th><th class="num">VAT</th><th class="num">Rentals</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><th>TOTAL</th><th class="num">${fig({ col: 'invoiceTotal', from: sel, to: sel }, f(amt))}</th><th></th><th></th><th class="num">${unpaid ? fig({ col: 'invoiceUnpaid', from: sel, to: sel }, 'unpaid ' + f(unpaid), 'pg-red') : ''}</th><th class="num">${f(vat)}</th><th></th></tr></tfoot></table></div></div>
    <p class="subtitle">An invoice number shown as a link is one that matches a set of rentals exactly; click it to see them. VAT is not part of Billed or Paid on a rental.</p>`;
}

function paymentsPage(db, st, ctx){
  const rg = monthRange(db); if(!rg) return '<p class="subtitle">No data yet.</p>';
  const f = ctx.fmt, byM = new Map();
  (db.payments || []).forEach(p => { const m = String(p.date || '').slice(0, 7); if(!m) return; const o = byM.get(m) || { n: 0, sum: 0, unl: 0 }; o.n++; o.sum += num(p.amount); if(p.rentalId === '' || p.rentalId == null) o.unl += num(p.amount); byM.set(m, o); });
  const months = [...byM.keys()].sort();
  const body = months.map(m => { const o = byM.get(m); return `<tr><td>${monthName(m)}</td><td class="num">${o.n}</td><td class="num">${fig({ col: 'received', from: m, to: m }, f(o.sum))}</td><td class="num">${o.unl ? f(o.unl) : '—'}</td></tr>`; }).join('');
  const tot = [...byM.values()].reduce((s, o) => s + o.sum, 0), unl = [...byM.values()].reduce((s, o) => s + o.unl, 0);
  return `<p class="subtitle">Money received, by the date it was paid. "Not linked" is money listed as paid that could not be tied to a rental; link it from the Payments table.</p>
    <div class="table-wrap"><div class="table-scroll"><table class="pg-table"><thead><tr><th>Month</th><th class="num">Payments</th><th class="num">Received</th><th class="num">Not linked</th></tr></thead><tbody>${body || '<tr class="empty-row"><td colspan="4">No payments yet.</td></tr>'}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${months.length ? fig({ col: 'received', from: months[0], to: months[months.length - 1] }, f(tot)) : f(0)}</th><th class="num">${f(unl)}</th></tr></tfoot></table></div></div>`;
}

export function drillHtml(db, st, ctx){
  let drill = '';
  if(st.drill){
    const d = drillRecords(db, st.drill, ctx);
    drill = `<div class="table-wrap pg-drill" id="pgDrill"><div class="table-head"><h3>${esc(d.title)}</h3><span><b>${ctx.fmt(d.total)}</b> · ${d.rows.length} record${d.rows.length === 1 ? '' : 's'}
        ${d.showAll ? ` <button type="button" class="btn" data-pg="showall" data-spec="${attr(d.showAll)}" style="width:auto;padding:5px 10px;">Show all in ${esc(d.showAll.panel)} ↗</button>` : ''} <button type="button" class="btn" data-pg="closedrill" style="width:auto;padding:5px 10px;">✕ Close</button></span></div>
      <div class="table-scroll" style="max-height:340px;overflow:auto;"><table class="pg-table"><thead><tr>${d.head.map((h, i) => `<th class="${i === d.head.length - 1 ? 'num' : ''}">${esc(h)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${d.rows.map((r, i) => `<tr>${r.cells.map((c, j) => `<td class="${j === r.cells.length - 1 ? 'num' : ''}">${esc(c)}</td>`).join('')}<td><button type="button" class="row-edit" data-pg="open" data-open="${attr(r.open)}" title="Open where this is kept">Open ↗</button></td></tr>`).join('') || `<tr class="empty-row"><td colspan="${d.head.length + 1}">Nothing behind this figure.</td></tr>`}</tbody>
      <tfoot><tr><th colspan="${d.head.length - 1}">Total</th><th class="num">${ctx.fmt(d.total)}</th><th></th></tr></tfoot></table></div></div>`;
  }
  return drill;
}

export function pagesHtml(db, st, ctx){
  const nav = (ctx.pageList ? ctx.pageList() : PAGE_LIST).map(p => `<button type="button" class="btn ${p.id === st.page ? 'primary' : ''}" data-pg="page" data-page="${p.id}" style="width:auto;padding:6px 12px;">${esc(p.label)}</button>`).join(' ');
  if(st.page === 'allexp'){ st.ex = st.ex || exState('range', db); }
  const body = st.page === 'allexp' ? explorerHtml(db, st.ex, Object.assign({}, ctx, { paidFor: ctx.paidFor })) : st.page === 'progress' ? progressPage(db, st, ctx) : st.page === 'invoices' ? invoicesPage(db, st, ctx) : st.page === 'payments' ? paymentsPage(db, st, ctx) : st.page === 'fuel' ? fuelPage(db, st, ctx)
    : st.page === 'subhire' ? subhirePageHtml(db, st, ctx) : st.page === 'subhireDriver' ? driverPageHtml(db, st, ctx)
    : costPage(db, st, ctx, COSTS.find(c => c.id === st.page) || COSTS[0]);
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${nav}</div>${drillHtml(db, st, ctx)}${body}`;
}

/* Click handling. st is the page state ({page, vehicleId, month, drill}); returns true when something changed and the view must be redrawn. */
export function pagesClick(e, st, ctx){
  const ct = chipTap(e, 'inv', { invStatus: st.invStatus, invLink: st.invLink }); if(ct){ st[ct.group] = ct.key; st.drill = null; return true; }
  const t = e.target.closest('[data-pg]'); if(!t) return false;
  const a = t.dataset.pg;
  if(a === 'page'){ st.page = t.dataset.page; st.drill = null; return true; }
  if(a === 'month'){ st.month = t.dataset.month; st.drill = null; return true; }
  if(a === 'shmonth' || a === 'sdmonth' || a === 'showner'){ st.drill = null; return subhireClick(t, st); }
  if(a === 'drill'){ st.drill = JSON.parse(t.dataset.spec); st.scrollDrill = true; return true; }
  if(a === 'closedrill'){ st.drill = null; return true; }
  if(a === 'open'){ ctx.nav.openRecord(JSON.parse(t.dataset.open)); return false; }
  if(a === 'fuelmonth'){ st.month = t.dataset.month; st.fuelAll = false; st.fuelEdit = null; st.drill = null; return true; }
  if(a === 'fuelprev' || a === 'fuelnext'){ const ms = fuelAccountMonths(ctx.db()).map(m => m.month); const i = ms.indexOf(st.month && ms.includes(st.month) ? st.month : ms[ms.length - 1]);
    const j = a === 'fuelprev' ? i - 1 : i + 1; if(j >= 0 && j < ms.length){ st.month = ms[j]; st.fuelEdit = null; st.drill = null; } return true; }
  if(a === 'fuelall'){ st.fuelAll = !st.fuelAll; st.fuelEdit = null; st.drill = null; return true; }
  if(a === 'topupedit'){ st.fuelEdit = t.dataset.id; const tx = (ctx.db().fuelAccount || []).find(x => x.id == t.dataset.id); if(tx && tx.date){ st.month = String(tx.date).slice(0, 7); } st.fuelAll = false; return true; }
  if(a === 'topupcancel'){ st.fuelEdit = null; return true; }
  if(a === 'topupsave'){
    const box = t.closest('.pg-fuelform'), v = k => box.querySelector('[data-f="' + k + '"]').value;
    const date = v('date'), amount = Number(v('amount')), note = v('note').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ ctx.toast('Choose the date of the top-up'); return false; }
    if(!(amount > 0)){ ctx.toast('The top-up amount must be more than 0'); return false; }
    const d = ctx.db(); d.fuelAccount = d.fuelAccount || [];
    const ex = st.fuelEdit ? d.fuelAccount.find(x => x.id == st.fuelEdit) : null;
    ctx.guard(ex ? ex.date : date, ex ? 'change this top-up' : 'add this top-up', () => {
      if(ex){ ex.date = date; ex.amount = amount; ex.note = note; } else d.fuelAccount.push({ id: ctx.uid(), date, kind: 'topup', amount, note, xlRef: '' });
      st.fuelEdit = null; st.month = date.slice(0, 7); ctx.markDirty(); ctx.redraw(); ctx.toast(ex ? 'Top-up updated' : 'Top-up added');
    });
    return false;
  }
  if(a === 'topupdel'){
    const d = ctx.db(), x = (d.fuelAccount || []).find(z => z.id == t.dataset.id); if(!x) return false;
    if(!window.confirm('Delete the top-up of ' + ctx.fmt(x.amount) + ' on ' + x.date + '? The balance will change.')) return false;
    ctx.guard(x.date, 'delete this top-up', () => { d.fuelAccount = d.fuelAccount.filter(z => z.id != x.id); ctx.markDirty(); ctx.redraw(); });
    return false;
  }
  if(a === 'openingsave'){
    const box = t.closest('.pg-fuelform'), val = Number(box.querySelector('[data-f="opening"]').value) || 0;
    const d = ctx.db(); d.fuelAccount = d.fuelAccount || [];
    ctx.guard('', 'change the opening balance', () => {
      d.fuelAccount = d.fuelAccount.filter(z => z.kind !== 'opening');
      if(val) d.fuelAccount.push({ id: ctx.uid(), date: '2026-01-01', kind: 'opening', amount: val, note: 'Balance carried in', xlRef: '' });
      ctx.markDirty(); ctx.redraw(); ctx.toast('Opening balance saved');
    });
    return false;
  }
  if(a === 'fillremove'){
    const d = ctx.db(), x = (d.expenses || []).find(z => z.id == t.dataset.id); if(!x) return false;
    if(!window.confirm('Delete this fuel fill of ' + ctx.fmt(x.amount) + ' on ' + x.date + '? It will no longer count as fuel taken.')) return false;
    ctx.removeExpense(x.id, () => ctx.redraw());
    return false;
  }
  if(a === 'showall'){ const s = JSON.parse(t.dataset.spec); ctx.nav.showList(s.panel, s.filter); return false; }
  return false;
}
export function pagesChange(e, st){
  const t = e.target.closest('[data-pg-set]'); if(!t) return false;
  st[t.dataset.pgSet] = t.value; st.drill = null; return true;
}
