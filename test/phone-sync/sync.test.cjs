'use strict';
const { createDevBackup } = require('../../electron/phone-sync/devBackup.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { setup, SimPhone, baseData, core, LIST_KEYS } = require('./helpers.cjs');
const { createStore } = require('../../electron/ledgerFile.cjs');
const syncDb = require('../../electron/phone-sync/syncDb.cjs');

const pinOf = env => env.sync.status().pin;
async function paired(env, name, opts){ const ph = new SimPhone(env, name, opts); const r = await ph.pair(pinOf(env), opts && opts.choice); assert.ok(r.ok, JSON.stringify(r)); return ph; }
const reopen = async env => { const s2 = createStore({ root: env.root }); const r = await s2.load('Main'); s2.closeAll(); return r; };
const review = env => env.sync.reviewList();
const trackRow = (env, list, id) => env.store.sync.conn('Main').prepare('SELECT * FROM sync_track WHERE list = ? AND id = ?').get(list, String(id));

test('1A tracking is hidden and existing records get an old timestamp', async () => {
  const env = await setup();
  const r = await reopen(env);
  assert.deepEqual(Object.keys(r.data).sort(), Object.keys(baseData()).sort(), 'the ledger holds exactly its own fields: no tracking leaks into records');
  assert.ok(!JSON.stringify(r.data).includes('sync_'));
  // a database from before sync existed: no tracking yet. Opening it stamps every record with an OLD time, once.
  const c = env.store.sync.conn('Main'); c.exec("DELETE FROM sync_track; DELETE FROM sync_info"); env.store.closeAll();
  const s2 = createStore({ root: env.root, now: () => new Date(env.now()) }); await s2.load('Main');
  const t = s2.sync.conn('Main').prepare('SELECT * FROM sync_track WHERE list = ? AND id = ?').get('rentals', '4');
  assert.equal(t.changed_at, '1970-01-01T00:00:00.000Z'); assert.equal(t.seq, 0);
  assert.equal(s2.sync.conn('Main').prepare('SELECT COUNT(*) n FROM sync_track').get().n, 5, 'every existing record is stamped');
  // a new edit is stamped with the current time; untouched records keep the old stamp
  const d = (await s2.load('Main')).data; d.rentals[0].amount = 6000;
  assert.ok((await s2.save('Main', d)).ok);
  const t2 = s2.sync.conn('Main').prepare('SELECT * FROM sync_track WHERE list = ? AND id = ?').get('rentals', '4'); assert.ok(t2.seq > 0); assert.equal(t2.changed_at, '2026-11-08T10:00:00.000Z');
  assert.equal(s2.sync.conn('Main').prepare('SELECT seq FROM sync_track WHERE list = ? AND id = ?').get('vehicles', '1').seq, 0);
  s2.closeAll(); await env.sync.stop();
});

test('1A deletes are tracked and the last version is kept', async () => {
  const env = await setup();
  const d = (await env.store.load('Main')).data; d.payments = [];
  await env.store.save('Main', d);
  assert.equal(trackRow(env, 'payments', 5).deleted, 1);
  const kept = env.store.sync.conn('Main').prepare('SELECT data FROM sync_deleted WHERE list = ? AND id = ?').get('payments', '5');
  assert.equal(JSON.parse(kept.data).amount, 2000);
  await env.close();
});

test('1B only the desktop range counts for the id counter', () => {
  const d = baseData(); d.rentals.push({ id: 1000000007 }); d.payments.push({ id: 2000000001 });
  assert.equal(core.topDesktopId(d), 5);
  assert.deepEqual(core.phoneRange(1), { start: 1000000000, end: 1999999999 });
});

test('pairing: PIN attempts are rate-limited, approval, own number range, no extra copy at pairing', async () => {
  const env = await setup({ pinLifetimeMs: 10 * 60 * 1000 });
  const bad = new SimPhone(env, 'Intruder');
  const wrongPin = pinOf(env) === '000000' ? '000001' : '000000';
  for(let i = 0; i < 5; i++){ const r = await bad.call('/fp/pair', { pin: wrongPin, name: 'x', phoneId: bad.id, phoneTime: bad.time(), protocol: 1 }); assert.equal(r.error, 'bad-pin'); assert.equal(r.tryAgain, true); }
  assert.equal(env.sync.status().badPins, 5, 'the window can say how many wrong tries there were');
  const blocked = await bad.call('/fp/pair', { pin: pinOf(env), name: 'x', phoneId: bad.id, phoneTime: bad.time(), protocol: 1 });
  assert.equal(blocked.error, 'pin-rate-limited');
  env.sync.refreshPin();
  const stillBlocked = await bad.call('/fp/pair', { pin: pinOf(env), name: 'x', phoneId: bad.id, phoneTime: bad.time(), protocol: 1 });
  assert.equal(stillBlocked.error, 'pin-rate-limited', 'changing the PIN does not bypass the lock');
  env.tick(5 * 60 * 1000);
  const right = await bad.call('/fp/pair', { pin: pinOf(env), name: 'x', phoneId: bad.id, phoneTime: bad.time(), protocol: 1 });
  assert.ok(right.ok && right.pairingId, 'pairing is available again when the five-minute lock expires');
  env.sync.reject(right.pairingId);
  const ph = await paired(env, 'Phone A');
  assert.equal(ph.range.start, 1000000000);
  assert.ok(!fs.readdirSync(env.store.dirs.copies).some(f => /before pairing/.test(f)), 'no extra safety copy is made at pairing any more');
  const ph2 = await paired(env, 'Phone B');
  assert.equal(ph2.range.start, 2000000000, 'each phone gets its own range');
  const unpaired = new SimPhone(env, 'Nobody'); assert.equal((await unpaired.call('/fp/full/begin', {})).error, 'not-paired');
  await env.close();
});

test('pairing PIN expires and the listener stays on its private host', async () => {
  const env = await setup({ pinLifetimeMs: 1000 });
  const oldPin = pinOf(env);
  assert.equal(env.sync._state.server.address().address, '127.0.0.1');
  env.tick(1001);
  const ph = new SimPhone(env, 'Expired');
  const expired = await ph.call('/fp/pair', { pin: oldPin, name: 'Expired', phoneId: ph.id, phoneTime: ph.time(), protocol: 1 });
  assert.equal(expired.error, 'pin-expired');
  assert.notEqual(pinOf(env), oldPin);
  await env.close();
});

test('1E the PIN is good for one phone only', async () => {
  const env = await setup(); const pin = pinOf(env);
  const a = new SimPhone(env, 'A'); assert.ok((await a.pair(pin)).ok);
  assert.notEqual(pinOf(env), pin);
  const b = new SimPhone(env, 'B'); const r = await b.call('/fp/pair', { pin, name: 'B', phoneId: b.id, phoneTime: b.time(), protocol: 1 }); assert.equal(r.error, 'bad-pin');
  await env.close();
});

test('first full copy: everything arrives, totals agree, no tracking data', async () => {
  const env = await setup(); const ph = await paired(env, 'P');
  const r = await ph.fullCopy(); assert.ok(r.ok); assert.ok(r.totalsOk, JSON.stringify(r.diff));
  assert.equal(ph.get('rentals', 4).amount, 5000); assert.equal(ph.get('payments', 5).amount, 2000);
  assert.equal(env.sync.arrivals().length, 0, 'the first full copy gets no green dots');
  await env.close();
});

test('phone adds records: they reach the desktop SQLite, survive a close and reopen, and get green dots', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const rid = ph.add('rentals', { vehicleId: 2, clientId: 3, pickup: '2026-12-01', return: '2026-12-02', amount: 7000, status: 'Active' });
  const pid = ph.add('payments', { rentalId: rid, amount: 3000, date: '2026-12-01' });
  const before = env.calls.before;
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.commit.summary.added, 2); assert.ok(r.finish.totalsOk, JSON.stringify(r.finish.diff));
  assert.equal(env.calls.before, before + 1, 'the screen was asked to save first');
  assert.ok(env.calls.after[env.calls.after.length - 1].changed, 'and to reload after');
  const re = await reopen(env);                                          // "close the app and open it again"
  assert.equal(re.data.rentals.find(x => x.id === rid).amount, 7000);
  assert.equal(re.data.payments.find(x => x.id === pid).amount, 3000);
  assert.equal(re.syncRev >= 1, true);
  assert.deepEqual(env.sync.arrivals().map(a => a.list + a.id).sort(), ['payments' + pid, 'rentals' + rid].sort());
  assert.equal(core.totals(re.data).payments.sum, 5000);
  await env.close();
});

