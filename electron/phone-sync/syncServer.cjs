/* FleetPilot phone sync: the desktop's side of the conversation. Runs in the Electron MAIN process; needs no Electron (the tests start it directly).

   WHO SPEAKS FIRST: the desktop only waits. The phone starts every conversation. The server starts with the app and stays on for as long as FleetPilot is open (a status bar on every screen shows it); the Connect phone window only shows and controls it.
   The messages are written down in docs/phone-sync/SYNC_SPEC.md; the phone app is built from that file.

   EVERY WRITE goes through the same queue as the screens (store.sync.queue), so a sync and a save can never collide.
   A SYNC, in order:  begin -> push (small numbered batches, kept in sync_inbox) -> commit (the whole sync is applied in ONE transaction, then read back
   and checked) -> pull (the desktop's changes, small batches, read only) -> finish (the phone confirms it has saved them; only now does the desktop
   mark them as delivered). If anything stops half way, nothing is lost and nothing is applied twice. */
'use strict';
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto'), dgram = require('dgram');
const syncDb = require('./syncDb.cjs');
const core = require('./syncCore.cjs');
const { LIST_KEYS, key } = syncDb;

const PROTOCOL = 1, MIN_PROTOCOL = 1;
const DEFAULT_PORT = 47600, DISCOVERY_PORT = 47599;
const CLOCK_LIMIT_MS = 2 * 60 * 1000;
const CONNECTED_MS = 45 * 1000;                         // a phone counts as connected while it has spoken to us in the last 45 seconds
const PIN_LIFETIME_MS = 5 * 60 * 1000;
const PIN_ATTEMPTS_PER_ADDRESS = 5;
const PIN_BLOCK_MS = 5 * 60 * 1000;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const LOW_FREE = 300 * 1024 * 1024;

function localAddresses(){
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(n => (nets[n] || []).forEach(i => { if(i && (i.family === 'IPv4' || i.family === 4) && !i.internal) out.push({ name: n, address: i.address }); }));
  const priv = a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a);
  return out.filter(x => priv(x.address));
}

