/* FleetPilot phone sync: the merge. Pure functions on plain objects, so tests and the phone app can run the same rules.
   The rules (all agreed in the build plan):
     - Nothing is removed by sync on its own. A record you deleted on purpose stays deleted; it is never brought back by a sync.
     - Same record edited on both sides: the newest edit wins, the other version is kept in the review list.
     - Edit against delete: the delete stands, the edit is kept in the review list (with a Restore).
     - A record whose vehicle, client, driver or rental is missing is HELD ASIDE, shown in the review list, and tried again next sync.
     - After a merge: overlapping bookings, duplicate entries and broken links are only REPORTED; nothing is cancelled, merged or removed. */
'use strict';
const { LIST_KEYS, key, canon, SEP } = require('./syncDb.cjs');

/* parents first: a rental needs its vehicle and client, a payment needs its rental ... */
const ORDER = ['vehicles', 'clients', 'drivers', 'invoices', 'rentals', 'bookings', 'coops', 'expenses', 'payments', 'insurance', 'driverAllowances', 'accounts', 'loans', 'fuelAccount', 'individuals', 'chama'];
/* list -> [field, parent list]; every non-empty link must point at a record that exists */
const LINKS = {
  rentals: [['vehicleId', 'vehicles'], ['clientId', 'clients'], ['driverId', 'drivers']],
  bookings: [['vehicleId', 'vehicles'], ['clientId', 'clients']],
  insurance: [['vehicleId', 'vehicles']],
  expenses: [['vehicleId', 'vehicles'], ['rentalId', 'rentals']],
  payments: [['rentalId', 'rentals']],
  drivers: [['vehicleId', 'vehicles']],
  invoices: [['clientId', 'clients']],
  coops: [['clientId', 'clients'], ['rentalId', 'rentals']],
  driverAllowances: [['driverId', 'drivers']]
};
const REQUIRED = { rentals: ['vehicleId', 'clientId'], bookings: ['vehicleId', 'clientId'], insurance: ['vehicleId'], driverAllowances: ['driverId'] };
const empty = v => v == null || v === '';
const num = v => Number(v) || 0;
const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/* ---------- ids: each device has its own range ---------- */
const DESKTOP_MAX = 999999999;               // the desktop keeps 1 .. 999,999,999
const RANGE_SIZE = 1000000000;               // phone number k gets k*1e9 .. k*1e9 + 999,999,999
const phoneRange = index => ({ start: index * RANGE_SIZE, end: index * RANGE_SIZE + DESKTOP_MAX });
/* the highest id the desktop itself handed out: ids in a phone's range are ignored (this is the fix for the two places that used to look at every id) */
function topDesktopId(data){
  let top = 0;
  LIST_KEYS.forEach(k => (Array.isArray(data[k]) ? data[k] : []).forEach(r => { const n = Number(r && r.id); if(Number.isFinite(n) && n <= DESKTOP_MAX && n > top) top = n; }));
  return top;
}

/* ---------- links ---------- */
function missingLinks(data, list, rec, extraGone){
  const out = [], ids = {};
  (LINKS[list] || []).forEach(([field, parent]) => {
    const v = rec[field];
    if(empty(v)) return;                                       // an empty link is allowed here (the existing screens decide)
    if(!ids[parent]) ids[parent] = new Set((data[parent] || []).map(r => String(r.id)));
    if(!ids[parent].has(String(v)) || (extraGone && extraGone.has(key(parent, v)))) out.push({ field, parent, value: v });
  });
  return out;
}
/* every record in the data that points at something that is not there (reported, never removed) */
function findBroken(data){
  const out = [];
  Object.keys(LINKS).forEach(list => (data[list] || []).forEach(r => {
    const m = missingLinks(data, list, r);
    const req = (REQUIRED[list] || []).filter(f => empty(r[f]));
    if(m.length || req.length) out.push({ list, id: r.id, missing: m, empty: req });
  }));
  return out;
}

/* ---------- totals (counts and money, compared after every sync) ---------- */
const round2 = n => Math.round(n * 100) / 100;
function totals(data, skip){
  const t = {};
  LIST_KEYS.forEach(list => {
    let n = 0, sum = 0;
    (Array.isArray(data[list]) ? data[list] : []).forEach(r => { if(!r || r.id == null) return; if(skip && skip.has(key(list, r.id))) return; n++; sum += num(r.amount); });
    t[list] = { n, sum: round2(sum) };
  });
  return t;
}
function totalsDiff(a, b){
  const bad = [];
  LIST_KEYS.forEach(l => { const x = a[l] || { n: 0, sum: 0 }, y = b[l] || { n: 0, sum: 0 }; if(x.n !== y.n || Math.abs(x.sum - y.sum) > 0.005) bad.push({ list: l, a: x, b: y }); });
  return bad;
}

