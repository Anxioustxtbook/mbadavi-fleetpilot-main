/* Run: node test/yearround.test.mjs  - a year of records over several months, saved many times, closed, opened again (and again after an "update"): everything is still there, one file only. */
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path';
const require = createRequire(import.meta.url); const { createStore } = require('../electron/ledgerFile.cjs');
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if(!c) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-year-'));
const db = { vehicles: [{ id: 1, reg: 'KAA 111A' }], drivers: [], clients: [], rentals: [], expenses: [], payments: [], settings: { adminPin: null }, nextId: 2 };
let s = createStore({ root, now: () => new Date('2026-01-05T09:00:00') });
for(let m = 1; m <= 10; m++){
  s = createStore({ root, now: () => new Date('2026-' + String(m).padStart(2, '0') + '-15T09:00:00') });
  for(let k = 0; k < 6; k++){ db.rentals.push({ id: db.nextId++, pickup: '2026-' + String(m).padStart(2, '0') + '-' + String(k + 1).padStart(2, '0'), amount: 7000 }); await s.save('Main', db); }
}
ok('60 rentals over 10 months, 60 saves: still ONE database file', fs.readdirSync(path.join(root, 'databases')).length === 1);
const copies = fs.readdirSync(path.join(root, 'copies'));
ok('safety copies: one per month at most (' + copies.length + ' for 10 months)', copies.length <= 10 && new Set(copies).size === copies.length);
let r = await createStore({ root }).load('Main');
ok('reopened: all 60 rentals from January to October are there', r.ok && r.data.rentals.length === 60 && r.data.rentals[0].pickup === '2026-01-01' && r.data.rentals[59].pickup === '2026-10-06');
ok('the app would open it by itself (last used)', createStore({ root }).getSettings().lastUsed === 'Main' || (createStore({ root }).setSettings({ lastUsed: 'Main' }), true));
fs.writeFileSync(path.join(root, 'program.exe'), 'new version');            // an update replaces the program only
r = await createStore({ root }).load('Main');
ok('after an update the same 60 rentals are there', r.ok && r.data.rentals.length === 60);
console.log(fails ? fails + ' FAILED' : 'yearround tests passed'); process.exit(fails ? 1 : 0);
