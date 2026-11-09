/* Chama, laid out like the CHAMA sheet: one row per slot, and for every round three columns: Due, Paid on, Amount.
   A late payment is just the real date typed in "Paid on" (click the cell). The cell turns green when paid on time, amber when late,
   red when it is past due and not paid. TOTAL under each round adds what was paid.
   - "+ New chama" makes another one (name, amount, number of slots, first date, days between slots, rounds)
   - the name can be changed at any time
   - when every slot of the last round is paid, the next round starts by itself (same slots, same amounts, dates move on by one round)
   Data: db.chama rows { scheme, slot, dueDate, amount, paid, paidDate }. Round k of a slot = its k-th row by due date. */
import { gridHtml, figBtn } from './gridEdit.js';

const num = v => Number(v) || 0;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const today = () => new Date().toISOString().slice(0, 10);

export const chamaRegistry = {};   // grid descriptions, refilled on every draw (Pilot's grid binding looks tables up here)

export function schemeNames(db){ return [...new Set((db.chama || []).map(c => c.scheme))].filter(Boolean); }

export function model(db, name){
  const by = new Map();
  (db.chama || []).filter(c => c.scheme === name).forEach(c => { const k = String(c.slot); (by.get(k) || by.set(k, []).get(k)).push(c); });
  const slots = [...by.keys()].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  slots.forEach(k => by.get(k).sort((a, b) => (a.dueDate || '') < (b.dueDate || '') ? -1 : (a.dueDate || '') > (b.dueDate || '') ? 1 : num(a.id) - num(b.id)));
  const rounds = Math.max(0, ...slots.map(k => by.get(k).length));
  const entry = (k, r) => (by.get(String(k)) || [])[r - 1] || null;
  const roundEntries = r => slots.map(k => entry(k, r)).filter(Boolean);
  const roundDone = r => { const e = roundEntries(r); return e.length > 0 && e.every(x => x.paid); };
  let current = rounds; for(let r = 1; r <= rounds; r++){ if(!roundDone(r)){ current = r; break; } }
  return { name, by, slots, rounds, entry, roundEntries, roundDone, current };
}

/* days between two rounds: the slots' own last gap if they have one, otherwise the step between neighbouring slots times the number of slots */
function roundGap(m){
  const gaps = m.slots.map(k => { const l = m.by.get(k); return l.length >= 2 && l[l.length - 1].dueDate && l[l.length - 2].dueDate ? dayDiff(l[l.length - 2].dueDate, l[l.length - 1].dueDate) : 0; }).filter(g => g > 0);
  if(gaps.length) return median(gaps);
  const first = m.roundEntries(1).map(e => e.dueDate).filter(isDate).sort(); const steps = [];
  for(let i = 1; i < first.length; i++) steps.push(dayDiff(first[i - 1], first[i]));
  return Math.max(7, (median(steps) || 7) * Math.max(1, m.slots.length));
}

export function startNextRound(db, uid, name){
  const m = model(db, name); if(!m.slots.length) return 0; const gap = roundGap(m); let n = 0;
  m.slots.forEach(k => { const l = m.by.get(k), last = l[l.length - 1]; if(!last || !isDate(last.dueDate)) return;
    db.chama.push({ id: uid(), scheme: name, slot: last.slot, dueDate: addDays(last.dueDate, l.length >= 2 && isDate(l[l.length - 2].dueDate) ? Math.max(1, dayDiff(l[l.length - 2].dueDate, last.dueDate)) : gap), amount: num(last.amount), paid: false, paidDate: '', note: '', xlRef: '' }); n++; });
  return n;
}

