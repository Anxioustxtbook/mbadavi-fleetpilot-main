/* Run: node test/dbpersist.test.mjs  — the page's start-up and save rules, against the real file store */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
import { startDatabase, DesktopDb, lowDisk } from '../src/dbPersist.js'; import { todayData } from '../src/today.js';
const { createStore } = createRequire(import.meta.url)('../electron/ledgerFile.cjs');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const fmtOf = file => { const d = new DatabaseSync(file, { readOnly: true }); try{ return Number(d.prepare("SELECT value FROM meta WHERE key = 'formatVersion'").get().value); }finally{ d.close(); } };
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if(!c) fails++; };
const led = (n, x) => Object.assign({ vehicles: Array.from({ length: n }, (_, i) => ({ id: i + 1, reg: 'K' + i })), rentals: [], nextId: n + 1, settings: {} }, x);
const bridgeOf = store => ({ dbSettings: async () => ({ ok: true, settings: store.getSettings(), databases: store.list(), folder: store.root }), dbSetSettings: async p => ({ ok: true, settings: store.setSettings(p) }),
  dbLoad: n => store.load(n), dbSave: (n, d) => store.save(n, d), dbSaveSync: (n, d) => store.saveSync(n, d), dbCreate: (n, d) => store.create(n, d), dbCopies: async () => ({ ok: true, copies: store.copies() }), dbReadCopy: async id => store.readCopy(id) });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')); let store = createStore({ root, now: () => new Date('2026-10-31T09:00:00') }); let b = bridgeOf(store);
const yes = () => true;

/* a new installation starts with a new SQLite database; browser storage is not consulted */
let browserRead = false;
let st = await startDatabase({ bridge: b, readBrowser: async () => { browserRead = true; return { data: led(7) }; }, confirmFn: yes });
ok('first start: starts empty without reading browser storage', st.source === 'empty' && st.data === null && st.needsFirstSave && !browserRead);
const d = new DesktopDb(b, st.name); await d.save(led(7));
ok('first save creates the SQLite database', store.list()[0].records === 7 && store.getSettings().migrated === true && store.getSettings().lastUsed === 'Main');
/* later start reads the SQLite file */
await d.save(led(9));
st = await startDatabase({ bridge: b, confirmFn: yes });
ok('next start opens the saved SQLite file', st.source === 'file' && st.data.vehicles.length === 9);

/* which database is shown */
await store.create('Second', led(2)); await d.save(led(9));
st = await startDatabase({ bridge: b, confirmFn: yes }); ok('default: the last one used', st.name === 'Main');
store.setSettings({ lastUsed: 'Second' }); st = await startDatabase({ bridge: b, confirmFn: yes }); ok('last used follows', st.name === 'Second');
store.setSettings({ startWith: 'Main' }); st = await startDatabase({ bridge: b, confirmFn: yes }); ok('Pilot setting wins over last used', st.name === 'Main');
st = await startDatabase({ bridge: b, confirmFn: yes, openOnce: 'Second' }); ok('"Open" in Pilot opens that one now', st.name === 'Second');
store.setSettings({ startWith: 'last' });

/* a newer file: blocked, never written */
store.closeAll(); const f = path.join(root, 'databases', 'Second.db'); { const d = new DatabaseSync(f); d.exec("UPDATE meta SET value = '99' WHERE key = 'formatVersion'"); d.close(); }
store = createStore({ root }); b = bridgeOf(store); store.setSettings({ lastUsed: 'Second' });
st = await startDatabase({ bridge: b, confirmFn: yes });
ok('a newer file: start-up stops with a plain message', st.blocked && /newer version/.test(st.blocked.message));
const dn = new DesktopDb(b, 'Second'); dn.blocked = st.blocked.message; ok('and saving to it is refused', (await dn.save(led(1))).locked === true && fmtOf(f) === 99);

/* a damaged file: the monthly copy is offered */
store = createStore({ root, now: () => new Date('2026-11-02T09:00:00') }); b = bridgeOf(store); const dm = new DesktopDb(b, 'Main'); await dm.save(led(9, { x: 1 })); await dm.save(led(10));
store.closeAll(); fs.writeFileSync(path.join(root, 'databases', 'Main.db'), 'broken, not a database file at all'); store.setSettings({ lastUsed: 'Main' });
st = await startDatabase({ bridge: b, confirmFn: yes });
ok('damaged file: the newest monthly copy is loaded and the damaged one set aside', st.source === 'copy' && st.data.vehicles.length === 9 && fs.readdirSync(path.join(root, 'damaged')).length === 1);

/* messages: red only for a lasting failure, yellow for a nearly full disk */
let fail = true; const flaky = { dbSave: async () => fail ? { ok: false, error: 'the file is locked' } : { ok: true, bytes: 1000, free: 50e6 }, dbSetSettings: async () => ({}) };
const fd = new DesktopDb(flaky, 'Main'); await fd.save(led(1)); ok('one failed write is retried quietly (no red message)', fd.problem() === '');
await fd.save(led(1)); ok('the same failure twice is shown', /locked/.test(fd.problem()));
fail = false; await fd.save(led(1)); ok('and clears when saving works again', fd.problem() === '' && /nearly full/.test(fd.diskNote()));
ok('disk rule: plenty of room is silent', !lowDisk(5e9, 3e6) && lowDisk(100e6, 3e6) && lowDisk(2e9, 200e6));

/* Today */
const db = led(3, { bookings: [{ id: 50, vehicleId: 1, clientId: 1, pickup: '2026-10-31', return: '2026-11-02', status: 'Confirmed' }, { id: 51, vehicleId: 2, clientId: 1, pickup: '2026-11-03', return: '2026-11-04', status: 'Pending' }, { id: 52, vehicleId: 2, clientId: 1, pickup: '2026-11-02', return: '2026-11-04', status: 'Cancelled' }],
  clients: [{ id: 1, name: 'ACME' }], rentals: [{ id: 60, vehicleId: 3, clientId: 1, pickup: '2026-10-25', return: '2026-10-30', status: 'Active' }, { id: 61, vehicleId: 1, clientId: 1, pickup: '2026-10-28', return: '2026-10-31', status: 'Active' }, { id: 62, vehicleId: 2, clientId: 1, pickup: '2026-10-31', return: '2026-11-01', status: 'Active' }] });
const t = todayData(db, '2026-10-31');
ok('Today: going out = booking + rental starting today', t.out.length === 2);
ok('Today: due back today and late are separate', t.back.length === 1 && t.late.length === 1 && t.late[0].daysLate === 1);
ok('Today: bookings in the next days, cancelled ones left out', t.next.length === 1 && t.next[0].id === 51);
console.log(fails ? fails + ' FAILED' : 'dbpersist tests passed'); process.exit(fails ? 1 : 0);
