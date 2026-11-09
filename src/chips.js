/* Category chips: a row of buttons with a count on each, one tap filters the table, a second tap on the same chip clears it.
   Used by Fuel, Performance, Sub-hire and Pages > Invoices. Nothing here changes data; it only chooses which rows are shown.

   A "group" is one row of chips: { id, label, options: [{ key, label }], test: (row, key) => boolean }.
   `active` is { groupId: key } ('' or missing = All).
   The count on a chip is the number of rows that chip would show GIVEN the other rows of chips already chosen
   (so after choosing Coop, the Ola / Outside / Mixed counts are for Coop rentals only). */

export function applyFacets(rows, groups, active, skipId){
  active = active || {};
  return rows.filter(r => groups.every(g => g.id === skipId || !active[g.id] || g.test(r, active[g.id])));
}
export function facetCounts(rows, groups, active){
  const out = {};
  groups.forEach(g => {
    const base = applyFacets(rows, groups, active, g.id), c = { '': base.length };
    g.options.forEach(o => { c[o.key] = base.filter(r => g.test(r, o.key)).length; });
    out[g.id] = c;
  });
  return out;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `.fp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0;}
.fp-chips .fp-chip-l{font-size:12px;color:var(--ink-dim);margin-right:2px;min-width:64px;}
.fp-chip{border:1px solid var(--line);background:var(--panel-2);color:var(--ink);border-radius:999px;padding:4px 12px;font-size:12.5px;font-family:var(--sans);cursor:pointer;}
.fp-chip:hover{border-color:var(--amber);}
.fp-chip.on{background:var(--amber);color:#1a1a1a;border-color:var(--amber);font-weight:600;}
.fp-chip small{opacity:.75;margin-left:4px;font-family:var(--mono);}
.fp-chip.zero:not(.on){opacity:.45;}`;
export function ensureChipStyles(){
  try{ if(typeof document === 'undefined' || document.getElementById('fpChipCss')) return; const s = document.createElement('style'); s.id = 'fpChipCss'; s.textContent = CSS; document.head.appendChild(s); }catch(e){}
}
/* one row of chips. scope = the screen ('fuel', 'perf' ...) so clicks can be told apart. */
export function chipsHtml(scope, group, counts, active){
  const cur = (active && active[group.id]) || '', c = counts || {};
  const chip = (key, label) => `<button type="button" class="fp-chip ${cur === key ? 'on' : ''} ${c[key] ? '' : 'zero'}" data-chip="${esc(scope)}" data-group="${esc(group.id)}" data-key="${esc(key)}" aria-pressed="${cur === key}">${esc(label)}<small>${c[key] || 0}</small></button>`;
  return `<div class="fp-chips" role="group" aria-label="${esc(group.label)}"><span class="fp-chip-l">${esc(group.label)}</span>${chip('', 'All')}${group.options.map(o => chip(o.key, o.label)).join('')}</div>`;
}
/* the tap: returns { group, key } with key '' when the chip that is already on was tapped again (= clear), or null when the click was not on a chip of this scope */
export function chipTap(e, scope, active){
  const b = e.target && e.target.closest ? e.target.closest('[data-chip]') : null;
  if(!b || b.dataset.chip !== scope) return null;
  const key = b.dataset.key, group = b.dataset.group;
  return { group, key: key !== '' && (active || {})[group] === key ? '' : key };
}
