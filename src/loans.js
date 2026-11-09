/* Loans (admin, inside Pilot). Three editable tables like the LOAN sheet, plus the loan list they hang from:
     1. Loans        - one line per loan: name (rename here), what for, borrowed, day due. Scheduled / paid / balance are worked out.
     2. Monthly      - months down, loans across, the instalment in each cell. Click a cell to change it; totals follow.
     3. Due in a month - the "due this month" list: name, due, day, paid so far, left. Pick any month.
     4. Individuals  - the running balances (LAWYER, WIN, SAM ...): lines for each person, balance = sum of the lines.
   The data is db.loans (schedule inside each loan, as before) and db.individuals. Nothing is typed twice. */
import { gridHtml, figBtn } from './gridEdit.js';

const num = v => Number(v) || 0;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = ym => { const [y, m] = String(ym).split('-'); return (MONTHS[Number(m) - 1] || ym) + ' ' + y; };
const nextMonth = ym => { const [y, m] = ym.split('-').map(Number); return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'); };
const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

/* ---------- schedule helpers ---------- */
export function scheduleOf(l){ if(Array.isArray(l.schedule)) return l.schedule; try{ const s = JSON.parse(l.schedule || '[]'); return Array.isArray(s) ? s : []; }catch(e){ return []; } }
function save(l, sch){
  sch.sort((a, b) => a.month < b.month ? -1 : 1);
  l.schedule = JSON.stringify(sch);
  l.startDate = sch.length ? sch[0].month : ''; l.endDate = sch.length ? sch[sch.length - 1].month : '';
  const p = sch.filter(s => paidOf(s) >= s.amount && s.amount > 0); l.paidThrough = p.length ? p[p.length - 1].month : '';
  if(sch.length) l.instalment = sch[sch.length - 1].amount;
}
export const paidOf = s => (s.paid && s.paidAmount == null) ? num(s.amount) : Math.min(num(s.paidAmount), num(s.amount) || Infinity);
export const loanName = l => { const a = l.lender || '', b = l.item || ''; return a && b && a !== b ? a + ' · ' + b : (a || b || 'Loan'); };

export function loanMonths(db){
  const set = new Set((db.settings && db.settings.loanExtraMonths || []).filter(isMonth));
  (db.loans || []).forEach(l => scheduleOf(l).forEach(s => set.add(s.month)));
  return [...set].sort();
}
export function getCell(l, month){ const s = scheduleOf(l).find(x => x.month === month); return s ? num(s.amount) : 0; }
export function setCell(l, month, amount){
  const sch = scheduleOf(l), i = sch.findIndex(x => x.month === month), a = Math.abs(num(amount));   // typed as -42000 (like the Excel) or 42000: both mean an instalment of 42,000
  if(!a){ if(i >= 0) sch.splice(i, 1); }
  else if(i >= 0){ sch[i].amount = a; if(sch[i].paidAmount != null && sch[i].paidAmount > a) sch[i].paidAmount = a; }
  else sch.push({ month, amount: a, paid: false });
  save(l, sch);
}
export function removeMonth(db, month){
  (db.loans || []).forEach(l => { const sch = scheduleOf(l).filter(s => s.month !== month); save(l, sch); });
  if(db.settings && db.settings.loanExtraMonths) db.settings.loanExtraMonths = db.settings.loanExtraMonths.filter(m => m !== month);
}
export function addMonth(db){
  const ms = loanMonths(db); const last = ms.length ? ms[ms.length - 1] : new Date().toISOString().slice(0, 7);
  const m = ms.length ? nextMonth(last) : last; db.settings = db.settings || {};
  db.settings.loanExtraMonths = (db.settings.loanExtraMonths || []).concat([m]); return m;
}
export function addLoan(db, uid){ const l = { id: uid(), lender: 'New loan', item: '', borrowed: 0, instalment: 0, dueDay: 0, startDate: '', endDate: '', paidThrough: '', note: '', schedule: '[]', xlRef: '' }; (db.loans = db.loans || []).push(l); return l; }
export function removeLoan(db, id){ db.loans = (db.loans || []).filter(l => String(l.id) !== String(id)); }
export function loanTotals(l){
  const sch = scheduleOf(l), scheduled = sch.reduce((s, x) => s + num(x.amount), 0), paid = sch.reduce((s, x) => s + paidOf(x), 0);
  return { scheduled, paid, balance: scheduled - paid, borrowed: num(l.borrowed) };
}
/* the "due this month" table */
export function dueList(db, month){
  const rows = [];
  (db.loans || []).forEach(l => { const s = scheduleOf(l).find(x => x.month === month); if(!s || !num(s.amount)) return;
    const paid = paidOf(s); rows.push({ id: l.id, name: loanName(l), due: num(s.amount), day: num(l.dueDay), paid, paidDate: paid > 0 ? (s.paidDate || '') : '', left: num(s.amount) - paid }); });
  rows.sort((a, b) => (a.day || 99) - (b.day || 99));
  rows.forEach((r, i) => { r.no = i + 1; });
  return rows;
}
export function setDuePaid(l, month, amount){
  const sch = scheduleOf(l), s = sch.find(x => x.month === month); if(!s) return false;
  const a = Math.max(0, num(amount)); s.paidAmount = Math.min(a, num(s.amount)); s.paid = s.paidAmount >= num(s.amount); if(!a) delete s.paidDate; else if(!s.paidDate) s.paidDate = new Date().toISOString().slice(0, 10); save(l, sch); return true;
}
export function setDueDate(l, month, date){ const sch = scheduleOf(l), s = sch.find(x => x.month === month); if(!s) return false; s.paidDate = date || ''; save(l, sch); return true; }

/* ---------- individuals (LAWYER, WIN, SAM ...) ---------- */
export function persons(db){
  const by = new Map(); (db.individuals || []).forEach(x => { if(!by.has(x.person)) by.set(x.person, []); by.get(x.person).push(x); });
  const names = [...by.keys()]; const first = n => Math.min(...by.get(n).map(x => num(x.order) || 1e9));
  names.sort((a, b) => first(a) - first(b));
  return names.map(n => { const lines = by.get(n).sort((a, b) => (num(a.order) || 1e9) - (num(b.order) || 1e9)); return { name: n, lines, balance: lines.reduce((s, x) => s + num(x.amount), 0) }; });
}
export function addPerson(db, name){
  const n = String(name || '').trim().toUpperCase(); if(!n) return null;
  if((db.individuals || []).some(x => x.person === n)) return null;
  (db.individuals = db.individuals || []).push({ id: db.nextId++, person: n, date: '', amount: 0, note: 'Opening', order: nextOrder(db), xlRef: '' }); return n;
}
export function nextOrder(db){ return (db.individuals || []).reduce((m, x) => Math.max(m, num(x.order)), 0) + 1; }
export function renamePerson(db, from, to){
  const n = String(to || '').trim().toUpperCase(); if(!n || n === from) return false;
  if((db.individuals || []).some(x => x.person === n)) return false;
  (db.individuals || []).forEach(x => { if(x.person === from) x.person = n; }); return true;
}
export function removePerson(db, name){ db.individuals = (db.individuals || []).filter(x => x.person !== name); }

/* ---------- screens ---------- */
const registry = {};
export const loansRegistry = registry;

export function loansHtml(db, st, ctx){
  Object.keys(registry).forEach(k => delete registry[k]);
  const fmt = ctx.fmt, loans = db.loans || [], fm = (db.settings && db.settings.rowFormats) || {};
  const today = new Date().toISOString().slice(0, 7);
  st.dueMonth = isMonth(st.dueMonth) ? st.dueMonth : today;

  /* 1. the loans themselves */
  registry.loanlist = { id: 'loanlist', title: 'Loans', fmt, formats: fm.loanlist, label: 'TOTAL',
    columns: [{ key: 'lender', label: 'Name (click to rename)', type: 'text' }, { key: 'item', label: 'For (car or purpose)', type: 'text' }, { key: 'borrowed', label: 'Borrowed', type: 'money' }, { key: 'dueDay', label: 'Due day', type: 'number' },
      { key: 'scheduled', label: 'Scheduled', type: 'money', compute: l => loanTotals(l).scheduled, drill: l => ({ col: 'loan', loanId: l.id, kind: 'scheduled' }) }, { key: 'paid', label: 'Paid', type: 'money', compute: l => loanTotals(l).paid, drill: l => ({ col: 'loan', loanId: l.id, kind: 'paid' }) }, { key: 'balance', label: 'Balance', type: 'money', compute: l => loanTotals(l).balance, drill: l => ({ col: 'loan', loanId: l.id, kind: 'balance' }) },
      { key: 'note', label: 'Note', type: 'text' }],
    totals: { borrowed: 'sum', scheduled: 'sum', paid: 'sum', balance: 'sum' }, footDrill: { scheduled: { col: 'loanAll', kind: 'scheduled' }, paid: { col: 'loanAll', kind: 'paid' }, balance: { col: 'loanAll', kind: 'balance' } }, rows: loans,
    onSet: (id, k, v) => { const l = loans.find(x => String(x.id) === String(id)); if(l) l[k] = k === 'dueDay' ? Math.max(0, Math.min(31, Math.round(num(v)))) : v; },
    onAdd: () => addLoan(db, ctx.uid), onRemove: id => removeLoan(db, id) };

  /* 2. months down, loans across */
  const months = loanMonths(db);
  const mrows = months.map(m => { const r = { id: m, month: monthName(m) }; loans.forEach(l => { r['L' + l.id] = getCell(l, m); }); return r; });
  const loanCols = loans.map(l => ({ key: 'L' + l.id, label: loanName(l), type: 'money' }));
  const totals = { total: 'sum' }, footDrill = { total: { col: 'loanAll', kind: 'scheduled' } }; loans.forEach(l => { totals['L' + l.id] = 'sum'; footDrill['L' + l.id] = { col: 'loan', loanId: l.id, kind: 'scheduled' }; });
  registry.loanmonthly = { id: 'loanmonthly', title: 'Monthly instalments', fmt, formats: fm.loanmonthly, label: 'TOTAL', rows: mrows,
    columns: [{ key: 'month', label: 'Month', type: 'text', readonly: true }].concat(loanCols, [{ key: 'total', label: 'All loans', type: 'money', compute: r => loans.reduce((s, l) => s + num(r['L' + l.id]), 0), drill: r => ({ col: 'loanMonth', month: r.id, kind: 'due' }) }]),
    totals, footDrill, onSet: (month, key, v) => { const l = loans.find(x => 'L' + x.id === key); if(l) setCell(l, month, v); },
    onAdd: () => addMonth(db), onRemove: month => removeMonth(db, month),
    extra: '<p class="subtitle" style="padding:6px 10px 0;">Click a figure to change it (type 0 to clear). Totals update at once. Type it with or without the minus sign.</p>' };

  /* 3. due in a month */
  const due = dueList(db, st.dueMonth);
  registry.loandue = { id: 'loandue', title: 'Due in ' + monthName(st.dueMonth), fmt, formats: fm.loandue, label: 'TOTAL', rows: due,
    columns: [{ key: 'no', label: 'No', type: 'number', readonly: true }, { key: 'name', label: 'Loan', type: 'text', readonly: true }, { key: 'due', label: 'Due', type: 'money', readonly: true, drill: r => ({ col: 'loanMonth', month: st.dueMonth, loanId: r.id, kind: 'due' }) }, { key: 'day', label: 'Day', type: 'number' }, { key: 'paid', label: 'Paid so far', type: 'money' }, { key: 'paidDate', label: 'Paid on', type: 'date' }, { key: 'left', label: 'Left', type: 'money', compute: r => r.due - r.paid, drill: r => ({ col: 'loanMonth', month: st.dueMonth, loanId: r.id, kind: 'left' }) }],
    totals: { due: 'sum', paid: 'sum', left: 'sum' }, footDrill: { due: { col: 'loanMonth', month: st.dueMonth, kind: 'due' }, paid: { col: 'loanMonth', month: st.dueMonth, kind: 'paid' }, left: { col: 'loanMonth', month: st.dueMonth, kind: 'left' } },
    onSet: (id, k, v) => { const l = loans.find(x => String(x.id) === String(id)); if(!l) return; if(k === 'day') l.dueDay = Math.max(0, Math.min(31, Math.round(num(v)))); if(k === 'paid') setDuePaid(l, st.dueMonth, v); if(k === 'paidDate') setDueDate(l, st.dueMonth, v); },
    extra: `<div style="padding:8px 10px;"><label style="display:inline-block;margin-right:8px;">Month</label><input type="month" id="ln_due" value="${esc(st.dueMonth)}" style="width:auto;display:inline-block;"> <span class="subtitle">Paid so far is typed in; it clears when it reaches the amount due.</span></div>` };

  /* 4. individuals */
  const people = persons(db);
  const peopleHtml = people.map((p, i) => { const id = 'ind' + i;
    registry[id] = { id, title: '', fmt, formats: fm[id], label: 'BALANCE', rows: p.lines,
      columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'note', label: 'Note', type: 'text' }],
      totals: { amount: 'sum' }, onSet: (lid, k, v) => { const x = (db.individuals || []).find(y => String(y.id) === String(lid)); if(x) x[k] = v; },
      onAdd: () => { (db.individuals = db.individuals || []).push({ id: ctx.uid(), person: p.name, date: new Date().toISOString().slice(0, 10), amount: 0, note: '', order: nextOrder(db), xlRef: '' }); },
      onRemove: lid => { db.individuals = (db.individuals || []).filter(y => String(y.id) !== String(lid)); },
      extra: `<div style="padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><b style="font-size:15px;">${esc(p.name)}</b><span class="subtitle">${p.balance === 0 ? 'cleared' : 'balance ' + figBtn({ col: 'person', person: p.name }, esc(fmt(p.balance)))}</span>
        <button type="button" class="row-edit" data-ln="renameperson" data-p="${esc(p.name)}">✎ Rename</button><button type="button" class="row-del" data-ln="delperson" data-p="${esc(p.name)}" title="Remove this person and all lines">✕ Remove</button></div>` };
    return gridHtml(registry[id]); }).join('');

  const bar = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 10px;"><button type="button" class="btn primary" data-ln="newloan" style="width:auto;padding:8px 16px;">+ Add a loan</button><button type="button" class="btn" data-ln="newformat" style="width:auto;padding:8px 14px;border:2px solid #f0b44f;background:rgba(240,180,79,.16);">⚠ A different loan format? Contact the developer</button></div>`;
  return `${bar}<h3 style="margin:6px 0;">Loans</h3>${gridHtml(registry.loanlist)}
    <h3 style="margin:18px 0 6px;">Monthly</h3>${gridHtml(registry.loanmonthly)}
    <h3 style="margin:18px 0 6px;">Due this month</h3>${gridHtml(registry.loandue)}
    <h3 style="margin:18px 0 6px;">Individuals <span class="subtitle" style="font-weight:400;">(part of Loans)</span></h3><p class="subtitle">Each person's running lines. The balance is the sum of the lines (0 = cleared).</p>
    ${peopleHtml || '<p class="subtitle">No individuals yet.</p>'}
    <div style="margin-top:10px;"><button type="button" class="btn" data-ln="addperson" style="width:auto;padding:7px 14px;">+ Add person</button></div>`;
}