test('desktop edits and new records reach the phone, and nothing is sent twice', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const d = (await env.store.load('Main')).data; d.rentals[0].amount = 5500; d.vehicles.push({ id: 11, reg: 'KCC 003C' }); d.nextId = 12;
  await env.store.save('Main', d);
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ph.get('rentals', 4).amount, 5500); assert.equal(ph.get('vehicles', 11).reg, 'KCC 003C');
  assert.ok(r.finish.totalsOk);
  const again = await ph.sync(); assert.equal(again.pulled.length, 0, 'the second sync sends nothing');
  assert.equal(again.commit.summary.added + again.commit.summary.updated, 0);
  await env.close();
});

test('same record edited on both sides: newest wins, the other version is kept, and it can be switched', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  env.tick(60000);
  const d = (await env.store.load('Main')).data; d.rentals[0].amount = 8000; await env.store.save('Main', d);       // desktop edit
  env.tick(60000); ph.edit('rentals', 4, { amount: 9000 });                                                         // phone edit, later: wins
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ph.get('rentals', 4).amount, 9000);
  assert.equal((await reopen(env)).data.rentals[0].amount, 9000);
  const cf = review(env).find(x => x.kind === 'conflict'); assert.ok(cf); assert.equal(cf.payload.desktop.amount, 8000);
  // Restore: the owner switches to the other version; it travels to the phone
  const rr = await env.sync.resolve(cf.id, 'useOther'); assert.ok(rr.ok, JSON.stringify(rr));
  assert.equal((await reopen(env)).data.rentals[0].amount, 8000);
  await ph.sync(); assert.equal(ph.get('rentals', 4).amount, 8000);
  assert.ok(!review(env).some(x => x.kind === 'conflict'));
  await env.close();
});