/* ---------- checks that only report ---------- */
const overlap = (aS, aE, bS, bE) => aS <= bE && aE >= bS;               // same rule as the entry check in ledger.js
function overlapReports(data, touched){
  const out = [], seen = new Set();
  const all = [];
  ['bookings', 'rentals'].forEach(l => (data[l] || []).forEach(r => { if(r.status !== 'Cancelled' && !empty(r.vehicleId) && r.pickup && r.return) all.push({ list: l, rec: r }); }));
  all.forEach(a => {
    if(!touched.has(key(a.list, a.rec.id))) return;
    all.forEach(b => {
      if(a === b || String(a.rec.vehicleId) !== String(b.rec.vehicleId)) return;
      if(!overlap(a.rec.pickup, a.rec.return, b.rec.pickup, b.rec.return)) return;
      const ka = key(a.list, a.rec.id), kb = key(b.list, b.rec.id), rk = 'overlap:' + [ka, kb].sort().join('|');
      if(seen.has(rk)) return; seen.add(rk);
      const car = (data.vehicles || []).find(v => String(v.id) === String(a.rec.vehicleId));
      const one = x => (x.list === 'bookings' ? 'Booking' : 'Rental') + ' ' + x.rec.pickup + ' to ' + x.rec.return;
      out.push({ kind: 'overlap', rkey: rk, list: a.list, rec_id: a.rec.id, title: 'Double booking' + (car ? ' on ' + (car.reg || car.plate || car.name || car.id) : '') + ': ' + one(a) + ' and ' + one(b),
        payload: { a: { list: a.list, id: a.rec.id }, b: { list: b.list, id: b.rec.id } } });
    });
  });
  return out;
}
/* the same rules as the "this looks like one already recorded" check on Payments, run over what just arrived */
function duplicateReports(data, touched){
  const out = [];
  const add = (list, a, b, what) => { const rk = 'duplicate:' + list + ':' + [String(a.id), String(b.id)].sort().join('|');
    out.push({ kind: 'duplicate', rkey: rk, list, rec_id: a.id, title: 'Possible duplicate ' + what + ' (' + (a.date || a.paidDate || '') + ', ' + num(a.amount) + ')', payload: { a: { list, id: a.id }, b: { list, id: b.id } } }); };
  const rules = {
    expenses: (a, b) => num(a.amount) > 0 && a.category === b.category && num(a.amount) === num(b.amount) && a.date === b.date && String(a.vehicleId || '') === String(b.vehicleId || ''),
    fuelAccount: (a, b) => a.kind !== 'opening' && b.kind !== 'opening' && num(a.amount) > 0 && num(a.amount) === num(b.amount) && a.date === b.date,
    payments: (a, b) => num(a.amount) > 0 && String(a.rentalId || '') === String(b.rentalId || '') && num(a.amount) === num(b.amount) && a.date === b.date,
    insurance: (a, b) => num(a.amount) > 0 && String(a.vehicleId) === String(b.vehicleId) && num(a.amount) === num(b.amount) && a.paidDate === b.paidDate && !!a.paidDate
  };
  const what = { expenses: 'expense', fuelAccount: 'fuel entry', payments: 'payment', insurance: 'insurance payment' };
  Object.keys(rules).forEach(list => {
    const arr = data[list] || [];
    arr.forEach(a => { if(!touched.has(key(list, a.id))) return; arr.forEach(b => { if(a !== b && String(a.id) !== String(b.id) && rules[list](a, b)) add(list, a, b, what[list]); }); });
  });
  /* automatic records that must exist once per rental */
  [['coops', () => true, 'Coop line'], ['expenses', r => r.source === 'rental', 'Rental expense']].forEach(([list, test, label]) => {
    const g = new Map();
    (data[list] || []).forEach(r => { if(!empty(r.rentalId) && test(r)) { const k = String(r.rentalId); (g.get(k) || g.set(k, []).get(k)).push(r); } });
    g.forEach((rows, rid) => { if(rows.length > 1) out.push({ kind: 'duplicate', rkey: 'auto:' + list + ':' + rid, list, rec_id: rows[0].id, title: label + ' made more than once for one rental (' + rows.length + ' lines)',
      payload: { auto: true, items: rows.map(r => ({ list, id: r.id })) } }); });
  });
  return out;
}