/* ---------- add a new loan (name, amount, instalment, first month, how many months, day due) ---------- */
export function createLoan(db, uid, f){
  const name = String(f.name || '').trim(), instalment = Math.abs(num(f.instalment)), months = Math.round(num(f.months));
  if(!name) return { error: 'Type the loan name (for example the bank or the person)' };
  if(!instalment) return { error: 'Type the instalment per month' };
  if(!isMonth(f.firstMonth)) return { error: 'Choose the first month of the instalments' };
  if(months < 1 || months > 240) return { error: 'Number of months must be between 1 and 240' };
  if((db.loans || []).some(l => String(l.lender || '').trim().toLowerCase() === name.toLowerCase() && String(l.item || '').trim().toLowerCase() === String(f.item || '').trim().toLowerCase())) return { error: 'A loan with this name and purpose already exists. Change the name or the purpose, or edit the existing one' };
  const l = { id: uid(), lender: name, item: String(f.item || '').trim(), borrowed: Math.abs(num(f.borrowed)), instalment, dueDay: Math.max(0, Math.min(31, Math.round(num(f.dueDay)))), startDate: '', endDate: '', paidThrough: '', note: String(f.note || '').trim(), schedule: '[]', xlRef: '' };
  let m = f.firstMonth; for(let i = 0; i < months; i++){ setCell(l, m, instalment); m = nextMonth(m); }
  (db.loans = db.loans || []).push(l);
  return { loan: l };
}

