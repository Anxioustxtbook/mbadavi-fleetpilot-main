/* FleetPilot desktop side of the database. Runs in the Electron MAIN process.

   The data is kept in SQLite (Node's built-in node:sqlite, so nothing to install or compile).

   WHERE THE DATA LIVES (per user, never inside the program folder, so an update never touches it):
     %APPDATA%\FleetPilot\databases\<name>.db       the database(s), one SQLite file each; one is shown at start
     %APPDATA%\FleetPilot\copies\                   one safety copy per month, and one copy before an upgrade of the data layout
     %APPDATA%\FleetPilot\damaged\                  a file that could not be read is set aside here, never overwritten
     %APPDATA%\FleetPilot\old-files\                the .fpdb.json files of v21 and earlier, after their data was moved into SQLite
     %APPDATA%\FleetPilot\settings.json             which database opens at start, which was used last
   The folder is fixed ("FleetPilot" under the user's AppData), so it does not depend on the app name or ID in the build settings.

   INSIDE A DATABASE
     meta(key, value)                       format name, format version, program version, name, saved at, record count
     fields(key, pos, kind, value)          every top-level key of the ledger, in order: kind 'list' (rows in records) or 'value' (JSON)
     records(list, pos, id, data)           one row per record of every list (vehicles, rentals, payments, ...), data is the record as JSON

   THE FORMAT VERSION describes the data layout. A newer program opens an older database and upgrades it step by step (a copy of the
   old one is kept once). An older program refuses a newer database with a plain message and never writes to it.
   Every save is one transaction: it is either fully written or not at all.
   The testable part (createStore) does not need Electron; registerLedgerFile() wires it to the window. */
'use strict';
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const syncDb = require('./phone-sync/syncDb.cjs');
const crypto = require('crypto');

const FORMAT_NAME = 'fleetpilot-database';
const CURRENT_FORMAT = 1;
const APP_VERSION = 'v23';
const EXT = '.db';
const OLD_EXT = '.fpdb.json';
const LIST_KEYS = ['vehicles', 'drivers', 'clients', 'bookings', 'rentals', 'expenses', 'payments', 'invoices', 'driverAllowances', 'accounts', 'loans', 'insurance', 'chama', 'fuelAccount', 'coops', 'individuals'];

/* UPGRADES[n] turns format n into format n + 1 (the ledger object in, the ledger object out). To change the data layout one day:
   raise CURRENT_FORMAT by one and add UPGRADES[<old number>] here. Nothing else has to change.
   Format 0 is a bare ledger with no wrapper (the oldest .fpdb.json files). */
