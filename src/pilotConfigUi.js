/* The ⋮ menu next to "Pilot" and its "Pilot display" window. Everything changes at once and is saved with the ledger.
   Sections: the links under Pilot in the left menu (add / remove / rename / reorder), the sections shown inside Pilot, the Pages buttons, and the Overview columns. */
import * as PC from './pilotConfig.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* api: { lists(): { links, tabs, pages, cols }, destinations: [{dest,label,group}], save(patch), reset(which) } */
export function initPilotConfigUi(api){
  let menu = null, overlay = null;

  function closeMenu(){ if(menu){ menu.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escKey, true); } }
  function outside(e){ if(menu && !menu.contains(e.target) && !e.target.closest('[data-pldots]')) closeMenu(); }
  function escKey(e){ if(e.key === 'Escape') closeMenu(); }
  function openMenu(anchor){
    closeMenu();
    menu = document.createElement('div'); menu.className = 'pl-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button type="button" role="menuitem" data-plm="config">⚙ Pilot display…</button><button type="button" role="menuitem" data-plm="reset">↺ Show everything again</button>';
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect(), w = menu.offsetWidth || 210;
    menu.style.top = Math.min(window.innerHeight - 100, r.bottom + 4) + 'px'; menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    menu.addEventListener('click', e => { const b = e.target.closest('[data-plm]'); if(!b) return; closeMenu();
      if(b.dataset.plm === 'config') openConfig();
      else if(window.confirm('Show every section, page and column again, with their original names, and restore the left-menu links?')){ api.reset('all'); } });
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escKey, true);
    const first = menu.querySelector('button'); if(first) first.focus();
  }

  const rowTools = (kind, id, i, n) => `<button type="button" class="row-edit" data-pc="up" data-k="${kind}" data-id="${esc(id)}" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">▲</button><button type="button" class="row-edit" data-pc="down" data-k="${kind}" data-id="${esc(id)}" ${i === n - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">▼</button>`;
  function listSection(kind, title, note, list){
    const shown = list.filter(x => !x.hidden), hidden = list.filter(x => x.hidden);
    return `<h3 style="margin:18px 0 4px;">${title}</h3><p class="subtitle" style="margin:0 0 6px;">${note}</p>
      ${list.map((x, i) => `<div class="pc-row" style="${x.hidden ? 'opacity:.55;' : ''}">${rowTools(kind, x.id, i, list.length)}
        <input data-pc="label" data-k="${kind}" data-id="${esc(x.id)}" value="${esc(x.label)}" maxlength="32" aria-label="Name of ${esc(x.defLabel)}" ${x.hidden ? 'disabled' : ''}>
        ${x.label !== x.defLabel ? `<span class="subtitle" style="margin:0;white-space:nowrap;">was ${esc(x.defLabel)}</span>` : ''}
        ${x.hidden ? `<button type="button" class="row-edit" data-pc="show" data-k="${kind}" data-id="${esc(x.id)}">+ Add back</button>` : `<button type="button" class="row-del" data-pc="hide" data-k="${kind}" data-id="${esc(x.id)}" ${shown.length === 1 ? 'disabled' : ''} title="${shown.length === 1 ? 'At least one must stay' : 'Remove from view'}">✕ Remove</button>`}</div>`).join('')}
      ${hidden.length ? '' : ''}<div style="margin-top:4px;"><button type="button" class="row-edit" data-pc="reset" data-k="${kind}">↺ Original list</button></div>`;
  }
  function linksSection(links){
    const groups = {}; api.destinations.forEach(d => { (groups[d.group] = groups[d.group] || []).push(d); });
    return `<h3 style="margin:6px 0 4px;">Links under Pilot (left menu)</h3><p class="subtitle" style="margin:0 0 6px;">The shortcuts shown under Pilot once the admin area is open. Add the ones you use, remove the ones you do not, and rename them.</p>
      ${links.map((x, i) => `<div class="pc-row">${rowTools('links', x.id, i, links.length)}<input data-pc="label" data-k="links" data-id="${esc(x.id)}" value="${esc(x.label)}" maxlength="32" aria-label="Name of this link">
        <span class="subtitle" style="margin:0;white-space:nowrap;">→ ${esc((api.destinations.find(d => d.dest === x.dest) || {}).label || x.dest)}</span><button type="button" class="row-del" data-pc="remove-link" data-id="${esc(x.id)}">✕ Remove</button></div>`).join('') || '<p class="subtitle">No links. Add one below.</p>'}
      <div class="pc-row" style="margin-top:6px;"><select id="pcNewDest" aria-label="Where the new link goes">${Object.keys(groups).map(g => `<optgroup label="${esc(g)}">${groups[g].map(d => `<option value="${esc(d.dest)}">${esc(d.label)}</option>`).join('')}</optgroup>`).join('')}</select>
        <input id="pcNewLabel" placeholder="Name (optional)" maxlength="32" aria-label="Name of the new link"><button type="button" class="btn primary" data-pc="add-link" style="width:auto;padding:6px 14px;margin:0;">+ Add link</button></div>
      <div style="margin-top:4px;"><button type="button" class="row-edit" data-pc="reset" data-k="links">↺ Original links</button></div>`;
  }
  function body(){
    const L = api.lists();
    return linksSection(L.links)
      + listSection('tabs', 'Sections inside Pilot', 'The buttons along the top of Pilot. Removing one only hides the button; nothing is deleted.', L.tabs)
      + listSection('pages', 'Pages', 'The page buttons under Pages.', L.pages)
      + listSection('cols', 'Overview columns', 'Hiding a column here does not change any total: "Total spent" still counts every cost.', L.cols);
  }
  function draw(){ const keep = overlay.querySelector('#pcBody'); const top = keep ? keep.scrollTop : 0; overlay.querySelector('#pcBody').innerHTML = body(); overlay.querySelector('#pcBody').scrollTop = top; }
  function openConfig(){
    if(overlay) overlay.remove();
    overlay = document.createElement('div'); overlay.className = 'modal-overlay show'; overlay.id = 'pilotConfigOverlay';
    overlay.innerHTML = `<div class="modal-box fm-box" role="dialog" aria-modal="true" aria-labelledby="pcTitle" style="max-width:720px;width:94vw;max-height:90vh;display:flex;flex-direction:column;"><div class="fm-head"><div><h2 id="pcTitle">Pilot display</h2><p>Choose what Pilot shows and what it is called. Changes apply at once.</p></div><button type="button" class="fm-close" id="pcClose" aria-label="Close">✕</button></div><div id="pcBody" style="overflow:auto;padding:12px 18px 18px;flex:1;"></div></div>`;
    document.body.appendChild(overlay); draw();
    const close = () => { overlay.remove(); overlay = null; };
    overlay.querySelector('#pcClose').addEventListener('click', close);
    overlay.addEventListener('click', e => { if(e.target === overlay){ close(); return; } onClick(e); });
    overlay.addEventListener('change', onChange);
    overlay.addEventListener('keydown', e => { if(e.key === 'Escape'){ close(); } else if(e.key === 'Enter' && e.target.matches('input[data-pc="label"]')){ e.target.blur(); } });
    const f = overlay.querySelector('input'); if(f) f.focus();
  }
  const listOf = k => api.lists()[k];
  function onClick(e){
    const b = e.target.closest('[data-pc]'); if(!b || b.disabled) return; const a = b.dataset.pc, k = b.dataset.k, id = b.dataset.id;
    if(a === 'up' || a === 'down'){ api.save({ [k]: PC.move(listOf(k), id, a === 'up' ? -1 : 1) }); }
    else if(a === 'hide'){ api.save({ [k]: PC.setHidden(listOf(k), id, true) }); }
    else if(a === 'show'){ api.save({ [k]: PC.setHidden(listOf(k), id, false) }); }
    else if(a === 'remove-link'){ api.save({ links: PC.removeLink(api.lists().links, id) }); }
    else if(a === 'add-link'){ const sel = overlay.querySelector('#pcNewDest'), d = api.destinations.find(x => x.dest === sel.value); if(!d) return;
      api.save({ links: PC.addLink(api.lists().links, d.dest, overlay.querySelector('#pcNewLabel').value, d.label) }); }
    else if(a === 'reset'){ api.reset(k); }
    else return;
    if(overlay) draw();
  }
  function onChange(e){
    const i = e.target.closest('input[data-pc="label"]'); if(!i) return; const k = i.dataset.k, id = i.dataset.id;
    api.save({ [k]: k === 'links' ? PC.renameLink(api.lists().links, id, i.value) : PC.rename(listOf(k), id, i.value) });
    if(overlay) draw();
  }
  return { openMenu, openConfig, closeMenu };
}