export function createChama(db, uid, f){
  const name = String(f.name || '').trim(); if(!name) return { ok: false, why: 'A name is needed' };
  if(schemeNames(db).some(n => n.toLowerCase() === name.toLowerCase())) return { ok: false, why: 'There is already a chama called ' + name };
  const amount = num(f.amount), slots = Math.round(num(f.slots)), every = Math.round(num(f.every)), rounds = Math.max(1, Math.round(num(f.rounds)) || 1);
  if(!(amount > 0)) return { ok: false, why: 'The amount for each slot is needed' };
  if(!(slots >= 1 && slots <= 200)) return { ok: false, why: 'Number of slots must be between 1 and 200' };
  if(!isDate(f.first)) return { ok: false, why: 'The first due date is needed' };
  if(!(every >= 1)) return { ok: false, why: 'Days between slots is needed (e.g. 5, 7 or 30)' };
  for(let r = 0; r < rounds; r++) for(let s = 1; s <= slots; s++)
    db.chama.push({ id: uid(), scheme: name, slot: s, dueDate: addDays(f.first, (r * slots + (s - 1)) * every), amount, paid: false, paidDate: '', note: '', xlRef: '' });
  return { ok: true, name, count: slots * rounds };
}

/* the grid for one chama; view = 'cur' (the round being paid) | 'all' | a round number */
function describe(db, name, view, ctx){
  const m = model(db, name), t = today();
  const shown = view === 'all' ? Array.from({ length: m.rounds }, (_, i) => i + 1) : (view && view !== 'cur' && Number(view) >= 1 && Number(view) <= m.rounds ? [Number(view)] : (m.rounds ? [m.current] : []));
  const columns = [{ key: 'slot', label: 'No.', type: 'text', readonly: true }];
  shown.forEach(r => { columns.push({ key: 'd' + r, label: 'R' + r + ' Due', type: 'date' }, { key: 'p' + r, label: 'R' + r + ' Paid on', type: 'date' }, { key: 'a' + r, label: 'R' + r + ' Amount', type: 'money' }); });
  const rows = m.slots.map(k => { const row = { id: k, slot: k };
    shown.forEach(r => { const e = m.entry(k, r); row['d' + r] = e ? e.dueDate || '' : ''; row['p' + r] = e && e.paid ? (e.paidDate || e.dueDate || '') : ''; row['a' + r] = e ? num(e.amount) : ''; });
    return row; });
  const totals = {}; shown.forEach(r => { totals['a' + r] = rs => rs.reduce((s, row) => { const e = m.entry(row.id, r); return s + (e && e.paid ? num(e.amount) : 0); }, 0); });
  const footDrill = {}; shown.forEach(r => { footDrill['a' + r] = { col: 'chama', scheme: name, kind: 'round', round: r }; });
  const desc = { id: 'chama:' + name, label: 'PAID', fmt: ctx.fmt, formats: ((ctx.settings() || {}).rowFormats || {})['chama:' + name], columns, rows, totals, footDrill,
    cellStyle: (row, key) => { const r = Number(key.slice(1)); if(!r) return ''; const e = m.entry(row.id, r); if(!e) return '';
      const late = e.paid && e.paidDate && e.dueDate && e.paidDate > e.dueDate, ok = e.paid && !late, over = !e.paid && e.dueDate && e.dueDate < t;
      return late ? 'background:rgba(214,168,79,.22);' : ok ? 'background:rgba(53,184,107,.16);' : over ? 'background:rgba(224,90,82,.16);' : ''; },
    onSet: (slot, key, v) => {
      const r = Number(key.slice(1)), kind = key[0]; let e = m.entry(slot, r);
      if(kind === 'd'){ if(!isDate(v)) return; if(e) e.dueDate = v; else { const l = m.by.get(String(slot)) || [];
        db.chama.push({ id: ctx.uid(), scheme: name, slot: isNaN(Number(slot)) ? slot : Number(slot), dueDate: v, amount: num((l[l.length - 1] || {}).amount), paid: false, paidDate: '', note: '', xlRef: '' }); } return; }
      if(!e) return;
      if(kind === 'a'){ e.amount = num(v); return; }
      if(kind === 'p'){
        if(v && isDate(v)){ e.paid = true; e.paidDate = v; } else { e.paid = false; e.paidDate = ''; }
        const m2 = model(db, name);
        if(r === m2.rounds && m2.roundDone(r) && m2.roundEntries(r).length === m2.slots.length){ if(startNextRound(db, ctx.uid, name)) ctx.toast('Round ' + r + ' is complete. Round ' + (r + 1) + ' has started.'); }
      }
    },
    onAdd: () => { const k = (m.slots.length ? Math.max(...m.slots.map(x => Number(x) || 0)) : 0) + 1; const gap = m.slots.length >= 2 ? dayDiff((m.entry(m.slots[0], 1) || {}).dueDate || t, (m.entry(m.slots[1], 1) || {}).dueDate || t) || 7 : 7;
      for(let r = 1; r <= Math.max(1, m.rounds); r++){ const prev = m.entry(m.slots[m.slots.length - 1], r); const base = prev && isDate(prev.dueDate) ? prev.dueDate : t; const unit = prev ? num(prev.amount) : 0;
        db.chama.push({ id: ctx.uid(), scheme: name, slot: k, dueDate: addDays(base, gap), amount: unit, paid: false, paidDate: '', note: '', xlRef: '' }); } },
    onRemove: slot => { db.chama = db.chama.filter(c => !(c.scheme === name && String(c.slot) === String(slot))); },
    extra: '' };
  return { desc, m, shown };
}

