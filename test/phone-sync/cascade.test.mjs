/* The automatic clean-up (links.js / cascade.js repair) must never delete a record: it keeps it and lists it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repair } from '../../src/cascade.js';
import { housekeeping } from '../../src/links.js';

const mk = () => ({ vehicles: [{ id: 1 }], clients: [{ id: 2 }], drivers: [], rentals: [{ id: 3, vehicleId: 1, clientId: 2, type: 'rent', status: 'Active' }], bookings: [{ id: 7, vehicleId: 9, clientId: 2 }, { id: 8, vehicleId: 1, clientId: 2 }],
  insurance: [{ id: 9, vehicleId: 5 }], expenses: [{ id: 10, source: 'rental', rentalId: 99, amount: 5 }, { id: 11, vehicleId: 1, rentalId: null }], payments: [], invoices: [], coops: [], individuals: [] });

test('repair keeps every record and lists the ones with a missing link', () => {
  const db = mk(); const r = repair(db);
  assert.equal(db.bookings.length, 2); assert.equal(db.insurance.length, 1); assert.equal(db.expenses.length, 2);
  const keys = r.report.map(x => x.list + ':' + x.id).sort();
  assert.deepEqual(keys, ['bookings:7', 'expenses:10', 'insurance:9']);
});
test('housekeeping after a sync removes nothing', () => {
  const db = mk(); let n = 100; const before = JSON.stringify(Object.keys(db).map(k => (db[k] || []).length));
  housekeeping(db, () => n++);
  assert.equal(JSON.stringify(Object.keys(db).map(k => (db[k] || []).length)), before.replace(/\]$/, ']'), 'no list got shorter');
});
