/* FleetPilot developer backup. Runs in the Electron MAIN process. NOTHING of this is ever shown on a screen.

   One SQLite file and one JSON file sit side by side in  %APPDATA%\FleetPilot\developer\ :
       <database name> - developer.db       a full, consistent copy of the live database (all tables, including the hidden sync tables): open it in DB Browser for SQLite
       <database name> - developer.json     the same ledger as plain JSON (every list, every record, settings), readable without FleetPilot
       backup-log.txt                       one line per run (ok or why it was skipped), for the developer only

   The SAME two files are refreshed every 14 days (they are not multiplied into many copies). The first run is made soon after the app first opens.
   A refresh never damages the previous backup: the new copy is written beside it under a temporary name, checked (integrity, record counts, readable JSON),
   and only then replaces the old one. If any check fails, the old backup stays exactly as it was and the reason goes into backup-log.txt.
   The live database is only read, never changed (apart from one hidden line that remembers when the last backup was made). */
'use strict';
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const syncDb = require('./syncDb.cjs');

const EVERY_DAYS = 14, CHECK_EVERY_MS = 6 * 60 * 60 * 1000, FIRST_DELAY_MS = 45 * 1000, LOG_MAX = 100 * 1024;

function createDevBackup(opts){
  const store = opts.store, S = store.sync, now = opts.now || (() => new Date());
  const days = opts.days || EVERY_DAYS;
  const dir = path.join(store.root, 'developer');
  let timer = null, first = null, name = '', running = false;
  const files = n => ({ db: path.join(dir, n + ' - developer.db'), json: path.join(dir, n + ' - developer.json') });
  const rm = f => { try{ fs.unlinkSync(f); }catch(e){} };

  function log(line){
    try{
      S.mk(dir); const f = path.join(dir, 'backup-log.txt');
      let old = ''; try{ if(fs.statSync(f).size > LOG_MAX) old = fs.readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'); }catch(e){}
      if(old) fs.writeFileSync(f, old + '\n');
      fs.appendFileSync(f, now().toISOString() + '  ' + line + '\n');
    }catch(e){}
  }
  const lastAt = n => { try{ return Number(syncDb.infoGet(S.conn(n), 'devBackupAt', 0)) || 0; }catch(e){ return 0; } };
  function due(n){
    const f = files(n), at = lastAt(n);
    if(!S.exists(f.db) || !S.exists(f.json) || !at) return true;                  // a missing file is made again at once
    return now().getTime() - at >= days * 24 * 3600 * 1000;
  }

  /* make (or refresh) the two files now; { ok } or { ok:false, error } or { skipped:true } */
  async function run(n, force){
    n = S.resolveName(n); if(!n) return { ok: false, error: 'no database' };
    if(running) return { skipped: true }; running = true;
    const f = files(n), tmpDb = f.db + '.new', tmpJson = f.json + '.new';
    try{
      if(!force && !due(n)) return { skipped: true };
      return await S.queue(() => {
        S.mk(dir); rm(tmpDb); rm(tmpJson);
        const live = S.conn(n);
        const q = live.prepare('PRAGMA quick_check').get();
        if(!q || Object.values(q)[0] !== 'ok'){ log('SKIPPED  the live database did not pass its check; the older backup was left as it is'); return { ok: false, error: 'live database check failed' }; }
        const free = store.diskFree(); let size = 0; try{ size = fs.statSync(S.fileFor(n)).size; }catch(e){}
        if(free != null && free < size * 3 + 50 * 1024 * 1024){ log('SKIPPED  not enough free disk space; the older backup was left as it is'); return { ok: false, error: 'low disk' }; }
        S.copyDb(n, tmpDb);                                                         // VACUUM INTO: a consistent copy even while the app is running
        const chk = new DatabaseSync(tmpDb, { readOnly: true });
        let ledger, counts;
        try{
          const r = chk.prepare('PRAGMA quick_check').get(); if(!r || Object.values(r)[0] !== 'ok') throw new Error('the new copy did not pass its check');
          ledger = S.readLedger(chk);
          const a = chk.prepare('SELECT COUNT(*) n FROM records').get().n, b = live.prepare('SELECT COUNT(*) n FROM records').get().n;
          if(a !== b) throw new Error('the new copy has ' + a + ' records but the database has ' + b);
          counts = {}; Object.keys(ledger).forEach(k => { if(Array.isArray(ledger[k])) counts[k] = ledger[k].length; });
        }finally{ try{ chk.close(); }catch(e){} }
        const text = JSON.stringify({ app: 'FleetPilot', kind: 'developer-backup', database: n, madeAt: now().toISOString(), device: store.deviceId, counts, data: ledger }, null, 1);
        fs.writeFileSync(tmpJson, text);
        const back = JSON.parse(fs.readFileSync(tmpJson, 'utf8')); if(!back || !back.data || JSON.stringify(Object.keys(back.data)) !== JSON.stringify(Object.keys(ledger))) throw new Error('the JSON file did not read back correctly');
        fs.renameSync(tmpDb, f.db); fs.renameSync(tmpJson, f.json);                 // only now is the older backup replaced
        syncDb.infoSet(live, 'devBackupAt', now().getTime());
        log('OK       ' + n + ': ' + Object.values(counts).reduce((x, y) => x + y, 0) + ' records written to the .db and .json files');
        return { ok: true, db: f.db, json: f.json };
      });
    }catch(e){
      rm(tmpDb); rm(tmpJson); log('FAILED   ' + String(e && e.message || e) + '; the older backup was left as it is');
      return { ok: false, error: String(e && e.message || e) };
    }finally{ running = false; }
  }

  /* start watching a database: a first look soon after the app opens, then every few hours while it stays open */
  function watch(n){
    name = n;
    if(first) clearTimeout(first);
    first = setTimeout(() => { run(name).catch(() => {}); }, opts.firstDelayMs == null ? FIRST_DELAY_MS : opts.firstDelayMs);
    if(first.unref) first.unref();
    if(!timer){ timer = setInterval(() => { if(name) run(name).catch(() => {}); }, opts.checkEveryMs || CHECK_EVERY_MS); if(timer.unref) timer.unref(); }
  }
  function stop(){ if(first) clearTimeout(first); if(timer) clearInterval(timer); first = timer = null; }
  return { run, watch, stop, due, files, dir };
}
module.exports = { createDevBackup, EVERY_DAYS };
