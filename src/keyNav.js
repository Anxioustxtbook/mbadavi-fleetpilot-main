/* Keyboard navigation, so the whole app can be used without a mouse.
   - Tab / Shift+Tab walk through everything clickable; a clear gold outline shows where you are.
   - Sidebar: Up / Down / Home / End move between screens, Enter opens one.
   - Alt+1 ... Alt+9 open the first nine screens; Alt+Up / Alt+Down go to the previous / next screen.
   - Tables: arrow keys move between cells (and between buttons in a row); Enter / Space presses a figure or card;
     Enter or F2 on an editable cell starts editing (Enter saves, Esc cancels) and focus stays on that cell.
   - "/" or Ctrl+K: search (the table search, or Search everything on the Dashboard).
   - Alt+M: jump into the screen's content.   Alt+Left: back (already in the app).   ?: shows this list.   Esc closes it.
   Nothing here changes data; it only moves focus and presses buttons the same way a click would. */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/* things that react to a click but are not buttons: made reachable by keyboard */
const CLICKABLE = '.card[data-goto],#expCatTable tbody tr,td[data-g="cell"],[data-pg]:not(button):not(a),[data-open]:not(button):not(a),[onclick]:not(button):not(a):not(input):not(select):not(label)';
const TYPING = 'INPUT,SELECT,TEXTAREA';

const HELP = [
  ['Tab / Shift+Tab', 'Move to the next / previous button or field'],
  ['↑ ↓ (sidebar)', 'Move between screens; Enter opens the one you are on'],
  ['Alt+1 … Alt+9', 'Open Dashboard, Vehicles, Drivers … (first nine screens)'],
  ['Alt+↑ / Alt+↓', 'Previous / next screen'],
  ['Arrow keys (in a table)', 'Move between cells, rows and the buttons in a row'],
  ['Enter or Space', 'Press the highlighted button, figure or card'],
  ['Enter or F2 (on a cell)', 'Edit the cell. Enter saves, Esc cancels'],
  ['/  or  Ctrl+K', 'Search'],
  ['Alt+M', 'Jump into the content of this screen'],
  ['Alt+←', 'Back'],
  ['?', 'Show or hide this list'],
  ['Esc', 'Close a window, list or this help']
];

const visible = el => {
  if(!el || !el.isConnected) return false;
  const r = el.getClientRects();
  if(!r.length) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
};
const typingIn = el => !!el && (TYPING.includes(el.tagName) || el.isContentEditable);
const splashOn = () => {
  const idle = document.getElementById('idleSplash');
  if(idle && idle.classList.contains('on')) return true;
  const intro = document.getElementById('introSplash');
  if(intro && visible(intro)){ const s = getComputedStyle(intro); if(Number(s.opacity) > 0.05) return true; }
  return false;
};
const overlayOpen = () => [...document.querySelectorAll('.modal-overlay.show,#importOverlay.show,.fm-overlay.show,#fileModal.show')].some(visible);

function injectStyle(){
  if(document.getElementById('keyNavStyle')) return;
  const st = document.createElement('style'); st.id = 'keyNavStyle';
  st.textContent = `
  :focus-visible{outline:2px solid #E0A030;outline-offset:2px;}
  input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #E0A030;outline-offset:1px;}
  td[data-g="cell"]:focus-visible,#expCatTable tbody tr:focus-visible,tr[tabindex]:focus-visible{outline:2px solid #E0A030;outline-offset:-2px;background:rgba(224,160,48,.12);}
  .nav button:focus-visible{outline-offset:-2px;background:var(--panel-2);}
  .card[data-goto]:focus-visible,[data-pg]:focus-visible{outline-offset:3px;}
  .kn-help{position:fixed;inset:0;z-index:10050;background:rgba(6,9,13,.55);display:flex;align-items:center;justify-content:center;padding:16px;}
  .kn-box{background:var(--panel,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);border-radius:12px;max-width:520px;width:100%;max-height:86vh;overflow:auto;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35);}
  .kn-box h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between;align-items:center;gap:10px;}
  .kn-box table{width:100%;border-collapse:collapse;font-size:13px;}
  .kn-box td{padding:6px 4px;border-top:1px solid var(--line-soft,#ddd);vertical-align:top;}
  .kn-box td:first-child{white-space:nowrap;font-family:var(--mono,monospace);font-weight:600;padding-right:14px;}
  .kn-box button{cursor:pointer;border:1px solid var(--line,#ccc);background:var(--panel-2,#eee);color:inherit;border-radius:7px;padding:4px 10px;font:inherit;}
  .kn-hint{position:fixed;left:240px;bottom:8px;z-index:5;font-size:11px;color:var(--ink-faint,#888);pointer-events:none;}
  @media(max-width:900px){.kn-hint{display:none;}}
  @media print{.kn-help,.kn-hint{display:none !important;}}`;
  document.head.appendChild(st);
}