test('a wrong clock on the older edit never wins: the desktop edit made later is kept when the phone clock runs behind but the owner says the desktop is right', async () => {
  const env = await setup(); const ph = await paired(env, 'P', { skew: -10 * 60 * 1000, choice: { reference: 'desktop' } });
  assert.equal(ph.pendingInfo, undefined);
  await ph.fullCopy(); env.tick(60000);
  ph.edit('rentals', 4, { amount: 1111 });                                        // phone stamped 10 min behind
  env.tick(1000); const d = (await env.store.load('Main')).data; d.rentals[0].amount = 2222; await env.store.save('Main', d);   // desktop is later in real time
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ph.get('rentals', 4).amount, 2222, 'with the offset corrected, the desktop edit is the newest');
  await env.close();
});

test('edit against delete: the delete stands, the edit is kept for review', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  env.tick(1000);
  const d = (await env.store.load('Main')).data; d.payments[0].amount = 2500; await env.store.save('Main', d);     // desktop edits the payment
  ph.remove('payments', 5);                                                                                          // phone deletes it
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  const re = await reopen(env); assert.equal(re.data.payments.length, 0, 'the delete stands');
  const it = review(env).find(x => x.kind === 'delete-edit'); assert.ok(it); assert.equal(it.payload.edited.amount, 2500);
  assert.ok(env.sync._state && true);
  await env.close();
});

test('a record deleted on purpose stays deleted; a phone edit of it only goes to review; Restore brings it back on both sides', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  let d = (await env.store.load('Main')).data; d.payments = []; await env.store.save('Main', d);                    // desktop deletes
  env.tick(1000); ph.edit('payments', 5, { amount: 2100 });
  let r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await reopen(env)).data.payments.length, 0, 'the sync did not bring it back');
  assert.ok(!ph.has('payments', 5), 'and the phone got the delete');
  const it = review(env).find(x => x.kind === 'delete-edit'); assert.ok(it);
  const res = await env.sync.resolve(it.id, 'restore'); assert.ok(res.ok, JSON.stringify(res));
  assert.equal((await reopen(env)).data.payments.length, 1);
  r = await ph.sync(); assert.ok(r.ok); assert.ok(ph.has('payments', 5), 'Restore reaches the phone');
  await env.close();
});

test('nothing is deleted by sync, even when a parent is deleted on the phone', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  ph.remove('vehicles', 1);                                                       // the phone deletes the vehicle only (its rental stays)
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  const re = await reopen(env);
  assert.equal(re.data.rentals.length, 1, 'the rental that pointed at the vehicle is still there');
  assert.ok(review(env).some(x => x.kind === 'broken-link'), 'and it is reported, never removed');
  await env.close();
});

