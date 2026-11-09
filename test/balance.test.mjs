import { balanceChecks } from '../src/balance.js';
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if(!c) fails++; };
const good = { nextId: 50, vehicles: [{ id: 1, reg: 'KDU 1' }], clients: [{ id: 2, name: 'A' }], drivers: [],
  rentals: [{ id: 3, vehicleId: 1, clientId: 2, pickup: '2026-09-01', return: '2026-09-02', amount: 7000, invoice: '11' }],
  payments: [{ id: 4, rentalId: 3, date: '2026-09-03', amount: 7000 }], invoices: [{ id: 5, no: '11', amount: 7000 }], expenses: [{ id: 6, vehicleId: 1, date: '2026-09-02', category: 'Fuel', amount: 100, account: 'Ola' }], coops: [], insurance: [] };
let r = balanceChecks(good, '2026-10-28'); ok('clean db: all checks pass', r.every(c => c.ok));
const bad = JSON.parse(JSON.stringify(good));
bad.payments.push({ id: 4, rentalId: 99, date: '2027-01-01', amount: 50 }, { id: 7, rentalId: 3, date: '', amount: 10 });
bad.invoices.push({ id: 8, no: '11' }); bad.rentals.push({ id: 9, vehicleId: 77, clientId: 2, pickup: '2026-09-05', return: '2026-09-01', amount: 0, invoice: '12' });
bad.coops.push({ id: 10, name: 'X', rentalId: 3, amount: 5000, start: '2026-09-01' }); bad.nextId = 5; bad.expenses.push({ id: 11, category: 'Fuel', amount: 300 });
r = balanceChecks(bad, '2026-10-28'); const by = Object.fromEntries(r.map(c => [c.id, c]));
['overpaid', 'pay-orphan', 'pay-dates', 'inv-dup', 'inv-missing', 'links', 'ids', 'rental-data', 'coop', 'fuel'].forEach(k => ok('catches: ' + k, !by[k].ok));
ok('rental money still adds up', by['rental-money'].ok);
process.exit(fails ? 1 : 0);
