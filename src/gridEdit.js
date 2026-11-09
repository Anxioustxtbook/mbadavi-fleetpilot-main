/* Editable sheets: every table that looks like an Excel sheet is drawn with this, so it behaves the same everywhere.
     - click a cell to change it (Enter or leaving the cell saves, Esc cancels)
     - "+ Add line" adds a row, ✕ removes one (asks first), B makes a row bold, ◐ highlights it (click again to clear)
     - totals and computed columns are worked out again after every change
   A module describes its table once ("desc") and hands over what to do on a change; nothing here knows about loans or coops.
   desc = { id, title?, cellStyle?(row, colKey)=>css (colour one cell, e.g. a late payment), columns:[{key,label,type:'text'|'number'|'date'|'select'|'money', options?, readonly?, compute?:(row,rows)=>value, align?}],
            rows:[{id, ...fields}], totals?:{ key: 'sum' | (rows)=>value }, label?:'TOTAL',
            onSet(rowId, key, value), onAdd?(), onRemove?(rowId), canRemove?(rowId), rowOpen?(rowId) (extra row button), extra?: html,
            fmt?: n=>string, formats?: db.settings.rowFormats[id] }
   Formats (bold / highlight) are kept in db.settings.rowFormats[tableId][rowId] so they are saved with the file. */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const HL = ['', 'amber', 'green', 'red'];
const HL_CSS = { amber: 'background:rgba(214,168,79,.16)', green: 'background:rgba(53,184,107,.14)', red: 'background:rgba(224,90,82,.14)' };

/* a figure that can be tapped to see how it was made (the same button Pages uses; Pilot handles data-pg="drill") */
export const figBtn = (spec, text, cls) => `<button type="button" class="pg-fig ${cls || ''}" data-pg="drill" data-spec="${esc(JSON.stringify(spec))}" title="Tap to see how this was made">${text}</button>`;

export function getFormat(settings, tableId, rowId){ const t = (settings && settings.rowFormats || {})[tableId]; return (t && t[rowId]) || {}; }
export function setFormat(settings, tableId, rowId, patch){
  settings.rowFormats = settings.rowFormats || {}; const t = settings.rowFormats[tableId] = settings.rowFormats[tableId] || {};
  const f = Object.assign({}, t[rowId], patch);
  if(!f.b) delete f.b; if(!f.hl) delete f.hl;
  if(Object.keys(f).length) t[rowId] = f; else delete t[rowId];
  return f;
}
export function dropFormats(settings, tableId, rowId){ const t = settings && settings.rowFormats && settings.rowFormats[tableId]; if(t) delete t[rowId]; }
export function nextHighlight(cur){ return HL[(HL.indexOf(cur || '') + 1) % HL.length]; }

/* the value a cell shows (computed columns look at the whole row and the other rows) */
export function cellValue(col, row, rows){ return col.compute ? col.compute(row, rows) : row[col.key]; }
export function totalFor(desc, col){
  const t = desc.totals && desc.totals[col.key]; if(!t) return null;
  return typeof t === 'function' ? t(desc.rows) : desc.rows.reduce((s, r) => s + num(cellValue(col, r, desc.rows)), 0);
}
function show(col, v, fmt){
  if(col.type === 'select' && col.options){ const o = col.options.find(x => String(typeof x === 'object' ? x.value : x) === String(v == null ? '' : v)); return o ? String(typeof o === 'object' ? o.label : o) : (v == null ? '' : String(v)); }
  if(v === null || v === undefined || v === '') return '';
  if(col.type === 'money') return (fmt || (n => Number(n).toLocaleString()))(v);
  if(col.type === 'number') return Number(v).toLocaleString();
  return String(v);
}

