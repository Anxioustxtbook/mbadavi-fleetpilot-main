/* Run: node test/dbstore.test.mjs   (needs no Electron: the desktop store is plain Node + node:sqlite) */
import { createRequire } from 'module';
import fs from 'fs'; import os from 'os'; import path from 'path';
const require = createRequire(import.meta.url);
const { createStore, CURRENT_FORMAT } = require('../electron/ledgerFile.cjs');
const { DatabaseSync } = require('node:sqlite');

let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if(!c) fails++; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
const ledger = (n, extra) => Object.assign({ vehicles: Array.from({ length: n }, (_, i) => ({ id: i + 1, reg: 'KAA ' + i })), drivers: [], clients: [], rentals: [], expenses: [], payments: [], settings: { adminPin: 'x' }, nextId: n + 1 }, extra || {});
const at = iso => () => new Date(iso);
const dbFile = (root, name) => path.join(root, 'databases', name + '.db');
const peek = (file, sql) => { const d = new DatabaseSync(file, { readOnly: true }); try{ return d.prepare(sql).all(); }finally{ d.close(); } };

/* ---- save, close, open again ---- */
{
  const root = tmp(); let s = createStore({ root, now: at('2026-10-31T10:00:00') });
  const r = await s.save('Main', ledger(3, { period: null, nested: { a: [1, 2, { b: 'c' }] } }));
  ok('save writes the SQLite database', r.ok && fs.existsSync(dbFile(root, 'Main')) && r.bytes > 0);
  ok('each record is its own row', peek(dbFile(root, 'Main'), "SELECT id FROM records WHERE list = 'vehicles' ORDER BY pos").map(x => x.id).join() === '1,2,3');
  s.closeAll(); s = createStore({ root });                       // "close and start again"
  const l = await s.load('Main');
  ok('reopened: the same records are there', l.ok && l.data.vehicles.length === 3 && l.data.settings.adminPin === 'x' && l.data.nextId === 4);
  ok('values, nulls, nested objects and empty lists come back exactly', l.ok && l.data.period === null && JSON.stringify(l.data.nested) === '{"a":[1,2,{"b":"c"}]}' && Array.isArray(l.data.drivers) && l.data.drivers.length === 0);
  ok('the order of keys is kept', Object.keys(l.data).join() === Object.keys(ledger(3, { period: null, nested: 1 })).join());
  ok('the list shows it with its record count', s.list()[0].name === 'Main' && s.list()[0].records === 3);
  ok('last used / start-with settings are kept', (s.setSettings({ lastUsed: 'Main' }), createStore({ root }).getSettings().lastUsed === 'Main' && createStore({ root }).getSettings().startWith === 'last'));
  const sy = s.saveSync('Main', ledger(5));
  ok('synchronous save (window closing) works', sy.ok && (await createStore({ root }).load('Main')).data.vehicles.length === 5);
  await s.save('Main', ledger(1));
  ok('a shorter list leaves no old rows behind', peek(dbFile(root, 'Main'), "SELECT COUNT(*) n FROM records")[0].n === 1);
  s.closeAll();
}

/* ---- indexed daily records are retrieved directly from the continuous SQLite ledger ---- */
{
  const root = tmp(), s = createStore({ root });
  const date = '2026-01-02';
  const data = ledger(1, {
    rentals: [
      { id: 1, pickup: date, return: date, status: 'Active', amount: 100 },
      { id: 2, pickup: date, return: date, status: 'Cancelled', amount: 200 },
      { id: 3, pickup: '2026-01-01', return: date, status: 'Active', amount: 300 },
      { id: 4, pickup: '2026-01-01', return: '2026-01-01', status: 'Active', amount: 400 },
      { id: 5, pickup: date, return: '2026-01-03', status: 'Active', amount: 500 }
    ],
    payments: [{ id: 6, date, amount: 25 }, { id: 7, date: '2026-01-03', amount: 50 }],
    expenses: [{ id: 8, date, amount: 10 }, { id: 9, date: '2026-01-03', amount: 20 }],
    bookings: [{ id: 10, bookedOn: date }, { id: 11, bookedOn: '2026-01-03' }]
  });
  await s.save('Main', data);
  const day = s.daily('Main', date);
  ok('daily SQLite lookup returns only the selected-date rentals, payments and expenses', day.ok && day.rentals.map(x => x.id).join() === '1,5' && day.payments.map(x => x.id).join() === '6' && day.expenses.map(x => x.id).join() === '8');
  ok('daily SQLite lookup includes active, due-back and overdue rentals correctly', day.activeOnDate.map(x => x.id).join() === '1,3,5' && day.dueBack.map(x => x.id).join() === '1,3' && day.overdue.map(x => x.id).join() === '4');
  ok('daily SQLite lookup counts bookings and rejects invalid dates', day.bookings === 1 && !s.daily('Main', '2026-02-30').ok);
  const plan = peek(dbFile(root, 'Main'), "EXPLAIN QUERY PLAN SELECT data FROM records WHERE list = 'expenses' AND json_extract(data, '$.date') = '2026-01-02'");
  ok('daily expense lookup uses its SQLite date index', plan.some(x => /expenses_by_date/.test(x.detail)));
  s.closeAll();
}

