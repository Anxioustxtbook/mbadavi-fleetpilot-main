/* FleetPilot phone sync: the hidden tables and the tracking done at every save.
   Runs in the Electron MAIN process (no Electron needed, so the tests load it directly).

   WHAT LIVES HERE (inside each database file, never read by screens, records or Excel):
     sync_info(key, value)       rev (goes up at every sync write), seq (change counter), trackInit
     sync_track(list, id, ...)   one row per record: change number (seq), change time, which device, deleted marker, where it arrived from
     sync_deleted(list, id, ...) the last version of every deleted record, so a delete can be undone
     sync_devices(...)           the register of paired phones
     sync_review(...)            held, conflicting, overlapping and duplicate records waiting for the owner
     sync_inbox(...)             batches received from a phone, kept until the whole sync is applied

   HOW TRACKING WORKS: every save (writeLedger) compares the new data with what is stored and stamps the records that changed or
   disappeared. ledger.js has hundreds of places that change data; none of them is touched. */
'use strict';

const LIST_KEYS = ['vehicles', 'drivers', 'clients', 'bookings', 'rentals', 'expenses', 'payments', 'invoices', 'driverAllowances', 'accounts', 'loans', 'insurance', 'chama', 'fuelAccount', 'coops', 'individuals'];
const EPOCH = '1970-01-01T00:00:00.000Z';
const SEP = '\u0001';
const key = (list, id) => list + SEP + String(id);