test('broken links: a record with a missing vehicle is held aside, then applied when the vehicle arrives', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const vid = ph.add('vehicles', { reg: 'NEW 999' }); ph.records.vehicles.get(String(vid)).seq = ph.seq;          // phone vehicle + rental
  const rid = ph.add('rentals', { vehicleId: vid, clientId: 3, pickup: '2027-01-01', return: '2027-01-02', amount: 100, status: 'Active' });
  // the connection delivers only the rental in the first round: send it by itself
  const first = ph.localChanges().filter(c => c.list === 'rentals');
  const s1 = 'SHELD0001'; await ph.call('/fp/sync/begin', { session: s1, phoneTime: ph.time(), protocol: 1, instance: ph.instance, phoneSeq: ph.seq, ack: ph.ack });
  await ph.call('/fp/sync/push', { session: s1, batch: 1, changes: first });
  const c1 = await ph.call('/fp/sync/commit', { session: s1, batches: 1 }); assert.ok(c1.ok, JSON.stringify(c1));
  assert.equal(c1.summary.held, 1);
  assert.ok(!(await reopen(env)).data.rentals.some(x => x.id === rid), 'the rental is not in the ledger yet');
  const held = review(env).find(x => x.kind === 'held'); assert.ok(held);
  // next sync carries everything, the vehicle arrives and the held rental is applied
  const r = await ph.sync({ all: true }); assert.ok(r.ok, JSON.stringify(r));
  const re = await reopen(env); assert.ok(re.data.rentals.some(x => x.id === rid)); assert.ok(re.data.vehicles.some(x => x.id === vid));
  assert.ok(!review(env).some(x => x.kind === 'held'), 'the held item closed itself');
  await env.close();
});

test('the totals check reports a mismatch', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const session = 'STOT00001'; await ph.call('/fp/sync/begin', { session, phoneTime: ph.time(), protocol: 1, instance: ph.instance, phoneSeq: 0, ack: ph.ack });
  const c = await ph.call('/fp/sync/commit', { session, batches: 0 });
  const bad = ph.totals(); bad.payments.sum += 1;
  const f = await ph.call('/fp/sync/finish', { session, ack: c.pullUpTo, totals: bad });
  assert.equal(f.totalsOk, false); assert.equal(f.diff[0].list, 'payments');
  await env.close();
});

test('double bookings and duplicate entries are reported, nothing is cancelled or removed', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  ph.add('rentals', { vehicleId: 1, clientId: 3, pickup: '2026-11-02', return: '2026-11-04', amount: 100, status: 'Active' });   // overlaps rental 4 on car 1
  ph.add('payments', { rentalId: 4, amount: 2000, date: '2026-11-02' });                                                          // same as payment 5
  const r = await ph.sync(); assert.ok(r.ok, JSON.stringify(r));
  const kinds = review(env).map(x => x.kind);
  assert.ok(kinds.includes('overlap')); assert.ok(kinds.includes('duplicate'));
  const re = await reopen(env); assert.equal(re.data.rentals.length, 2); assert.equal(re.data.payments.length, 2);
  await env.close();
});

test('the clock: a big difference asks the owner first; sync is not blocked by a choice, and a choice is remembered', async () => {
  const env = await setup(); const ph = await paired(env, 'P', { skew: 10 * 60 * 1000, choice: { reference: 'phone' } });
  const dev = env.sync.status().devices[0]; assert.equal(dev.reference, 'phone');
  await ph.fullCopy();
  const ok = await ph.sync(); assert.ok(ok.ok, 'the same clocks as at pairing: no new question');
  ph.skew = -30 * 60 * 1000;                                                       // the phone clock jumps
  const b = await ph.sync(); assert.equal(b.error, 'clock-pending');
  assert.equal(env.sync.status().clockPending.length, 1);
  assert.ok((await env.sync.setClock(ph.id, 'desktop')).ok);
  assert.ok((await ph.sync()).ok);
  await env.close();
});

test('pairing with very different clocks needs the owner to say which one is right', async () => {
  const env = await setup(); const ph = new SimPhone(env, 'P', { skew: 3600 * 1000 });
  const r = await ph.call('/fp/pair', { pin: pinOf(env), name: 'P', phoneId: ph.id, phoneTime: ph.time(), protocol: 1 });
  const need = await env.sync.approve(r.pairingId); assert.equal(need.needClock, true);
  const yes = await env.sync.approve(r.pairingId, { reference: 'phone' }); assert.ok(yes.ok);
  await env.close();
});

test('version check: an older or newer app is told to update', async () => {
  const env = await setup(); const ph = new SimPhone(env, 'P', { protocol: 99 });
  const r = await ph.call('/fp/pair', { pin: pinOf(env), name: 'x', phoneId: ph.id, phoneTime: ph.time(), protocol: 99 }); assert.equal(r.error, 'update-desktop');
  const old = await ph.call('/fp/pair', { pin: pinOf(env), name: 'x', phoneId: ph.id, phoneTime: ph.time(), protocol: 0 }); assert.equal(old.error, 'update-app');
  await env.close();
});

