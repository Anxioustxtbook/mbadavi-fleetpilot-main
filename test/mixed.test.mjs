import { rentalSource, fuelAudit, carPerformance } from '../src/fuelCore.js';
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if(!c) bad++; };
const db = { vehicles: [{ id: 1, reg: 'KAA 1A' }, { id: 2, reg: 'KBB 2B', ownership: 'subhire' }],
  rentals: [{ id: 10, vehicleId: 1, pickup: '2026-05-02', return: '2026-05-05', days: 4, amount: 40000, fuel: 0, status: 'Returned' }, { id: 11, vehicleId: 1, pickup: '2026-05-10', return: '2026-05-11', days: 2, amount: 20000, fuel: 1500, status: 'Returned' }, { id: 12, vehicleId: 2, pickup: '2026-05-03', return: '2026-05-04', days: 2, amount: 30000, subhireCost: 12000, type: 'coop', status: 'Returned' }],
  expenses: [{ id: 1, category: 'Fuel', vehicleId: 1, rentalId: 10, date: '2026-05-02', amount: 3000, account: 'Ola' }, { id: 2, category: 'Fuel', vehicleId: 1, rentalId: 10, date: '2026-05-04', amount: 2000, account: 'Outside' },
    { id: 3, category: 'Fuel', vehicleId: 1, rentalId: 11, date: '2026-05-10', amount: 1000, account: 'Ola' }, { id: 4, category: 'Fuel', vehicleId: 2, rentalId: 12, date: '2026-05-03', amount: 900 }] };
ok('Ola then Outside in one rental = Mixed', rentalSource(db, db.rentals[0]).source === 'Mixed');
ok('Ola only', rentalSource(db, db.rentals[1]).source === 'Ola');
ok('untagged coop fuel', rentalSource(db, db.rentals[2]).source === 'Untagged');
const a = fuelAudit(db, '', '').find(x => x.rentalId === 10); ok('audit carries split', a.ola === 3000 && a.outside === 2000 && a.total === 5000);
const c = carPerformance(db, '', ''); const car1 = c.find(x => x.reg === 'KAA 1A');
ok('car fuel is one total (5000 + 1500 + 1000)', car1.fuel === 7500); ok('mixed count', car1.mixed === 1);
ok('net = billed - fuel', car1.net === 60000 - 7500);
const car2 = c.find(x => x.reg === 'KBB 2B'); ok('sub-hire car net includes sub-hire cost', car2.net === 30000 - 900 - 12000);
process.exit(bad ? 1 : 0);