function createSync(opts){
  const store = opts.store, S = store.sync, hooks = opts.hooks || {};
  const now = opts.now || (() => new Date());
  const connectMs = opts.connectMs || CONNECTED_MS, badPinDelay = opts.badPinDelayMs == null ? 1000 : opts.badPinDelayMs;
  const state = { running: false, db: '', port: 0, host: '', server: null, udp: null, pin: '', pinExpiresAt: 0, pinAttempts: new Map(), badPins: 0, error: '', udpError: '',
    pending: new Map(), clockPending: new Map(), lastCheck: null, lastSync: null, busy: false, seen: new Map() };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const iso = () => now().toISOString();
  const err = (res, code, error, extra) => send(res, code, Object.assign({ ok: false, error }, extra || {}));
  function send(res, code, obj){ const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); }
  const db = () => S.conn(state.db);
  const newPin = () => {
    state.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    state.pinExpiresAt = now().getTime() + (opts.pinLifetimeMs || PIN_LIFETIME_MS);
    state.badPins = 0;
  };
  const refreshPin = () => { if(!state.running) return { ok: false, error: 'phone connection is not running' }; newPin(); return { ok: true }; };

  /* ---------- devices ---------- */
  const deviceRow = id => db().prepare('SELECT * FROM sync_devices WHERE device_id = ?').get(String(id || ''));
  const devices = () => db().prepare('SELECT device_id, name, status, range_start, range_end, paired_at, last_sync_at, last_ack, offset_ms, reference, app_version FROM sync_devices ORDER BY paired_at').all();
  function authed(req){
    const d = deviceRow(req.headers['x-fp-device']); const tok = req.headers['x-fp-token'];
    if(!d || d.status !== 'active' || !tok || !safeEq(sha(tok), d.token_hash)) return null;
    state.seen.set(d.device_id, now().getTime());          // the status bar shows "connected" while a paired phone keeps talking to us
    return d;
  }

  /* ---------- checks around every sync ---------- */
  function integrity(){                                  // a quick integrity check of the live file
    try{ const r = db().prepare('PRAGMA quick_check').get(); const ok = r && Object.values(r)[0] === 'ok'; state.lastCheck = { at: iso(), ok: !!ok }; return !!ok; }
    catch(e){ state.lastCheck = { at: iso(), ok: false, error: S.plainError(e) }; return false; }
  }
  function lowDisk(){
    const free = store.diskFree(); if(free == null) return false;
    let size = 0; try{ size = fs.statSync(S.fileFor(state.db)).size; }catch(e){}
    return free < (opts.lowFree != null ? opts.lowFree : LOW_FREE) || free < size * 20;
  }
  const versionProblem = body => {
    const p = Number(body && body.protocol) || 0;
    if(p < MIN_PROTOCOL) return { code: 426, error: 'update-app', message: 'The phone app is older than this FleetPilot. Update the phone app, then try again.' };
    if(p > PROTOCOL) return { code: 426, error: 'update-desktop', message: 'The phone app is newer than this FleetPilot. Update FleetPilot on the computer, then try again.' };
    return null;
  };

  /* ---------- pairing ---------- */
  function allocateRange(){
    let idx = Number(syncDb.infoGet(db(), 'rangeIndex', 0)) || 0; idx++;
    const r = core.phoneRange(idx);
    const clash = db().prepare('SELECT device_id FROM sync_devices WHERE NOT (range_end < ? OR range_start > ?)').get(r.start, r.end);
    if(clash) throw new Error('number ranges overlap, pairing refused');
    return { index: idx, start: r.start, end: r.end };
  }
  async function approve(pairingId, choice){
    const p = state.pending.get(pairingId); if(!p) return { ok: false, error: 'that phone is no longer waiting' };
    if(Math.abs(p.diffMs) > CLOCK_LIMIT_MS && !(choice && (choice.reference === 'phone' || choice.reference === 'desktop')))
      return { ok: false, needClock: true, error: 'the clocks differ: choose which one is correct' };
    return S.queue(() => {
      const copy = '';                                    // no extra safety copy at pairing: the monthly copy and the developer backup are enough (this only reads the desktop)
      let r; try{ r = allocateRange(); }catch(e){ return { ok: false, error: e.message }; }
      const token = crypto.randomBytes(24).toString('hex');
      const ref = Math.abs(p.diffMs) > CLOCK_LIMIT_MS ? choice.reference : 'none';
      const snapshot = syncDb.maxSeq(db());
      const existing = deviceRow(p.phoneId);
      db().exec('BEGIN IMMEDIATE');
      try{
        if(existing) db().prepare('DELETE FROM sync_devices WHERE device_id = ?').run(p.phoneId);
        db().prepare('INSERT INTO sync_devices (device_id, name, token_hash, status, range_index, range_start, range_end, paired_at, last_ack, offset_ms, reference, instance, app_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(p.phoneId, p.name, sha(token), 'active', existing ? existing.range_index : r.index, existing ? existing.range_start : r.start, existing ? existing.range_end : r.end, iso(), 0, p.diffMs, ref, p.instance, p.appVersion);
        if(!existing) syncDb.infoSet(db(), 'rangeIndex', r.index);
        db().exec('COMMIT');
      }catch(e){ try{ db().exec('ROLLBACK'); }catch(e2){} return { ok: false, error: S.plainError(e) }; }
      const row = deviceRow(p.phoneId);
      p.status = 'approved'; p.token = token; p.range = { start: row.range_start, end: row.range_end }; p.copy = copy; p.snapshot = snapshot;
      newPin();                                           // the PIN is good for one phone only
      return { ok: true, device: p.phoneId, copy };
    });
  }
  function reject(pairingId){ const p = state.pending.get(pairingId); if(!p) return { ok: false }; p.status = 'rejected'; return { ok: true }; }

  /* ---------- clock (a pop-up asks which one is right; sync is never blocked by a wrong clock) ---------- */
  function checkClock(d, phoneTime){
    const diff = Date.parse(phoneTime) - now().getTime();
    if(!Number.isFinite(diff)) return { ok: false, error: 'the phone did not send its time' };
    if(Math.abs(diff - d.offset_ms) > CLOCK_LIMIT_MS || (Math.abs(diff) > CLOCK_LIMIT_MS && d.reference === 'none')){
      state.clockPending.set(d.device_id, { device: d.device_id, name: d.name, diffMs: diff, desktopTime: iso(), phoneTime });
      return { ok: false, pending: true };
    }
    state.clockPending.delete(d.device_id);
    if(Math.abs(diff) <= CLOCK_LIMIT_MS) S.queue(() => db().prepare('UPDATE sync_devices SET offset_ms = ?, reference = ? WHERE device_id = ?').run(diff, 'none', d.device_id)).catch(() => {});
    return { ok: true, diff };
  }
  function setClock(deviceId, reference){
    const c = state.clockPending.get(deviceId); if(!c) return { ok: false, error: 'nothing is waiting for a clock choice' };
    if(reference !== 'phone' && reference !== 'desktop') return { ok: false, error: 'choose phone or desktop' };
    return S.queue(() => { db().prepare('UPDATE sync_devices SET offset_ms = ?, reference = ? WHERE device_id = ?').run(c.diffMs, reference, deviceId); state.clockPending.delete(deviceId); return { ok: true }; });
  }

  /* ---------- reading for the phone ---------- */
  const lookup = db => (list, id) => { const r = db.prepare('SELECT data FROM records WHERE list = ? AND id = ?').get(list, String(id)); return r ? JSON.parse(r.data) : null; };
  function pullPage(d, upTo, cursor, limit, catchup){
    const from = Math.max(catchup ? -1 : d.last_ack, cursor);
    const rows = db().prepare('SELECT list, id, seq, changed_at, device, deleted, arrived_from, restore FROM sync_track WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?').all(from, upTo, limit);
    const get = lookup(db()), changes = [];
    rows.forEach(r => {
      if(r.arrived_from === d.device_id && r.device === d.device_id) return;           // the phone's own latest version: no need to send it back
      if(r.deleted){ changes.push({ list: r.list, id: isNaN(Number(r.id)) ? r.id : Number(r.id), deleted: true, at: r.changed_at, dev: r.device }); return; }
      const rec = get(r.list, r.id); if(!rec) return;
      const c = { list: r.list, id: rec.id, deleted: false, at: r.changed_at, dev: r.device, data: rec }; if(r.restore) c.restore = true; changes.push(c);
    });
    return { changes, next: rows.length ? rows[rows.length - 1].seq : cursor, done: rows.length < limit };
  }

  /* ---------- applying a phone's changes: ONE transaction, parents first, nothing removed ---------- */
  function commit(d, session, changes, mode){ return serial(() => commitNow(d, session, changes, mode)); }
  async function commitNow(d, session, changes, mode){
    if(!integrity()) return { ok: false, error: 'integrity', message: 'The database did not pass its check, so the sync was cancelled. Nothing was changed.' };
    if(lowDisk()) return { ok: false, error: 'low-disk', message: 'The computer is nearly out of disk space, so the sync was not started. Free some space and try again.' };
    if(hooks.beforeApply){ try{ const r = await hooks.beforeApply(); if(r === false) return { ok: false, error: 'screen', message: 'The FleetPilot screen could not finish saving first, so the sync was not applied. Nothing was changed.' }; }
      catch(e){ return { ok: false, error: 'screen', message: 'The FleetPilot screen could not finish saving first, so the sync was not applied. Nothing was changed.' }; } }
    let out;
    try{
      out = await S.queue(() => {
        const c = db(), name = state.db;
        const { data } = { data: S.readLedger(c) };
        const track = syncDb.readTrack(c), tombs = syncDb.readTombs(c);
        /* records held aside last time are tried again, with the newest of anything the phone sent now */
        const heldRows = syncDb.reviewList(c, 'open').filter(r => r.kind === 'held' && r.payload && r.payload.change);
        const all = new Map();
        heldRows.forEach(r => { const ch = r.payload.change; if(ch && (r.device == null || r.device === d.device_id)) all.set(key(ch.list, ch.id), ch); });
        changes.forEach(ch => { if(ch && ch.list) all.set(key(ch.list, ch.id), ch); });
        const dev = { id: d.device_id, last_ack: mode === 'catchup' ? -1 : d.last_ack, offset_ms: d.offset_ms, reference: d.reference };
        const m = core.merge({ data, track, tombs, changes: Array.from(all.values()), dev });
        const changed = m.applied.size > 0 || m.extraTombs.length > 0;
        const after = (wdb) => {
          const t = iso();
          heldRows.forEach(r => { if(m.applied.has(key(r.list, r.rec_id))) syncDb.reviewClose(wdb, r.id, 'done'); });
          wdb.prepare("UPDATE sync_review SET status = 'done' WHERE kind = 'broken-link' AND status = 'open'").run();
          m.broken.forEach(b => syncDb.reviewAdd(wdb, { kind: 'broken-link', rkey: 'broken:' + key(b.list, b.id), list: b.list, rec_id: b.id,
            title: 'A link is missing: ' + b.list.replace(/s$/, '') + ' ' + b.id + ' (' + b.missing.map(x => x.parent.replace(/s$/, '') + ' ' + x.value).concat(b.empty.map(f => f + ' is empty')).join(', ') + ')', payload: { missing: b.missing, empty: b.empty } }, t));
          m.review.forEach(r => syncDb.reviewAdd(wdb, Object.assign({ device: d.device_id }, r), t));
          wdb.prepare('DELETE FROM sync_inbox WHERE device = ? AND session = ?').run(d.device_id, session);
          wdb.prepare('UPDATE sync_devices SET last_sync_at = ?, last_phone_seq = ? WHERE device_id = ?').run(t, d.last_phone_seq, d.device_id);
          if(changed) syncDb.bumpRev(wdb);
        };
        const res = S.writeNow(name, data, { stamps: m.applied, extraTombs: m.extraTombs, after });
        if(!res.ok) throw Object.assign(new Error(res.error), { writeFailed: true });
        const heldList = m.held.map(h => h.change);
        return { m, changed, rev: syncDb.getRev(c), heldKeys: m.heldKeys, heldList, totals: core.totals(data), res };
      });
    }catch(e){
      if(hooks.afterApply) try{ await hooks.afterApply({ changed: false }); }catch(e2){}
      return { ok: false, error: 'write', message: 'The changes could not be saved on the computer (' + (e && e.message || e) + '). Nothing was changed; try the sync again.' };
    }
    const okAfter = integrity();
    if(hooks.afterApply){ try{ await hooks.afterApply({ changed: out.changed, rev: out.rev }); }catch(e){} }
    state.lastSync = { at: iso(), device: d.device_id };
    d.__held = out.heldKeys;
    return { ok: true, integrity: okAfter, summary: { added: out.m.counts.added, updated: out.m.counts.updated, deleted: out.m.counts.deleted, held: out.heldKeys.size,
      reviews: out.m.review.length, conflicts: out.m.review.filter(r => r.kind === 'conflict').length }, rev: out.rev, totals: out.totals, heldKeys: Array.from(out.heldKeys), heldList: out.heldList };
  }

  /* ---------- HTTP ---------- */
  function readBody(req, limit){
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if(size > limit){ reject(Object.assign(new Error('too big'), { tooBig: true })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  let chain = Promise.resolve();                         // two syncs never apply at the same moment
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const sessions = new Map();                            // session id -> { device, pullUpTo, catchup, snapshot }
  const goodSession = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

  async function route(req, res){
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if(req.method === 'GET' && p === '/fp/hello'){
      return send(res, 200, { ok: true, fp: 1, protocol: PROTOCOL, minProtocol: MIN_PROTOCOL, desktopId: store.deviceId, name: os.hostname(), db: state.db, appVersion: S.appVersion, time: iso() });
    }
    if(req.method === 'GET' && p === '/fp/pair/status'){
      const pr = state.pending.get(url.searchParams.get('id') || '');
      if(!pr) return err(res, 404, 'unknown');
      if(pr.status === 'approved'){ const out = { ok: true, status: 'approved', token: pr.token, range: pr.range, desktopId: store.deviceId, db: state.db, desktopTime: iso(), snapshotSeq: pr.snapshot };
        pr.status = 'delivered'; return send(res, 200, out); }
      return send(res, 200, { ok: true, status: pr.status === 'delivered' ? 'approved' : pr.status, clock: Math.abs(pr.diffMs) > CLOCK_LIMIT_MS });
    }
    if(req.method !== 'POST') return err(res, 404, 'not found');
    let d = null;
    if(p !== '/fp/pair'){
      d = authed(req);
      if(!d) return err(res, 401, 'not-paired', { message: 'This phone is not paired with this computer.' });
    }
    let body = {}; let raw;
    try{ raw = await readBody(req, p === '/fp/backup' ? 2 * 1024 * 1024 * 1024 : 24 * 1024 * 1024); }catch(e){ return err(res, 413, 'too-big'); }
    if(p !== '/fp/backup'){ try{ body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }catch(e){ return err(res, 400, 'bad-json'); } }

    if(p === '/fp/pair'){
      const v = versionProblem(body); if(v) return err(res, v.code, v.error, { message: v.message });
      if(now().getTime() >= state.pinExpiresAt){
        newPin();
        return err(res, 410, 'pin-expired', { message: 'This PIN expired. Read the new PIN shown on the computer and try again.' });
      }
      const source = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
      const attempts = state.pinAttempts.get(source) || { count: 0, blockedUntil: 0 };
      const currentTime = now().getTime();
      if(attempts.blockedUntil > currentTime){
        const remainingMs = attempts.blockedUntil - currentTime;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        return err(res, 429, 'pin-rate-limited', {
          retryAfterMs: remainingMs,
          message: 'Too many incorrect PIN attempts from this network address. Pairing is locked for about ' + remainingMinutes + ' more minute' + (remainingMinutes === 1 ? '' : 's') + '.'
        });
      }
      if(attempts.blockedUntil && attempts.blockedUntil <= currentTime){ attempts.count = 0; attempts.blockedUntil = 0; }
      if(!body.pin || !safeEq(String(body.pin), state.pin)){
        state.badPins++;
        attempts.count++;
        if(attempts.count >= (opts.pinAttemptsPerAddress || PIN_ATTEMPTS_PER_ADDRESS))
          attempts.blockedUntil = currentTime + (opts.pinBlockMs || PIN_BLOCK_MS);
        state.pinAttempts.set(source, attempts);
        if(badPinDelay > 0) await sleep(badPinDelay);
        return err(res, 403, 'bad-pin', { tryAgain: true, message: 'That PIN is not right. Check the PIN on the computer and try again.' });
      }
      state.pinAttempts.delete(source);
      const phoneId = String(body.phoneId || '').slice(0, 64), name = String(body.name || 'Phone').slice(0, 60);
      if(!/^[A-Za-z0-9_-]{6,64}$/.test(phoneId)) return err(res, 400, 'bad-device');
      const diff = Date.parse(body.phoneTime) - now().getTime();
      if(!Number.isFinite(diff)) return err(res, 400, 'no-time', { message: 'The phone did not send its time.' });
      const id = crypto.randomBytes(8).toString('hex');
      state.pending.set(id, { id, phoneId, name, instance: String(body.instance || ''), appVersion: String(body.appVersion || ''), diffMs: diff, phoneTime: body.phoneTime, desktopTime: iso(), status: 'waiting', asked: iso() });
      return send(res, 200, { ok: true, pairingId: id });
    }

    /* everything below needs a paired phone */
    if(state.busyFull && p === '/fp/full/begin') return err(res, 409, 'busy');

    if(p === '/fp/ping') return send(res, 200, { ok: true, time: iso(), desktopId: store.deviceId });      // the phone calls this every ~15 seconds while its app is open: it keeps the green "connected" bar on

    if(p === '/fp/full/begin'){
      const v = versionProblem(body); if(v) return err(res, v.code, v.error, { message: v.message });
      if(!integrity()) return err(res, 500, 'integrity', { message: 'The database did not pass its check, so nothing was sent.' });
      const snapshot = syncDb.maxSeq(db()), counts = {};
      LIST_KEYS.forEach(l => { counts[l] = db().prepare('SELECT COUNT(*) n FROM records WHERE list = ?').get(l).n; });
      return send(res, 200, { ok: true, snapshotSeq: snapshot, counts, order: core.ORDER, range: { start: d.range_start, end: d.range_end }, desktopId: store.deviceId, desktopTime: iso() });
    }
    if(p === '/fp/full/page'){
      const li = Math.max(0, Number(body.li) || 0), off = Math.max(0, Number(body.off) || 0), size = Math.min(500, Math.max(1, Number(body.size) || 200));
      const order = core.ORDER.filter(l => LIST_KEYS.includes(l)); if(li >= order.length) return send(res, 200, { ok: true, done: true, records: [], list: null });
      const list = order[li];
      const rows = db().prepare('SELECT data FROM records WHERE list = ? ORDER BY pos LIMIT ? OFFSET ?').all(list, size, off);
      const more = rows.length === size;
      return send(res, 200, { ok: true, list, records: rows.map(r => JSON.parse(r.data)), next: more ? { li, off: off + size } : { li: li + 1, off: 0 }, done: !more && li + 1 >= order.length });
    }
    if(p === '/fp/full/done'){
      return S.queue(() => {
        const snapshot = Number(body.snapshotSeq) || 0;
        db().prepare('UPDATE sync_devices SET last_ack = ?, last_sync_at = ?, app_version = ? WHERE device_id = ?').run(snapshot, iso(), String(body.appVersion || d.app_version || ''), d.device_id);
        const mine = core.totals(S.readLedger(db())), diff = body.totals ? core.totalsDiff(mine, body.totals) : [];
        state.lastSync = { at: iso(), device: d.device_id, full: true };
        send(res, 200, { ok: true, totalsOk: diff.length === 0, diff, totals: mine });
      });
    }

    if(p === '/fp/sync/begin'){
      const v = versionProblem(body); if(v) return err(res, v.code, v.error, { message: v.message });
      if(!goodSession(body.session)) return err(res, 400, 'bad-session');
      const clk = checkClock(d, body.phoneTime);
      if(!clk.ok && clk.pending) return err(res, 409, 'clock-pending', { message: 'The clocks of the phone and the computer differ. Answer the question on the computer, then try again.' });
      if(!clk.ok) return err(res, 400, 'no-time', { message: clk.error });
      const maxS = syncDb.maxSeq(db());
      const restoredPhone = Number(body.phoneSeq) < Number(d.last_phone_seq) || (d.instance && body.instance && d.instance !== String(body.instance) && Number(body.ack) > 0);
      const restoredDesktop = Number(body.ack) > maxS;
      const catchup = !!(restoredPhone || restoredDesktop || body.mode === 'catchup');
      const have = db().prepare('SELECT batch FROM sync_inbox WHERE device = ? AND session = ?').all(d.device_id, body.session).map(r => r.batch);
      sessions.set(body.session, { device: d.device_id, pullUpTo: maxS, catchup });
      await S.queue(() => db().prepare('UPDATE sync_devices SET instance = ?, last_phone_seq = ?, app_version = ? WHERE device_id = ?').run(String(body.instance || d.instance || ''), Math.max(Number(body.phoneSeq) || 0, restoredPhone ? 0 : d.last_phone_seq), String(body.appVersion || ''), d.device_id));
      return send(res, 200, { ok: true, session: body.session, desktopTime: iso(), pullUpTo: maxS, catchup, received: have, lastAck: d.last_ack, restoredPhone: !!restoredPhone, restoredDesktop: !!restoredDesktop });
    }
    if(p === '/fp/sync/push'){
      if(!goodSession(body.session) || !Array.isArray(body.changes) || !Number.isInteger(body.batch) || body.batch < 1) return err(res, 400, 'bad-batch');
      await S.queue(() => db().prepare('INSERT INTO sync_inbox (device, session, batch, payload) VALUES (?, ?, ?, ?) ON CONFLICT(device, session, batch) DO UPDATE SET payload = excluded.payload').run(d.device_id, body.session, body.batch, JSON.stringify(body.changes)));
      return send(res, 200, { ok: true, batch: body.batch });
    }
    if(p === '/fp/sync/commit'){
      if(!goodSession(body.session)) return err(res, 400, 'bad-session');
      const total = Number(body.batches) || 0;
      const rows = db().prepare('SELECT batch, payload FROM sync_inbox WHERE device = ? AND session = ? ORDER BY batch').all(d.device_id, body.session);
      const got = new Set(rows.map(r => r.batch));
      for(let i = 1; i <= total; i++) if(!got.has(i)) return err(res, 409, 'missing-batch', { missing: i, message: 'Batch ' + i + ' did not arrive. Send it again.' });
      const changes = []; rows.forEach(r => { if(r.batch <= total) JSON.parse(r.payload).forEach(c => changes.push(c)); });
      const sess = sessions.get(body.session) || { catchup: body.mode === 'catchup' };
      const r = await commit(d, body.session, changes, sess.catchup ? 'catchup' : 'normal');
      if(!r.ok) return err(res, r.error === 'low-disk' ? 507 : 500, r.error, { message: r.message });
      sessions.set(body.session, Object.assign(sess, { pullUpTo: syncDb.maxSeq(db()), held: r.heldKeys, heldList: r.heldList, rev: r.rev }));
      return send(res, 200, { ok: true, summary: r.summary, integrity: r.integrity, pullUpTo: syncDb.maxSeq(db()), heldKeys: r.heldKeys });
    }
    if(p === '/fp/sync/pull'){
      const s = sessions.get(body.session); if(!s || s.device !== d.device_id) return err(res, 404, 'unknown-session', { message: 'This sync is no longer open. Start it again.' });
      const dd = deviceRow(d.device_id);
      const page = pullPage(dd, s.pullUpTo, Math.max(-1, Number(body.cursor) || -1), Math.min(500, Math.max(1, Number(body.limit) || 200)), s.catchup);
      return send(res, 200, Object.assign({ ok: true, pullUpTo: s.pullUpTo }, page));
    }
    if(p === '/fp/sync/finish'){
      const s = sessions.get(body.session); if(!s || s.device !== d.device_id) return err(res, 404, 'unknown-session');
      const ack = Math.min(Number(body.ack) || 0, s.pullUpTo);
      return S.queue(() => {
        db().prepare('UPDATE sync_devices SET last_ack = ?, last_sync_at = ? WHERE device_id = ?').run(Math.max(ack, 0), iso(), d.device_id);
        const skip = new Set(s.held || []);
        const mine = core.totals(S.readLedger(db()), null);
        /* records held aside exist on the phone but not here yet: they count on this side too, so a held record is not a mismatch */
        (s.heldList || []).forEach(ch => { if(ch && ch.data){ const t = mine[ch.list] || (mine[ch.list] = { n: 0, sum: 0 }); t.n++; t.sum = Math.round((t.sum + (Number(ch.data.amount) || 0)) * 100) / 100; } });
        const diff = body.totals ? core.totalsDiff(mine, body.totals) : [];
        sessions.delete(body.session);
        state.lastSync = { at: iso(), device: d.device_id };
        send(res, 200, { ok: true, totalsOk: diff.length === 0, diff, held: skip.size, integrity: integrity() });
      });
    }
    if(p === '/fp/backup'){
      const label = String(req.headers['x-fp-name'] || d.name || 'phone').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || 'phone';
      const target = path.join(store.dirs.copies, state.db + ' - phone backup ' + label + ' ' + S.stamp() + '.phonebackup.json');   // never over the live data
      try{ S.mk(store.dirs.copies); fs.writeFileSync(target, raw); }catch(e){ return err(res, 500, 'write', { message: 'The backup could not be stored: ' + S.plainError(e) }); }
      return send(res, 200, { ok: true, file: path.basename(target), bytes: raw.length });
    }
    return err(res, 404, 'not found');
  }

  /* ---------- start / stop ---------- */
  function listen(port, tries){
    const host = opts.host || (opts.port === 0 ? '127.0.0.1' : localAddresses()[0] && localAddresses()[0].address);
    if(!host) return Promise.reject(new Error('NO_PRIVATE_NETWORK'));
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => { route(req, res).catch(e => { try{ err(res, 500, 'server', { message: String(e && e.message || e) }); }catch(e2){} }); });
      srv.once('error', e => { if(e && e.code === 'EADDRINUSE' && tries > 0) resolve(listen(port + 1, tries - 1)); else reject(e); });
      srv.listen(port, host, () => resolve({ srv, port: srv.address().port, host }));
    });
  }
  function startUdp(){
    try{
      const u = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      u.on('error', e => { state.udpError = String(e && e.message || e); try{ u.close(); }catch(e2){} state.udp = null; });
      u.on('message', (msg, rinfo) => {
        const t = String(msg).trim(); if(!t.startsWith('FPDISCOVER')) return;
        const want = t.split(' ')[1]; if(want && want !== store.deviceId) return;
        const out = Buffer.from(JSON.stringify({ fp: 1, d: store.deviceId, a: state.host ? [state.host + ':' + state.port] : [] }));
        try{ u.send(out, rinfo.port, rinfo.address); }catch(e){}
      });
      u.bind(opts.discoveryPort || DISCOVERY_PORT, () => { try{ u.setBroadcast(true); }catch(e){} });
      state.udp = u;
    }catch(e){ state.udpError = String(e && e.message || e); }
  }
  async function start(dbName){
    if(state.running) await stop();
    state.db = S.resolveName(dbName); state.error = '';
    try{ S.conn(state.db); }catch(e){ state.error = 'The database could not be opened: ' + S.plainError(e); return { ok: false, error: state.error }; }
    if(!integrity()){ state.error = 'The database did not pass its check, so Connect phone was not started. Nothing was changed.'; return { ok: false, error: state.error }; }
    try{ const r = await listen(opts.port == null ? DEFAULT_PORT : opts.port, opts.port == null ? 10 : 0); state.server = r.srv; state.port = r.port; state.host = r.host; }
    catch(e){
      state.error = e && e.message === 'NO_PRIVATE_NETWORK'
        ? 'Connect phone requires a private IPv4 network. Join your phone and computer to the same trusted Wi-Fi, then try again.'
        : 'FleetPilot could not open its connection on this computer (' + (e && e.code || e) + '). If Windows asks about the firewall, allow FleetPilot only on private networks.';
      return { ok: false, error: state.error };
    }
    newPin(); state.running = true; state.pending.clear(); state.clockPending.clear(); state.seen.clear();
    if(opts.discovery !== false) startUdp();
    return { ok: true, port: state.port };
  }
  /* the app starts the connection once for the whole time it is open; opening the Connect phone window calls this too and changes nothing when it is already running */
  async function ensure(dbName){
    if(state.running && state.server && state.db === S.resolveName(dbName)) return { ok: true, port: state.port, already: true };
    return start(dbName);
  }
  async function stop(){
    state.running = false; sessions.clear(); state.seen.clear();
    if(state.server){ await new Promise(r => { try{ state.server.close(() => r()); state.server.closeAllConnections && state.server.closeAllConnections(); }catch(e){ r(); } }); state.server = null; }
    state.host = '';
    if(state.udp){ try{ state.udp.close(); }catch(e){} state.udp = null; }
    state.pending.clear(); state.clockPending.clear();
    return { ok: true };
  }

  /* ---------- what the Connect phone window shows ---------- */
  const folderBytes = () => { let n = 0; try{ fs.readdirSync(store.dirs.copies).forEach(f => { try{ n += fs.statSync(path.join(store.dirs.copies, f)).size; }catch(e){} }); }catch(e){} return n; };
  function qrText(){
    const addrs = state.host ? [state.host + ':' + state.port] : [];
    return JSON.stringify({ fp: 1, d: store.deviceId, n: os.hostname(), a: addrs, p: state.pin, db: state.db });
  }
  function status(){
    const addrs = localAddresses();
    const out = { running: state.running, error: state.error, udpError: state.udpError, db: state.db, port: state.port, network: addrs.length > 0, addresses: state.host ? [state.host + ':' + state.port] : [], pc: os.hostname(),
      pin: state.running ? state.pin : '', badPins: state.badPins, qr: state.running ? qrText() : '',
      pending: Array.from(state.pending.values()).filter(p => p.status === 'waiting').map(p => ({ id: p.id, name: p.name, asked: p.asked, diffMs: p.diffMs, clock: Math.abs(p.diffMs) > CLOCK_LIMIT_MS, desktopTime: p.desktopTime, phoneTime: p.phoneTime })),
      clockPending: Array.from(state.clockPending.values()), lastSync: state.lastSync };
    if(state.db){
      try{ out.devices = devices(); out.reviewOpen = syncDb.reviewList(db(), 'open').length; out.records = db().prepare('SELECT COUNT(*) n FROM records').get().n; }catch(e){ out.devices = []; }
      out.health = { lastCheck: state.lastCheck, copiesBytes: folderBytes() };
      try{ const c = store.copies()[0]; out.health.lastCopy = c ? { id: c.id, madeAt: c.madeAt } : null; }catch(e){}
    }
    return out;
  }
  /* the small status the bar at the bottom of every screen asks for (cheap: no file or record counting) */
  function barStatus(){
    const t = now().getTime(), addrs = localAddresses();
    const connected = [];
    state.seen.forEach((at, id) => { if(t - at <= connectMs){ let n = ''; try{ const r = deviceRow(id); n = r ? r.name : ''; }catch(e){} connected.push({ id, name: n || 'Phone', at }); } });
    let paired = 0, review = 0;
    if(state.db){ try{ paired = db().prepare("SELECT COUNT(*) n FROM sync_devices WHERE status = 'active'").get().n; review = syncDb.reviewList(db(), 'open').length; }catch(e){} }
    const waiting = Array.from(state.pending.values()).filter(p => p.status === 'waiting');
    return { running: state.running, error: state.error, network: addrs.length > 0, address: state.host ? state.host + ':' + state.port : '',
      connected, syncing: Array.from(sessions.values()).some(x => t - (state.seen.get(x.device) || 0) <= 20000), waiting: waiting.length + state.clockPending.size, waitingIds: waiting.map(p => p.id).concat(Array.from(state.clockPending.keys())),
      paired, review, lastSync: state.lastSync };
  }
  function healthCheck(){ return { ok: integrity(), lastCheck: state.lastCheck }; }

  /* ---------- the review list: the owner's answers ---------- */
  const reviewList = () => (state.db ? syncDb.reviewList(db(), 'open') : []);
  function localEdit(list, id, data, opt){ return serial(() => localEditNow(list, id, data, opt)); }
  async function localEditNow(list, id, data, opt){
    if(!LIST_KEYS.includes(list)) return { ok: false, error: 'unknown list' };
    if(hooks.beforeApply){ try{ if((await hooks.beforeApply()) === false) return { ok: false, error: 'The screen could not finish saving first.' }; }catch(e){ return { ok: false, error: 'The screen could not finish saving first.' }; } }
    let out;
    try{
      out = await S.queue(() => {
        const c = db(), data0 = S.readLedger(c), arr = data0[list] || (data0[list] = []);
        const rec = JSON.parse(JSON.stringify(data)); rec.id = rec.id != null ? rec.id : id;
        const bad = core.missingLinks(data0, list, rec);
        if(bad.length) return { ok: false, error: 'still points at something that is not there: ' + bad.map(b => b.parent.replace(/s$/, '') + ' ' + b.value).join(', ') };
        const i = arr.findIndex(r => String(r.id) === String(id));
        if(i >= 0) arr[i] = rec; else arr.push(rec);
        const stamps = new Map(); stamps.set(key(list, rec.id), { at: iso(), dev: store.deviceId, restore: !!(opt && opt.restore), arrivedFrom: opt && opt.arrivedFrom || null });
        const after = wdb => { if(opt && opt.reviewId) syncDb.reviewClose(wdb, opt.reviewId, 'done'); syncDb.bumpRev(wdb); };
        const res = S.writeNow(state.db, data0, { stamps, after });
        if(!res.ok) return { ok: false, error: res.error };
        return { ok: true, rev: syncDb.getRev(c) };
      });
    }catch(e){ out = { ok: false, error: String(e && e.message || e) }; }
    if(hooks.afterApply) try{ await hooks.afterApply({ changed: !!(out && out.ok), rev: out && out.rev }); }catch(e){}
    return out;
  }
  async function resolve(id, action, payload){
    const row = syncDb.reviewList(db(), 'open').find(r => r.id === Number(id)); if(!row) return { ok: false, error: 'that item is already settled' };
    const P = row.payload || {};
    const done = () => S.queue(() => { syncDb.reviewClose(db(), row.id, 'done'); return { ok: true }; });
    if(action === 'dismiss') return done();
    if(action === 'useOther' && row.kind === 'conflict'){
      const other = P.keptSide === 'phone' ? P.desktop : P.phone;
      return localEdit(row.list, row.rec_id, other, { reviewId: row.id });
    }
    if(action === 'restore' && row.kind === 'delete-edit') return localEdit(row.list, row.rec_id, P.edited, { reviewId: row.id, restore: true });
    if(action === 'edit' && payload && payload.data){
      const asHeld = row.kind === 'held';
      const list = payload.list && LIST_KEYS.includes(payload.list) ? payload.list : row.list, rid = payload.id != null ? payload.id : row.rec_id;   // overlaps and duplicates name two records: the owner picks one
      return localEdit(list, rid, payload.data, { reviewId: row.id, arrivedFrom: asHeld ? row.device : null, restore: row.kind === 'delete-edit' });
    }
    return { ok: false, error: 'that action does not apply here' };
  }
  const arrivals = () => {
    if(!state.db) return [];
    const today = now(); const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    return db().prepare("SELECT list, id, arrived_at FROM sync_track WHERE arrived_from IS NOT NULL AND deleted = 0").all()
      .filter(r => { const t = new Date(r.arrived_at); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') === day; }).map(r => ({ list: r.list, id: r.id }));
  };
  const phoneBackups = () => { try{ return fs.readdirSync(store.dirs.copies).filter(f => /phone backup|before pairing/.test(f)).map(f => ({ name: f, size: fs.statSync(path.join(store.dirs.copies, f)).size })); }catch(e){ return []; } };
  return { start, ensure, stop, status, barStatus, refreshPin, approve, reject, setClock, resolve, reviewList, arrivals, healthCheck, qrText, phoneBackups, _state: state, _sessions: sessions };
}
module.exports = { createSync, localAddresses, PROTOCOL, MIN_PROTOCOL, CLOCK_LIMIT_MS, CONNECTED_MS };