/* ---- database management keeps the active ledger and recovery snapshots safe ---- */
{
  const root = tmp(), s = createStore({ root });
  await s.save('Main', ledger(1));
  await s.save('Archive', ledger(2));
  s.setSettings({ lastUsed: 'Main', startWith: 'Archive' });
  ok('the active database cannot be deleted', !s.deleteDatabase('Main', 'Main').ok && fs.existsSync(dbFile(root, 'Main')));
  const removed = s.deleteDatabase('Archive', 'Main');
  ok('an inactive database can be deleted without deleting its recovery copy', removed.ok && !fs.existsSync(dbFile(root, 'Archive')) && s.copies().some(x => x.db === 'Archive'));
  ok('deleting a startup default safely returns startup to the last-used database', s.getSettings().startWith === 'last' && s.getSettings().lastUsed === 'Main');
  s.closeAll();
}

/* ---- the .fpdb.json files of v21 and earlier move into SQLite once ---- */
{
  const root = tmp(); fs.mkdirSync(path.join(root, 'databases'), { recursive: true });
  const wrapped = { format: 'fleetpilot-database', formatVersion: 1, appVersion: 'v21', name: 'Main', savedAt: '2026-10-01T08:00:00.000Z', records: 4, data: ledger(4) };
  fs.writeFileSync(path.join(root, 'databases', 'Main.fpdb.json'), JSON.stringify(wrapped));
  fs.writeFileSync(path.join(root, 'databases', 'Bare.fpdb.json'), JSON.stringify(ledger(2)));    // format 0
  fs.writeFileSync(path.join(root, 'databases', 'Broken.fpdb.json'), '{"vehicles":[');
  const s = createStore({ root }); const l = await s.load('Main');
  ok('an old JSON database is opened from SQLite with all its records', l.ok && l.data.vehicles.length === 4 && l.savedAt === '2026-10-01T08:00:00.000Z');
  ok('the start tells where the old file went', /old-files/.test(l.movedFrom));
  ok('the old file is kept, unchanged, in old-files and no JSON database is left', fs.existsSync(path.join(root, 'old-files', 'Main.fpdb.json')) && !fs.readdirSync(path.join(root, 'databases')).some(n => n.endsWith('.json')));
  ok('a bare (format 0) JSON ledger is moved too', (await s.load('Bare')).data.vehicles.length === 2);
  ok('a damaged JSON file is set aside, not moved', fs.readdirSync(path.join(root, 'damaged')).some(n => n.startsWith('Broken')) && !fs.existsSync(dbFile(root, 'Broken')));
  s.closeAll();
  ok('starting again does not move anything twice', (createStore({ root }).list().length === 2) && !(await createStore({ root }).load('Main')).movedFrom);
}

/* ---- format version: newer program upgrades an older database step by step, once-copy of the old one ---- */
{
  const root = tmp(), steps = [];
  const upgrades = { 0: d => d, 1: d => { steps.push(1); d.step1 = true; return d; }, 2: d => { steps.push(2); d.step2 = d.step1 === true; return d; } };
  const v1 = createStore({ root, current: 1, upgrades }); await v1.save('Main', ledger(2)); v1.closeAll();
  const v3 = createStore({ root, current: 3, upgrades }); const l = await v3.load('Main');
  ok('format 1 -> 3 runs step 1 then step 2, in order', l.ok && steps.join() === '1,2' && l.data.step1 === true && l.data.step2 === true && l.upgradedFrom === 1 && l.formatVersion === 3);
  ok('the old database is kept once, named with its version', fs.existsSync(path.join(root, 'copies', 'Main - old format v1.db')));
  v3.closeAll();
  const before = peek(dbFile(root, 'Main'), 'SELECT data FROM records');
  const v2 = createStore({ root, current: 2, upgrades });                // an OLDER program meets the format-3 database
  const refuse = await v2.load('Main');
  ok('an older program refuses a newer database with a plain message', !refuse.ok && refuse.reason === 'newer' && /newer version of FleetPilot/.test(refuse.message));
  const w = await v2.save('Main', ledger(9));
  ok('and never overwrites it', !w.ok && w.locked === true && JSON.stringify(peek(dbFile(root, 'Main'), 'SELECT data FROM records')) === JSON.stringify(before));
  ok('same for the synchronous save', v2.saveSync('Main', ledger(9)).ok === false);
  const bad = createStore({ root: tmp(), current: 2, upgrades: { 0: d => d } });
  await bad.save('X', ledger(1)); bad.closeAll();
  const bad2 = createStore({ root: bad.root, current: 3, upgrades: { 0: d => d } });
  ok('a missing upgrade step fails safely', (await bad2.load('X')).reason === 'upgrade-failed');
  bad2.closeAll();
}
{
  const root = tmp(); const s = createStore({ root }); const l = (await s.save('Main', ledger(1)), await s.load('Main'));
  ok('a current database opens without an upgrade', l.ok && l.upgradedFrom === null && l.formatVersion === CURRENT_FORMAT); s.closeAll();
}

