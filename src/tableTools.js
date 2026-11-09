/* Table tools, added to every table in the app without touching the screens that draw them.
     - 🔍 Search on every table that has no search of its own (type, rows that do not match are hidden)
     - Totals on top: long tables show the totals of their number columns above the first row, so nobody scrolls to the bottom.
       They follow the search: search a client and the totals are that client's.
     - ← Back: goes back through the places visited (screens, and Pilot tabs / pages when Pilot tells us).
     - ↑ Top: appears after a long scroll and takes you back to the top.
   Nothing here changes any data. */

const NUM_SKIP = /balance|rate|%|\bkm\b|odo|mileage|year|phone|\bid\b|^no\.?$|^#$|invoice no|contract|receipt/i;
const LONG_ROWS = 8;       // totals on top from this many rows
const SEARCH_ROWS = 3;     // search button from this many rows

const css = `
.tt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12.5px;}
.tt-btn{border:1px solid var(--line);background:var(--panel-2);color:var(--ink-dim);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12.5px;font-family:var(--sans);}
.tt-btn:hover{color:var(--amber);}
.tt-search{display:none;padding:5px 9px;min-width:190px;background:var(--panel-2);border:1px solid var(--line);border-radius:7px;color:var(--ink);font-size:12.5px;font-family:var(--sans);}
.tt-bar.open .tt-search{display:inline-block;}
.tt-count{color:var(--ink-faint);font-family:var(--mono);font-size:11px;}
.tt-tot{display:flex;flex-wrap:wrap;gap:4px 14px;padding:6px 10px;background:var(--panel-2);border-bottom:1px solid var(--line);font-size:12.5px;}
.tt-tot span{white-space:nowrap;color:var(--ink-dim);}
.tt-tot b{color:var(--ink);font-family:var(--mono);}
.tt-tot .tt-lbl{color:var(--amber);font-weight:600;}
#ttBack,#ttTop{position:fixed;z-index:900;border:1px solid var(--amber-dim,var(--line));background:var(--panel-2);color:var(--amber);border-radius:999px;padding:9px 16px;font-size:13px;font-family:var(--sans);cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35);display:none;}
#ttTop{right:22px;bottom:76px;width:44px;height:44px;padding:0;font-size:18px;}
#ttBack{bottom:22px;left:240px;}
#ttBack.show,#ttTop.show{display:block;}
@media(max-width:760px){#ttBack{left:96px;}}
@media print{#ttBack,#ttTop,.tt-bar,.tt-tot{display:none !important;}}
`;

const state = new WeakMap();     // table -> { q, bar, tot }
let scheduled = false;

const textOf = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
export function parseNum(s){
  let t = String(s == null ? '' : s).replace(/KSh|KES|Ksh|ksh|,|\s/g, '');
  if(!t) return null;
  let neg = false;
  if(/^\(.*\)$/.test(t)){ neg = true; t = t.slice(1, -1); }
  if(/^[−–-]/.test(t)){ neg = !neg; t = t.slice(1); }
  if(!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t); return neg ? -n : n;
}
const money = n => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

function bodyRows(table){
  return [...table.tBodies].flatMap(tb => [...tb.rows]).filter(r => !r.classList.contains('empty-row') && !r.querySelector('td[colspan]:only-child'));
}
function hasOwnSearch(wrap){
  const sel = 'input[type="search"],input[id*="search" i],input[id*="find" i],input[placeholder*="search" i],input[placeholder*="find" i]';
  if(wrap.querySelector(sel + ':not(.tt-search)')) return true;
  let p = wrap.previousElementSibling, n = 0;
  while(p && n < 2 && !p.classList.contains('table-wrap')){ if(p.querySelector && (p.matches(sel) || p.querySelector(sel))) return true; p = p.previousElementSibling; n++; }
  return false;
}
function numericColumns(table){
  const head = table.tHead && table.tHead.rows[table.tHead.rows.length - 1]; if(!head) return [];
  return [...head.cells].map((th, i) => ({ i, label: textOf(th), num: th.classList.contains('num') })).filter(c => c.num && c.label && !NUM_SKIP.test(c.label));
}

