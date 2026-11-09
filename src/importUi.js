/* "Import Excel" window: read the workbook, analyse it, let the user review every flagged line, and only then add it to the database. */
import { analyze, decide } from './importer/index.js';
import { mergeImport } from './importer/merge.js';
import { isFleetPilotBackup } from './importer/backupDetection.js';
import { plain, normReg } from './importer/util.js';
import { DEVELOPER_EMAIL, developerMailto } from './loans.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initImportUi(ctx){
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.xlsx'; input.style.display = 'none'; document.body.appendChild(input);
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'importOverlay';
  overlay.innerHTML = '<div class="modal-box fm-box" style="max-width:920px;width:94vw;max-height:90vh;display:flex;flex-direction:column;"><div class="fm-head"><div><h2>Import Excel</h2><p id="impSub"></p></div><button type="button" class="fm-close" id="impClose" aria-label="Close">✕</button></div><div id="impBody" style="overflow:auto;padding:12px 18px;flex:1;"></div><div class="fm-foot" id="impFoot"></div></div>';
  document.body.appendChild(overlay);
  let raw = null, state = { overrides: {}, ignores: [] }, res = null, fileName = '';
  let view = null, listScroll = 0;        // view: the source-sheet screen opened by a Fix button { kind:'item'|'check'|'note', key, sheet, row, span }
  const close = () => { overlay.classList.remove('show'); view = null; editKey = null; };
  let editKey = null;      // the review line whose fields are open for quick editing
  const editHtml = r => {
    const rental = 'days' in r, f = [];
    if('reg' in r) f.push(['reg', 'Reg', r.reg]);
    f.push([rental ? 'pickup' : 'date', rental ? 'Date out' : 'Date', r.pickup, 'date']);
    if(rental){ f.push(['return', 'Date in', r.return, 'date']); f.push(['days', 'Days', r.days, 'number']); f.push(['client', 'Client', r.who]); }
    f.push(['amount', 'Amount', r.amount, 'number']);
    return `<div data-editbox="${esc(keyOf(r))}" style="margin:6px 0;padding:8px;border:1px solid var(--line,#30363d);border-radius:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">${f.map(([k, l, v, t]) => `<label style="font-size:12px;">${l}<br><input data-ef="${k}" data-orig="${esc(v == null ? '' : v)}" type="${t === 'number' ? 'number' : 'text'}" ${t === 'number' ? 'step="any"' : ''} ${t === 'date' ? 'placeholder="YYYY-MM-DD"' : ''} value="${esc(v == null ? '' : v)}" style="width:${t === 'date' ? 125 : t === 'number' ? 95 : 140}px;"></label>`).join('')}
      <button type="button" class="btn primary" data-editsave="${esc(r.id)}" style="width:auto;padding:6px 14px;">Save changes</button><button type="button" class="btn" data-edit="${esc(keyOf(r))}" style="width:auto;padding:6px 12px;">Cancel</button></div>`;
  };
  const editBtn = r => `<button class="row-edit" data-edit="${esc(keyOf(r))}" title="Change these fields here">Edit ✎</button>`;
  const openGroups = new Set();      // which groups of the review list are open: kept across redraws so a fix does not fold the list
  document.getElementById('impClose').addEventListener('click', close);

  async function readWorkbook(file){
    const wb = new window.ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
    const out = {};
    wb.worksheets.forEach(ws => { const rows = []; const cols = ws.columnCount;
      for(let r = 1; r <= ws.rowCount; r++){ const row = ws.getRow(r), cells = []; for(let c = 1; c <= cols; c++) cells.push(row.getCell(c).value); rows.push(cells); }
      out[ws.name] = rows; });
    return out;
  }
  function run(moveTo){
    res = analyze(raw, { overrides: state.overrides, ignores: state.ignores, today: new Date().toISOString().slice(0, 10) });
    if(moveTo !== undefined){           // a fix was chosen on the source screen: go straight to the next line to review (or back to the list)
      const nx = moveTo && res.ok ? res.review.find(r => keyOf(r) === moveTo && r.status !== 'done') : null;
      view = nx ? { kind: 'item', key: moveTo, sheet: nx.sheet, row: nx.row, span: 8, item: nx } : null;
    }
    const keepScroll = document.getElementById('impBody') ? document.getElementById('impBody').scrollTop : 0;
    draw();
    if(view){ const t = document.getElementById('fixTarget'); if(t) t.scrollIntoView({ block: 'center' }); }
    else if(moveTo === undefined){ document.getElementById('impBody').scrollTop = keepScroll; }
    else document.getElementById('impBody').scrollTop = listScroll;
  }


  /* ---------- Fix: the source sheet, opened at the row the problem is on ---------- */
  const keyOf = r => [r.recKey || '', r.code || '', r.sheet || '', r.row || ''].join('|');
  const colName = i => { let n = i + 1, s = ''; while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const isoOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const showCell = v => { const p = plain(v); if(p === null || p === undefined) return ''; if(p instanceof Date) return isNaN(p) ? '' : (p.getUTCFullYear() + '-' + String(p.getUTCMonth() + 1).padStart(2, '0') + '-' + String(p.getUTCDate()).padStart(2, '0')); if(typeof p === 'number') return Number.isInteger(p) ? String(p) : p.toLocaleString(undefined, { maximumFractionDigits: 2 }); return String(p); };
  function openItems(){
    const open = res.review.filter(r => r.status !== 'done'), groups = {};
    open.forEach(r => { (groups[r.severity + ' | ' + r.problem] = groups[r.severity + ' | ' + r.problem] || []).push(r); });
    const order = { high: 0, medium: 1, low: 2 };
    return Object.keys(groups).sort((a, b) => order[a.split(' | ')[0]] - order[b.split(' | ')[0]] || groups[b].length - groups[a].length).reduce((acc, k) => acc.concat(groups[k]), []);
  }
  /* which cells of the row are the ones the problem is about (the amount, the registration, the date, the name) */
  function matchers(v){
    const want = [];
    if(v.item){ const r = v.item;
      if(typeof r.amount === 'number') want.push(c => typeof c === 'number' && Math.abs(c - r.amount) < 0.5);
      if(r.reg){ const g = normReg(r.reg); want.push(c => typeof c === 'string' && normReg(c) === g); }
      if(r.pickup && /^\d{4}-\d{2}-\d{2}$/.test(String(r.pickup))) want.push(c => c instanceof Date && !isNaN(c) && (c.toISOString().slice(0, 10) === r.pickup || isoOf(c) === r.pickup));
      if(r.who && String(r.who).trim().length >= 3){ const w = String(r.who).trim().toLowerCase(); want.push(c => typeof c === 'string' && c.length >= 3 && (c.toLowerCase().includes(w) || w.includes(c.toLowerCase()))); }
    }
    if(v.check){ const c0 = v.check; want.push(c => typeof c === 'number' && (Math.abs(c - c0.excel) < 0.5 || Math.abs(c - c0.imported) < 0.5)); }
    return want;
  }
  function sourceView(){
    const rows = raw && raw[view.sheet];
    const back = '<button class="btn" data-fix="back" style="width:auto;padding:6px 12px;">← Back to the list</button>';
    if(!rows) return back + `<p>The sheet <b>${esc(view.sheet)}</b> was not found in this file, so there is nothing to show.</p>`;
    const total = rows.length, row = Math.min(Math.max(1, Number(view.row) || 1), total), span = view.span || 8;
    const from = Math.max(1, row - span), to = Math.min(total, row + span);
    const plainRow = i => (rows[i - 1] || []).map(plain);
    let ncols = 1; for(let i = from; i <= to; i++){ const r = plainRow(i); for(let c = r.length - 1; c >= 0; c--){ if(r[c] !== null){ ncols = Math.max(ncols, c + 1); break; } } }
    ncols = Math.min(ncols, 26);
    let head = 0, best = 2; for(let i = 1; i <= Math.min(12, total); i++){ const n = plainRow(i).filter(x => typeof x === 'string').length; if(n > best){ best = n; head = i; } }
    const want = matchers(view);
    const line = (i, pin) => { const cells = plainRow(i), hit = i === row;
      return `<tr id="${hit ? 'fixTarget' : ''}" style="${hit ? 'background:rgba(240,180,79,.22);outline:2px solid #f0b44f;' : (pin ? 'background:rgba(120,120,120,.16);font-weight:600;' : '')}"><td class="num" style="color:var(--ink-faint);white-space:nowrap;">${hit ? '▶ ' : ''}${i}</td>${Array.from({ length: ncols }, (_, c) => { const v = cells[c], mark = hit && v !== null && v !== undefined && want.some(f => { try{ return f(v); }catch(e){ return false; } });
        return `<td style="white-space:nowrap;${mark ? 'background:#f0b44f;color:#2b1d00;font-weight:700;border-radius:3px;' : ''}">${esc(showCell(rows[i - 1] ? rows[i - 1][c] : null))}</td>`; }).join('')}</tr>`; };
    const lines = []; if(head && head < from) lines.push(line(head, true) + `<tr><td colspan="${ncols + 1}" class="subtitle" style="text-align:center;">⋯</td></tr>`);
    for(let i = from; i <= to; i++) lines.push(line(i, i === head));
    const items = openItems(), idx = view.kind === 'item' ? items.findIndex(r => keyOf(r) === view.key) : -1;
    const it = view.item, ck = view.check;
    const what = it ? `<div><b>${esc(it.problem || '')}</b> <span class="subtitle">· ${esc(it.severity || '')}</span></div><div>${esc(it.detail || '')}</div>`
      : ck ? `<div><b>${esc(ck.label)}</b></div><div>Your Excel says <b>${ctx.fmt(ck.excel)}</b>, the app read <b>${ctx.fmt(ck.imported)}</b> (${ck.diff > 0 ? '+' : ''}${ctx.fmt(ck.diff)}). The amber cells in the highlighted row are the totals being compared.</div>`
      : `<div>${esc(view.text || '')}</div>`;
    const fixes = it ? `<div style="margin-top:6px;">${(it.choices || []).map((c, i) => `<button class="row-edit" data-item="${esc(it.id)}" data-choice="${i}">${esc(c.label)}</button>`).join(' ')} <button class="row-edit" data-item="${esc(it.id)}" data-choice="ignore">Leave as is</button> ${editBtn(it)}${editKey === keyOf(it) ? editHtml(it) : ''}</div>`
      : `<div class="subtitle" style="margin-top:6px;">Change the cell in your Excel file and import it again, or tell the developer: <a href="${developerMailto('FleetPilot import: ' + view.sheet + ' row ' + row, 'Sheet ' + view.sheet + ', row ' + row + '\n' + (ck ? ck.label : (view.text || '')))}">${DEVELOPER_EMAIL}</a></div>`;
    const nav = view.kind === 'item' && items.length ? `<span class="subtitle" style="margin:0 8px;">${idx >= 0 ? (idx + 1) + ' of ' + items.length + ' to review' : items.length + ' to review'}</span><button class="btn" data-fix="prev" style="width:auto;padding:6px 12px;" ${idx <= 0 ? 'disabled' : ''}>◀ Previous</button> <button class="btn" data-fix="next" style="width:auto;padding:6px 12px;" ${idx < 0 || idx >= items.length - 1 ? 'disabled' : ''}>Next ▶</button>` : '';
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">${back}${nav}</div>
      <div style="border:1px solid #f0b44f;border-radius:8px;padding:8px 10px;margin-bottom:8px;background:rgba(240,180,79,.08);"><div class="subtitle" style="margin:0 0 4px;"><b>${esc(view.sheet)}</b> · row ${row}${it && it.who ? ' · ' + esc(it.who) : ''}</div>${what}${fixes}</div>
      <div class="table-scroll" style="max-height:48vh;overflow:auto;border:1px solid var(--line,#30363d);border-radius:6px;"><table class="pg-table" data-no-tools="1" style="font-size:12.5px;"><thead><tr><th class="num">Row</th>${Array.from({ length: ncols }, (_, c) => `<th>${colName(c)}</th>`).join('')}</tr></thead><tbody>${lines.join('')}</tbody></table></div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;"><button class="btn" data-fix="more" style="width:auto;padding:5px 12px;">Show more rows</button><span class="subtitle" style="margin:0;align-self:center;">Rows ${from} to ${to} of ${total}. This is your file as it was read; nothing here is changed until you choose a fix and import.</span></div>`;
  }
  function openFix(next){ view = Object.assign({ span: 8 }, next); draw(); const t = document.getElementById('fixTarget'); if(t) t.scrollIntoView({ block: 'center' }); }

  function draw(){
    const body = document.getElementById('impBody'), foot = document.getElementById('impFoot'), sub = document.getElementById('impSub');
    sub.textContent = fileName;
    if(res.ok && view){
      if(view.kind === 'item'){ const live = res.review.find(r => keyOf(r) === view.key && r.status !== 'done'); if(!live){ view = null; } else view.item = live; }
    }
    if(res.ok && view){
      body.innerHTML = sourceView(); foot.innerHTML = '<button class="btn" id="impCancel">Close</button>'; document.getElementById('impCancel').onclick = close;
      return;
    }
    if(!res.ok){ body.innerHTML = '<p>' + esc(res.error) + '</p>'; foot.innerHTML = '<button class="btn" id="impCancel">Close</button>'; document.getElementById('impCancel').onclick = close; return; }
    const s = res.stats, open = res.review.filter(r => r.status !== 'done');
    const groups = {}; open.forEach(r => { (groups[r.severity + ' | ' + r.problem] = groups[r.severity + ' | ' + r.problem] || []).push(r); });
    const order = { high: 0, medium: 1, low: 2 };
    const keys = Object.keys(groups).sort((a, b) => order[a.split(' | ')[0]] - order[b.split(' | ')[0]] || groups[b].length - groups[a].length);
    const bad = res.checks.filter(c => !c.ok && c.group !== 'Monthly summary (Sheet1)');
    const ps = res.data.paymentStats || {};
    const payBlock = ps.rentals ? `<p><b>${s.invoices}</b> invoices (${ctx.fmt(s.invoicesTotal)}, of which ${ctx.fmt(s.invoicesUnpaid)} unpaid). Payments listed as PAID in your files become payments: <b>${(ps.exact.payments + ps.approx.payments + ps.ochwada.payments + ps.unlinked.payments)}</b> in all.
      Billed <b>${ctx.fmt(ps.billed)}</b>, collected <b>${ctx.fmt(ps.collected)}</b>, owed <b>${ctx.fmt(ps.owed)}</b>.
      <span class="subtitle">${ps.exact.invoices} invoices matched their rentals exactly; ${ps.approx.invoices} were applied to the client's oldest rentals (marked "matched by client" in Payments); ${ps.unlinked.payments} payments (${ctx.fmt(ps.unlinked.amount)}) could not be tied to a rental and show as "not linked".
      ${ps.noEvidence} rentals (${ctx.fmt(ps.noEvidenceAmount)}) have no payment listed anywhere, so they stay owing until you tick them or use "Mark shown as paid" on the Rentals screen.</span></p>` : '';
    body.innerHTML = payBlock + `<p><b>${s.rentals}</b> rentals (billed <b>${ctx.fmt(s.billed)}</b>), <b>${s.expenses}</b> expenses, <b>${s.allowances}</b> allowances, ${s.vehicles} vehicles, ${s.clients} clients, ${s.drivers} drivers, ${s.loans} loans, ${s.insurance} insurance lines.</p>
      <p class="subtitle">Nothing is added until you press <b>Import</b>. Your fixes below are remembered if you import a newer file later.</p>
      ${bad.length ? `<details data-gk="__checks" ${openGroups.has('__checks') ? 'open' : ''} style="margin:8px 0;"><summary><b>${bad.length}</b> of your own totals do not match what was read</summary>${bad.map(c => `<div class="subtitle">${esc(c.label)}: Excel ${ctx.fmt(c.excel)}, read ${ctx.fmt(c.imported)} (${c.diff > 0 ? '+' : ''}${ctx.fmt(c.diff)}) ${c.sheet ? `<button class="row-edit" data-fix="check" data-i="${res.checks.indexOf(c)}" title="Show this total in your Excel sheet, highlighted" style="border-color:#f0b44f;color:#f0b44f;font-weight:700;">Fix ▸</button>` : ''}</div>`).join('')}</details>` : '<p>✓ Your own totals match what was read.</p>'}
      ${res.notes.length ? `<details data-gk="__notes" ${openGroups.has('__notes') ? 'open' : ''} style="margin:8px 0;"><summary>${res.notes.length} sheets or rows I could not read: please explain</summary>${res.notes.map((n, i) => `<div class="subtitle">${esc(n.sheet || '')}${n.row ? ' row ' + n.row : ''}: ${esc(n.text)} ${n.sheet && n.row ? `<button class="row-edit" data-fix="note" data-i="${i}" title="Show these rows in your Excel sheet" style="border-color:#f0b44f;color:#f0b44f;font-weight:700;">Show ▸</button>` : ''}</div>`).join('')}</details>` : ''}
      <h3 style="margin:12px 0 6px;">${open.length} lines to review</h3>
      ${keys.map(k => { const [sev, prob] = k.split(' | '); const list = groups[k]; const withSet = list.filter(r => r.choices && r.choices.length && r.choices[0].set);
        return `<details data-gk="${esc(k)}" ${openGroups.has(k) ? 'open' : ''} style="margin:6px 0;"><summary><b>${esc(prob)}</b> · ${list.length} · ${sev}</summary>
          ${withSet.length ? `<button class="btn" data-bulk="${esc(k)}" style="width:auto;padding:6px 12px;margin:6px 0;">Apply first suggestion to ${withSet.length}</button>` : ''}
          ${list.slice(0, 40).map(r => `<div style="border-top:1px solid var(--line,#ddd);padding:6px 0;"><div class="subtitle">${esc(r.sheet)} row ${r.row} · ${esc(r.who || '')} ${esc(r.reg || '')} ${esc(r.pickup || '')}</div><div>${esc(r.detail)}</div>
            ${r.sheet && r.row ? `<button class="row-edit" data-fix="item" data-key="${esc(keyOf(r))}" title="Show this row in your Excel sheet, highlighted" style="border-color:#f0b44f;color:#f0b44f;font-weight:700;">Fix ▸</button> ` : ''}${(r.choices || []).map((c, i) => `<button class="row-edit" data-item="${esc(r.id)}" data-choice="${i}">${esc(c.label)}</button>`).join(' ')} <button class="row-edit" data-item="${esc(r.id)}" data-choice="ignore">Leave as is</button> ${editBtn(r)}${editKey === keyOf(r) ? editHtml(r) : ''}</div>`).join('')}
          ${list.length > 40 ? `<div class="subtitle">…and ${list.length - 40} more of this kind. Use the button above, or fix these first and the rest will show.</div>` : ''}</details>`; }).join('')}`;
    foot.innerHTML = `<label class="fm-check" style="margin-right:auto;"><input type="checkbox" id="impOk"><span>I have reviewed this</span></label><button class="btn" id="impCancel">Cancel</button><button class="btn primary" id="impGo" disabled>Import ${s.rentals} rentals and ${s.expenses} expenses</button>`;
    document.getElementById('impCancel').onclick = close;
    document.getElementById('impOk').onchange = e => { document.getElementById('impGo').disabled = !e.target.checked; };
    document.getElementById('impGo').onclick = () => {
      if(ctx.checkpoint) ctx.checkpoint();      // the ledger as it was is kept as an automatic copy before the import is added
      const d = ctx.getDb(); const log = mergeImport(d, res, { today: res.today });
      d.settings.importDecisions = JSON.stringify(state);
      ctx.markDirty(); ctx.renderAll(); close();
      const a = log.added; ctx.toast(`Imported ${a.rentals || 0} rentals, ${a.expenses || 0} expenses, ${a.invoices || 0} invoices, ${(a.payments || 0) + (a.paymentsNotLinked || 0)} payments, ${a.clients || 0} new clients` + (a.driverJobs ? `, ${a.driverJobs} sub-hire driver jobs tied to their rentals` : '') + (a.retypedSelf ? `, ${a.retypedSelf} rentals set to self-drive` : '') + ((log.skipped.rentals) ? `; ${log.skipped.rentals} rentals were already there` : ''));
    };
  }
  function pick(item, choice){ state = decide(state, item, choice); }
  overlay.addEventListener('toggle', e => { const d = e.target; if(d && d.dataset && d.dataset.gk){ if(d.open) openGroups.add(d.dataset.gk); else openGroups.delete(d.dataset.gk); } }, true);
  overlay.addEventListener('click', e => {
    const fx = e.target.closest('[data-fix]');
    if(fx && res && res.ok){
      const a = fx.dataset.fix, body = document.getElementById('impBody');
      if(a === 'item'){ const r = res.review.find(x => keyOf(x) === fx.dataset.key); if(r){ listScroll = body.scrollTop; openFix({ kind: 'item', key: keyOf(r), sheet: r.sheet, row: r.row, item: r }); } return; }
      if(a === 'check'){ const c = res.checks[Number(fx.dataset.i)]; if(c){ listScroll = body.scrollTop; openFix({ kind: 'check', sheet: c.sheet, row: c.row || 1, check: c }); } return; }
      if(a === 'note'){ const n = res.notes[Number(fx.dataset.i)]; if(n){ listScroll = body.scrollTop; openFix({ kind: 'note', sheet: n.sheet, row: n.row, text: n.text }); } return; }
      if(a === 'back'){ view = null; draw(); document.getElementById('impBody').scrollTop = listScroll; return; }
      if(a === 'more' && view){ view.span = (view.span || 8) + 12; draw(); const t = document.getElementById('fixTarget'); if(t) t.scrollIntoView({ block: 'center' }); return; }
      if((a === 'prev' || a === 'next') && view && view.kind === 'item'){ const items = openItems(), i = items.findIndex(r => keyOf(r) === view.key), j = a === 'prev' ? i - 1 : i + 1;
        if(items[j]) openFix({ kind: 'item', key: keyOf(items[j]), sheet: items[j].sheet, row: items[j].row, item: items[j] }); return; }
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if(ed){ editKey = editKey === ed.dataset.edit ? null : ed.dataset.edit; const bd = document.getElementById('impBody'), sc = bd.scrollTop; draw(); bd.scrollTop = sc; return; }
    const sv = e.target.closest('[data-editsave]');
    if(sv){ const item = res.review.find(r => r.id === sv.dataset.editsave); if(!item) return;
      const set = {}; let bad = '';
      sv.parentElement.querySelectorAll('[data-ef]').forEach(inp => { const k = inp.dataset.ef, v = inp.value.trim(); if(v === inp.dataset.orig.trim()) return;
        if((k === 'pickup' || k === 'return' || k === 'date') && !/^\d{4}-\d{2}-\d{2}$/.test(v)){ bad = 'Dates must look like 2026-03-15'; return; }
        if(k === 'amount' || k === 'days'){ if(v === '' || isNaN(Number(v))){ bad = 'Enter a number for ' + k; return; } set[k] = Number(v); }
        else if(k === 'reg'){ set[k] = normReg(v); } else set[k] = v; });
      if(bad){ ctx.toast(bad); return; }
      if(!Object.keys(set).length){ ctx.toast('Nothing changed.'); return; }
      let moveTo; if(view && view.kind === 'item'){ const items = openItems(), i = items.findIndex(r => keyOf(r) === keyOf(item)), nx = items[i + 1] || items[i - 1]; moveTo = nx ? keyOf(nx) : null; }
      editKey = null; pick(item, { set }); ctx.toast('Changed. It is checked again and remembered if you import a newer file.'); run(moveTo); return; }
    const b = e.target.closest('[data-item]');
    if(b){ const item = res.review.find(r => r.id === b.dataset.item); if(!item) return;
      let moveTo; if(view && view.kind === 'item'){ const items = openItems(), i = items.findIndex(r => keyOf(r) === keyOf(item)), nx = items[i + 1] || items[i - 1]; moveTo = nx ? keyOf(nx) : null; }   // after a fix, carry on with the next one
      pick(item, b.dataset.choice === 'ignore' ? 'ignore' : item.choices[Number(b.dataset.choice)]); run(moveTo); return; }
    const g = e.target.closest('[data-bulk]');
    if(g){ const [sev, prob] = g.dataset.bulk.split(' | '); res.review.filter(r => r.severity === sev && r.problem === prob && r.choices && r.choices[0] && r.choices[0].set).forEach(r => pick(r, r.choices[0])); run(); }
  });
  input.addEventListener('change', async () => {
    const f = input.files[0]; input.value = ''; if(!f) return;
    fileName = f.name; ctx.toast('Reading ' + f.name + '…'); if(ctx.keepOriginal) ctx.keepOriginal(f);
    try{
      raw = await readWorkbook(f);
      if(isFleetPilotBackup(raw)){
        res = null; view = null;
        document.getElementById('impSub').textContent = f.name;
        document.getElementById('impBody').innerHTML = '<p><b>This is a FleetPilot database backup.</b></p><p>Import Excel is for reading your original performance workbook. Importing a FleetPilot export here can treat report totals as new rental records and inflate your figures.</p><p>To restore this file, close this message and use <b>Open Excel backup</b> instead. This warning prevents any records from being added.</p>';
        document.getElementById('impFoot').innerHTML = '<button class="btn" id="impCancel">Close</button>';
        document.getElementById('impCancel').onclick = close;
        overlay.classList.add('show');
        return;
      }
      const saved = ctx.getDb().settings.importDecisions; try{ state = saved ? JSON.parse(saved) : { overrides: {}, ignores: [] }; }catch(e){ state = { overrides: {}, ignores: [] }; }
      view = null; listScroll = 0; overlay.classList.add('show'); run();
    }catch(err){ console.error(err); ctx.toast('Could not read that file: ' + (err.message || err)); }
  });
  return { open: () => input.click() };
}