const UPGRADES = { 0: data => data };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS fields (key TEXT PRIMARY KEY, pos INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT);
  CREATE TABLE IF NOT EXISTS records (list TEXT NOT NULL, pos INTEGER NOT NULL, id TEXT, data TEXT NOT NULL, PRIMARY KEY (list, pos));
  CREATE INDEX IF NOT EXISTS records_by_id ON records (list, id);
  CREATE INDEX IF NOT EXISTS rentals_by_pickup ON records (json_extract(data, '$.pickup')) WHERE list = 'rentals';
  CREATE INDEX IF NOT EXISTS rentals_by_return ON records (json_extract(data, '$.return')) WHERE list = 'rentals';
  CREATE INDEX IF NOT EXISTS expenses_by_date ON records (json_extract(data, '$.date')) WHERE list = 'expenses';
  CREATE INDEX IF NOT EXISTS payments_by_date ON records (json_extract(data, '$.date')) WHERE list = 'payments';
  CREATE INDEX IF NOT EXISTS bookings_by_booked_on ON records (json_extract(data, '$.bookedOn')) WHERE list = 'bookings';`;

const countRecords = d => { let n = 0; if(d && typeof d === 'object') LIST_KEYS.forEach(k => { if(Array.isArray(d[k])) n += d[k].length; }); return n; };
const cleanName = n => String(n == null ? '' : n).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60);
const two = n => String(n).padStart(2, '0');
const sqlText = s => "'" + String(s).replace(/'/g, "''") + "'";

function plainError(e){
  const c = e && e.code, sc = e && e.errcode != null ? (e.errcode & 0xff) : -1;
  if(c === 'ENOSPC' || sc === 13) return 'the disk is full';
  if(sc === 5 || sc === 6 || c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' || sc === 8) return 'Windows is not letting FleetPilot write the database file (another program may be holding it, or the folder is protected)';
  if(c === 'ENOENT' || sc === 14) return 'the FleetPilot data folder is missing';
  return String(e && e.message || e);
}
const isDamage = e => { const sc = e && e.errcode != null ? (e.errcode & 0xff) : -1; return sc === 11 || sc === 26 || !!(e && e.damaged); };   // SQLITE_CORRUPT, SQLITE_NOTADB

/* ---------- the old JSON files (read only: moving them into SQLite, and old monthly copies) ---------- */
function parseText(text){
  let o; try{ o = JSON.parse(text); }catch(e){ const x = new Error('the file is not readable (' + e.message + ')'); x.damaged = true; throw x; }
  if(o && o.format === FORMAT_NAME && Number.isInteger(o.formatVersion) && o.data && typeof o.data === 'object') return { version: o.formatVersion, data: o.data, header: o };
  if(o && Array.isArray(o.vehicles)) return { version: 0, data: o, header: {} };   // a bare ledger: format 0
  const x = new Error('the file does not hold a FleetPilot database'); x.damaged = true; throw x;
}

/* ---------- one SQLite file ---------- */
function openDb(file, opts){
  const db = new DatabaseSync(file, opts && opts.readOnly ? { readOnly: true } : {});
  try{
    db.exec('PRAGMA busy_timeout = ' + ((opts && opts.busyTimeout) || 3000));
    if(!(opts && opts.readOnly)){ db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;'); db.exec(SCHEMA); db.exec(syncDb.SYNC_SCHEMA); }
  }catch(e){ try{ db.close(); }catch(e2){} throw e; }
  return db;
}
function readMeta(db){
  const m = {}; db.prepare('SELECT key, value FROM meta').all().forEach(r => { m[r.key] = r.value; });
  if(m.format !== FORMAT_NAME){ const x = new Error('the file does not hold a FleetPilot database'); x.damaged = true; throw x; }
  return { format: m.format, formatVersion: Number(m.formatVersion) || 0, appVersion: m.appVersion || '', name: m.name || '', savedAt: m.savedAt || '', records: Number(m.records) || 0 };
}
function readLedger(db){
  const out = {}, lists = {};
  db.prepare('SELECT key, kind, value FROM fields ORDER BY pos').all().forEach(f => {
    if(f.kind === 'list'){ out[f.key] = []; lists[f.key] = out[f.key]; }
    else out[f.key] = f.value == null ? null : JSON.parse(f.value);
  });
  db.prepare('SELECT list, data FROM records ORDER BY list, pos').all().forEach(r => { if(lists[r.list]) lists[r.list].push(JSON.parse(r.data)); });
  return out;
}
function writeLedger(db, name, data, appVersion, format, savedAt, track){
  db.exec('BEGIN IMMEDIATE');
  try{
    const tracked = track ? syncDb.trackSave(db, data, track) : null;        // compares with what is stored, BEFORE it is replaced
    db.exec('DELETE FROM records; DELETE FROM fields; DELETE FROM meta;');
    const field = db.prepare('INSERT INTO fields (key, pos, kind, value) VALUES (?, ?, ?, ?)');
    const rec = db.prepare('INSERT INTO records (list, pos, id, data) VALUES (?, ?, ?, ?)');
    let pos = 0;
    Object.keys(data).forEach(k => {
      const v = data[k];
      if(v === undefined || typeof v === 'function') return;
      if(Array.isArray(v)){
        field.run(k, pos++, 'list', null);
        v.forEach((r, i) => { const id = r && typeof r === 'object' && r.id != null ? String(r.id) : null; rec.run(k, i, id, r === undefined ? 'null' : JSON.stringify(r)); });
      }else field.run(k, pos++, 'value', JSON.stringify(v));
    });
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    [['format', FORMAT_NAME], ['formatVersion', String(format)], ['appVersion', appVersion], ['name', name], ['savedAt', savedAt], ['records', String(countRecords(data))]].forEach(p => meta.run(p[0], p[1]));
    if(track && track.after) track.after(db, tracked);                        // sync: review rows, device rows and the revision go in the SAME transaction
    db.exec('COMMIT');
  }catch(e){ try{ db.exec('ROLLBACK'); }catch(e2){} throw e; }
}
/* the whole check of a file opened for reading: it is SQLite, it is not damaged, it holds a FleetPilot database */
function readFile(file, busyTimeout){
  const db = openDb(file, { readOnly: true, busyTimeout });
  try{
    const ok = db.prepare('PRAGMA quick_check').get();
    if(!ok || Object.values(ok)[0] !== 'ok'){ const x = new Error('the database file is damaged'); x.damaged = true; throw x; }
    return { header: readMeta(db), data: readLedger(db) };
  }finally{ db.close(); }
}

function createStore(opts){
  const root = opts.root, now = opts.now || (() => new Date());
  const appVersion = opts.appVersion || APP_VERSION, current = opts.current || CURRENT_FORMAT, steps = opts.upgrades || UPGRADES;
  const busyTimeout = opts.busyTimeout || 3000;
  const dirs = { db: path.join(root, 'databases'), copies: path.join(root, 'copies'), damaged: path.join(root, 'damaged'), old: path.join(root, 'old-files') };
  const settingsFile = path.join(root, 'settings.json');
  const locked = new Map();                       // database name (lower case) -> the plain message: a newer database, never written to
  const moved = new Map();                        // database name (lower case) -> the old .fpdb.json file its data came from (this start only)
  let chain = Promise.resolve();
  const queue = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const mk = d => fs.mkdirSync(d, { recursive: true });
  const exists = f => { try{ fs.statSync(f); return true; }catch(e){ return false; } };
  const fileFor = name => path.join(dirs.db, name + EXT);
  const monthKey = () => { const d = now(); return d.getFullYear() + '-' + two(d.getMonth() + 1); };
  const monthlyPath = (name, month) => path.join(dirs.copies, name + ' - monthly ' + month + EXT);
  const oldFormatPath = (name, v) => path.join(dirs.copies, name + ' - old format v' + v + EXT);
  const stamp = () => now().toISOString().replace(/[:.]/g, '-');

  /* this computer's permanent device id (one for the whole program, kept beside settings.json) */
  function loadDeviceId(){
    if(opts.deviceId) return opts.deviceId;
    const f = path.join(root, 'device.json');
    try{ const j = JSON.parse(fs.readFileSync(f, 'utf8')); if(j && typeof j.deviceId === 'string' && j.deviceId) return j.deviceId; }catch(e){}
    const id = 'D-' + crypto.randomBytes(8).toString('hex');
    try{ mk(root); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ deviceId: id })); fs.renameSync(tmp, f); }catch(e){}
    return id;
  }
  const deviceId = loadDeviceId();
  const trackCtx = extras => Object.assign({ deviceId, now: () => now().toISOString() }, extras || {});

  /* one open connection per database while the program runs */
  const conns = new Map();
  function conn(name){
    const key = name.toLowerCase(); let c = conns.get(key);
    if(!c){ mk(dirs.db); c = openDb(fileFor(name), { busyTimeout }); try{ syncDb.ensureTracking(c, deviceId, now().toISOString()); }catch(e){ try{ c.close(); }catch(e2){} throw e; } conns.set(key, c); }
    return c;
  }
  function release(name){ const key = String(name).toLowerCase(), c = conns.get(key); if(c){ try{ c.close(); }catch(e){} conns.delete(key); } }
  function closeAll(){ Array.from(conns.keys()).forEach(release); }
  function copyDb(name, target){ mk(path.dirname(target)); conn(name).exec('VACUUM INTO ' + sqlText(target)); }
  const validFile = f => { try{ readFile(f, busyTimeout); return true; }catch(e){ return false; } };

  /* ---------- settings (which database opens at start) ---------- */
  function getSettings(){
    let s = {}; try{ s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; }catch(e){}
    return { startWith: typeof s.startWith === 'string' && s.startWith ? s.startWith : 'last', lastUsed: typeof s.lastUsed === 'string' ? s.lastUsed : '', migrated: s.migrated === true };
  }
  function setSettings(patch){
    const s = Object.assign(getSettings(), patch || {});
    if(typeof s.startWith !== 'string' || !s.startWith) s.startWith = 'last';
    mk(root); const tmp = settingsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, settingsFile); return s;
  }

  function runSteps(data, from){
    let v = from, d = data;
    while(v < current){ const step = steps[v]; if(typeof step !== 'function') throw new Error('no upgrade step from format ' + v); d = step(d) || d; v++; }
    return d;
  }
  function newerMessage(v){ return 'This database was saved by a newer version of FleetPilot (its format is ' + v + ', this program understands up to ' + current + '). Install the newest FleetPilot to open it. Nothing was changed and nothing will be written to it.'; }

  /* ---------- once: the .fpdb.json files of v21 and earlier are moved into SQLite ---------- */
  function moveOldFiles(){
    let names = []; try{ names = fs.readdirSync(dirs.db); }catch(e){ return; }
    names.filter(n => n.endsWith(OLD_EXT)).forEach(n => {
      const name = n.slice(0, -OLD_EXT.length), src = path.join(dirs.db, n);
      if(exists(fileFor(name))) return;                       // already moved (SQLite wins); the old file stays where it is
      let parsed;
      try{ parsed = parseText(fs.readFileSync(src, 'utf8')); }
      catch(e){ if(e.damaged){ try{ mk(dirs.damaged); fs.renameSync(src, path.join(dirs.damaged, name + ' - ' + stamp() + OLD_EXT)); }catch(e2){} } return; }
      if(parsed.version > current) return;                    // a newer program's file: leave it alone
      const dbFile = fileFor(name);
      try{
        const data = runSteps(JSON.parse(JSON.stringify(parsed.data)), parsed.version);
        const c = openDb(dbFile, { busyTimeout });
        try{ writeLedger(c, name, data, appVersion, current, parsed.header.savedAt || now().toISOString()); }finally{ c.close(); }
        mk(dirs.old); fs.renameSync(src, path.join(dirs.old, n));
        moved.set(name.toLowerCase(), path.join(dirs.old, n));
      }catch(e){ try{ fs.rmSync(dbFile, { force: true }); }catch(e2){} }   // try again next start; the JSON file was not touched
    });
  }
  moveOldFiles();

  /* ---------- the databases ---------- */
  function list(){
    let names = []; try{ names = fs.readdirSync(dirs.db); }catch(e){}
    return names.filter(n => n.endsWith(EXT)).map(n => {
      const f = path.join(dirs.db, n), st = fs.statSync(f); let h = {};
      try{ const c = openDb(f, { readOnly: true, busyTimeout }); try{ h = readMeta(c); }finally{ c.close(); } }catch(e){}
      return { name: n.slice(0, -EXT.length), modified: st.mtimeMs, size: st.size, savedAt: h.savedAt || '', records: h.records || 0, formatVersion: h.formatVersion || 0 };
    }).sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  }
  function resolveName(name){          // the exact existing name for a name typed in any letter case
    const n = cleanName(name); if(!n) return '';
    const hit = list().find(x => x.name.toLowerCase() === n.toLowerCase()); return hit ? hit.name : n;
  }
  function daily(name, date){
    name = resolveName(name);
    if(!name || !exists(fileFor(name))) return { ok: false, error: 'The selected SQLite database could not be found.' };
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: 'Choose a valid calendar date.' };
    const parsedDate = new Date(date + 'T00:00:00.000Z');
    if(Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) return { ok: false, error: 'Choose a valid calendar date.' };
    const c = conn(name);
    const rows = (listName, where, ...params) => {
      if(!['rentals', 'payments', 'expenses'].includes(listName)) throw new Error('Unsupported daily record list.');
      return c.prepare("SELECT data FROM records WHERE list = '" + listName + "' AND " + where + ' ORDER BY pos').all(...params).map(r => JSON.parse(r.data));
    };
    const bookings = c.prepare("SELECT COUNT(*) n FROM records WHERE list = 'bookings' AND json_extract(data, '$.bookedOn') = ?").get(date).n;
    return {
      ok: true, date,
      rentals: rows('rentals', "json_extract(data, '$.pickup') = ? AND COALESCE(json_extract(data, '$.status'), '') <> 'Cancelled'", date),
      activeOnDate: rows('rentals', "json_extract(data, '$.pickup') <= ? AND json_extract(data, '$.return') >= ? AND COALESCE(json_extract(data, '$.status'), '') <> 'Cancelled'", date, date),
      dueBack: rows('rentals', "json_extract(data, '$.return') = ? AND json_extract(data, '$.status') = 'Active'", date),
      overdue: rows('rentals', "json_extract(data, '$.return') < ? AND json_extract(data, '$.status') = 'Active'", date),
      payments: rows('payments', "json_extract(data, '$.date') = ?", date),
      expenses: rows('expenses', "json_extract(data, '$.date') = ?", date),
      bookings
    };
  }

  async function load(name){
    name = resolveName(name); if(!name) return { ok: false, reason: 'missing', error: 'no database name' };
    const file = fileFor(name); if(!exists(file)) return { ok: false, reason: 'missing', name };
    release(name);
    let parsed;
    try{ parsed = readFile(file, busyTimeout); }
    catch(e){
      if(!isDamage(e)) return { ok: false, reason: 'unreadable', name, error: plainError(e) };
      let setAside = '';          // the damaged file is moved away so that the next save can never overwrite it
      try{ mk(dirs.damaged); setAside = path.join(dirs.damaged, name + ' - ' + stamp() + EXT); fs.renameSync(file, setAside); }catch(e2){ setAside = ''; }
      return { ok: false, reason: 'damaged', name, error: e.message, setAside };
    }
    const v = parsed.header.formatVersion;
    if(v > current){ locked.set(name.toLowerCase(), newerMessage(v)); return { ok: false, reason: 'newer', name, fileVersion: v, message: newerMessage(v) }; }
    let data = parsed.data, upgradedFrom = null, keptCopy = '';
    if(v < current){
      try{
        const stepped = runSteps(JSON.parse(JSON.stringify(data)), v);
        const keep = oldFormatPath(name, v);                  // one copy of the old database, only now, named with its version
        if(!exists(keep)){ copyDb(name, keep); keptCopy = keep; }
        data = stepped; upgradedFrom = v;
        await queue(() => writeLedger(conn(name), name, data, appVersion, current, now().toISOString(), trackCtx()));
      }catch(e){ return { ok: false, reason: 'upgrade-failed', name, error: plainError(e) }; }
    }
    const movedFrom = moved.get(name.toLowerCase()) || '';
    let syncRev = 0; try{ syncRev = syncDb.getRev(conn(name)); }catch(e){}
    return { ok: true, name, data, savedAt: parsed.header.savedAt || '', formatVersion: current, upgradedFrom, keptCopy, movedFrom, syncRev };
  }

  function prepareSave(name, data){
    name = cleanName(name);
    if(!name) return { fail: { ok: false, error: 'the database has no name' } };
    if(!data || typeof data !== 'object' || !Array.isArray(data.vehicles)) return { fail: { ok: false, error: 'nothing to save' } };
    const msg = locked.get(name.toLowerCase()); if(msg) return { fail: { ok: false, locked: true, error: msg } };
    return { name };
  }
  /* monthly copy: the first save of a new month keeps the database as it stood before that save (or, for a brand new one, as just written) */
  function monthlyBefore(name){
    const month = monthKey(), copy = monthlyPath(name, month), file = fileFor(name);
    if(exists(copy)) return { done: true };
    if(!exists(file)) return { after: true, copy, month };
    if(!validFile(file)) return { done: false };           // never keep a damaged database as the monthly copy
    try{ copyDb(name, copy); return { done: true, made: copy, month }; }catch(e){ return { done: false, error: plainError(e) }; }
  }
  function afterWrite(name, pre){
    let made = pre.made || '', copyError = pre.error || '';
    if(pre.after){ try{ copyDb(name, pre.copy); made = pre.copy; }catch(e){ copyError = plainError(e); } }
    return { monthlyCopy: made ? path.basename(made) : '', copyError };
  }
  function diskFree(){ try{ if(typeof fs.statfsSync === 'function'){ const s = fs.statfsSync(root); return Number(s.bavail) * Number(s.bsize); } }catch(e){} return null; }

  /* After every write the file is opened again and read back; what comes back must equal what was written.
     A mismatch is reported as a failed save, so the screen never says "saved" for data that is not there. */
  function readBackMismatch(name, data){
    const c = openDb(fileFor(name), { readOnly: true, busyTimeout });
    try{
      const got = readLedger(c), want = JSON.parse(JSON.stringify(data));
      const wantKeys = Object.keys(want);
      if(Object.keys(got).length !== wantKeys.length) return 'the list of fields differs';
      for(const k of wantKeys){ if(syncDb.canon(got[k]) !== syncDb.canon(want[k])) return k; }
      return '';
    }finally{ try{ c.close(); }catch(e){} }
  }
  /* node:sqlite is synchronous, so the normal save and the "window is closing" save are the same work; the normal one waits its turn.
     extras (used by sync only): stamps, extraTombs, after(db) -- see syncDb.trackSave */
  function writeNow(name, data, extras){
    try{
      const pre = monthlyBefore(name), savedAt = now().toISOString();
      writeLedger(conn(name), name, data, appVersion, current, savedAt, trackCtx(extras));
      const bad = readBackMismatch(name, data);
      if(bad) return { ok: false, readback: true, error: 'the data read back from the file did not match what was written (' + bad + ')' };
      let bytes = 0; try{ bytes = fs.statSync(fileFor(name)).size; }catch(e){}
      return Object.assign({ ok: true, name, savedAt, bytes, free: diskFree(), rev: syncDb.getRev(conn(name)) }, afterWrite(name, pre));
    }catch(e){ return { ok: false, error: plainError(e), code: e && (e.code || e.errcode) || '' }; }
  }
  /* a page that was loaded before a sync wrote underneath it must not save over the sync: it is told to reload first */
  function staleCheck(name, rev){
    if(rev == null) return null;
    let cur = 0; try{ cur = syncDb.getRev(conn(name)); }catch(e){ return null; }
    return Number(rev) === cur ? null : { ok: false, stale: true, error: 'the data changed underneath the screen (a phone sync); the screen must reload before it saves' };
  }
  function save(name, data, rev){
    const p = prepareSave(name, data); if(p.fail) return Promise.resolve(p.fail);
    return queue(() => staleCheck(p.name, rev) || writeNow(p.name, data));
  }
  function saveSync(name, data, rev){
    const p = prepareSave(name, data); if(p.fail) return p.fail;
    return staleCheck(p.name, rev) || writeNow(p.name, data);
  }
  /* a new database: refuses a name that is already used (any letter case), never overwrites */
  async function create(name, data){
    const n = cleanName(name); if(!n) return { ok: false, error: 'Type a name for the new database.' };
    if(list().some(x => x.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'A database called "' + n + '" already exists.' };
    return save(n, data);
  }
  function deleteDatabase(name, activeName){
    name = resolveName(name);
    if(!name || !exists(fileFor(name))) return { ok: false, error: 'The selected database could not be found.' };
    const settings = getSettings(), key = name.toLowerCase();
    if(key === String(activeName || '').toLowerCase() || key === String(settings.lastUsed || '').toLowerCase())
      return { ok: false, error: 'The database currently in use cannot be deleted. Open another database first.' };
    const previousStart = settings.startWith, previousLast = settings.lastUsed;
    const patch = {};
    if(String(settings.startWith).toLowerCase() === key) patch.startWith = 'last';
    if(String(settings.lastUsed).toLowerCase() === key) patch.lastUsed = activeName || '';
    if(Object.keys(patch).length) setSettings(patch);
    release(name);
    try{
      fs.unlinkSync(fileFor(name));
    }catch(e){
      if(Object.keys(patch).length) setSettings({ startWith: previousStart, lastUsed: previousLast });
      return { ok: false, error: plainError(e) };
    }
    return { ok: true, name };
  }

  /* ---------- safety copies (SQLite; monthly copies from v21 and earlier are .fpdb.json and can still be read) ---------- */
  const RE_MONTH = /^(.*) - monthly (\d{4}-\d{2})(\.db|\.fpdb\.json)$/, RE_OLD = /^(.*) - old format v(\d+)(\.db|\.fpdb\.json)$/;
  function readAnyCopy(file){
    if(file.endsWith(OLD_EXT)){ const p = parseText(fs.readFileSync(file, 'utf8')); return { version: p.version, data: p.data, savedAt: p.header.savedAt || '', records: countRecords(p.data) }; }
    const r = readFile(file, busyTimeout); return { version: r.header.formatVersion, data: r.data, savedAt: r.header.savedAt, records: r.header.records };
  }
  function copies(){
    let names = []; try{ names = fs.readdirSync(dirs.copies); }catch(e){}
    const out = [];
    names.forEach(n => {
      let m = RE_MONTH.exec(n), kind = 'monthly', tag = '';
      if(m) tag = m[2]; else { m = RE_OLD.exec(n); kind = 'format'; if(m) tag = 'v' + m[2]; }
      if(!m) return;
      const f = path.join(dirs.copies, n), st = fs.statSync(f); let h = {};
      try{ if(n.endsWith(EXT)){ const c = openDb(f, { readOnly: true, busyTimeout }); try{ h = readMeta(c); }finally{ c.close(); } } else h = readAnyCopy(f); }catch(e){}
      out.push({ id: n, db: m[1], kind, tag, madeAt: st.mtimeMs, savedAt: h.savedAt || '', records: h.records || 0, size: st.size });
    });
    return out.sort((a, b) => b.madeAt - a.madeAt);
  }
  function readCopy(id){
    const base = path.basename(String(id || ''));
    if(base !== String(id) || !(RE_MONTH.test(base) || RE_OLD.test(base))) return { ok: false, error: 'not a copy of this program' };
    try{
      const c = readAnyCopy(path.join(dirs.copies, base));
      if(c.version > current) return { ok: false, error: newerMessage(c.version) };
      return { ok: true, id: base, data: runSteps(JSON.parse(JSON.stringify(c.data)), c.version), savedAt: c.savedAt };
    }catch(e){ return { ok: false, error: plainError(e) }; }
  }
  function deleteCopy(id){
    const base = path.basename(String(id || ''));
    if(base !== String(id) || !(RE_MONTH.test(base) || RE_OLD.test(base))) return { ok: false, error: 'not a copy of this program' };
    const file = path.join(dirs.copies, base);
    try{
      const stat = fs.lstatSync(file);
      if(!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: 'the selected copy is not a regular file' };
      fs.unlinkSync(file);
      return { ok: true, id: base };
    }catch(e){ return { ok: false, error: plainError(e) }; }
  }
  return { deviceId, root, dirs, getSettings, setSettings, list, load, save, saveSync, create, deleteDatabase, daily, copies, readCopy, deleteCopy, diskFree, cleanName, monthKey, closeAll, isLocked: n => locked.has(String(n).toLowerCase()),
    /* the doors the sync engine uses; everything it writes goes through the SAME queue as the screens (one writer only) */
    sync: { queue, conn, fileFor, copyDb, writeNow, readBackMismatch, readLedger, resolveName, stamp, now, mk, exists, validFile, trackCtx, plainError, appVersion } };
}

/* ---------- Electron wiring (needs Electron; not loaded by the tests) ---------- */
function registerLedgerFile(){
  const { app, ipcMain, shell, BrowserWindow } = require('electron');
  const root = path.join(app.getPath('appData'), 'FleetPilot');
  const store = createStore({ root });
  const safe = fn => async (...a) => { try{ return await fn(...a); }catch(e){ return { ok: false, error: plainError(e) }; } };
  let openOnce = '';

  /* two copies of the program writing one database would overwrite each other: a second start just brings the first to the front */
  if(!app.requestSingleInstanceLock()){ app.quit(); return store; }
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if(w){ if(w.isMinimized()) w.restore(); w.focus(); } });
  app.on('will-quit', () => store.closeAll());

  ipcMain.handle('db:settings', safe(() => ({ ok: true, settings: store.getSettings(), databases: store.list(), folder: root })));
  ipcMain.handle('db:setSettings', safe((ev, patch) => ({ ok: true, settings: store.setSettings(patch) })));
  ipcMain.handle('db:setOpenOnce', safe((ev, name) => {
    openOnce = store.cleanName(name);
    return openOnce ? { ok: true } : { ok: false, error: 'The database name is invalid.' };
  }));
  ipcMain.handle('db:takeOpenOnce', safe(() => {
    const name = openOnce;
    openOnce = '';
    return { ok: true, name };
  }));
  ipcMain.handle('db:load', safe((ev, name) => store.load(name)));
  ipcMain.handle('db:save', safe((ev, name, data, rev) => store.save(name, data, rev)));
  ipcMain.handle('db:create', safe((ev, name, data) => store.create(name, data)));
  ipcMain.handle('db:delete', safe((ev, name, activeName) => store.deleteDatabase(name, activeName)));
  ipcMain.handle('db:daily', safe((ev, name, date) => store.daily(name, date)));
  ipcMain.handle('db:copies', safe(() => ({ ok: true, copies: store.copies() })));
  ipcMain.handle('db:readCopy', safe((ev, id) => store.readCopy(id)));
  ipcMain.handle('db:deleteCopy', safe((ev, id) => store.deleteCopy(id)));
  ipcMain.handle('db:showFolder', safe(() => { fs.mkdirSync(root, { recursive: true }); shell.openPath(root); return { ok: true }; }));
  ipcMain.on('db:saveSync', (ev, name, data, rev) => { try{ ev.returnValue = store.saveSync(name, data, rev); }catch(e){ ev.returnValue = { ok: false, error: plainError(e) }; } });

  /* closing a window: ask the page to write what is pending first (it also writes synchronously as it unloads), then close for real */
  app.on('browser-window-created', (e, w) => {
    let closing = false;
    w.on('close', ev => {
      if(closing) return;
      ev.preventDefault(); closing = true;
      const done = () => { try{ if(!w.isDestroyed()) w.close(); }catch(err){} };
      const timer = setTimeout(done, 6000);
      ipcMain.once('db:flushed', () => { clearTimeout(timer); done(); });
      try{ w.webContents.send('db:flush'); }catch(err){ clearTimeout(timer); done(); }
    });
  });
  return store;
}
module.exports = { createStore, registerLedgerFile, CURRENT_FORMAT, UPGRADES, FORMAT_NAME, APP_VERSION, countRecords, cleanName };