function apply(table){
  const st = state.get(table); if(!st) return;
  const rows = bodyRows(table), q = (st.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  rows.forEach(r => {
    const hit = !q.length || q.every(w => textOf(r).toLowerCase().includes(w));
    if(hit){ if(r.dataset.ttHide){ r.style.display = ''; delete r.dataset.ttHide; } shown++; }
    else if(!r.dataset.ttHide){ r.dataset.ttHide = '1'; r.style.display = 'none'; }
  });
  const setText = (el, v) => { if(el && el.textContent !== v) el.textContent = v; };
  setText(st.count, q.length ? shown + ' of ' + rows.length + ' rows' : rows.length + ' rows');
  if(st.tot){
    const cols = numericColumns(table);
    if(rows.length < LONG_ROWS || !cols.length){ st.tot.style.display = 'none'; return; }
    const tf = table.tFoot && table.tFoot.rows[0];
    const parts = cols.map(c => {
      let v = null;
      if(tf && !q.length && tf.cells[c.i]) v = parseNum(textOf(tf.cells[c.i]));
      if(v === null){ v = 0; let any = false; rows.forEach(r => { if(r.dataset.ttHide) return; const cell = r.cells[c.i]; const n = cell ? parseNum(textOf(cell)) : null; if(n !== null){ v += n; any = true; } }); if(!any) return null; }
      return `<span>${c.label.replace(/</g, '&lt;')}: <b>${money(v)}</b></span>`;
    }).filter(Boolean);
    if(!parts.length){ st.tot.style.display = 'none'; return; }
    st.tot.style.display = '';
    const html = `<span class="tt-lbl">${q.length ? 'Totals of the ' + shown + ' rows shown' : 'Totals'}</span>${parts.join('')}`;
    if(st.html !== html){ st.html = html; st.tot.innerHTML = html; }
  }
}

function enhance(table){
  const scroll = table.closest('.table-scroll'); if(!scroll) return;
  if(table.closest('.modal-box,.fm-box,#importOverlay') || table.dataset.noTools) return;
  const wrap = scroll.parentElement; if(!wrap) return;
  const rows = bodyRows(table);
  let st = state.get(table);
  if(!st){
    if(rows.length < SEARCH_ROWS && !numericColumns(table).length) return;
    st = { q: '' }; state.set(table, st);
  }
  const wantSearch = rows.length >= SEARCH_ROWS && !hasOwnSearch(wrap);
  const wantTot = rows.length >= LONG_ROWS && numericColumns(table).length > 0;
  if(st.bar && !st.bar.isConnected){ st.bar = null; st.count = null; }
  if(!st.bar && wantSearch){
    const bar = document.createElement('div'); bar.className = 'tt-bar';
    bar.innerHTML = '<button type="button" class="tt-btn" title="Search this table">🔍 Search</button><input type="search" class="tt-search" placeholder="Type to filter the rows…" aria-label="Search this table"><span class="tt-count"></span>';
    const btn = bar.querySelector('button'), inp = bar.querySelector('input');
    btn.addEventListener('click', () => { bar.classList.toggle('open'); if(bar.classList.contains('open')) inp.focus(); else { inp.value = ''; st.q = ''; apply(table); } });
    inp.addEventListener('input', () => { st.q = inp.value; apply(table); });
    inp.addEventListener('keydown', e => { if(e.key === 'Escape'){ inp.value = ''; st.q = ''; bar.classList.remove('open'); apply(table); } });
    wrap.insertBefore(bar, scroll); st.bar = bar; st.count = bar.querySelector('.tt-count');
  }
  /* The totals strip is made ONCE per table. (Before, a table that has its own search, like Payments, reset this every sweep, and every new strip
     triggered the next sweep: strips piled up without end and pushed the table down, which looked like the page sliding.) */
  if(st.tot && !st.tot.isConnected) st.tot = null;
  if(wantTot && !st.tot){
    [...wrap.children].forEach(x => { if(x.classList && x.classList.contains('tt-tot')) x.remove(); });
    const t = document.createElement('div'); t.className = 'tt-tot'; wrap.insertBefore(t, scroll); st.tot = t;
  }
  if(!wantTot && st.tot){ st.tot.style.display = 'none'; }
  apply(table);
}

function sweep(){
  scheduled = false;
  document.querySelectorAll('.panel .table-scroll > table, .panel table.pg-table').forEach(enhance);
}
function schedule(){ if(!scheduled){ scheduled = true; setTimeout(sweep, 120); } }

/* ---- Back ---- */
const hist = [];           // { label, go }
let current = null, going = false;
function panelOf(){ const a = document.querySelector('.nav button.active'); return a ? { key: 'panel:' + a.dataset.panel, label: textOf(a.querySelector('.label-txt') || a) || a.dataset.panel, panel: a.dataset.panel } : null; }
function refreshBack(){ const b = document.getElementById('ttBack'); if(!b) return; b.classList.toggle('show', hist.length > 0); if(hist.length){ const t = '← Back to ' + hist[hist.length - 1].label; if(b.textContent !== t) b.textContent = t; } }
export function pushPlace(label, go, key){
  if(going) return;
  if(hist.length && hist[hist.length - 1].key === key) return;
  hist.push({ label, go, key }); if(hist.length > 60) hist.shift(); refreshBack();
}
function trackPanel(){
  const p = panelOf(); if(!p) return;
  if(current && current.key !== p.key && !going){
    const prev = current; pushPlace(prev.label, () => document.querySelector(`.nav button[data-panel="${prev.panel}"]`)?.click(), prev.key);
  }
  current = p;
}
function goBack(){
  const h = hist.pop(); if(!h) return;
  going = true; try { h.go(); } finally { setTimeout(() => { going = false; trackPanel(); refreshBack(); }, 60); }
  refreshBack();
}

/* ---- Top ---- */
let scroller = null;
function onScroll(e){
  const t = e.target === document ? document.scrollingElement : e.target; if(!t || t.nodeType !== 1) return;
  const big = t === document.scrollingElement || t.clientHeight >= window.innerHeight * 0.6; if(!big) return;
  scroller = t; const b = document.getElementById('ttTop'); if(b) b.classList.toggle('show', t.scrollTop > 700);
}

export function initTableTools(){
  if(window.fleetTableTools) return; window.fleetTableTools = { pushPlace, sweep };
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const back = document.createElement('button'); back.id = 'ttBack'; back.type = 'button'; back.title = 'Go back to where you were (Alt + ←)'; back.addEventListener('click', goBack);
  const top = document.createElement('button'); top.id = 'ttTop'; top.type = 'button'; top.title = 'Back to top'; top.setAttribute('aria-label', 'Back to top'); top.textContent = '↑';
  top.addEventListener('click', () => { (scroller || document.querySelector('.main') || document.scrollingElement).scrollTo({ top: 0, behavior: 'smooth' }); });
  document.body.append(back, top);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', e => { if(e.altKey && e.key === 'ArrowLeft' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')){ e.preventDefault(); goBack(); } });
  new MutationObserver(list => {
    if(list.every(m => { const n = m.target.nodeType === 1 ? m.target : m.target.parentElement; return n && n.closest && n.closest('.tt-bar,.tt-tot,#ttBack,#ttTop,.toast'); })) return;
    schedule(); trackPanel();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  trackPanel(); schedule();
}