const SYNC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_info (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sync_track (list TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, changed_at TEXT NOT NULL, device TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, arrived_from TEXT, arrived_at TEXT, restore INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (list, id));
  CREATE INDEX IF NOT EXISTS sync_track_seq ON sync_track (seq);
  CREATE TABLE IF NOT EXISTS sync_deleted (list TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted_at TEXT, device TEXT, PRIMARY KEY (list, id));
  CREATE TABLE IF NOT EXISTS sync_devices (device_id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, status TEXT, range_index INTEGER, range_start INTEGER, range_end INTEGER,
    paired_at TEXT, last_sync_at TEXT, last_ack INTEGER NOT NULL DEFAULT 0, offset_ms INTEGER NOT NULL DEFAULT 0, reference TEXT NOT NULL DEFAULT 'none',
    instance TEXT, app_version TEXT, last_phone_seq INTEGER NOT NULL DEFAULT 0, last_totals TEXT);
  CREATE TABLE IF NOT EXISTS sync_review (id INTEGER PRIMARY KEY AUTOINCREMENT, rkey TEXT, kind TEXT NOT NULL, list TEXT, rec_id TEXT, device TEXT,
    created_at TEXT, status TEXT NOT NULL DEFAULT 'open', title TEXT, payload TEXT);
  CREATE INDEX IF NOT EXISTS sync_review_rkey ON sync_review (rkey, status);
  CREATE TABLE IF NOT EXISTS sync_inbox (device TEXT NOT NULL, session TEXT NOT NULL, batch INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (device, session, batch));`;

/* the same record always gives the same text, whatever order its fields were written in */
function canon(v){
  if(Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if(v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && typeof v[k] !== 'function').map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function infoGet(db, k, dflt){ const r = db.prepare('SELECT value FROM sync_info WHERE key = ?').get(k); return r ? r.value : dflt; }
function infoSet(db, k, v){ db.prepare('INSERT INTO sync_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)); }

/* Records that were in the database before sync existed get an OLD timestamp, so they never override a newer phone edit.
   Runs once per database; the ledger data itself is not touched. */
function ensureTracking(db, deviceId, nowIso){
  if(infoGet(db, 'trackInit', '')) return false;
  db.exec('BEGIN IMMEDIATE');
  try{
    const ins = db.prepare('INSERT OR IGNORE INTO sync_track (list, id, seq, changed_at, device, deleted) VALUES (?, ?, 0, ?, ?, 0)');
    db.prepare('SELECT list, id FROM records WHERE id IS NOT NULL').all().forEach(r => ins.run(r.list, r.id, EPOCH, deviceId));
    infoSet(db, 'trackInit', nowIso); if(infoGet(db, 'seq', '') === '') infoSet(db, 'seq', 0); if(infoGet(db, 'rev', '') === '') infoSet(db, 'rev', 0);
    db.exec('COMMIT'); return true;
  }catch(e){ try{ db.exec('ROLLBACK'); }catch(e2){} throw e; }
}

/* called inside the save transaction, BEFORE the old records are removed */
function trackSave(db, data, ctx){
  const now = ctx.now(), dev = ctx.deviceId, stamps = ctx.stamps || new Map();
  let seq = Number(infoGet(db, 'seq', 0)) || 0;
  const oldMap = new Map();
  db.prepare('SELECT list, id, data FROM records WHERE id IS NOT NULL').all().forEach(r => oldMap.set(key(r.list, r.id), r.data));
  const up = db.prepare('INSERT INTO sync_track (list, id, seq, changed_at, device, deleted, arrived_from, arrived_at, restore) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(list, id) DO UPDATE SET seq = excluded.seq, changed_at = excluded.changed_at, device = excluded.device, deleted = excluded.deleted, arrived_from = excluded.arrived_from, arrived_at = excluded.arrived_at, restore = excluded.restore');
  const unDelete = db.prepare('DELETE FROM sync_deleted WHERE list = ? AND id = ?');
  const putDeleted = db.prepare('INSERT INTO sync_deleted (list, id, data, deleted_at, device) VALUES (?, ?, ?, ?, ?) ON CONFLICT(list, id) DO UPDATE SET data = excluded.data, deleted_at = excluded.deleted_at, device = excluded.device');
  const stamp = (list, id, deleted) => {
    const s = stamps.get(key(list, id));
    up.run(list, String(id), ++seq, s ? s.at : now, s ? s.dev : dev, deleted ? 1 : 0, s && s.arrivedFrom ? s.arrivedFrom : null, s && s.arrivedFrom ? now : null, s && s.restore ? 1 : 0);
  };
  const seen = new Set();
  let changed = 0, removed = 0;
  LIST_KEYS.forEach(list => {
    (Array.isArray(data[list]) ? data[list] : []).forEach(r => {
      if(!r || typeof r !== 'object' || r.id == null) return;
      const k = key(list, r.id); seen.add(k);
      const old = oldMap.get(k);
      if(old === undefined || canon(JSON.parse(old)) !== canon(JSON.parse(JSON.stringify(r)))){ stamp(list, r.id, false); unDelete.run(list, String(r.id)); changed++; }
    });
  });
  oldMap.forEach((raw, k) => {
    if(seen.has(k)) return;
    const [list, id] = k.split(SEP);
    stamp(list, id, true); const s = stamps.get(k);
    putDeleted.run(list, id, raw, s ? s.at : now, s ? s.dev : dev); removed++;
  });
  /* deletes of records this database never had (a phone deleted something the desktop never saw): remember them so they cannot come back */
  (ctx.extraTombs || []).forEach(t => {
    const s = { at: t.at, dev: t.dev, arrivedFrom: t.arrivedFrom };
    stamps.set(key(t.list, t.id), s); stamp(t.list, t.id, true);
    putDeleted.run(t.list, String(t.id), t.data ? JSON.stringify(t.data) : null, t.at, t.dev);
  });
  infoSet(db, 'seq', seq);
  return { changed, removed, seq };
}

/* ---------- reading the tracking (used by the sync engine) ---------- */
function readTrack(db){
  const m = new Map();
  db.prepare('SELECT list, id, seq, changed_at, device, deleted, arrived_from, arrived_at, restore FROM sync_track').all().forEach(r => m.set(key(r.list, r.id), r));
  return m;
}
function readTombs(db){
  const m = new Map();
  db.prepare('SELECT list, id, data, deleted_at, device FROM sync_deleted').all().forEach(r => m.set(key(r.list, r.id), { data: r.data ? JSON.parse(r.data) : null, deleted_at: r.deleted_at, device: r.device }));
  return m;
}
const maxSeq = db => Number(infoGet(db, 'seq', 0)) || 0;
const getRev = db => Number(infoGet(db, 'rev', 0)) || 0;
const bumpRev = db => { const n = getRev(db) + 1; infoSet(db, 'rev', n); return n; };

/* ---------- the review list ---------- */
function reviewAdd(db, r, nowIso){
  if(r.rkey){ const ex = db.prepare("SELECT id FROM sync_review WHERE rkey = ? AND status = 'open'").get(r.rkey); if(ex){ db.prepare('UPDATE sync_review SET title = ?, payload = ? WHERE id = ?').run(r.title || '', JSON.stringify(r.payload || {}), ex.id); return ex.id; } }
  return Number(db.prepare('INSERT INTO sync_review (rkey, kind, list, rec_id, device, created_at, status, title, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.rkey || null, r.kind, r.list || null, r.rec_id == null ? null : String(r.rec_id), r.device || null, nowIso, 'open', r.title || '', JSON.stringify(r.payload || {})).lastInsertRowid);
}
function reviewList(db, status){
  return db.prepare('SELECT id, rkey, kind, list, rec_id, device, created_at, status, title, payload FROM sync_review WHERE status = ? ORDER BY id DESC').all(status || 'open')
    .map(r => Object.assign({}, r, { payload: r.payload ? JSON.parse(r.payload) : {} }));
}
const reviewClose = (db, id, how) => db.prepare('UPDATE sync_review SET status = ? WHERE id = ?').run(how || 'done', id);

module.exports = { LIST_KEYS, EPOCH, SEP, key, SYNC_SCHEMA, canon, infoGet, infoSet, ensureTracking, trackSave, readTrack, readTombs, maxSeq, getRev, bumpRev, reviewAdd, reviewList, reviewClose };