test('resumable: a dropped batch is asked for again and nothing is applied twice', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  for(let i = 0; i < 4; i++) ph.add('expenses', { amount: 10 + i, date: '2026-11-0' + (i + 1), category: 'Fuel', vehicleId: 1 });
  const session = 'SRESUME01';
  const a = await ph.sync({ session, dropBatch: 2, batchSize: 1 }); assert.equal(a.error, 'missing-batch'); assert.equal(a.missing, 2);
  assert.equal((await reopen(env)).data.expenses.length, 0, 'nothing was applied');
  const b = await ph.sync({ session, batchSize: 1 }); assert.ok(b.ok, JSON.stringify(b));      // the same session: batches already received are not sent again
  assert.equal((await reopen(env)).data.expenses.length, 4);
  const c = await ph.sync({ batchSize: 1, resend: true, all: true }); assert.ok(c.ok);        // sending everything again changes nothing
  assert.equal((await reopen(env)).data.expenses.length, 4);
  await env.close();
});

test('a phone restored from an old backup is detected and caught up safely', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  ph.add('expenses', { amount: 1, date: '2026-11-01', category: 'Fuel', vehicleId: 1 }); await ph.sync();
  ph.add('expenses', { amount: 2, date: '2026-11-02', category: 'Fuel', vehicleId: 1 }); await ph.sync();
  const begin = await ph.call('/fp/sync/begin', { session: 'SOLD00001', phoneTime: ph.time(), protocol: 1, instance: ph.instance, phoneSeq: 0, ack: ph.ack });   // its change counter went back in time
  assert.equal(begin.catchup, true); assert.equal(begin.restoredPhone, true);
  const r = await ph.sync({ mode: 'catchup', all: true }); assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await reopen(env)).data.expenses.length, 2, 'catching up changes nothing that was already there');
  await env.close();
});

test('phone backup goes to the safety copies folder and never over the live database', async () => {
  const env = await setup(); const ph = await paired(env, 'My Phone');
  const live = fs.readFileSync(env.store.sync.fileFor('Main'));
  const r = await fetch(env.url + '/fp/backup', { method: 'POST', headers: { 'x-fp-device': ph.id, 'x-fp-token': ph.token, 'x-fp-name': 'My Phone' }, body: JSON.stringify({ records: 3 }) });
  const j = await r.json(); assert.ok(j.ok, JSON.stringify(j));
  assert.ok(fs.existsSync(path.join(env.store.dirs.copies, j.file)));
  assert.ok(Buffer.compare(live, fs.readFileSync(env.store.sync.fileFor('Main'))) === 0);
  await env.close();
});

test('unauthenticated phone backup is rejected before receiving its payload', async () => {
  const env = await setup();
  const r = await fetch(env.url + '/fp/backup', {
    method: 'POST',
    headers: { 'x-fp-name': 'Unauthenticated' },
    body: JSON.stringify({ shouldNotBeStored: true })
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'not-paired');
  await env.close();
});

test('the connection stays on for the whole app; opening the window again changes nothing', async () => {
  const env = await setup(); const pin = pinOf(env);
  assert.equal((await fetch(env.url + '/fp/hello')).status, 200);
  const again = await env.sync.ensure('Main'); assert.ok(again.ok && again.already, 'ensure on a running server does nothing');
  assert.equal(pinOf(env), pin, 'the PIN is not changed by opening the window');
  assert.equal((await fetch(env.url + '/fp/hello')).status, 200);
  const np = env.sync.refreshPin(); assert.ok(np.ok); assert.notEqual(pinOf(env), pin, 'New PIN gives a new one');
  await env.sync.stop();
  await assert.rejects(() => fetch(env.url + '/fp/hello'), 'it stops only when the app stops');
  store_close(env);
});

test('the status bar: ready, then green connected while a phone talks, then back to ready; waiting questions show', async () => {
  const env = await setup({ connectMs: 45000 });
  let b = env.sync.barStatus();
  assert.equal(b.running, true); assert.equal(b.connected.length, 0); assert.equal(b.paired, 0); assert.equal(b.waiting, 0);
  const ph = new SimPhone(env, 'Veronica phone');
  const r = await ph.call('/fp/pair', { pin: pinOf(env), name: ph.name, phoneId: ph.id, phoneTime: ph.time(), protocol: 1 });
  assert.equal(env.sync.barStatus().waiting, 1, 'a phone that wants to connect shows as waiting for the owner');
  assert.equal(env.sync.barStatus().connected.length, 0, 'not connected until approved');
  await env.sync.approve(r.pairingId);
  const s = await ph.call('/fp/pair/status?id=' + r.pairingId, null, 'GET'); ph.token = s.token;
  assert.equal(env.sync.barStatus().waiting, 0);
  const pong = await ph.call('/fp/ping', {}); assert.ok(pong.ok);
  b = env.sync.barStatus(); assert.equal(b.connected.length, 1); assert.equal(b.connected[0].name, 'Veronica phone'); assert.equal(b.paired, 1);
  env.tick(30000); assert.equal(env.sync.barStatus().connected.length, 1, 'still connected 30 seconds after the last word');
  env.tick(20000); assert.equal(env.sync.barStatus().connected.length, 0, 'not connected 50 seconds after the last word');
  await ph.call('/fp/ping', {}); assert.equal(env.sync.barStatus().connected.length, 1, 'a ping brings it back');
  const stranger = new SimPhone(env, 'Stranger'); assert.equal((await stranger.call('/fp/ping', {})).error, 'not-paired');
  assert.equal(env.sync.barStatus().connected.length, 1, 'an unpaired phone never counts as connected');
  await env.close();
});

test('a sync shows as syncing on the bar while it runs and the phone is heard', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  ph.add('expenses', { amount: 5, date: '2026-11-01', category: 'Fuel', vehicleId: 1 });
  const begin = await ph.call('/fp/sync/begin', { session: 'S' + 'x'.repeat(10), phoneTime: ph.time(), appVersion: 'sim', protocol: 1, instance: ph.instance, phoneSeq: ph.seq, ack: ph.ack });
  assert.ok(begin.ok, JSON.stringify(begin));
  assert.equal(env.sync.barStatus().syncing, true);
  env.tick(25000); assert.equal(env.sync.barStatus().syncing, false, 'a sync the phone walked away from does not stay "syncing" forever');
  await env.close();
});
function store_close(env){ env.store.closeAll(); }