/* small pop-ups: the add-loan form, and the "my loan has a different format" notice */
function modal(html){
  const old = document.getElementById('lnModal'); if(old) old.remove();
  const w = document.createElement('div'); w.id = 'lnModal';
  w.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:14px;overflow:auto;';
  w.innerHTML = html; document.body.appendChild(w); return w;
}
const BOX = 'background:var(--panel,#161b22);color:var(--ink,#e6edf3);border:1px solid var(--line,#30363d);border-radius:12px;padding:18px;max-width:460px;width:100%;font-size:14px;';
const FIELD = 'width:100%;box-sizing:border-box;padding:8px;margin-top:3px;';

export const DEVELOPER_EMAIL = 'jiranisystem23@gmail.com';
export function developerMailto(subject, body){ return 'mailto:' + DEVELOPER_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body); }

export function openNewFormat(){
  const w = modal(`<div style="${BOX}border:2px solid #f0b44f;box-shadow:0 0 0 4px rgba(240,180,79,.25);">
    <h3 style="margin:0 0 6px;">⚠ A new loan format</h3>
    <p style="margin:0 0 8px;line-height:1.45;">This screen handles loans with a name, an amount borrowed, a fixed instalment each month and a day due. If your loan works differently (for example instalments that change, interest only, a grace period, or a lender statement), <b>contact the developer</b> so the app gets a matching format. Nothing is lost in the meantime: you can still keep the loan as a line with a note.</p>
    <p style="margin:0 0 8px;">Developer email: <b>${DEVELOPER_EMAIL}</b></p>
    <label>Describe how the loan works</label><textarea id="lnFmtText" rows="4" style="${FIELD}" placeholder="Lender, how the amount is paid, when, what is different..."></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;"><button type="button" class="btn" id="lnFmtClose" style="width:auto;padding:8px 14px;">Close</button><button type="button" class="btn" id="lnFmtCopy" style="width:auto;padding:8px 14px;">Copy message</button><a class="btn primary" id="lnFmtMail" href="${developerMailto('FleetPilot: new loan format needed', '')}" style="width:auto;padding:8px 14px;text-decoration:none;display:inline-block;box-sizing:border-box;">✉ Email the developer</a></div></div>`);
  const text = () => 'FleetPilot: new loan format needed.\n\n' + (w.querySelector('#lnFmtText').value.trim() || '(please describe the loan)');
  const refreshMail = () => { w.querySelector('#lnFmtMail').setAttribute('href', developerMailto('FleetPilot: new loan format needed', text())); };
  w.querySelector('#lnFmtText').addEventListener('input', refreshMail);
  w.querySelector('#lnFmtClose').onclick = () => w.remove();
  w.querySelector('#lnFmtMail').addEventListener('click', refreshMail);
  w.querySelector('#lnFmtCopy').onclick = () => {
    const t = 'To: ' + DEVELOPER_EMAIL + '\n' + text();
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { const b = w.querySelector('#lnFmtCopy'); b.textContent = 'Copied. Send it to ' + DEVELOPER_EMAIL; }, () => { const a = w.querySelector('#lnFmtText'); a.value = t; a.select(); });
  };
}

