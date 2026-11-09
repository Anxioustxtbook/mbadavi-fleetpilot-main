// node test/chips.test.mjs : the category chips (counts follow the other chips, tap again clears, Mixed fills)
import { applyFacets, facetCounts, chipsHtml, chipTap } from '../src/chips.js';
import { fuelAudit } from '../src/fuelCore.js';
let bad = 0; const ok = (n, c) => { if(!c){ bad++; console.log('FAIL', n); } else console.log('ok  ', n); };
const rows = [{ t: 'coop', s: 'Ola' }, { t: 'coop', s: 'Mixed' }, { t: 'walk', s: 'Ola' }, { t: 'walk', s: 'Outside' }, { t: 'walk', s: 'Mixed' }];
const groups = [{ id: 't', label: 'Type', options: [{ key: 'coop', label: 'Coop' }, { key: 'walk', label: 'Walk-in' }], test: (r, k) => r.t === k },
  { id: 's', label: 'Source', options: ['Ola', 'Outside', 'Mixed'].map(k => ({ key: k, label: k })), test: (r, k) => r.s === k }];
let c = facetCounts(rows, groups, {});
ok('no chip chosen: counts are totals', c.t.coop === 2 && c.t.walk === 3 && c.s.Mixed === 2 && c.s[''] === 5);
c = facetCounts(rows, groups, { t: 'coop' });
ok('after Coop: source counts are for Coop only', c.s.Ola === 1 && c.s.Mixed === 1 && c.s.Outside === 0);
ok('after Coop: the type row still shows both types (so you can switch)', c.t.coop === 2 && c.t.walk === 3);
ok('apply: Coop + Mixed = 1 row', applyFacets(rows, groups, { t: 'coop', s: 'Mixed' }).length === 1);
ok('apply: nothing chosen = all rows', applyFacets(rows, groups, {}).length === 5 && applyFacets(rows, groups, { t: '' }).length === 5);
const html = chipsHtml('x', groups[1], c.s, { s: 'Mixed' });
ok('html: counts, active chip and All chip', /data-key="Mixed"[^>]*>Mixed<small>1/.test(html) && html.includes('fp-chip on') && html.includes('data-key=""'));
const fake = (key, group, scope) => ({ target: { closest: () => ({ dataset: { chip: scope || 'x', key, group } }) } });
ok('tap a chip selects it', chipTap(fake('Ola', 's'), 'x', {}).key === 'Ola');
ok('tap the chip that is on clears it', chipTap(fake('Ola', 's'), 'x', { s: 'Ola' }).key === '');
ok('tap All clears', chipTap(fake('', 's'), 'x', { s: 'Ola' }).key === '');
ok('a chip of another screen is ignored', chipTap(fake('Ola', 's', 'perf'), 'x', {}) === null);
// Mixed on the real rule: Ola + Outside fills on one rental
const db = { vehicles: [{ id: 1 }], rentals: [{ id: 10, vehicleId: 1, pickup: '2026-10-01', return: '2026-10-03', status: 'Returned', fuel: 0 }, { id: 11, vehicleId: 1, pickup: '2026-10-05', return: '2026-10-06', status: 'Returned', fuel: 0 }],
  expenses: [{ id: 1, category: 'Fuel', rentalId: 10, vehicleId: 1, date: '2026-10-01', amount: 100, account: 'Ola' }, { id: 2, category: 'Fuel', rentalId: 10, vehicleId: 1, date: '2026-10-02', amount: 50, account: 'Outside' }, { id: 3, category: 'Fuel', rentalId: 11, vehicleId: 1, date: '2026-10-05', amount: 70, account: 'Ola' }] };
const a = fuelAudit(db, '', ''), mixed = a.filter(x => x.source === 'Mixed');
ok('rental with Ola + Outside is Mixed, the other is Ola', mixed.length === 1 && mixed[0].rentalId === 10 && a.find(x => x.rentalId === 11).source === 'Ola');
process.exit(bad ? 1 : 0);