export function gridHtml(desc){
  const fmt = desc.fmt, cols = desc.columns, fm = desc.formats || {};
  const head = cols.map(c => `<th class="${c.type === 'number' || c.type === 'money' ? 'num' : ''}">${esc(c.label)}</th>`).join('') + '<th></th>';
  const body = desc.rows.map(r => { const f = fm[r.id] || {};
    const cells = cols.map(c => { const v = cellValue(c, r, desc.rows); const ro = c.readonly || !!c.compute; const numeric = c.type === 'number' || c.type === 'money';
      const neg = numeric && num(v) < 0 ? 'color:var(--red);' : '';
      let inner = esc(show(c, v, fmt));
      if(ro && c.drill && inner !== '' && (!numeric || num(v) !== 0)){ let sp = null; try{ sp = c.drill(r, v); }catch(e){ sp = null; } if(sp) inner = figBtn(sp, inner); }
      return `<td class="${numeric ? 'num' : ''} ${ro ? 'g-ro' : 'g-cell'}" ${ro ? '' : `data-g="cell" data-t="${esc(desc.id)}" data-r="${esc(r.id)}" data-c="${esc(c.key)}" title="Click to change"`} style="${neg}${f.b ? 'font-weight:700;' : ''}${desc.cellStyle ? (desc.cellStyle(r, c.key) || '') : ''}">${inner}</td>`; }).join('');
    const rm = desc.onRemove && (!desc.canRemove || desc.canRemove(r.id));
    const tools = `<td class="g-tools" style="white-space:nowrap;text-align:right;"><button type="button" class="row-edit" data-g="bold" data-t="${esc(desc.id)}" data-r="${esc(r.id)}" title="Bold" style="${f.b ? 'color:var(--amber);' : ''}"><b>B</b></button>`
      + `<button type="button" class="row-edit" data-g="hl" data-t="${esc(desc.id)}" data-r="${esc(r.id)}" title="Highlight (click again to change colour)" style="${f.hl ? 'color:var(--amber);' : ''}">◐</button>`
      + (desc.rowOpen ? `<button type="button" class="row-edit" data-g="open" data-t="${esc(desc.id)}" data-r="${esc(r.id)}" title="${esc(desc.rowOpenLabel || 'Open where it is kept')}">↗</button>` : '')
      + (rm ? `<button type="button" class="row-del" data-g="del" data-t="${esc(desc.id)}" data-r="${esc(r.id)}" title="Remove">✕</button>` : '') + '</td>';
    return `<tr style="${f.hl ? HL_CSS[f.hl] : ''}">${cells}${tools}</tr>`; }).join('');
  const hasTot = desc.totals && Object.keys(desc.totals).length;
  const foot = hasTot ? `<tfoot><tr>${cols.map((c, i) => { const t = totalFor(desc, c); const numeric = c.type === 'number' || c.type === 'money';
      let txt = i === 0 && t === null ? esc(desc.label || 'TOTAL') : (t === null ? '' : esc(show({ type: c.type === 'number' ? 'number' : 'money' }, t, fmt)));
      const fd = desc.footDrill && desc.footDrill[c.key]; if(fd && t !== null && num(t) !== 0){ let sp = null; try{ sp = typeof fd === 'function' ? fd(t) : fd; }catch(e){ sp = null; } if(sp) txt = figBtn(sp, txt); }
      return `<th class="${numeric ? 'num' : ''}">${txt}</th>`; }).join('')}<th></th></tr></tfoot>` : '';
  return `<div class="table-wrap g-wrap" data-gt="${esc(desc.id)}">${desc.title ? `<div class="subtitle" style="padding:8px 10px 0;"><b>${esc(desc.title)}</b></div>` : ''}${desc.extra || ''}<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr class="empty-row"><td colspan="${cols.length + 1}">Nothing here yet.</td></tr>`}</tbody>${foot}</table></div>`
    + (desc.onAdd ? `<div style="padding:8px 10px;"><button type="button" class="btn" data-g="add" data-t="${esc(desc.id)}" style="width:auto;padding:6px 14px;">+ Add line</button></div>` : '') + '</div>';
}

/* Wire a container. `registry` is { tableId: desc } refilled on every render; `ctx` = { settings:()=>db.settings, changed:()=>void, confirm?:(msg)=>bool } */
export function bindGrid(root, registry, ctx){
  const find = t => registry[t];
  let ptr = null;   // the cell the pointer went down on: if a change redraws the table, editing carries on in that cell
  root.addEventListener('pointerdown', e => { const c = e.target.closest('[data-g="cell"]'); ptr = c ? { t: c.dataset.t, r: c.dataset.r, c: c.dataset.c } : null; }, true);
  const rowOf = (desc, id) => desc.rows.find(r => String(r.id) === String(id));
  root.addEventListener('click', e => {
    if(e.target.closest('[data-pg]')) return;     // a figure that opens "how it was made" is not an edit
    const el = e.target.closest('[data-g]'); if(!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    const desc = find(el.dataset.t); if(!desc) return; const act = el.dataset.g;
    if(act === 'cell'){ startEdit(el, desc); return; }
    if(act === 'add'){ if(desc.onAdd){ desc.onAdd(); ctx.changed(); } return; }
    if(act === 'bold'){ const cur = (desc.formats || {})[el.dataset.r] || {}; setFormat(ctx.settings(), desc.id, el.dataset.r, { b: cur.b ? 0 : 1 }); ctx.changed(true); return; }
    if(act === 'hl'){ const cur = (desc.formats || {})[el.dataset.r] || {}; setFormat(ctx.settings(), desc.id, el.dataset.r, { hl: nextHighlight(cur.hl) }); ctx.changed(true); return; }
    if(act === 'open'){ if(desc.rowOpen) desc.rowOpen(el.dataset.r); return; }
    if(act === 'del'){ const ok = (ctx.confirm || (m => window.confirm(m)))('Remove this line? It is taken out of the totals as well.'); if(!ok) return;
      desc.onRemove(el.dataset.r); dropFormats(ctx.settings(), desc.id, el.dataset.r); ctx.changed(); }
  });
  function startEdit(td, desc){
    if(td.querySelector('input,select')) return;
    const col = desc.columns.find(c => c.key === td.dataset.c); const row = rowOf(desc, td.dataset.r); if(!col || !row) return;
    const raw = row[col.key]; const old = td.innerHTML; let done = false;
    let input;
    if(col.type === 'select'){ input = document.createElement('select'); (col.options || []).forEach(o => { const v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o; const op = document.createElement('option'); op.value = v; op.textContent = l; if(String(v) === String(raw)) op.selected = true; input.appendChild(op); }); }
    else { input = document.createElement('input'); input.type = col.type === 'date' ? 'date' : (col.type === 'number' || col.type === 'money' ? 'number' : 'text'); if(input.type === 'number') input.step = 'any'; input.value = raw == null ? '' : raw; }
    input.style.cssText = 'width:100%;min-width:70px;padding:3px 5px;'; td.innerHTML = ''; td.appendChild(input); input.focus(); if(input.select) input.select();
    const finish = save => { if(done) return; done = true;
      if(!save){ td.innerHTML = old; return; }
      let v = input.value; if(col.type === 'number' || col.type === 'money') v = v === '' ? 0 : Number(v);
      if(String(v) === String(raw == null ? '' : raw)){ td.innerHTML = old; return; }
      desc.onSet(row.id, col.key, v); ctx.changed();
      if(ptr && !(ptr.t === td.dataset.t && String(ptr.r) === String(td.dataset.r) && ptr.c === td.dataset.c)){
        const next = [...root.querySelectorAll('[data-g="cell"]')].find(el => el.dataset.t === ptr.t && String(el.dataset.r) === String(ptr.r) && el.dataset.c === ptr.c), d2 = find(ptr.t);
        ptr = null; if(next && d2) startEdit(next, d2); } };
    input.addEventListener('keydown', ev => { if(ev.key === 'Enter'){ ev.preventDefault(); finish(true); } else if(ev.key === 'Escape'){ finish(false); } });
    input.addEventListener('blur', () => finish(true));
    if(col.type === 'select') input.addEventListener('change', () => finish(true));
  }
}