test('a page that loaded before a sync is told to reload instead of saving over it', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const loaded = await env.store.load('Main');
  ph.add('expenses', { amount: 5, date: '2026-11-01', category: 'Fuel', vehicleId: 1 }); await ph.sync();
  const r = await env.store.save('Main', loaded.data, loaded.syncRev);
  assert.equal(r.ok, false); assert.equal(r.stale, true);
  const fresh = await env.store.load('Main'); assert.equal(fresh.data.expenses.length, 1);
  assert.ok((await env.store.save('Main', fresh.data, fresh.syncRev)).ok);
  await env.close();
});

test('two sync batches arriving while a save is in progress: every write waits its turn', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const d = (await env.store.load('Main')).data;
  ph.add('expenses', { amount: 7, date: '2026-11-01', category: 'Fuel', vehicleId: 1 });
  const sess = 'SBUSY0001';
  await ph.call('/fp/sync/begin', { session: sess, phoneTime: ph.time(), protocol: 1, instance: ph.instance, phoneSeq: ph.seq, ack: ph.ack });
  const ch = ph.localChanges();
  const results = await Promise.all([
    env.store.save('Main', d),
    ph.call('/fp/sync/push', { session: sess, batch: 1, changes: ch }),
    ph.call('/fp/sync/push', { session: sess, batch: 2, changes: [] }),
    env.store.save('Main', d)
  ]);
  results.forEach(r => assert.ok(r.ok, JSON.stringify(r)));
  const c = await ph.call('/fp/sync/commit', { session: sess, batches: 2 }); assert.ok(c.ok, JSON.stringify(c));
  assert.equal((await reopen(env)).data.expenses.length, 1);
  await env.close();
});

test('cutting a write in the middle leaves the old data whole', async () => {
  const env = await setup(); const seqBefore = trackRow(env, 'rentals', 4).seq;
  const d = (await env.store.load('Main')).data; d.rentals[0].amount = 1; d.bad = { toJSON(){ throw new Error('power cut'); } };
  const r = await env.store.save('Main', d); assert.equal(r.ok, false);
  const re = await reopen(env); assert.equal(re.data.rentals[0].amount, 5000);
  assert.equal(trackRow(env, 'rentals', 4).seq, seqBefore, 'the tracking was rolled back with it');
  await env.close();
});

test('a locked file: the save waits, fails with a plain message, and works once released', async () => {
  const env = await setup({ busyTimeout: 200 });
  const { DatabaseSync } = require('node:sqlite');
  const d = (await env.store.load('Main')).data;
  const other = new DatabaseSync(env.store.sync.fileFor('Main')); other.exec('BEGIN EXCLUSIVE');
  const r = await env.store.save('Main', d); assert.equal(r.ok, false); assert.match(r.error, /not letting FleetPilot write|locked|busy/i);
  other.exec('ROLLBACK'); other.close();
  assert.ok((await env.store.save('Main', d)).ok);
  await env.close();
});