export function chamaHtml(db, st, ctx){
  const names = schemeNames(db), t = today();
  Object.keys(chamaRegistry).forEach(k => delete chamaRegistry[k]);
  const newForm = st.showNew ? `<div class="table-wrap" style="padding:12px;margin-bottom:14px;"><b>New chama</b>
      <div class="form-grid" style="margin-top:8px;"><div><label>Name</label><input id="cm_n_name" placeholder="e.g. Chama C - 5,000 weekly"></div><div><label>Amount for each slot</label><input id="cm_n_amount" type="number" min="1"></div>
        <div><label>Number of slots</label><input id="cm_n_slots" type="number" min="1" max="200" value="10"></div><div><label>First due date</label><input id="cm_n_first" type="date" value="${t}"></div>
        <div><label>Days between slots</label><input id="cm_n_every" type="number" min="1" value="7"></div><div><label>Rounds to set up</label><input id="cm_n_rounds" type="number" min="1" max="12" value="1"></div></div>
      <button type="button" class="btn primary" data-cm="create" style="width:auto;padding:8px 16px;">Create chama</button> <button type="button" class="btn" data-cm="newclose" style="width:auto;padding:8px 16px;">Cancel</button></div>` : '';
  const top = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;"><button type="button" class="btn primary" data-cm="newopen" style="width:auto;padding:8px 16px;">+ New chama</button>
    <span class="subtitle" style="margin:0;">Click a cell to change it. Type the real date in <b>Paid on</b> when a payment is late. Green = paid on time, amber = paid late, red = past due and not paid.</span></div>`;
  if(!names.length) return top + newForm + '<p class="subtitle">No chama yet. Press + New chama to start one.</p>';
  const blocks = names.map(name => {
    const view = (st.view || {})[name] || 'cur'; const { desc, m, shown } = describe(db, name, view, ctx); chamaRegistry[desc.id] = desc;
    const all = (db.chama || []).filter(c => c.scheme === name), paid = all.filter(c => c.paid), saved = paid.reduce((s, c) => s + num(c.amount), 0);
    const behind = all.filter(c => !c.paid && c.dueDate && c.dueDate <= t).reduce((s, c) => s + num(c.amount), 0), late = paid.filter(c => c.paidDate && c.dueDate && c.paidDate > c.dueDate).length;
    const next = all.filter(c => !c.paid && c.dueDate && c.dueDate > t).sort((a, b) => a.dueDate < b.dueDate ? -1 : 1)[0];
    const chips = ['cur', 'all'].concat(Array.from({ length: m.rounds }, (_, i) => String(i + 1))).map(v => `<button type="button" class="btn ${String(view) === v ? 'primary' : ''}" data-cm="view" data-name="${esc(name)}" data-v="${v}" style="width:auto;padding:4px 10px;">${v === 'cur' ? 'Current round' + (m.rounds ? ' (' + m.current + ')' : '') : v === 'all' ? 'All rounds' : 'Round ' + v}</button>`).join(' ');
    return `<div class="table-wrap" style="padding:12px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><input data-cm-name="${esc(name)}" value="${esc(name)}" title="Change the name" aria-label="Chama name" style="font-weight:700;min-width:240px;max-width:100%;width:auto;">
        <button type="button" class="btn" data-cm="delete" data-name="${esc(name)}" style="width:auto;padding:5px 10px;" title="Remove this whole chama">Delete chama</button></div>
      <div class="subtitle" style="margin:6px 0 8px;">Round ${m.current} of ${m.rounds} · saved so far <b>${saved ? figBtn({ col: 'chama', scheme: name, kind: 'saved' }, esc(ctx.fmt(saved))) : esc(ctx.fmt(saved))}</b> · behind by <b style="${behind ? 'color:var(--red);' : ''}">${behind ? figBtn({ col: 'chama', scheme: name, kind: 'behind' }, esc(ctx.fmt(behind))) : esc(ctx.fmt(behind))}</b>${late ? ' · ' + late + ' paid late' : ''} · next due ${next ? esc(next.dueDate) + ' (' + ctx.fmt(next.amount) + ')' : '—'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${chips}</div>
      ${gridHtml(desc)}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"><button type="button" class="btn" data-cm="nextround" data-name="${esc(name)}" style="width:auto;padding:6px 14px;">Start next round now</button>
        ${m.rounds > 1 ? `<button type="button" class="btn" data-cm="droplast" data-name="${esc(name)}" style="width:auto;padding:6px 14px;">Remove last round</button>` : ''}</div>
      <p class="subtitle" style="margin:6px 0 0;">A contribution that came from the Excel with no paid date shows its due date until you type the real one. The next round starts by itself when the last round is fully paid.</p></div>`;
  }).join('');
  return top + newForm + blocks;
}

/* returns true when the screen must be redrawn */
export function chamaClick(e, db, st, ctx){
  const t = e.target.closest('[data-cm]'); if(!t) return false; const a = t.dataset.cm, name = t.dataset.name;
  if(a === 'newopen'){ st.showNew = true; return true; }
  if(a === 'newclose'){ st.showNew = false; return true; }
  if(a === 'view'){ st.view = st.view || {}; st.view[name] = t.dataset.v; return true; }
  if(a === 'create'){ const v = id => (document.getElementById(id) || {}).value;
    const res = createChama(db, ctx.uid, { name: v('cm_n_name'), amount: v('cm_n_amount'), slots: v('cm_n_slots'), first: v('cm_n_first'), every: v('cm_n_every'), rounds: v('cm_n_rounds') });
    if(!res.ok){ ctx.toast(res.why); return false; } st.showNew = false; st.view = Object.assign(st.view || {}, { [res.name]: 'cur' }); ctx.toast('Chama created'); ctx.changed(); return false; }
  if(a === 'nextround'){ const n = startNextRound(db, ctx.uid, name); ctx.toast(n ? 'Next round started' : 'Nothing to continue from'); if(n) ctx.changed(); return false; }
  if(a === 'droplast'){ const m = model(db, name); if(m.rounds < 2) return false;
    if(!ctx.confirm('Remove round ' + m.rounds + ' of ' + name + '? Anything typed in it is lost.')) return false;
    const ids = new Set(m.slots.map(k => (m.entry(k, m.rounds) || {}).id).filter(Boolean)); db.chama = db.chama.filter(c => !ids.has(c.id)); ctx.changed(); return false; }
  if(a === 'delete'){ if(!ctx.confirm('Delete the whole chama "' + name + '" with all its rounds? This cannot be undone.')) return false;
    db.chama = db.chama.filter(c => c.scheme !== name); ctx.changed(); return false; }
  return false;
}

export function chamaChange(e, db, ctx){
  const i = e.target.closest('[data-cm-name]'); if(!i) return false; const old = i.dataset.cmName, nu = i.value.trim();
  if(!nu || nu === old){ i.value = old; return true; }
  if(schemeNames(db).some(n => n !== old && n.toLowerCase() === nu.toLowerCase())){ ctx.toast('There is already a chama called ' + nu); i.value = old; return true; }
  db.chama.forEach(c => { if(c.scheme === old) c.scheme = nu; });
  const rf = (ctx.settings() || {}).rowFormats; if(rf && rf['chama:' + old]){ rf['chama:' + nu] = rf['chama:' + old]; delete rf['chama:' + old]; }
  ctx.toast('Renamed to ' + nu); ctx.changed(); return true;
}