/* make click-only things reachable; in a table only one cell/row per table sits in the Tab order (arrows do the rest) */
function enhance(root){
  const scope = root && root.querySelectorAll ? root : document;
  const list = [...scope.querySelectorAll(CLICKABLE)];
  if(scope !== document && scope.matches && scope.matches(CLICKABLE)) list.push(scope);
  for(const el of list){
    if(el.hasAttribute('tabindex')) continue;
    const inTable = el.tagName === 'TD' || el.tagName === 'TR';
    el.setAttribute('tabindex', inTable ? '-1' : '0');
    if(!inTable && !el.getAttribute('role')) el.setAttribute('role', 'button');
  }
  const tables = new Set();
  list.forEach(el => { const t = el.closest && el.closest('table'); if(t) tables.add(t); });
  tables.forEach(t => {
    if(t.querySelector('[tabindex="0"]:is(td,tr)')) return;
    const first = t.querySelector('td[tabindex],tr[tabindex]');
    if(first) first.setAttribute('tabindex', '0');
  });
}

function rowCandidates(tr){
  const out = [];
  [...tr.cells].forEach(td => {
    if(td.hasAttribute('tabindex')) { out.push(td); return; }
    const f = [...td.querySelectorAll(FOCUSABLE)].filter(visible);
    f.forEach(x => out.push(x));
  });
  return out.filter(visible);
}
function cellOf(el){ return el.closest('td,th'); }
function focusEl(el){ if(!el) return false; if(el.tagName === 'TD' || el.tagName === 'TR'){ document.querySelectorAll('[tabindex="0"]:is(td,tr)').forEach(x => { if(x !== el && x.closest('table') === el.closest('table')) x.setAttribute('tabindex', '-1'); }); el.setAttribute('tabindex', '0'); } el.focus({ preventScroll: false }); if(el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; }

function tableMove(target, key){
  const table = target.closest('table'); if(!table) return false;
  const rows = [...table.rows].filter(visible);
  if(target.tagName === 'TR'){
    const i = rows.indexOf(target); const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0; if(!step) return false;
    for(let j = i + step; j >= 0 && j < rows.length; j += step){ if(rows[j].hasAttribute('tabindex')){ focusEl(rows[j]); return true; } }
    return false;
  }
  const td = cellOf(target); const tr = td && td.parentElement; if(!tr) return false;
  if(key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End'){
    const c = rowCandidates(tr); if(!c.length) return false;
    let i = c.findIndex(x => x === target || x.contains(target));
    if(i < 0) i = 0;
    const n = key === 'Home' ? 0 : key === 'End' ? c.length - 1 : i + (key === 'ArrowRight' ? 1 : -1);
    if(n < 0 || n >= c.length || n === i) return false;
    return focusEl(c[n]);
  }
  if(key === 'ArrowDown' || key === 'ArrowUp'){
    const step = key === 'ArrowDown' ? 1 : -1;
    const cands = rowCandidates(tr); const idx = cands.findIndex(x => x === target || x.contains(target));
    const col = [...tr.cells].indexOf(td);
    const sameCell = idx >= 0 ? cands.filter(x => cellOf(x) === td).indexOf(target) : 0;
    for(let j = rows.indexOf(tr) + step; j >= 0 && j < rows.length; j += step){
      const r = rows[j]; if(r.parentElement.tagName === 'THEAD' && step > 0) continue;
      const cell = r.cells[col]; if(!cell) continue;
      let t = null;
      if(cell.hasAttribute('tabindex')) t = cell;
      else { const f = [...cell.querySelectorAll(FOCUSABLE)].filter(visible); t = f[Math.min(Math.max(sameCell, 0), f.length - 1)] || null; }
      if(t) return focusEl(t);
    }
  }
  return false;
}

function navButtons(){ return [...document.querySelectorAll('#nav button[data-panel]')].filter(visible); }
function openScreen(i){ const b = navButtons()[i]; if(b){ b.click(); setTimeout(() => b.focus(), 60); return true; } return false; }

function findSearch(){
  const panel = document.querySelector('.panel.active'); if(!panel) return null;
  const direct = [...panel.querySelectorAll('input[type=search],input.tt-search,input[id*="earch"]')].find(visible);
  if(direct) return { input: direct };
  const btn = [...panel.querySelectorAll('#btnGlobalSearchToggle,.tt-btn')].find(visible);
  return btn ? { button: btn } : null;
}
function doSearch(){
  const s = findSearch(); if(!s) return false;
  if(s.input){ s.input.focus(); if(s.input.select) s.input.select(); return true; }
  const wasOpen = s.button.closest('.tt-bar') && s.button.closest('.tt-bar').classList.contains('open');
  if(!wasOpen) s.button.click();
  setTimeout(() => { const bar = s.button.closest('.tt-bar'); const i = (bar && bar.querySelector('input')) || document.querySelector('.panel.active input[type=search]'); if(i) i.focus(); }, 80);
  return true;
}

function jumpToContent(){
  const panel = document.querySelector('.panel.active'); if(!panel) return false;
  const f = [...panel.querySelectorAll(FOCUSABLE)].filter(visible)[0];
  if(f){ f.focus(); return true; } panel.setAttribute('tabindex', '-1'); panel.focus(); return true;
}

let helpEl = null, helpFrom = null;
function closeHelp(){ if(!helpEl) return false; helpEl.remove(); helpEl = null; if(helpFrom && helpFrom.isConnected) helpFrom.focus(); helpFrom = null; return true; }
function openHelp(){
  if(helpEl) return closeHelp();
  helpFrom = document.activeElement;
  helpEl = document.createElement('div'); helpEl.className = 'kn-help'; helpEl.setAttribute('role', 'dialog'); helpEl.setAttribute('aria-label', 'Keyboard shortcuts');
  helpEl.innerHTML = `<div class="kn-box"><h3>Keyboard shortcuts <button type="button" id="knClose">Close (Esc)</button></h3><table>${HELP.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('')}</table></div>`;
  helpEl.addEventListener('click', e => { if(e.target === helpEl) closeHelp(); });
  helpEl.querySelector('#knClose').addEventListener('click', closeHelp);
  document.body.appendChild(helpEl); helpEl.querySelector('#knClose').focus();
  return true;
}

export function initKeyNav(){
  if(window.__keyNavOn) return; window.__keyNavOn = true;
  injectStyle(); enhance(document);

  /* keep new content reachable after every redraw */
  let pend = null, q = new Set();
  new MutationObserver(list => {
    list.forEach(m => m.addedNodes.forEach(n => { if(n.nodeType === 1 && !(n.closest && n.closest('.kn-help'))) q.add(n); }));
    if(pend || (!q.size && !wantBack)) return;
    pend = setTimeout(() => { pend = null; const nodes = [...q]; q.clear(); nodes.forEach(n => { if(n.isConnected) enhance(n); }); restoreCell(); }, 30);
  }).observe(document.body, { childList: true, subtree: true });

  /* editable cell: after Enter/Esc the table is redrawn; put focus back on the same cell */
  let lastCell = null, wantBack = null;
  document.addEventListener('focusin', e => {
    const t = e.target;
    if(t.matches && t.matches('td[data-g="cell"]')){ lastCell = { t: t.dataset.t, r: t.dataset.r, c: t.dataset.c }; const tb = t.closest('table'); if(tb){ tb.querySelectorAll('td[data-g="cell"][tabindex="0"],tr[tabindex="0"]').forEach(x => { if(x !== t) x.setAttribute('tabindex', '-1'); }); t.setAttribute('tabindex', '0'); } }
    else if(t.matches && t.matches('#expCatTable tbody tr')){ const tb = t.closest('table'); tb.querySelectorAll('tr[tabindex="0"]').forEach(x => { if(x !== t) x.setAttribute('tabindex', '-1'); }); t.setAttribute('tabindex', '0'); }
  });
  document.addEventListener('pointerdown', () => { wantBack = null; }, true);
  function restoreCell(){
    if(!wantBack) return;
    const w = wantBack; if(Date.now() - w.at > 1500){ wantBack = null; return; }
    const a = document.activeElement;
    if(a && a !== document.body && a.isConnected) return;          // focus is somewhere real already
    const cell = [...document.querySelectorAll('td[data-g="cell"]')].find(el => el.dataset.t === w.t && String(el.dataset.r) === String(w.r) && el.dataset.c === w.c);
    if(cell){ wantBack = null; focusEl(cell); }
  }
  /* capture phase: the editor removes its own input on Enter/Esc before the event bubbles up, so note the cell first */
  document.addEventListener('keydown', e => {
    const t = e.target;
    if((e.key === 'Enter' || e.key === 'Escape') && t.tagName && TYPING.includes(t.tagName) && t.parentElement && t.parentElement.matches('td[data-g="cell"]')){
      const td = t.parentElement; wantBack = { t: td.dataset.t, r: td.dataset.r, c: td.dataset.c, at: Date.now() };
    }
  }, true);

  document.addEventListener('keydown', e => {
    if(e.defaultPrevented || e.isComposing) return;
    if(splashOn()) return;
    const t = e.target, key = e.key;

    /* help window owns the keyboard while open */
    if(helpEl){ if(key === 'Escape' || key === '?'){ e.preventDefault(); closeHelp(); } else if(key === 'Tab'){ e.preventDefault(); helpEl.querySelector('#knClose').focus(); } return; }

    if(typingIn(t)) return;     // never steal keys while typing

    const mod = e.ctrlKey || e.metaKey;

    /* shortcuts that work anywhere (not while a window is open) */
    if(!overlayOpen()){
      if(e.altKey && !mod && /^[1-9]$/.test(key)){ if(openScreen(Number(key) - 1)){ e.preventDefault(); } return; }
      if(e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')){
        const b = navButtons(); const cur = b.findIndex(x => x.classList.contains('active')); const n = cur + (key === 'ArrowDown' ? 1 : -1);
        if(n >= 0 && n < b.length){ e.preventDefault(); openScreen(n); } return;
      }
      if(e.altKey && !mod && (key === 'm' || key === 'M')){ e.preventDefault(); jumpToContent(); return; }
      if((key === '/' && !mod && !e.altKey) || (mod && (key === 'k' || key === 'K'))){ if(doSearch()){ e.preventDefault(); } return; }
    }
    if(key === '?' && !mod){ e.preventDefault(); openHelp(); return; }
    if(mod || e.altKey) return;

    /* Esc: close the "how this was made" list if one is open and nothing else is */
    if(key === 'Escape'){
      if(overlayOpen()) return;
      const dr = document.getElementById('pgDrill');
      if(dr){ const x = dr.querySelector('[data-pg="closedrill"]'); if(x){ e.preventDefault(); x.click(); } }
      return;
    }

    /* sidebar: roving arrows */
    if(t.closest && t.closest('#nav') && t.matches('button[data-panel]')){
      const b = navButtons(); const i = b.indexOf(t);
      const n = key === 'ArrowDown' ? i + 1 : key === 'ArrowUp' ? i - 1 : key === 'Home' ? 0 : key === 'End' ? b.length - 1 : -1;
      if(n >= 0 && n < b.length){ e.preventDefault(); b[n].focus(); }
      return;
    }

    /* pressing things that are not real buttons */
    const clickLike = t.matches && t.matches('[role="button"],td[data-g="cell"],#expCatTable tbody tr,.card[data-goto]');
    if(clickLike && (key === 'Enter' || key === ' ' || (key === 'F2' && t.matches('td[data-g="cell"]')))){
      e.preventDefault();
      if(t.matches('td[data-g="cell"]')) wantBack = { t: t.dataset.t, r: t.dataset.r, c: t.dataset.c, at: Date.now() };
      t.click(); return;
    }

    /* tables: arrows */
    if(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key) && t.closest && t.closest('table')){
      if(tableMove(t, key)) e.preventDefault();
    }
  });

  /* a small reminder at the foot of the screen */
  const hint = document.createElement('div'); hint.className = 'kn-hint'; hint.textContent = 'Press ? for keyboard shortcuts'; document.body.appendChild(hint);
}