test('a damaged file is set aside and never overwritten', async () => {
  const env = await setup(); env.store.closeAll();
  const f = env.store.sync.fileFor('Main'); fs.writeFileSync(f, Buffer.alloc(4096, 7));
  const r = await env.store.load('Main'); assert.equal(r.reason, 'damaged');
  assert.ok(fs.readdirSync(env.store.dirs.damaged).length >= 1);
  await env.sync.stop();
});

test('a full disk is reported and the sync does not start', async () => {
  const env = await setup({}); const ph = await paired(env, 'P'); await ph.fullCopy();
  env.store.diskFree = () => 1000;                                                // pretend almost nothing is free
  const session = 'SDISK0001'; await ph.call('/fp/sync/begin', { session, phoneTime: ph.time(), protocol: 1, instance: ph.instance, phoneSeq: 0, ack: ph.ack });
  const c = await ph.call('/fp/sync/commit', { session, batches: 0 });
  assert.equal(c.error, 'low-disk'); assert.match(c.message, /disk space/);
  await env.close();
});

test('identity: the desktop keeps one permanent device id', async () => {
  const env = await setup(); const id = env.store.deviceId; await env.close();
  const again = createStore({ root: env.root }); assert.equal(again.deviceId, id); again.closeAll();
});

test('a saved screen is read back and compared (a mismatch is a failed save)', async () => {
  const env = await setup();
  const d = (await env.store.load('Main')).data;
  const res = await env.store.save('Main', d); assert.ok(res.ok);
  assert.equal(env.store.sync.readBackMismatch('Main', d), '');
  d.rentals[0].amount = 123;
  assert.equal(env.store.sync.readBackMismatch('Main', d), 'rentals', 'data that was not written is caught');
  await env.close();
});

test('a held record is fixed with Edit: it is added, gets a green dot, and the fix reaches the phone', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.fullCopy();
  const rid = ph.add('rentals', { vehicleId: 777, clientId: 3, pickup: '2027-05-01', return: '2027-05-02', amount: 100, status: 'Active' });
  const r = await ph.sync(); assert.ok(r.ok); assert.equal(r.commit.summary.held, 1);
  const held = review(env).find(x => x.kind === 'held');
  const bad = await env.sync.resolve(held.id, 'edit', { data: Object.assign({}, held.payload.change.data) }); assert.equal(bad.ok, false, 'it cannot be added while the link is still missing');
  const fixed = await env.sync.resolve(held.id, 'edit', { data: Object.assign({}, held.payload.change.data, { vehicleId: 2 }) }); assert.ok(fixed.ok, JSON.stringify(fixed));
  assert.equal((await reopen(env)).data.rentals.find(x => x.id === rid).vehicleId, 2);
  assert.ok(!review(env).some(x => x.kind === 'held'));
  assert.ok(env.sync.arrivals().some(a => a.list === 'rentals' && String(a.id) === String(rid)), 'it shows a green dot');
  await ph.sync(); assert.equal(ph.get('rentals', rid).vehicleId, 2, 'the phone gets the fixed version');
  await env.close();
});

test('the phone can find the computer again by a broadcast (the address changed)', async () => {
  const dgram = require('dgram'); const { createSync } = require('../../electron/phone-sync/syncServer.cjs');
  const env = await setup(); await env.sync.stop();
  const port = 47000 + Math.floor(Math.random() * 500);
  const s2 = createSync({ store: env.store, port: 0, discoveryPort: port, hooks: {} }); await s2.start('Main');
  const reply = await new Promise((resolve, reject) => {
    const u = dgram.createSocket('udp4'); const t = setTimeout(() => { u.close(); reject(new Error('no answer')); }, 3000);
    u.on('message', m => { clearTimeout(t); u.close(); resolve(JSON.parse(String(m))); });
    u.send(Buffer.from('FPDISCOVER ' + env.store.deviceId), port, '127.0.0.1');
  });
  assert.equal(reply.d, env.store.deviceId); assert.ok(Array.isArray(reply.a));
  const wrong = await new Promise(resolve => { const u = dgram.createSocket('udp4'); const t = setTimeout(() => { u.close(); resolve('silent'); }, 700); u.on('message', () => { clearTimeout(t); u.close(); resolve('answered'); }); u.send(Buffer.from('FPDISCOVER D-someone-else'), port, '127.0.0.1'); });
  assert.equal(wrong, 'silent', 'another computer is not answered');
  await s2.stop(); env.store.closeAll();
});

