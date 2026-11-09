import { db } from './db.js';

/* Column spec: [jsKey, sqlColumn, type, refTable?]
   types: i=id  r=reference id (nullable)  s=string  n=number  d=date  t=time  b=boolean */
const TABLES = {
  vehicles: ['vehicles', [
    ['id','id','i'], ['reg','reg','s'], ['make','make','s'], ['model','model','s'],
    ['year','year','s'], ['rate','rate','n'], ['owner','owner','s'], ['status','status','s']]],
  drivers: ['drivers', [
    ['id','id','i'], ['name','name','s'], ['phone','phone','s'], ['license','license','s'],
    ['vehicleId','vehicle_id','r','vehicles'], ['allowance','allowance','n'], ['status','status','s']]],
  clients: ['clients', [
    ['id','id','i'], ['name','name','s'], ['phone','phone','s'], ['idnum','idnum','s'], ['dl','dl','s']]],
  bookings: ['bookings', [
    ['id','id','i'], ['vehicleId','vehicle_id','r','vehicles'], ['clientId','client_id','r','clients'],
    ['bookedOn','booked_on','d'], ['pickup','pickup_date','d'], ['return','return_date','d'],
    ['deposit','deposit','n'], ['status','status','s'], ['reminderAck','reminder_ack','b']]],
  rentals: ['rentals', [
    ['id','id','i'], ['vehicleId','vehicle_id','r','vehicles'], ['clientId','client_id','r','clients'],
    ['contract','contract','s'], ['invoice','invoice','s'], ['receipt','receipt','s'],
    ['pickup','pickup_date','d'], ['pickupTime','pickup_time','t'],
    ['return','return_date','d'], ['returnTime','return_time','t'],
    ['rate','rate','n'], ['days','days','n'], ['mileage','mileage','s'], ['amount','amount','n'],
    ['status','status','s'], ['fuel','fuel','n'], ['fuelCharge','fuel_charge','n']]],
  expenses: ['expenses', [
    ['id','id','i'], ['vehicleId','vehicle_id','r','vehicles'], ['date','expense_date','d'],
    ['category','category','s'], ['desc','description','s'], ['qty','qty','n'], ['amount','amount','n'],
    ['billable','billable','b'], ['billClientId','bill_client_id','r','clients'],
    ['chargeAmount','charge_amount','n'], ['source','source','s'], ['rentalId','rental_id','r','rentals']]],
  payments: ['payments', [
    ['id','id','i'], ['rentalId','rental_id','r','rentals'], ['date','payment_date','d'],
    ['amount','amount','n'], ['method','method','s'], ['note','note','s']]],
  driverAllowances: ['driver_allowances', [
    ['id','id','i'], ['driverId','driver_id','r','drivers'], ['weekStart','week_start','d'],
    ['amount','amount','n'], ['note','note','s']]]
};

// parents first (insert order); reverse for delete
const ORDER = ['vehicles','clients','drivers','bookings','rentals','expenses','payments','driverAllowances'];

const toBool = v => v === true || v === 'true' || v === 1 || v === '1';
const toDate = v => {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : null;
};
const toTime = v => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : null;
};

function coerce(type, v) {
  switch (type) {
    case 'i': { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
    case 'r': { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
    case 'n': return Number(v) || 0;
    case 'b': return toBool(v) ? 1 : 0;
    case 'd': return toDate(v);
    case 't': return toTime(v);
    default:  return v === null || v === undefined ? '' : String(v);
  }
}

/** Load the whole ledger in the exact shape the app keeps in memory (`db`). */
export function loadState() {
  const meta = db.prepare('SELECT * FROM app_state WHERE id = 1').get();
  const state = {};
  for (const key of ORDER) {
    const [table, cols] = TABLES[key];
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
    state[key] = rows.map(row => {
      const o = {};
      for (const [js, sql, type] of cols) {
        let v = row[sql];
        if (type === 't') v = v ? String(v).slice(0, 5) : '';
        else if (type === 'd') v = v || '';
        else if (type === 'b') v = !!v;
        else if (type === 'r') v = v ?? null;
        o[js] = v;
      }
      return o;
    });
  }
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
  state.settings = (meta && parse(meta.settings)) || { adminPin: null, chartType: 'pie' };
  state.period = meta ? parse(meta.period) ?? null : null;
  state.nextId = meta ? Number(meta.next_id) : 1;
  state.lastModified = meta ? meta.last_modified : null;
  return {
    state,
    revision: meta ? meta.revision : 0,
    savedAt: meta ? meta.saved_at : null,
    fileName: meta ? meta.file_name : null,
    workbookDirty: meta ? !!meta.workbook_dirty : true
  };
}

export class RevisionConflict extends Error {
  constructor(current) { super('Server has newer data'); this.current = current; }
}

/** Replace the whole ledger atomically. Pass baseRevision to detect another device saving first. */
export function saveState(state, { fileName = null, workbookDirty = true, baseRevision = null, force = false } = {}) {
  const warnings = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const meta = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
    if (!force && baseRevision !== null && meta && Number(baseRevision) !== meta.revision) {
      throw new RevisionConflict(meta.revision);
    }

    // build rows + validate ids
    const prepared = {};
    const idSets = {};
    let maxId = 0;
    for (const key of ORDER) {
      const [, cols] = TABLES[key];
      const seen = new Set();
      prepared[key] = [];
      for (const rec of Array.isArray(state[key]) ? state[key] : []) {
        const id = coerce('i', rec.id);
        if (!id) { warnings.push(`${key}: skipped a record with invalid id (${rec.id})`); continue; }
        if (seen.has(id)) { warnings.push(`${key}: duplicate id ${id} skipped`); continue; }
        seen.add(id);
        maxId = Math.max(maxId, id);
        prepared[key].push(cols.map(([js, , type]) => (js === 'id' ? id : coerce(type, rec[js]))));
      }
      idSets[key] = seen;
    }

    // null out references that point to records that no longer exist
    for (const key of ORDER) {
      const [, cols] = TABLES[key];
      cols.forEach(([js, , type, ref], idx) => {
        if (type !== 'r') return;
        for (const row of prepared[key]) {
          if (row[idx] !== null && !idSets[ref].has(row[idx])) {
            warnings.push(`${key} #${row[0]}: ${js} -> missing ${ref} #${row[idx]} cleared`);
            row[idx] = null;
          }
        }
      });
    }

    // children first
    for (const key of [...ORDER].reverse()) db.exec(`DELETE FROM "${TABLES[key][0]}"`);
    for (const key of ORDER) {
      const [table, cols] = TABLES[key];
      if (!prepared[key].length) continue;
      const names = cols.map(c => `"${c[1]}"`).join(',');
      const insert = db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of prepared[key]) insert.run(...row);
    }

    const nextId = Math.max(Number(state.nextId) || 1, maxId + 1);
    db.prepare(
      `UPDATE app_state SET settings = ?, next_id = ?, period = ?, last_modified = ?,
         file_name = ?, workbook_dirty = ?, revision = revision + 1,
         saved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`
    ).run(JSON.stringify(state.settings || {}), nextId, JSON.stringify(state.period ?? null),
      state.lastModified || null, fileName, workbookDirty ? 1 : 0);
    const after = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
    db.exec('COMMIT');
    return { revision: after.revision, warnings };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
