/* Test helpers: a temporary data folder, a database with a few records, and a SIMULATED PHONE that speaks the sync messages (SYNC_SPEC.md)
   exactly as the real phone app will. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createStore } = require('../../electron/ledgerFile.cjs');
const { createSync } = require('../../electron/phone-sync/syncServer.cjs');
const core = require('../../electron/phone-sync/syncCore.cjs');
const { LIST_KEYS } = require('../../electron/phone-sync/syncDb.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpsync-'));
function baseData(){
  const d = { nextId: 10, settings: { adminPin: null, chartType: 'pie' } };
  LIST_KEYS.forEach(k => { d[k] = []; });
  d.vehicles = [{ id: 1, reg: 'KAA 001A' }, { id: 2, reg: 'KBB 002B' }];
  d.clients = [{ id: 3, name: 'ACME' }];
  d.rentals = [{ id: 4, vehicleId: 1, clientId: 3, pickup: '2026-11-01', return: '2026-11-03', amount: 5000, status: 'Active' }];
  d.payments = [{ id: 5, rentalId: 4, amount: 2000, date: '2026-11-02' }];
  return d;
}
async function setup(opts){
  opts = opts || {};
  const root = opts.root || tmp();
  let clock = opts.start || Date.parse('2026-11-08T10:00:00.000Z');
  const store = createStore({ root, now: () => new Date(clock), busyTimeout: opts.busyTimeout || 3000 });
  if(!opts.noCreate){ const r = await store.create('Main', opts.data || baseData()); if(!r.ok) throw new Error('create failed ' + JSON.stringify(r)); }
  const calls = { before: 0, after: [] };
  const sync = createSync({ store, port: 0, host: '127.0.0.1', discovery: false, now: () => new Date(clock), badPinDelayMs: opts.badPinDelayMs == null ? 0 : opts.badPinDelayMs, connectMs: opts.connectMs, pinLifetimeMs: opts.pinLifetimeMs,
    hooks: { beforeApply: async () => { calls.before++; return true; }, afterApply: async i => { calls.after.push(i); return true; } } });
  const st = await sync.start('Main'); if(!st.ok) throw new Error('start failed ' + st.error);
  const url = 'http://127.0.0.1:' + st.port;
  return { root, store, sync, url, calls, tick: ms => { clock += ms; return clock; }, now: () => clock, setNow: v => { clock = v; }, async close(){ await sync.stop(); store.closeAll(); } };
}

class SimPhone {
  constructor(env, name, opts){
    opts = opts || {};
    this.env = env; this.name = name || 'Test phone'; this.id = opts.id || 'P' + crypto.randomBytes(5).toString('hex');
    this.skew = opts.skew || 0; this.protocol = opts.protocol == null ? 1 : opts.protocol;
    this.records = {}; LIST_KEYS.forEach(k => { this.records[k] = new Map(); });    // list -> id -> { data, at, dev, seq, deleted, restore }
    this.tombs = new Map(); this.seq = 0; this.pushedSeq = 0; this.ack = 0; this.instance = crypto.randomBytes(4).toString('hex'); this.token = ''; this.range = null; this.nextId = 0;
    this.pending = [];
  }
  time(){ return new Date(this.env.now() + this.skew).toISOString(); }
  async call(p, body, method){
    const r = await fetch(this.env.url + p, { method: method || 'POST', headers: { 'content-type': 'application/json', 'x-fp-device': this.id, 'x-fp-token': this.token }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const j = await r.json(); j.status = r.status; return j;
  }
  async pair(pin, choice){
    const r = await this.call('/fp/pair', { pin, name: this.name, phoneId: this.id, instance: this.instance, phoneTime: this.time(), appVersion: 'sim', protocol: this.protocol });
    if(!r.ok) return r;
    const st = this.env.sync.status().pending.find(p => p.id === r.pairingId);
    const ap = await this.env.sync.approve(r.pairingId, choice); if(!ap.ok) return ap;
    const s = await this.call('/fp/pair/status?id=' + r.pairingId, null, 'GET');
    this.token = s.token; this.range = s.range; this.nextId = s.range.start; return { ok: true, approved: s, pendingInfo: st };
  }
  async fullCopy(){
    const b = await this.call('/fp/full/begin', { protocol: this.protocol }); if(!b.ok) return b;
    let cur = { li: 0, off: 0 }, done = false;
    while(!done){ const pg = await this.call('/fp/full/page', cur); pg.records.forEach(r => this.records[pg.list].set(String(r.id), { data: r, at: '1970-01-01T00:00:00.000Z', dev: 'D', seq: 0 })); done = pg.done; cur = pg.next || cur; }
    const fin = await this.call('/fp/full/done', { snapshotSeq: b.snapshotSeq, totals: this.totals() });
    this.ack = b.snapshotSeq; return Object.assign({ ok: true }, fin, { snapshotSeq: b.snapshotSeq });
  }
  totals(skip){ const d = {}; LIST_KEYS.forEach(l => { d[l] = Array.from(this.records[l].values()).filter(x => !x.deleted).map(x => x.data); }); return core.totals(d, skip); }
  /* local edits (what the phone screens would do) */
  add(list, data){ const id = this.nextId++; const rec = Object.assign({ id }, data); this.records[list].set(String(id), { data: rec, at: this.time(), dev: this.id, seq: ++this.seq }); return id; }
  edit(list, id, patch){ const e = this.records[list].get(String(id)); e.data = Object.assign({}, e.data, patch); e.at = this.time(); e.dev = this.id; e.seq = ++this.seq; delete e.restore; }
  remove(list, id){ const e = this.records[list].get(String(id)); this.records[list].delete(String(id)); this.tombs.set(list + '|' + id, { list, id, at: this.time(), dev: this.id, seq: ++this.seq, data: e && e.data }); }
  get(list, id){ const e = this.records[list].get(String(id)); return e ? e.data : null; }
  has(list, id){ return this.records[list].has(String(id)); }
  localChanges(all){
    const out = [];
    LIST_KEYS.forEach(l => this.records[l].forEach((e, id) => { if(all || e.seq > this.pushedSeq) out.push({ list: l, id: e.data.id, deleted: false, at: e.at, dev: e.dev, data: e.data }); }));
    this.tombs.forEach(t => { if(all || t.seq > this.pushedSeq) out.push({ list: t.list, id: t.id, deleted: true, at: t.at, dev: t.dev }); });
    return out;
  }
  applyPulled(c){
    if(c.deleted){ this.records[c.list].delete(String(c.id)); this.tombs.set(c.list + '|' + c.id, { list: c.list, id: c.id, at: c.at, dev: c.dev, seq: 0 }); return; }
    const t = this.tombs.get(c.list + '|' + c.id);
    if(t && !c.restore) return;                                                    // a delete stays a delete
    if(t){ this.tombs.delete(c.list + '|' + c.id); }
    this.records[c.list].set(String(c.id), { data: c.data, at: c.at, dev: c.dev, seq: 0 });
  }
  /* one whole sync; stopAfterPush / dropBatch let tests cut the connection */
  async sync(o){
    o = o || {};
    const session = o.session || 'S' + crypto.randomBytes(6).toString('hex');
    const b = await this.call('/fp/sync/begin', { session, phoneTime: this.time(), appVersion: 'sim', protocol: this.protocol, instance: this.instance, phoneSeq: o.phoneSeq != null ? o.phoneSeq : this.seq, ack: this.ack, mode: o.mode });
    if(!b.ok) return b;
    const changes = this.localChanges(b.catchup || o.all), size = o.batchSize || 2, batches = [];
    for(let i = 0; i < changes.length; i += size) batches.push(changes.slice(i, i + size));
    for(let i = 0; i < batches.length; i++){ if(o.dropBatch === i + 1) continue; if(b.received.includes(i + 1) && !o.resend) continue; const r = await this.call('/fp/sync/push', { session, batch: i + 1, changes: batches[i] }); if(!r.ok) return r; }
    if(o.stopAfterPush) return { ok: true, stopped: true, session, batches: batches.length };
    const c = await this.call('/fp/sync/commit', { session, batches: batches.length }); if(!c.ok) return Object.assign(c, { session, batches: batches.length });
    this.pushedSeq = this.seq;
    let cursor = -1, pulled = [];
    for(;;){ const pg = await this.call('/fp/sync/pull', { session, cursor, limit: o.pullSize || 2 }); if(!pg.ok) return pg; pulled.push(...pg.changes); cursor = pg.next; if(pg.done) break; }
    if(o.stopBeforeApply) return { ok: true, stopped: true, session };
    pulled.forEach(x => this.applyPulled(x));
    const held = new Set((c.heldKeys || []));
    const f = await this.call('/fp/sync/finish', { session, ack: c.pullUpTo, totals: this.totals(null) });
    if(f.ok) this.ack = c.pullUpTo;
    return Object.assign({ ok: true, session, commit: c, finish: f, pulled }, {});
  }
}
module.exports = { setup, SimPhone, baseData, tmp, core, LIST_KEYS };