export function openAddLoan(db, ctx){
  const m0 = new Date().toISOString().slice(0, 7);
  const w = modal(`<div style="${BOX}"><h3 style="margin:0 0 8px;">Add a loan</h3>
    <label>Loan name (bank or person)</label><input id="nl_name" style="${FIELD}">
    <label style="display:block;margin-top:8px;">For (car or purpose)</label><input id="nl_item" style="${FIELD}">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
      <div><label>Amount borrowed</label><input id="nl_borrowed" type="number" min="0" style="${FIELD}"></div>
      <div><label>Instalment per month</label><input id="nl_inst" type="number" min="0" style="${FIELD}"></div>
      <div><label>First month</label><input id="nl_first" type="month" value="${m0}" style="${FIELD}"></div>
      <div><label>Number of months</label><input id="nl_months" type="number" min="1" max="240" value="12" style="${FIELD}"></div>
      <div><label>Day due (0 = none)</label><input id="nl_day" type="number" min="0" max="31" value="0" style="${FIELD}"></div>
    </div>
    <label style="display:block;margin-top:8px;">Note</label><input id="nl_note" style="${FIELD}">
    <p id="nl_err" style="color:#f85149;margin:8px 0 0;min-height:18px;"></p>
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-top:6px;">
      <button type="button" class="btn" id="nl_fmt" style="width:auto;padding:8px 12px;border-color:#f0b44f;">⚠ My loan has a different format</button>
      <span style="display:flex;gap:8px;"><button type="button" class="btn" id="nl_cancel" style="width:auto;padding:8px 14px;">Cancel</button><button type="button" class="btn primary" id="nl_ok" style="width:auto;padding:8px 14px;">Add loan</button></span></div></div>`);
  const v = id => w.querySelector('#' + id).value;
  w.querySelector('#nl_cancel').onclick = () => w.remove();
  w.querySelector('#nl_fmt').onclick = () => { w.remove(); openNewFormat(); };
  w.querySelector('#nl_ok').onclick = () => {
    const res = createLoan(db, ctx.uid, { name: v('nl_name'), item: v('nl_item'), borrowed: v('nl_borrowed'), instalment: v('nl_inst'), firstMonth: v('nl_first'), months: v('nl_months'), dueDay: v('nl_day'), note: v('nl_note') });
    if(res.error){ w.querySelector('#nl_err').textContent = res.error; return; }
    w.remove(); ctx.toast('Loan added: ' + loanName(res.loan)); ctx.changed();
  };
  setTimeout(() => w.querySelector('#nl_name').focus(), 30);
}

/* extra buttons not covered by the grid engine; returns true when it handled the click */
export function loansClick(e, db, st, ctx){
  const b = e.target.closest('[data-ln]'); if(!b) return false; const act = b.dataset.ln;
  if(act === 'addperson'){ Promise.resolve(ctx.prompt('Name of the person', '')).then(n => { if(n == null) return; if(!addPerson(db, n)) ctx.toast('That name is empty or already there'); else ctx.changed(); }); return true; }
  if(act === 'renameperson'){ const who = b.dataset.p; Promise.resolve(ctx.prompt('New name for ' + who, who)).then(n => { if(n == null) return; if(!renamePerson(db, who, n)) ctx.toast('Not renamed: the name is empty or already used'); else ctx.changed(); }); return true; }
  if(act === 'newloan'){ openAddLoan(db, ctx); return true; }
  if(act === 'newformat'){ openNewFormat(); return true; }
  if(act === 'delperson'){ if(ctx.confirm('Remove ' + b.dataset.p + ' and every line under the name?')){ removePerson(db, b.dataset.p); ctx.changed(); } return true; }
  return false;
}
export function loansChange(e, st){ if(e.target.id === 'ln_due'){ st.dueMonth = e.target.value; return true; } return false; }