test('Disconnect: the connection stops on request, the bar says off, and starting again works with the same database', async () => {
  const env = await setup(); const ph = await paired(env, 'P'); await ph.call('/fp/ping', {});
  assert.equal(env.sync.barStatus().connected.length, 1);
  await env.sync.stop();
  const b = env.sync.barStatus(); assert.equal(b.running, false); assert.equal(b.connected.length, 0);
  await assert.rejects(() => fetch(env.url + '/fp/hello'));
  const r = await env.sync.start('Main'); assert.ok(r.ok);
  assert.equal(env.sync.barStatus().paired, 1, 'the paired phone is still paired after disconnecting and connecting again');
  await env.close();
});

const DAY = 24 * 3600 * 1000;
test('developer backup: a .db and a .json side by side, refreshed in place every 14 days, never more files', async () => {
  const env = await setup(); const { DatabaseSync } = require('node:sqlite');
  const dev = createDevBackup({ store: env.store, now: () => new Date(env.now()) });
  const f = dev.files('Main');
  assert.equal(dev.due('Main'), true);
  const r1 = await dev.run('Main'); assert.ok(r1.ok, JSON.stringify(r1));
  assert.ok(fs.existsSync(f.db) && fs.existsSync(f.json));
  const j1 = JSON.parse(fs.readFileSync(f.json, 'utf8')); assert.equal(j1.kind, 'developer-backup'); assert.ok(Array.isArray(j1.data.vehicles));
  const q = new DatabaseSync(f.db, { readOnly: true }); assert.equal(q.prepare('SELECT COUNT(*) n FROM records').get().n, env.store.sync.conn('Main').prepare('SELECT COUNT(*) n FROM records').get().n); assert.equal(Object.values(q.prepare('PRAGMA quick_check').get())[0], 'ok'); q.close();
  const d = (await env.store.load('Main')).data; d.clients.push({ id: 90, name: 'NEW CLIENT' }); assert.ok((await env.store.save('Main', d, (await env.store.load('Main')).syncRev)).ok);
  env.tick(13 * DAY); assert.equal(dev.due('Main'), false, 'not yet after 13 days'); assert.deepEqual(await dev.run('Main'), { skipped: true });
  assert.equal(JSON.parse(fs.readFileSync(f.json, 'utf8')).data.clients.some(c => c.id === 90), false, 'unchanged until it is due');
  env.tick(2 * DAY); assert.equal(dev.due('Main'), true);
  assert.ok((await dev.run('Main')).ok);
  assert.ok(JSON.parse(fs.readFileSync(f.json, 'utf8')).data.clients.some(c => c.id === 90), 'the same file now holds the newer data');
  assert.deepEqual(fs.readdirSync(dev.dir).sort(), ['Main - developer.db', 'Main - developer.json', 'backup-log.txt'], 'still only the two files and a log');
  assert.ok(!fs.readdirSync(env.store.dirs.copies).some(x => /developer/.test(x)), 'nothing in the safety copies list');
  await env.close();
});

test('developer backup: if a refresh fails the older backup stays exactly as it was', async () => {
  const env = await setup(); const dev = createDevBackup({ store: env.store, now: () => new Date(env.now()) }); const f = dev.files('Main');
  assert.ok((await dev.run('Main')).ok);
  const before = [fs.readFileSync(f.db), fs.readFileSync(f.json)];
  env.tick(15 * DAY); fs.mkdirSync(f.json + '.new');                                   // a folder where the temporary file must go: the write cannot work
  const r = await dev.run('Main'); assert.equal(r.ok, false);
  assert.ok(Buffer.compare(before[0], fs.readFileSync(f.db)) === 0 && Buffer.compare(before[1], fs.readFileSync(f.json)) === 0, 'old .db and .json untouched');
  assert.match(fs.readFileSync(path.join(dev.dir, 'backup-log.txt'), 'utf8'), /FAILED/);
  fs.rmdirSync(f.json + '.new'); assert.ok((await dev.run('Main')).ok, 'works again once the problem is gone');
  await env.close();
});

test('developer backup: a missing file is made again at once, even before 14 days', async () => {
  const env = await setup(); const dev = createDevBackup({ store: env.store, now: () => new Date(env.now()) }); const f = dev.files('Main');
  assert.ok((await dev.run('Main')).ok); fs.unlinkSync(f.json);
  assert.equal(dev.due('Main'), true); assert.ok((await dev.run('Main')).ok); assert.ok(fs.existsSync(f.json));
  await env.close();
});
