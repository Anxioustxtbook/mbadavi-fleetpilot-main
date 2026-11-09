/* Monthly summary, the same columns as Sheet1 of the old workbook, drawn from the database.
   Rentals count in the month they were taken; expenses, insurance payments in the month of their date. */
import { ownerCost, driverCost, isDriverLine } from './subhireCore.js';
export const SUMMARY_COLUMNS = [
  { key: 'fuel', label: 'Fuel' }, { key: 'subhire', label: 'Sub-hire' }, { key: 'subhireDriver', label: 'Sub-hire driver' },
  { key: 'allowance', label: 'Allowance' }, { key: 'insurance', label: 'Insurance' }, { key: 'carwash', label: 'Carwash' },
  { key: 'transport', label: 'Transport' }, { key: 'airport', label: 'Airport fee' }, { key: 'garage', label: 'Garage' }, { key: 'rent', label: 'Rent' }
];
export const CAT_COL = { Fuel: 'fuel', Cleaning: 'carwash', Transport: 'transport', Airport: 'airport', Garage: 'garage', Rent: 'rent', 'Sub-hire driver': 'subhireDriver' };

function nextMonth(ym){ let [y, m] = ym.split('-').map(Number); m++; if(m > 12){ m = 1; y++; } return y + '-' + String(m).padStart(2, '0'); }

export function monthlySummary(db, fromMonth, toMonth, opts = {}){   // 'YYYY-MM' inclusive; opts: { vehicleId, paidFor(rentalId) }
  const vid = opts.vehicleId || null, paidFor = opts.paidFor || null;
  const ofCar = id => !vid || id == vid;
  const rows = new Map();
  const row = ym => { if(!rows.has(ym)) rows.set(ym, Object.fromEntries([['month', ym]].concat(SUMMARY_COLUMNS.map(c => [c.key, 0]), [['billed', 0], ['rentals', 0], ['other', 0], ['days', 0], ['collected', 0]]))); return rows.get(ym); };
  const inRange = ym => ym >= fromMonth && ym <= toMonth;
  (db.rentals || []).forEach(r => { const ym = (r.pickup || '').slice(0, 7); if(!ym || !inRange(ym) || r.status === 'Cancelled' || !ofCar(r.vehicleId)) return;
    const m = row(ym); m.subhire += ownerCost(r); if(isDriverLine(db, r)) m.subhireDriver += driverCost(r); m.allowance += Number(r.allowance) || 0; m.billed += Number(r.amount) || 0; m.rentals++; m.days += Number(r.days) || 0; if(paidFor) m.collected += paidFor(r.id); });
  (db.expenses || []).forEach(x => { const ym = (x.date || '').slice(0, 7); if(!ym || !inRange(ym) || !ofCar(x.vehicleId)) return;
    const m = row(ym), col = CAT_COL[x.category]; if(col) m[col] += Number(x.amount) || 0; else m.other += Number(x.amount) || 0; });
  (db.insurance || []).forEach(i => { const ym = (i.paidDate || '').slice(0, 7); if(ym && inRange(ym) && ofCar(i.vehicleId)) row(ym).insurance += Number(i.amount) || 0; });
  /* standing monthly expenses (rent): {category, amount, fromMonth, toMonth?}; skipped in a month that already has a real entry for it */
  (!vid && db.settings && db.settings.standingExpenses || []).forEach(se => {
    const col = CAT_COL[se.category]; if(!col) return;
    const lo = se.fromMonth && se.fromMonth > fromMonth ? se.fromMonth : fromMonth;
    const hi = se.toMonth && se.toMonth < toMonth ? se.toMonth : toMonth;
    for(let ym = lo; ym <= hi; ym = nextMonth(ym)){
      const has = (db.expenses || []).some(x => x.category === se.category && (x.date || '').slice(0, 7) === ym);
      if(!has) row(ym)[col] += Number(se.amount) || 0;
    }
  });
  return [...rows.values()].sort((a, b) => a.month < b.month ? -1 : 1);
}