/* ---------- the merge ---------- */
/* a.data: the ledger (changed in place). a.track / a.tombs: from syncDb. a.changes: [{list,id,deleted,at,dev,data,restore}]
   a.dev: { id, last_ack, offset_ms, reference }   offset_ms = phone clock minus desktop clock; reference = whose clock is right */
function merge(a){
  const data = a.data, track = a.track, tombs = a.tombs, dev = a.dev;
  const off = Number(dev.offset_ms) || 0;
  const adjLocal = at => ms(at) + (dev.reference === 'phone' ? off : 0);        // phone is right: the desktop clock is behind by off
  const adjRemote = at => ms(at) - (dev.reference === 'desktop' ? off : 0);     // desktop is right: the phone clock is off by off
  const result = { applied: new Map(), touched: new Set(), review: [], held: [], extraTombs: [], counts: { added: 0, updated: 0, deleted: 0, ignored: 0 }, resolved: [] };
  LIST_KEYS.forEach(k => { if(!Array.isArray(data[k])) data[k] = []; });
  const find = (list, id) => data[list].find(r => String(r.id) === String(id));
  const localStamp = k => { const t = track.get(k); return t ? { at: t.changed_at, dev: t.device, seq: t.seq, deleted: !!t.deleted } : null; };
  /* newer = later corrected time; a tie goes to the larger device id so both sides always pick the same one */
  const remoteWins = (c, lt) => { const x = adjRemote(c.at), y = adjLocal(lt.at); return x !== y ? x > y : String(c.dev) > String(lt.dev); };
  const title = (c, what) => what + ' ' + c.list.replace(/s$/, '') + ' ' + c.id;

  const changes = (a.changes || []).filter(c => c && LIST_KEYS.includes(c.list) && c.id != null && (c.deleted || (c.data && typeof c.data === 'object')));
  result.counts.ignored = (a.changes || []).length - changes.length;
  const byOrder = (x, y) => ORDER.indexOf(x.list) - ORDER.indexOf(y.list) || ms(x.at) - ms(y.at);
  const deletes = changes.filter(c => c.deleted).sort((x, y) => byOrder(y, x));        // children before parents
  const upserts = changes.filter(c => !c.deleted).sort(byOrder);                       // parents before children
  const undo = [];                                                                     // how to put back each applied record if it has to be held

  /* 1. deletes: a delete stands; an edit made meanwhile on this side is kept for review */
  deletes.forEach(c => {
    const k = key(c.list, c.id), rec = find(c.list, c.id), lt = localStamp(k);
    if(rec){
      const concurrent = lt && lt.seq > dev.last_ack;
      if(concurrent) result.review.push({ kind: 'delete-edit', rkey: 'de:' + k, list: c.list, rec_id: c.id, title: 'Deleted on the phone but edited here: ' + title(c, ''),
        payload: { list: c.list, id: c.id, edited: JSON.parse(JSON.stringify(rec)), editedOn: 'desktop' } });
      data[c.list] = data[c.list].filter(r => r !== rec);
      result.applied.set(k, { at: c.at, dev: c.dev, arrivedFrom: dev.id, deleted: true }); result.counts.deleted++;
    }else if(!(lt && lt.deleted) && !tombs.has(k)){
      result.extraTombs.push({ list: c.list, id: c.id, at: c.at, dev: c.dev, arrivedFrom: dev.id, data: null });
    }
  });

  /* 2. new and edited records */
  upserts.forEach(c => {
    const k = key(c.list, c.id), rec = find(c.list, c.id), lt = localStamp(k), tomb = tombs.get(k);
    const wasDeleted = !rec && ((lt && lt.deleted) || tomb);
    if(wasDeleted){
      const delAt = (tomb && tomb.deleted_at) || (lt && lt.at) || '';
      if(c.restore && adjRemote(c.at) > adjLocal(delAt)){           // the owner chose Restore: an explicit, newer decision
        data[c.list].push(JSON.parse(JSON.stringify(c.data))); undo.push({ k, list: c.list, id: c.id, prev: null });
        result.applied.set(k, { at: c.at, dev: c.dev, arrivedFrom: dev.id }); result.counts.added++;
      }else{
        result.review.push({ kind: 'delete-edit', rkey: 'de:' + k, list: c.list, rec_id: c.id, title: 'Deleted here but edited on the phone: ' + title(c, ''),
          payload: { list: c.list, id: c.id, edited: c.data, editedOn: 'phone' } });
      }
      return;
    }
    if(!rec){
      data[c.list].push(JSON.parse(JSON.stringify(c.data))); undo.push({ k, list: c.list, id: c.id, prev: null });
      result.applied.set(k, { at: c.at, dev: c.dev, arrivedFrom: dev.id }); result.counts.added++; return;
    }
    if(canon(rec) === canon(c.data)) return;                          // already the same
    const concurrent = lt && (lt.seq > dev.last_ack || adjRemote(c.at) < adjLocal(lt.at));
    if(concurrent){
      const rw = remoteWins(c, lt);
      result.review.push({ kind: 'conflict', rkey: 'cf:' + k, list: c.list, rec_id: c.id, title: 'Edited on both sides: ' + title(c, ''),
        payload: { list: c.list, id: c.id, keptSide: rw ? 'phone' : 'desktop', desktop: JSON.parse(JSON.stringify(rec)), phone: c.data, desktopAt: lt.at, phoneAt: c.at } });
      if(!rw) return;
    }
    const idx = data[c.list].indexOf(rec);
    undo.push({ k, list: c.list, id: c.id, prev: JSON.parse(JSON.stringify(rec)) });
    data[c.list][idx] = JSON.parse(JSON.stringify(c.data));
    result.applied.set(k, { at: c.at, dev: c.dev, arrivedFrom: dev.id }); result.counts.updated++;
  });

  /* 3. link check on the finished picture. A record whose link is missing is put back as it was and held aside; this can chain (a held vehicle holds its rentals) */
  const heldKeys = new Set();
  const byKey = new Map(upserts.map(c => [key(c.list, c.id), c]));
  for(let guard = 0; guard < 50; guard++){
    let moved = false;
    undo.slice().forEach(u => {
      if(heldKeys.has(u.k) || !result.applied.has(u.k)) return;
      const rec = find(u.list, u.id); if(!rec) return;
      const m = missingLinks(data, u.list, rec);
      const req = (REQUIRED[u.list] || []).filter(f => empty(rec[f]));
      if(!m.length && !req.length) return;
      data[u.list] = data[u.list].filter(r => r !== rec); if(u.prev) data[u.list].push(u.prev);
      result.applied.delete(u.k); heldKeys.add(u.k); moved = true;
      if(u.prev) result.counts.updated--; else result.counts.added--;
      result.held.push({ change: byKey.get(u.k), missing: m.concat(req.map(f => ({ field: f, parent: '', value: '' }))) });
    });
    if(!moved) break;
  }
  heldKeys.forEach(k => { const c = byKey.get(k), h = result.held.find(x => x.change === c); const m = h ? h.missing : [];
    result.review.push({ kind: 'held', rkey: 'held:' + k, list: c.list, rec_id: c.id, title: 'Held aside (' + (m.map(x => (x.parent ? x.parent.replace(/s$/, '') + ' ' + x.value : x.field + ' is empty') + ' is missing').join(', ') || 'a link is missing') + '): ' + title(c, ''),
      payload: { change: c, missing: m } }); });

  /* 4. what to look at afterwards: only reports */
  result.applied.forEach((s, k) => { if(!s.deleted) result.touched.add(k); });
  result.broken = findBroken(data);
  /* a very large import could list thousands of look-alikes; the first 200 of each kind are listed and one line says how many more there are */
  const capped = (list, kind, label) => { if(list.length <= 200) return list; return list.slice(0, 200).concat([{ kind, rkey: kind + ':more', title: (list.length - 200) + ' more ' + label + ' were found and are not listed here. Fix the ones listed, then sync again.', payload: { auto: true } }]); };
  result.review.push(...capped(overlapReports(data, result.touched), 'overlap', 'double bookings'), ...capped(duplicateReports(data, result.touched), 'duplicate', 'possible duplicates'));
  result.heldKeys = heldKeys;
  return result;
}

module.exports = { ORDER, LINKS, REQUIRED, DESKTOP_MAX, RANGE_SIZE, phoneRange, topDesktopId, missingLinks, findBroken, totals, totalsDiff, overlapReports, duplicateReports, merge };