/* ---- a damaged file is set aside, never overwritten ---- */
{
  const root = tmp(); const s = createStore({ root }); await s.save('Main', ledger(2)); s.closeAll();
  fs.writeFileSync(dbFile(root, 'Main'), 'this is not a database at all, just text that replaced it');
  const s2 = createStore({ root }); const l = await s2.load('Main');
  ok('a file that cannot be read is reported as damaged', !l.ok && l.reason === 'damaged');
  ok('it is moved to the damaged folder, so nothing can overwrite it', l.setAside && fs.existsSync(l.setAside) && !fs.existsSync(dbFile(root, 'Main')));
  s2.closeAll();
}

/* ---- one safety copy per month ---- */
{
  const root = tmp(); let clock = new Date('2026-10-05T09:00:00'); const s = createStore({ root, now: () => clock });
  const first = await s.save('Main', ledger(1));
  ok('a brand new database gets this month\'s copy right away', first.monthlyCopy === 'Main - monthly 2026-10.db');
  clock = new Date('2026-10-20T09:00:00'); const again = await s.save('Main', ledger(2));
  ok('later saves in the same month make no new copy', again.monthlyCopy === '' && s.copies().length === 1);
  clock = new Date('2026-11-01T08:30:00'); const nov = await s.save('Main', ledger(3));
  ok('the first save of a new month makes the copy', nov.monthlyCopy === 'Main - monthly 2026-11.db');
  const rc = s.readCopy('Main - monthly 2026-11.db');
  ok('the copy holds the database as it stood before that save (2 cars, not 3)', rc.ok && rc.data.vehicles.length === 2);
  clock = new Date('2026-11-02T08:30:00'); await s.save('Main', ledger(4));
  ok('exactly one copy per month: two months, two copies', s.copies().filter(c => c.kind === 'monthly').length === 2);
  ok('the copy list shows records and the date of the data', s.copies().find(c => c.tag === '2026-11').records === 2);
  ok('a copy name that points outside the folder is refused', !s.readCopy('..\\..\\settings.json').ok && !s.readCopy('../x.db').ok);
  fs.writeFileSync(path.join(root, 'copies', 'Main - monthly 2026-09.fpdb.json'), JSON.stringify({ format: 'fleetpilot-database', formatVersion: 1, savedAt: '2026-09-30T10:00:00Z', data: ledger(6) }));
  ok('an old JSON monthly copy (v21) can still be read', s.readCopy('Main - monthly 2026-09.fpdb.json').data.vehicles.length === 6 && s.copies().some(c => c.tag === '2026-09' && c.records === 6));
  const liveDb = dbFile(root, 'Main'), liveBeforeDelete = fs.readFileSync(liveDb);
  ok('delete removes only the selected safety copy', s.deleteCopy('Main - monthly 2026-09.fpdb.json').ok && !fs.existsSync(path.join(root, 'copies', 'Main - monthly 2026-09.fpdb.json')) && fs.existsSync(liveDb));
  ok('delete rejects a path outside the copies folder', !s.deleteCopy('../Main.db').ok && fs.existsSync(liveDb));
  ok('delete leaves the active database unchanged', fs.readFileSync(liveDb).equals(liveBeforeDelete));
  s.closeAll();
}

/* ---- a database held by another program ---- */
{
  const root = tmp(); const s = createStore({ root, busyTimeout: 50 }); await s.save('Main', ledger(2));
  const other = new DatabaseSync(dbFile(root, 'Main')); other.exec('PRAGMA busy_timeout = 50; BEGIN EXCLUSIVE');
  const r = await s.save('Main', ledger(7));
  ok('a lock that stays: a plain message', !r.ok && /not letting FleetPilot write/.test(r.error));
  other.exec('ROLLBACK'); other.close();
  ok('the old data is untouched', (await s.load('Main')).data.vehicles.length === 2);
  ok('when the lock goes the next save works', (await s.save('Main', ledger(7))).ok && (await s.load('Main')).data.vehicles.length === 7);
  s.closeAll();
}

/* ---- several databases ---- */
{
  const root = tmp(); const s = createStore({ root });
  await s.save('Main', ledger(2)); const c = await s.create('Test books', ledger(1));
  ok('a second database can be created', c.ok && s.list().map(x => x.name).join() === 'Main,Test books');
  ok('creating one with a used name (any letter case) is refused and changes nothing', !(await s.create('main', ledger(9))).ok && (await s.load('Main')).data.vehicles.length === 2);
  ok('a name with forbidden characters is cleaned', s.cleanName('a/b:c*?') === 'a b c');
  s.closeAll();
}
const free = createStore({ root: tmp() }).diskFree(); ok('free disk space can be read (or is null on an old Electron)', free === null || free > 0);
console.log(fails ? fails + ' FAILED' : 'dbstore tests passed'); process.exit(fails ? 1 : 0);
