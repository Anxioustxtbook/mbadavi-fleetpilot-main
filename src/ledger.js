const ExcelJS = window.ExcelJS;

/* ---------- state ---------- */
let db = { vehicles: [], drivers: [], clients: [], bookings: [], rentals: [], expenses: [], payments: [], driverAllowances: [], settings: { adminPin: null, chartType: 'pie' }, nextId: 1, period: null, lastModified: null };
let dirty = false;
let currentFileName = null;
let currentFileHandle = null; // File System Access API handle, when supported
let localSaveTimer = null;
let localSavePending = false;
let localSaveError = false;
let localSaveRevision = 0;
let rolloverPromptShownThisSession = false;
let editingVehicleId = null, editingClientId = null, editingRentalId = null, editingBookingId = null, editingExpenseId = null, editingPaymentId = null;

function uid(){ return db.nextId++; }
function markDirty(){
  dirty = true;
  db.lastModified = new Date().toISOString();
  scheduleAutosave();
  renderFileStatus();
  /* Every data-changing action in this app already calls markDirty() right after
     it edits db (vehicles, rentals, expenses, payments, drivers, allowances,
     settings, etc). Refreshing the dashboard cards here — in one place — instead
     of relying on each individual call site to remember renderDashboard()
     guarantees the cards always reflect the current db state, even if the
     dashboard panel isn't the one on screen right now. That removes the class of
     bug where a card goes stale because some edit path forgot to refresh it.
     Guarded in case markDirty() ever fires before the dashboard DOM exists. */
  if(typeof renderDashboard === 'function' && document.getElementById('dashCards')){
    renderDashboard();
  }
  if(typeof renderWatchlist === 'function') renderWatchlist();
}
function fmt(n){ return 'KSh ' + (Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function escapeHTML(value){ return String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
/* Stored-XSS hardening: every dynamic innerHTML write is passed through a small DOM sanitizer.
   Existing application markup is preserved, while executable elements, inline event handlers,
   dangerous URL schemes and srcdoc are removed before the browser inserts the markup. */
(function installSafeInnerHTML(){
  const proto=Element.prototype, desc=Object.getOwnPropertyDescriptor(proto,'innerHTML');
  if(!desc || !desc.set || window.__fleetSafeInnerHTMLInstalled) return;
  window.__fleetSafeInnerHTMLInstalled=true;
  const nativeSet=desc.set, nativeGet=desc.get;
  const blockedTags=new Set(['SCRIPT','IFRAME','OBJECT','EMBED','APPLET','BASE','META','LINK']);
  function sanitize(html){
    const tpl=document.createElement('template');
    nativeSet.call(tpl, String(html));
    tpl.content.querySelectorAll('*').forEach(el=>{
      if(blockedTags.has(el.tagName)){el.remove();return;}
      [...el.attributes].forEach(a=>{
        const n=a.name.toLowerCase(), v=a.value.trim().toLowerCase();
        if(n.startsWith('on') || n==='srcdoc' || (['href','src','xlink:href','formaction'].includes(n) && /^(javascript:|vbscript:|data:text\/html)/i.test(v))) el.removeAttribute(a.name);
      });
    });
    return tpl.innerHTML;
  }
  Object.defineProperty(proto,'innerHTML',{get:nativeGet,set:function(value){nativeSet.call(this,sanitize(value));},configurable:desc.configurable,enumerable:desc.enumerable});
})();
/* ---------- shared money/date validation ----------
   parseFloat(...)||0 (used throughout this file for numeric inputs) quietly
   turns blanks/garbage into 0, but lets negative numbers straight through —
   so a mistyped "-500" fuel expense or payment would silently pass as valid
   and skew every downstream total, recovery, and report. These two checks are
   the actual gate: call isValidMoney() before accepting an amount a user typed,
   and isReasonableDate() before accepting a date, in the handlers that create
   money-moving records (expenses, payments). */
function isValidMoney(v, {allowZero=false}={}){
  const n = Number(v);
  if(!Number.isFinite(n)) return false;
  return allowZero ? n>=0 : n>0;
}
function isReasonableDate(dateStr){
  if(!dateStr) return false;
  const d = new Date(dateStr+'T00:00:00');
  if(isNaN(d)) return false;
  const year = d.getFullYear();
  return year>=2000 && year<=2100;
}

/* ---------- local-first persistence (IndexedDB) ---------- */
function scheduleAutosave(){
  localSavePending = true;
  localSaveError = false;
  localSaveRevision++;
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(saveAutosaveSnapshot, 500);
  renderFileStatus();
}
async function persistLocalDatabase(){
  scheduleAutosave();
  await saveAutosaveSnapshot();
}
async function saveAutosaveSnapshot(){
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  const revision = localSaveRevision;
  try{
    await window.fleetRepository.save(db, { fileName: currentFileName, workbookDirty: dirty });
    localSaveError = false;
    if(revision === localSaveRevision) localSavePending = false;
    renderFileStatus();
    if(revision !== localSaveRevision) scheduleAutosave();
  }catch(err){
    localSaveError = true;
    console.error('Local save failed:', err);
    renderFileStatus();
  }
}
async function readAutosaveSnapshot(){
  try{ return await window.fleetRepository.load(); }
  catch(err){ console.error('Could not load the local ledger:', err); return null; }
}
async function restoreLocalDatabase(){
  const snap = await readAutosaveSnapshot();
  if(!snap || !snap.data) return;
  let recovered;
  try{ recovered = JSON.parse(snap.data); }catch(e){ return; }
  if(!recovered || !Array.isArray(recovered.vehicles)) return;
  ['vehicles','drivers','clients','bookings','rentals','expenses','payments','driverAllowances'].forEach(key=>{
    if(!Array.isArray(recovered[key])) recovered[key] = [];
  });
  db = recovered;
  if(!db.settings) db.settings = { adminPin:null, chartType:'pie' };
  currentFileName = snap.fileName || null;
  currentFileHandle = null;
  dirty = snap.workbookDirty !== false;
  rolloverPromptShownThisSession = false;
  await migratePinIfNeeded(db);
  if(snap.savedAt) toast('Loaded your locally saved ledger from ' + new Date(snap.savedAt).toLocaleString());
}
/* Guards against silently loading a file that's older than unsaved work
   already sitting in this tab (e.g. someone else emailed back a copy of the
   ledger from before your latest edits). Doesn't attempt to merge — just warns
   before it discards what's on screen, same spirit as the browser's native
   "unsaved changes" prompt on tab close. */
function confirmLoadOverUnsaved(loadedDb){
  if((!dirty && !localSavePending) || !db.lastModified) return true;
  const loadedNewer = loadedDb.lastModified && loadedDb.lastModified > db.lastModified;
  if(loadedNewer) return true; // the file being opened already reflects more recent work than what's on screen
  return confirm(
    "You have unsaved changes in this session that are newer than the file you're about to open.\n\n" +
    "Loading it will replace what's on screen (an autosave backup of your current session is kept, but it's simplest to Save first).\n\nLoad anyway?"
  );
}

/* ---------- payments (own table — money actually received against a rental) ---------- */
const PAYMENT_METHODS = ['Cash','M-Pesa','Bank transfer','Card','Deposit','Other'];
function paidForRental(rentalId){
  return db.payments.filter(p=>p.rentalId==rentalId).reduce((s,p)=>s+(Number(p.amount)||0),0);
}
function owedForRental(rental){
  return Math.max(0, (Number(rental.amount)||0) - paidForRental(rental.id));
}
function paymentStatus(rental){
  if(!rental) return '<span class="status-unpaid">Unpaid</span>';
  const amount = Number(rental.amount)||0, owed = owedForRental(rental), paid = paidForRental(rental.id);
  if(paid<=0) return '<span class="status-unpaid">Unpaid</span>';
  if(owed<=0) return '<span class="status-paid">Paid</span>';
  return '<span class="status-partial">Partially Paid</span>';
}
function paymentTotalExcluding(paymentId,rentalId){
  return db.payments.filter(p=>p.rentalId==rentalId && p.id!=paymentId).reduce((s,p)=>s+(Number(p.amount)||0),0);
}
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(()=>t.classList.remove('show'), 3200);
}

/* ---------- shared "jump to this record" navigation ----------
   Used by the watchlist and global search: switches to the right sidebar
   panel, then either scrolls/highlights the matching table row (when the
   record has one, identified by a [data-id] element) or, for alerts that
   point at an action rather than a row (e.g. "go add a payment for this
   rental"), pre-fills and highlights the relevant form field instead. */
function flashEl(el, ms){
  if(!el) return;
  const orig = el.style.background;
  el.style.background = 'var(--amber-dim)';
  setTimeout(()=>{ el.style.background = orig; }, ms||1800);
}
function scrollToForm(formId, ms){
  const el = document.getElementById(formId);
  if(!el) return;
  el.scrollIntoView({behavior:'smooth', block:'start'});
  const orig = el.style.boxShadow;
  el.style.transition = 'box-shadow .3s ease';
  el.style.boxShadow = '0 0 0 2px var(--amber)';
  setTimeout(()=>{ el.style.boxShadow = orig; }, ms||1600);
}
function closeOverlaysForNav(){
  const searchBox = document.getElementById('globalSearchBox'); if(searchBox) searchBox.style.display = 'none';
  const wlOverlay = document.getElementById('watchlistOverlay'); if(wlOverlay) wlOverlay.classList.remove('show');
}
function navigateToRecord(panel, opts){
  opts = opts || {};
  document.querySelector(`.nav button[data-panel="${panel}"]`)?.click();
  closeOverlaysForNav();
  setTimeout(()=>{
    if(opts.selectId){
      const sel = document.getElementById(opts.selectId);
      if(sel){
        if(opts.value!=null) sel.value = opts.value;
        scrollToForm(opts.formId || (sel.closest('.form-grid')||{}).id);
        sel.focus();
      }
      return;
    }
    const activePanel = document.querySelector('.panel.active');
    const target = activePanel ? activePanel.querySelector(`[data-id="${opts.id}"]`) : null;
    const tr = target ? target.closest('tr') : null;
    if(tr){ tr.scrollIntoView({behavior:'smooth', block:'center'}); flashEl(tr); }
  }, 60);
}

/* ---------- closed-month locking ----------
   The ledger no longer gets wiped at rollover (see startNewMonth) — every past
   record just keeps accumulating. To stop someone from casually changing a month
   that's already been saved/reported on, any record dated before the current
   open period's start counts as "closed" and needs an extra confirmation (on top
   of whatever admin PIN gate already applies) before it can be touched. */
function isClosedMonth(dateStr){
  return !!(db.period && dateStr && dateStr < db.period.start);
}
function monthOfDate(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  return monthLabel(d.getFullYear(), d.getMonth());
}
function guardClosedMonth(dateStr, actionLabel, callback){
  if(isClosedMonth(dateStr)){
    const ok = confirm(`This record is in ${monthOfDate(dateStr)}, a closed month you've likely already saved/reported on.\n\nContinue to ${actionLabel}?`);
    if(!ok) return;
  }
  callback();
}
/* Small inline lock icon for date cells in closed months, so it's visible at a
   glance in the table which rows need the extra confirmation to touch. */
function lockBadge(dateStr){
  return isClosedMonth(dateStr) ? ` <span title="${monthOfDate(dateStr)} is closed — editing needs confirmation" style="cursor:default;">🔒</span>` : '';
}

/* ---------- admin pin gate ---------- */
// This PIN is a deterrent against accidental edits/cancellations, not a full
// access-control system (there's no separate login/identity layer here). What
// it does guarantee: the PIN itself is never stored or exported in plain text.
// It's hashed (SHA-256) before it touches db.settings.adminPin, so opening the
// saved .xlsx or the page's dev tools doesn't hand someone the PIN outright.
if(!db.settings) db.settings = { adminPin: null };
// Once the correct PIN has been entered once in this tab (or set for the first
// time), critical actions are unlocked for the rest of this session — no need
// to re-enter it for every subsequent edit/delete. Resets on page reload, same
// as rolloverPromptShownThisSession below.
let adminUnlockedThisSession = false;
async function hashPin(pin){
  const bytes = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function looksLikeHashedPin(v){ return typeof v==='string' && /^[0-9a-f]{64}$/.test(v); }
// Files saved before hashing was added may still carry a plain-text PIN. Upgrade
// it transparently the first time such a file is loaded, so it's never written
// back out in plain text again.
async function migratePinIfNeeded(targetDb){
  const pin = targetDb && targetDb.settings && targetDb.settings.adminPin;
  if(pin && !looksLikeHashedPin(pin)){
    targetDb.settings.adminPin = await hashPin(pin);
    markDirty();
  }
}
function checkAdminPin(actionLabel, callback){
  if(!db.settings) db.settings = { adminPin: null };
  if(adminUnlockedThisSession){ callback(); return; }
  if(!db.settings.adminPin){
    const newPin = prompt('No admin PIN is set yet. Set one now to protect critical changes (cancelling, editing, deleting):');
    if(newPin && newPin.trim()){
      hashPin(newPin.trim()).then(h=>{
        db.settings.adminPin = h;
        markDirty();
        adminUnlockedThisSession = true;
        callback();
      });
    } else {
      toast('Action cancelled — an admin PIN is required');
    }
    return;
  }
  const entered = prompt('Enter admin PIN to ' + actionLabel + ':');
  if(entered === null) return;
  hashPin(entered).then(h=>{
    if(h === db.settings.adminPin){ adminUnlockedThisSession = true; callback(); }
    else { toast('Incorrect PIN — action blocked'); }
  });
}
document.getElementById('btnAdminPin').addEventListener('click', ()=>{
  if(!db.settings) db.settings = { adminPin: null };
  if(!db.settings.adminPin){
    const newPin = prompt('Set an admin PIN to protect critical changes:');
    if(newPin && newPin.trim()){
      hashPin(newPin.trim()).then(h=>{ db.settings.adminPin = h; markDirty(); toast('Admin PIN set'); });
    }
    return;
  }
  const current = prompt('Enter current admin PIN:');
  if(current === null) return;
  hashPin(current).then(h=>{
    if(h !== db.settings.adminPin){ toast('Incorrect PIN'); return; }
    const next = prompt('Enter new admin PIN:');
    if(next && next.trim()){
      hashPin(next.trim()).then(h2=>{ db.settings.adminPin = h2; markDirty(); toast('Admin PIN updated'); });
    }
  });
});


/* ---------- watchlist ---------- */
function buildWatchlist(){
  const items=[];
  const due = (typeof getDueSoonBookings==='function') ? getDueSoonBookings() : [];
  due.forEach(bk=>{
    const v=db.vehicles.find(v=>v.id==bk.vehicleId), c=db.clients.find(c=>c.id==bk.clientId);
    const today=new Date(); today.setHours(0,0,0,0);
    const p=new Date(bk.pickup+'T00:00:00');
    const when=p.getTime()===today.getTime()?'Today':'Tomorrow';
    items.push({type:'red',icon:'🔔',title:`${when} pickup — ${v?v.reg:'Vehicle'}`,sub:`${c?c.name:'Client'} · pickup ${bk.pickup}`,
      nav:{panel:'bookings', id:bk.id}});
  });
  db.vehicles.filter(v=>v.status==='Maintenance').forEach(v=>items.push({type:'gold',icon:'🔧',title:`Vehicle in service — ${v.reg}`,sub:`${v.make||''} ${v.model||''}`.trim()||'Maintenance required',
    nav:{panel:'vehicles', id:v.id}}));
  db.rentals.filter(r=>r.status!=='Cancelled' && (typeof owedForRental==='function' ? owedForRental(r)>0 : false)).forEach(r=>{
    const v=db.vehicles.find(v=>v.id==r.vehicleId), c=db.clients.find(c=>c.id==r.clientId), owed=owedForRental(r);
    // Money owed on a rental is a payments task, not a rentals-table lookup — send
    // the user straight to the Payments form with this rental already selected.
    items.push({type:'red',icon:'💰',title:`Outstanding rental — ${v?v.reg:'Vehicle'}`,sub:`${c?c.name:'Client'} · ${fmt(owed)} still owed`,
      nav:{panel:'payments', selectId:'p_rental', value:r.id, formId:'paymentForm'}});
  });
  db.rentals.filter(r=>r.status==='Active').forEach(r=>{
    const v=db.vehicles.find(v=>v.id==r.vehicleId), c=db.clients.find(c=>c.id==r.clientId);
    const due=new Date(r.return+'T23:59:59');
    if(due.getTime()<Date.now()) items.push({type:'red',icon:'⏰',title:`Overdue return — ${v?v.reg:'Vehicle'}`,sub:`${c?c.name:'Client'} · due ${r.return}`,
      nav:{panel:'rentals', id:r.id}});
  });
  return items;
}
function renderWatchlist(){
  const items=buildWatchlist();
  const count=document.getElementById('watchlistCount'); if(count) count.textContent=items.length;
  const body=document.getElementById('watchlistBody'); if(!body) return;
  if(!items.length){ body.innerHTML='<div class="watch-empty">✓ Nothing needs attention right now.</div>'; return; }
  body.innerHTML=items.map((x,i)=>`<div class="watch-item" data-i="${i}" style="cursor:pointer;"><div class="watch-icon ${x.type}">${x.icon}</div><div class="watch-main"><div class="watch-title">${x.title}</div><div class="watch-sub">${x.sub}</div></div></div>`).join('');
  body.querySelectorAll('.watch-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const item = items[Number(el.dataset.i)];
      if(item && item.nav) navigateToRecord(item.nav.panel, item.nav);
    });
  });
}
(function(){
  const btn=document.getElementById('btnWatchlist'), overlay=document.getElementById('watchlistOverlay'), close=document.getElementById('watchlistClose');
  if(!btn||!overlay) return;
  const open=()=>{renderWatchlist();overlay.classList.add('show');overlay.setAttribute('aria-hidden','false');};
  const hide=()=>{overlay.classList.remove('show');overlay.setAttribute('aria-hidden','true');};
  btn.addEventListener('click',open); if(close) close.addEventListener('click',hide);
  overlay.addEventListener('click',e=>{if(e.target===overlay) hide();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape') hide();});
  window.renderWatchlist=renderWatchlist;
})();

/* ---------- nav ---------- */
document.getElementById('nav').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+btn.dataset.panel).classList.add('active');
  document.body.dataset.panel = btn.dataset.panel;
  if(btn.dataset.panel==='reports') renderReports();
  if(btn.dataset.panel==='dashboard') renderDashboard();
  if(btn.dataset.panel==='analysis') renderAnalysis();
});

/* ---------- full screen toggle ---------- */
const btnFullscreen = document.getElementById('btnFullscreen');
btnFullscreen.addEventListener('click', ()=>{
  if(!document.fullscreenElement){
    (document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(()=>{}));
    document.body.classList.add('fs-active');
    btnFullscreen.textContent = '⤡';
    btnFullscreen.title = 'Exit full screen';
  } else {
    document.exitFullscreen && document.exitFullscreen().catch(()=>{});
  }
});
document.addEventListener('fullscreenchange', ()=>{
  if(!document.fullscreenElement){
    document.body.classList.remove('fs-active');
    btnFullscreen.textContent = '⛶';
    btnFullscreen.title = 'Full screen';
  }
});

/* ---------- auto full screen on first interaction ---------- */
/* Browsers block requestFullscreen() on page load; it must be triggered by
   a user gesture. This fires it on the very first click/tap anywhere on
   the page (skipping the explicit fullscreen button itself, which already
   has its own handler above), so the app effectively "opens" full screen
   as soon as the user touches it. */
(function(){
  function firstInteractionFullscreen(e){
    if(e.target.closest && e.target.closest('#btnFullscreen')) return;
    if(!document.fullscreenElement){
      (document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(()=>{}));
      document.body.classList.add('fs-active');
      btnFullscreen.textContent = '⤡';
      btnFullscreen.title = 'Exit full screen';
    }
    document.removeEventListener('click', firstInteractionFullscreen, true);
  }
  document.addEventListener('click', firstInteractionFullscreen, true);
})();

/* ---------- badge spin: always spinning, slowly, whether the app is
   active or idle — no on/off timing logic to depend on, just a constant
   slow rotation (see the .brand-badge img rule in <style> above). ---------- */

/* ---------- excel (xlsx) conversion — ExcelJS ---------- */
/* Raw data sheets keep the app's tables round-trippable (used to reload the database). */
const DATA_SHEETS = {
  Vehicles: ['id','reg','make','model','year','rate','owner','status'],
  Drivers:  ['id','name','phone','license','vehicleId','allowance','status'],
  Clients:  ['id','name','phone','idnum','dl'],
  Bookings: ['id','vehicleId','clientId','bookedOn','pickup','return','deposit','status','reminderAck'],
  Rentals:  ['id','vehicleId','clientId','contract','invoice','receipt','pickup','pickupTime','return','returnTime','rate','days','mileage','amount','status','fuel','fuelCharge'],
  Expenses: ['id','vehicleId','date','category','desc','qty','amount','billable','billClientId','chargeAmount','source','rentalId'],
  Payments: ['id','rentalId','date','amount','method','note'],
  DriverAllowances: ['id','driverId','weekStart','amount','note']
};
const DATA_SHEET_KEY = { Vehicles:'vehicles', Drivers:'drivers', Clients:'clients', Bookings:'bookings', Rentals:'rentals', Expenses:'expenses', Payments:'payments', DriverAllowances:'driverAllowances' };
/* Settings sheet columns — periodStart/periodLabel record which calendar month this
   file represents, so the app can auto-detect month rollovers and so multi-month
   analysis can label each loaded file without guessing. */
const SETTINGS_COLS = ['adminPin','chartType','includeStatement','includeExpenseReport','includeFuelReport','includeTotals','periodStart','periodLabel','dashboardWidgets','lastModified'];

/* ---------- monthly period tracking ---------- */
function pad2(n){ return String(n).padStart(2,'0'); }
/* Date.prototype.toISOString() always converts to UTC first. For anyone in a timezone
   ahead of UTC (e.g. East Africa, UTC+3), local midnight is still the PREVIOUS calendar
   day in UTC — so `someDate.toISOString().slice(0,10)` silently returns yesterday's date,
   and for a date built at day 1 / hour 0 (as periodMonthRange does below) that means it
   returns the last day of the PREVIOUS month every single time. Use this instead whenever
   a Date object needs to become a "YYYY-MM-DD" string that still means the same calendar
   day it was created for. */
function toLocalISO(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function monthLabel(y,m){ return ['January','February','March','April','May','June','July','August','September','October','November','December'][m] + ' ' + y; }
function monthBounds(y,m){
  const start = `${y}-${pad2(m+1)}-01`;
  const lastDay = new Date(y, m+1, 0).getDate();
  const end = `${y}-${pad2(m+1)}-${pad2(lastDay)}`;
  return {start, end};
}
/* Legacy files (saved before period tracking existed) carry no periodStart — infer the
   month they represent from the latest activity date in the file, rather than assuming
   "now" (which would be wrong for an old file opened later). Falls back to the real
   current month only when the file has no dated records at all (a brand-new database). */
function inferPeriodFromData(targetDb){
  const dates = [];
  (targetDb.rentals||[]).forEach(r=>{ if(r.pickup) dates.push(r.pickup); });
  (targetDb.expenses||[]).forEach(x=>{ if(x.date) dates.push(x.date); });
  (targetDb.bookings||[]).forEach(bk=>{ if(bk.bookedOn) dates.push(bk.bookedOn); });
  let ref;
  if(dates.length){
    dates.sort();
    ref = new Date(dates[dates.length-1]+'T00:00:00');
  } else {
    ref = new Date();
  }
  const {start,end} = monthBounds(ref.getFullYear(), ref.getMonth());
  return { year:ref.getFullYear(), month:ref.getMonth(), start, end, label: monthLabel(ref.getFullYear(), ref.getMonth()) };
}
/* Sets the shared Dashboard/Reports period (used by both panels) to Monthly, pointed
   at whichever month the open file's data actually falls in — the same "latest dated
   entry" logic inferPeriodFromData already uses for db.period. Falls back to today's
   real month when the file has no dated records yet. Called on startup and every time
   a file is loaded, so opening an old saved month shows that month's real figures
   straight away instead of an empty "today" that has no data in it. The period can
   still be changed afterwards via either panel's selector. */
function resetPeriodToDataDefault(){
  const inferred = inferPeriodFromData(db);
  const refDate = toLocalISO(new Date(inferred.year, inferred.month, 1));
  ['rep_start','rep_end','dash_rep_start','dash_rep_end'].forEach(id=>{ document.getElementById(id).value=''; });
  document.getElementById('rep_ref').value = refDate;
  document.getElementById('dash_rep_ref').value = refDate;
  setPeriodType('monthly');
  // A freshly opened/loaded file also puts the Dashboard cards back on all-time
  // totals, same as pressing "Restore cards to default" — matches Reports' own
  // reset-to-this-file's-data behavior here.
  dashCardsAllTime = true;
}
function ensurePeriod(){
  if(!db.period){
    const now = new Date();
    const {start,end} = monthBounds(now.getFullYear(), now.getMonth());
    db.period = { year:now.getFullYear(), month:now.getMonth(), start, end, label: monthLabel(now.getFullYear(), now.getMonth()) };
  }
}
/* Auto-detects when the real calendar month has moved past the open file's period,
   and — per the confirm-before-switching workflow — surfaces a banner plus (once per
   session) an actual confirmation dialog, rather than switching files on its own. */
function checkMonthRollover(){
  ensurePeriod();
  const now = new Date();
  const isNewMonth = (now.getFullYear() > db.period.year) || (now.getFullYear()===db.period.year && now.getMonth() > db.period.month);
  const banner = document.getElementById('rolloverBanner');
  if(!isNewMonth){ if(banner) banner.style.display = 'none'; return; }
  const label = monthLabel(now.getFullYear(), now.getMonth());
  if(banner){
    banner.style.display = '';
    document.getElementById('rolloverBannerText').textContent = `${label} has started →`;
  }
  if(!rolloverPromptShownThisSession){
    rolloverPromptShownThisSession = true;
    openRolloverModal(now.getFullYear(), now.getMonth());
  }
}
/* Bookings have no "Completed" state (they're either still live or Cancelled).
   Used only for the informational "still open" count in the rollover modal now —
   nothing is actually filtered out of the ledger anymore, see startNewMonth. */
function getCarryoverBookings(){
  return db.bookings.filter(bk=>bk.status!=='Cancelled');
}
function openRolloverModal(y,m){
  const existing = document.getElementById('rolloverModalOverlay');
  if(existing) existing.remove();
  const label = monthLabel(y,m);
  const stillOpenBookings = getCarryoverBookings();
  const stillOpenRentals = db.rentals.filter(r=>r.status==='Active');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'rolloverModalOverlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-head">
        <div><h2>Start ${label}?</h2>
        <p>Currently working in: <b>${db.period ? db.period.label : '—'}</b></p></div>
        <button class="modal-close" id="rolloverModalClose">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--ink-dim);line-height:1.55;margin:0 0 14px;">
          It's now ${label}. Nothing gets deleted — this file keeps every booking, rental,
          expense, payment and allowance you've ever entered, the same way a multi-month
          statement would. Starting ${label} just moves the "open" period forward;
          ${db.period ? db.period.label : 'the current month'} becomes a closed month, which
          locks it behind a confirmation prompt if you (or someone else) ever need to edit
          something in it later.
        </p>
        <div class="hint" style="margin:0 0 16px;">
          Still open going into ${label}: <b>${stillOpenBookings.length}</b> booking(s) not yet cancelled,
          <b>${stillOpenRentals.length}</b> rental(s) still Active.
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button class="btn" id="rolloverLater" style="width:auto;padding:9px 16px;margin:0;">Not now</button>
          <button class="btn primary" id="rolloverGo" style="width:auto;padding:9px 16px;margin:0;">Start ${label} →</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = ()=> overlay.remove();
  overlay.querySelector('#rolloverModalClose').addEventListener('click', close);
  overlay.querySelector('#rolloverLater').addEventListener('click', close);
  overlay.querySelector('#rolloverGo').addEventListener('click', ()=>{ close(); startNewMonth(y,m); });
}
function startNewMonth(y,m){
  const {start,end} = monthBounds(y,m);
  const label = monthLabel(y,m);
  const prevLabel = db.period ? db.period.label : null;
  /* Nothing is deleted or filtered here anymore. Bookings, rentals, expenses,
     payments and driver allowances all just keep accumulating — this file behaves
     like a running ledger (the same shape as a multi-month export), not a
     per-month workspace that gets cleared out. The only thing that changes is
     which period counts as "open": everything before db.period.start becomes a
     closed month, which locks it behind an extra confirmation (see
     guardClosedMonth) rather than removing it. */
  db.period = { year:y, month:m, start, end, label };
  currentFileHandle = null;
  currentFileName = `Fleet Ledger - ${label}.xlsx`;
  markDirty();
  renderAll();
  const banner = document.getElementById('rolloverBanner');
  if(banner) banner.style.display = 'none';
  toast(`Started ${label}.${prevLabel ? ' '+prevLabel+' is now locked (still editable with confirmation).' : ''} Nothing was deleted. Click Save to create this month's file.`);
}
const THIN = { style:'thin' };
/* App accent colours (matching the on-screen CSS variables), used to tint total/summary
   figures in the exported Excel so revenue, expenses, fuel and net figures are visually
   distinguishable at a glance, the same way the dashboard cards are colour-coded. */
const XLSX_CLR = { green:'FF4F9E6E', red:'FFD9695F', amber:'FFE8A33D', fuel:'FFE0793B' };
function tintCell(ws, r, c, colorKey, bold){
  const cell = ws.getCell(r,c);
  const existing = cell.font || {};
  cell.font = Object.assign({}, existing, { color:{argb:XLSX_CLR[colorKey]}, bold: bold!==undefined ? bold : !!existing.bold });
}
/* Green when the figure is favourable (profit/surplus), red when it isn't — for net-style
   figures whose sign determines whether they're good or bad news. */
function tintNet(ws, r, c, value, bold){
  tintCell(ws, r, c, (Number(value)||0) >= 0 ? 'green' : 'red', bold);
}
/* A file's tracked period always spans a full calendar month (1st to last day) — but if
   that period is the month still in progress right now, only days up to today actually
   have data. Capping here stops the report from silently implying totals for days that
   haven't happened yet; a past, closed-out month (opened later) still gets its full range. */
function effectivePeriodEnd(period){
  const fullEnd = new Date(period.end+'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  return today < fullEnd ? today : fullEnd;
}
function periodRangeLabel(period){
  const label = period.label.toUpperCase();
  const fullEnd = new Date(period.end+'T00:00:00');
  const effEnd = effectivePeriodEnd(period);
  if(effEnd < fullEnd){
    const shown = effEnd.toLocaleDateString('default',{month:'short',day:'numeric'}).toUpperCase();
    return `${label} — THROUGH ${shown} (MONTH IN PROGRESS)`;
  }
  return label;
}
/* Money columns to total, and which (non-money) column carries the "TOTAL" label,
   for the raw data sheets that hold amounts. */
const DATA_SHEET_TOTALS = {
  Rentals:  { labelCol: 'contract', sumCols: ['days','amount','fuel','fuelCharge'], colColors: { amount:'green', fuel:'fuel', fuelCharge:'fuel' } },
  Expenses: { labelCol: 'desc',     sumCols: ['amount','chargeAmount'], colColors: { amount:'red', chargeAmount:'fuel' } },
  Payments: { labelCol: 'note',     sumCols: ['amount'], colColors: { amount:'green' } }
};

function addDataSheet(wb, name, rows, cols){
  const ws = wb.addWorksheet(name);
  ws.addRow(cols);
  ws.getRow(1).font = { bold:true };
  (rows && rows.length ? rows : []).forEach(r=> ws.addRow(cols.map(c=> (r[c]===undefined||r[c]===null) ? '' : r[c])));
  cols.forEach((c,i)=> ws.getColumn(i+1).width = Math.max(11, c.length+2));
  const totalsSpec = DATA_SHEET_TOTALS[name];
  if(totalsSpec && rows && rows.length){
    const totalRow = cols.map(c=>{
      if(c===totalsSpec.labelCol) return 'TOTAL';
      if(totalsSpec.sumCols.includes(c)) return rows.reduce((s,r)=> s+(Number(r[c])||0), 0);
      return '';
    });
    const rowNum = ws.addRow(totalRow).number;
    ws.getRow(rowNum).font = { bold:true };
    if(totalsSpec.colColors){
      cols.forEach((c,i)=>{
        const colorKey = totalsSpec.colColors[c];
        if(colorKey) tintCell(ws, rowNum, i+1, colorKey, true);
      });
    }
  }
  return ws;
}
/* Since the ledger now accumulates every month's records in one continuous table
   (see startNewMonth), a thin divider row is inserted wherever consecutive rows
   cross a month boundary — so scrolling down through the history still reads as
   distinct months, the way separate monthly files used to. */
function monthDividerRow(colspan, label){
  const tr = document.createElement('tr');
  tr.className = 'month-divider-row';
  tr.innerHTML = `<td colspan="${colspan}" style="background:var(--panel-2);color:var(--ink-dim);font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:6px 10px;">${label}</td>`;
  return tr;
}
function readDataSheet(wb, name, cols){
  const ws = wb.getWorksheet(name);
  if(!ws) return [];
  const rows = [];
  ws.eachRow((row, rowNumber)=>{
    if(rowNumber===1) return; // header row
    const obj = {}; let hasValue = false;
    cols.forEach((c,i)=>{
      let val = row.getCell(i+1).value;
      if(val && typeof val==='object' && 'text' in val) val = val.text; // rich text guard
      if(val instanceof Date) val = val.toISOString().slice(0,10);
      if(val!==null && val!==undefined && val!=='') hasValue = true;
      obj[c] = (val===null||val===undefined) ? '' : val;
    });
    if(!hasValue) return;
    // A summary/total row appended for reporting has no id — a real record on an id-keyed
    // sheet always has a positive numeric id, so this keeps totals rows from round-tripping
    // back in as fake records. Sheets with no id column (e.g. Settings, Meta) skip this check.
    if(cols.includes('id')){
      const idNum = Number(obj.id);
      if(!Number.isFinite(idNum) || idNum<=0) return;
    }
    rows.push(obj);
  });
  return rows;
}

/* ---- styled per-vehicle statement sheet, formatted like the original ledger book ---- */
const STMT_COLS = ['DATE','CLIENT','CONT. NO.','INV NO.','RCT NO.','DAYS','AMOUNT','PAID','OWED']; // columns C..K
function styleHeaderRow(ws, rowNum, firstCol, lastCol){
  const row = ws.getRow(rowNum);
  for(let c=firstCol;c<=lastCol;c++){ row.getCell(c).font = {bold:true}; row.getCell(c).border = {bottom:THIN}; }
}
/* Full grid box on every cell in the rectangle, matching the original ledger book's look
   (Performance_Statement.xlsx) — every used cell bordered on all four sides, not just the header. */
function boxRange(ws, r1, c1, r2, c2){
  for(let r=r1;r<=r2;r++){
    for(let c=c1;c<=c2;c++){
      ws.getCell(r,c).border = { top:THIN, bottom:THIN, left:THIN, right:THIN };
    }
  }
}
function ledgerTitle(ws, rowNum, firstCol, lastCol, text){
  ws.mergeCells(rowNum, firstCol, rowNum, lastCol);
  const title = ws.getCell(rowNum, firstCol);
  title.value = text;
  title.font = {bold:true}; title.alignment = {horizontal:'center'};
}
function addVehicleStatementBlock(ws, startRow, vehicle, rentalsForVehicle, expensesForVehicle, monthLabel){
  let r = startRow;
  ledgerTitle(ws, r, 3, 11, `${vehicle.reg} STATEMENT FOR ${monthLabel}`);
  r++;
  const rentalHeaderRow = r;
  STMT_COLS.forEach((h,i)=> ws.getCell(r,3+i).value = h);
  styleHeaderRow(ws, r, 3, 11);
  r++;
  let subDays=0, subAmount=0, subPaid=0;
  rentalsForVehicle.forEach(rental=>{
    const client = db.clients.find(c=>c.id==rental.clientId);
    const paid = paidForRental(rental.id);
    ws.getCell(r,3).value = rental.pickup + (rental.return && rental.return!==rental.pickup ? (' - '+rental.return) : '');
    ws.getCell(r,4).value = client ? client.name : '';
    ws.getCell(r,5).value = rental.contract || '';
    ws.getCell(r,6).value = rental.invoice || '';
    ws.getCell(r,7).value = rental.receipt || '';
    ws.getCell(r,8).value = Number(rental.days)||0;
    ws.getCell(r,9).value = Number(rental.amount)||0;
    ws.getCell(r,10).value = paid;
    ws.getCell(r,11).value = owedForRental(rental);
    subDays += Number(rental.days)||0; subAmount += Number(rental.amount)||0; subPaid += paid;
    r++;
  });
  ws.getCell(r,3).value = 'SUB TOTAL'; ws.getCell(r,3).font = {bold:true};
  ws.getCell(r,8).value = subDays; ws.getCell(r,8).font = {bold:true};
  ws.getCell(r,9).value = subAmount; tintCell(ws, r, 9, 'green', true);
  ws.getCell(r,10).value = subPaid; tintCell(ws, r, 10, 'green', true);
  ws.getCell(r,11).value = subAmount - subPaid; tintCell(ws, r, 11, (subAmount-subPaid)>0 ? 'red' : 'green', true);
  boxRange(ws, rentalHeaderRow, 3, r, 11);
  r += 2;
  const lessExpRow = r;
  ws.getCell(r,3).value = 'LESS EXPENSES'; ws.getCell(r,3).font = {bold:true};
  r++;
  let expTotal = 0;
  expensesForVehicle.forEach(x=>{
    ws.getCell(r,3).value = x.date;
    ws.getCell(r,4).value = x.desc || x.category || '';
    ws.getCell(r,5).value = Number(x.qty)||1;
    ws.getCell(r,6).value = x.category || '';
    ws.getCell(r,9).value = Number(x.amount)||0;
    tintCell(ws, r, 9, 'red');
    expTotal += Number(x.amount)||0;
    r++;
  });
  ws.getCell(r,9).value = expTotal; tintCell(ws, r, 9, 'red', true);
  r++;
  ws.getCell(r,3).value = 'TOTAL'; ws.getCell(r,3).font = {bold:true};
  ws.getCell(r,9).value = subAmount - expTotal; tintNet(ws, r, 9, subAmount - expTotal, true);
  boxRange(ws, lessExpRow, 3, r, 9);
  r += 2;
  ws.getCell(r,3).value = 'COLLECTED SO FAR'; ws.getCell(r,3).font = {bold:true};
  ws.getCell(r,10).value = subPaid; tintCell(ws, r, 10, 'green', true);
  r++;
  ws.getCell(r,3).value = 'STILL OWED BY CLIENTS'; ws.getCell(r,3).font = {bold:true};
  ws.getCell(r,11).value = subAmount - subPaid; tintCell(ws, r, 11, (subAmount-subPaid)>0 ? 'red' : 'green', true);
  r += 3; // blank rows before next vehicle's block
  return { nextRow: r, subAmount, subPaid, expTotal };
}
function addStatementSheet(wb){
  ensurePeriod();
  const start = new Date(db.period.start+'T00:00:00');
  const end = effectivePeriodEnd(db.period);
  const monthLabel = periodRangeLabel(db.period);
  const ws = wb.addWorksheet('Statement');
  [15,15.5,12,12,15,8,15,12,12].forEach((w,i)=> ws.getColumn(3+i).width = w);
  let row = 2, any = false;
  let fleetRevenue=0, fleetPaid=0, fleetExpenses=0;
  db.vehicles.forEach(v=>{
    const vr = db.rentals.filter(r=>r.vehicleId==v.id && r.status!=='Cancelled' && inRange(r.pickup,start,end));
    const ve = db.expenses.filter(x=>x.vehicleId==v.id && inRange(x.date,start,end));
    if(!vr.length && !ve.length) return;
    any = true;
    const result = addVehicleStatementBlock(ws, row, v, vr, ve, monthLabel);
    row = result.nextRow;
    fleetRevenue += result.subAmount;
    fleetPaid += result.subPaid;
    fleetExpenses += result.expTotal;
  });
  if(!any){
    ws.getCell(2,3).value = 'No rentals or expenses recorded for ' + monthLabel + ' yet.';
    return;
  }
  ledgerTitle(ws, row, 3, 11, 'FLEET-WIDE TOTAL — ALL VEHICLES (' + monthLabel + ')');
  row++;
  const fwHeadRow = row;
  ws.getCell(row,3).value = 'METRIC'; ws.getCell(row,9).value = 'AMOUNT';
  ws.getCell(row,10).value = 'PAID'; ws.getCell(row,11).value = 'OWED';
  styleHeaderRow(ws, row, 3, 11);
  row++;
  ws.getCell(row,3).value = 'Total rental revenue (invoiced, before expenses)';
  ws.getCell(row,9).value = fleetRevenue; tintCell(ws, row, 9, 'green', true);
  row++;
  ws.getCell(row,3).value = 'Total vehicle expenses deducted';
  ws.getCell(row,9).value = fleetExpenses; tintCell(ws, row, 9, 'red', true);
  row++;
  ws.getCell(row,3).value = 'Net total (revenue less expenses)'; ws.getCell(row,3).font = {bold:true};
  ws.getCell(row,9).value = fleetRevenue - fleetExpenses; tintNet(ws, row, 9, fleetRevenue - fleetExpenses, true);
  row++;
  ws.getCell(row,3).value = 'Total collected from clients so far';
  ws.getCell(row,10).value = fleetPaid; tintCell(ws, row, 10, 'green', true);
  row++;
  ws.getCell(row,3).value = 'Total still owed by clients'; ws.getCell(row,3).font = {bold:true};
  ws.getCell(row,11).value = fleetRevenue - fleetPaid; tintCell(ws, row, 11, (fleetRevenue-fleetPaid)>0 ? 'red' : 'green', true);
  boxRange(ws, fwHeadRow, 3, row, 11);
}

/* ---- expense report sheet, mirrors the Expense statement modal's current scope ---- */
function addExpenseReportSheet(wb){
  const vidEl = document.getElementById('exp_vehicle_pick');
  const vid = vidEl ? vidEl.value : '';
  const {start,end} = (typeof expPeriodRangeVals==='function') ? expPeriodRangeVals() : computePeriodRange('monthly', null, null, null);
  const v = vid ? db.vehicles.find(v=>v.id==vid) : null;
  let rows = db.expenses.filter(x=>inRange(x.date,start,end));
  if(vid) rows = rows.filter(x=>x.vehicleId==vid);

  const ws = wb.addWorksheet('Expense Report');
  [14,20,16,26,8,14].forEach((w,i)=> ws.getColumn(1+i).width = w);

  ledgerTitle(ws, 1, 1, 6, (v ? v.reg+' — ' : 'FLEET-WIDE — ') + 'EXPENSE REPORT (' + start.toDateString() + ' to ' + end.toDateString() + ')');

  let r = 3;
  const catHeaderRow = r;
  ['CATEGORY','COUNT','AMOUNT','% OF TOTAL'].forEach((h,i)=> ws.getCell(r,1+i).value = h);
  styleHeaderRow(ws, r, 1, 4);
  r++;
  const total = rows.reduce((s,x)=>s+(Number(x.amount)||0),0);
  const byCat = {}; EXP_CATEGORIES.forEach(c=>byCat[c]={count:0,amount:0});
  rows.forEach(x=>{ const cat = byCatMatch(x.category); byCat[cat].count++; byCat[cat].amount += Number(x.amount)||0; });
  EXP_CATEGORIES.filter(c=>byCat[c].count>0).sort((a,b)=>byCat[b].amount-byCat[a].amount).forEach(cat=>{
    const d = byCat[cat];
    ws.getCell(r,1).value = cat; ws.getCell(r,2).value = d.count; ws.getCell(r,3).value = d.amount;
    ws.getCell(r,4).value = (total ? (d.amount/total*100).toFixed(1) : '0.0') + '%';
    r++;
  });
  ws.getCell(r,1).value = 'TOTAL'; ws.getCell(r,1).font = {bold:true};
  ws.getCell(r,3).value = total; tintCell(ws, r, 3, 'red', true);
  boxRange(ws, catHeaderRow, 1, r, 4);
  r += 3;

  const detailHeaderRow = r;
  ['DATE','VEHICLE','CATEGORY','DESCRIPTION','QTY','AMOUNT'].forEach((h,i)=> ws.getCell(r,1+i).value = h);
  styleHeaderRow(ws, r, 1, 6);
  r++;
  rows.slice().sort((a,b)=> a.date<b.date?-1:(a.date>b.date?1:0)).forEach(x=>{
    const veh = db.vehicles.find(v=>v.id==x.vehicleId);
    ws.getCell(r,1).value = x.date;
    ws.getCell(r,2).value = veh?veh.reg:'';
    ws.getCell(r,3).value = x.category||'';
    ws.getCell(r,4).value = x.desc||'';
    ws.getCell(r,5).value = Number(x.qty)||1;
    ws.getCell(r,6).value = Number(x.amount)||0;
    r++;
  });
  ws.getCell(r,4).value = 'TOTAL'; ws.getCell(r,4).font = {bold:true};
  ws.getCell(r,6).value = total; tintCell(ws, r, 6, 'red', true);
  r++;
  boxRange(ws, detailHeaderRow, 1, r-1, 6);
}

/* ---- Fuel report: same ledger-book style as the Statement sheet, one block per vehicle ---- */
function addFuelReportSheet(wb){
  const vidEl = document.getElementById('exp_vehicle_pick');
  const vid = vidEl ? vidEl.value : '';
  const {start,end} = (typeof expPeriodRangeVals==='function') ? expPeriodRangeVals() : computePeriodRange('monthly', null, null, null);
  const monthLabel = start.toLocaleString('default',{month:'long',year:'numeric'}).toUpperCase();

  const ws = wb.addWorksheet('Fuel');
  [15,26,14,14,14,14,14].forEach((w,i)=> ws.getColumn(3+i).width = w); // C..I

  let r = 2;
  const vehiclesToShow = vid ? db.vehicles.filter(v=>v.id==vid) : db.vehicles;
  let anyRows = false;
  let fleetCost=0, fleetCharged=0;
  vehiclesToShow.forEach(v=>{
    const fuelRows = db.expenses.filter(x=>x.vehicleId==v.id && x.category==='Fuel' && inRange(x.date,start,end));
    if(!fuelRows.length) return;
    anyRows = true;
    ledgerTitle(ws, r, 3, 9, `${v.reg} FUEL FOR ${monthLabel}`);
    r++;
    const headerRow = r;
    ['DATE','DESCRIPTION','SOURCE','OFFICE COST (FRONTED)','BILLED TO','CHARGED TO CLIENT','RECOVERY'].forEach((h,i)=> ws.getCell(r,3+i).value = h);
    styleHeaderRow(ws, r, 3, 9);
    r++;
    let subCost=0, subCharged=0;
    fuelRows.slice().sort((a,b)=> a.date<b.date?-1:(a.date>b.date?1:0)).forEach(x=>{
      const client = x.billable ? db.clients.find(c=>c.id==x.billClientId) : null;
      const charged = x.billable ? (Number(x.chargeAmount)||0) : 0;
      ws.getCell(r,3).value = x.date;
      ws.getCell(r,4).value = x.desc || 'Fuel';
      ws.getCell(r,5).value = x.source==='rental' ? 'Rental-linked' : 'Manual';
      ws.getCell(r,6).value = Number(x.amount)||0;
      ws.getCell(r,7).value = client ? client.name : '—';
      ws.getCell(r,8).value = x.billable ? charged : 0;
      ws.getCell(r,9).value = x.billable ? (charged - (Number(x.amount)||0)) : 0;
      subCost += Number(x.amount)||0; subCharged += charged;
      r++;
    });
    ws.getCell(r,3).value = 'SUB TOTAL'; ws.getCell(r,3).font = {bold:true};
    ws.getCell(r,6).value = subCost; tintCell(ws, r, 6, 'fuel', true);
    ws.getCell(r,8).value = subCharged; tintCell(ws, r, 8, 'amber', true);
    ws.getCell(r,9).value = subCharged - subCost; tintNet(ws, r, 9, subCharged - subCost, true);
    boxRange(ws, headerRow, 3, r, 9);
    fleetCost += subCost; fleetCharged += subCharged;
    r += 3; // blank rows before next vehicle's block
  });
  if(!anyRows){
    ws.getCell(r,3).value = 'No fuel entries in this period.';
    r++;
    return ws;
  }
  // Fleet-wide total, shown only when the report covers every vehicle (not a single-vehicle scope)
  if(!vid){
    ledgerTitle(ws, r, 3, 9, 'FLEET-WIDE FUEL TOTAL — ALL VEHICLES (' + monthLabel + ')');
    r++;
    const fwHeadRow = r;
    ws.getCell(r,3).value = 'METRIC'; ws.getCell(r,6).value = 'FRONTED'; ws.getCell(r,8).value = 'CHARGED'; ws.getCell(r,9).value = 'NET';
    styleHeaderRow(ws, r, 3, 9);
    r++;
    ws.getCell(r,3).value = 'Total office-fronted (spent)';
    ws.getCell(r,6).value = fleetCost; tintCell(ws, r, 6, 'fuel');
    r++;
    ws.getCell(r,3).value = 'Total charged back to clients';
    ws.getCell(r,8).value = fleetCharged; tintCell(ws, r, 8, 'amber');
    r++;
    ws.getCell(r,3).value = 'Total net recovery (charged - fronted)'; ws.getCell(r,3).font = {bold:true};
    ws.getCell(r,9).value = fleetCharged - fleetCost; tintNet(ws, r, 9, fleetCharged - fleetCost, true);
    boxRange(ws, fwHeadRow, 3, r, 9);
  }
  return ws;
}

/* ---- Totals sheet: one-page fleet-wide summary — rentals, expenses by category, fuel recovery ---- */
function addTotalsSheet(wb){
  ensurePeriod();
  const start = new Date(db.period.start+'T00:00:00');
  const end = effectivePeriodEnd(db.period);
  const monthLbl = periodRangeLabel(db.period);

  const ws = wb.addWorksheet('Totals');
  ws.getColumn(2).width = 42; ws.getColumn(3).width = 14; ws.getColumn(4).width = 16;

  ledgerTitle(ws, 2, 2, 4, 'FLEET-WIDE — TOTALS SUMMARY (' + monthLbl + ')');

  const rentalsInPeriod = db.rentals.filter(r=> r.status!=='Cancelled' && inRange(r.pickup,start,end));
  const fleetRevenue = rentalsInPeriod.reduce((s,r)=> s+(Number(r.amount)||0), 0);
  const fleetPaid = rentalsInPeriod.reduce((s,r)=> s+paidForRental(r.id), 0);

  let r = 4;
  ws.getCell(r,2).value = 'RENTALS'; ws.getCell(r,2).font = {bold:true};
  r++;
  const rentHead = r;
  ws.getCell(r,2).value = 'METRIC'; ws.getCell(r,3).value = 'AMOUNT';
  styleHeaderRow(ws, r, 2, 3);
  r++;
  ws.getCell(r,2).value = 'Total rental revenue (invoiced)';
  ws.getCell(r,3).value = fleetRevenue; tintCell(ws, r, 3, 'green', true);
  r++;
  ws.getCell(r,2).value = 'Total collected from clients';
  ws.getCell(r,3).value = fleetPaid; tintCell(ws, r, 3, 'green', true);
  r++;
  ws.getCell(r,2).value = 'Total still owed by clients'; ws.getCell(r,2).font = {bold:true};
  ws.getCell(r,3).value = fleetRevenue - fleetPaid; tintCell(ws, r, 3, (fleetRevenue-fleetPaid)>0 ? 'red' : 'green', true);
  boxRange(ws, rentHead, 2, r, 3);
  r += 2;

  const expInPeriod = db.expenses.filter(x=> inRange(x.date,start,end));
  const byCat = {}; EXP_CATEGORIES.forEach(c=>byCat[c]={count:0,amount:0});
  expInPeriod.forEach(x=>{ const cat = byCatMatch(x.category); byCat[cat].count++; byCat[cat].amount += Number(x.amount)||0; });
  const catsUsed = EXP_CATEGORIES.filter(c=>byCat[c].count>0).sort((a,b)=>byCat[b].amount-byCat[a].amount);
  const expTotalAmt = expInPeriod.reduce((s,x)=> s+(Number(x.amount)||0), 0);

  ws.getCell(r,2).value = 'EXPENSES'; ws.getCell(r,2).font = {bold:true};
  r++;
  const expHead = r;
  ws.getCell(r,2).value = 'CATEGORY'; ws.getCell(r,3).value = 'COUNT'; ws.getCell(r,4).value = 'AMOUNT';
  styleHeaderRow(ws, r, 2, 4);
  r++;
  catsUsed.forEach(cat=>{
    ws.getCell(r,2).value = cat; ws.getCell(r,3).value = byCat[cat].count; ws.getCell(r,4).value = byCat[cat].amount;
    tintCell(ws, r, 4, 'red');
    r++;
  });
  ws.getCell(r,2).value = 'TOTAL MONEY USED (ALL EXPENSES)'; ws.getCell(r,2).font = {bold:true};
  ws.getCell(r,3).value = expInPeriod.length; ws.getCell(r,3).font = {bold:true};
  ws.getCell(r,4).value = expTotalAmt; tintCell(ws, r, 4, 'red', true);
  boxRange(ws, expHead, 2, r, 4);
  r += 2;

  // Net income — the headline figure: revenue actually invoiced this period, less every
  // expense logged this period. Green when the fleet made money, red when it didn't.
  const netIncome = fleetRevenue - expTotalAmt;
  ws.getCell(r,2).value = 'NET INCOME'; ws.getCell(r,2).font = {bold:true};
  r++;
  const netHead = r;
  ws.getCell(r,2).value = 'METRIC'; ws.getCell(r,3).value = 'AMOUNT';
  styleHeaderRow(ws, r, 2, 3);
  r++;
  ws.getCell(r,2).value = 'Net income (revenue - expenses)'; ws.getCell(r,2).font = {bold:true};
  ws.getCell(r,3).value = netIncome; tintNet(ws, r, 3, netIncome, true);
  boxRange(ws, netHead, 2, r, 3);
  r += 2;

  const fuelRows = expInPeriod.filter(x=> x.category==='Fuel');
  const fuelCost = fuelRows.reduce((s,x)=> s+(Number(x.amount)||0), 0);
  const fuelCharged = fuelRows.reduce((s,x)=> s+(x.billable ? (Number(x.chargeAmount)||0) : 0), 0);

  ws.getCell(r,2).value = 'FUEL RECOVERY'; ws.getCell(r,2).font = {bold:true};
  r++;
  const fuelHead = r;
  ws.getCell(r,2).value = 'METRIC'; ws.getCell(r,3).value = 'AMOUNT';
  styleHeaderRow(ws, r, 2, 3);
  r++;
  ws.getCell(r,2).value = 'Total office-fronted (fuel spent)';
  ws.getCell(r,3).value = fuelCost; tintCell(ws, r, 3, 'fuel', true);
  r++;
  ws.getCell(r,2).value = 'Total charged back to clients';
  ws.getCell(r,3).value = fuelCharged; tintCell(ws, r, 3, 'amber', true);
  r++;
  ws.getCell(r,2).value = 'Net recovery (charged - fronted)'; ws.getCell(r,2).font = {bold:true};
  ws.getCell(r,3).value = fuelCharged - fuelCost; tintNet(ws, r, 3, fuelCharged - fuelCost, true);
  boxRange(ws, fuelHead, 2, r, 3);
}

async function buildWorkbook(){
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fleet Ledger'; wb.created = new Date();

  Object.keys(DATA_SHEETS).forEach(name=> addDataSheet(wb, name, db[DATA_SHEET_KEY[name]], DATA_SHEETS[name]));
  addDataSheet(wb, 'Meta', [{nextId: db.nextId}], ['nextId']);
  ensurePeriod();
  addDataSheet(wb, 'Settings', [{
    adminPin: (db.settings&&db.settings.adminPin)||'',
    chartType: (db.settings&&db.settings.chartType)||'pie',
    includeStatement: !(db.settings && db.settings.includeStatement===false),
    includeExpenseReport: !!(db.settings && db.settings.includeExpenseReport),
    includeFuelReport: !!(db.settings && db.settings.includeFuelReport),
    includeTotals: !(db.settings && db.settings.includeTotals===false),
    periodStart: db.period ? db.period.start : '',
    periodLabel: db.period ? db.period.label : '',
    dashboardWidgets: JSON.stringify(getDashLayout()),
    lastModified: db.lastModified || ''
  }], SETTINGS_COLS);

  if(!(db.settings && db.settings.includeStatement===false)) addStatementSheet(wb);
  if(db.settings && db.settings.includeExpenseReport) addExpenseReportSheet(wb);
  if(db.settings && db.settings.includeFuelReport) addFuelReportSheet(wb);
  if(!(db.settings && db.settings.includeTotals===false)) addTotalsSheet(wb);

  return wb;
}
function workbookToDb(wb){
  const newDb = {
    vehicles: readDataSheet(wb,'Vehicles', DATA_SHEETS.Vehicles),
    drivers:  readDataSheet(wb,'Drivers',  DATA_SHEETS.Drivers),
    clients:  readDataSheet(wb,'Clients',  DATA_SHEETS.Clients),
    bookings: readDataSheet(wb,'Bookings', DATA_SHEETS.Bookings),
    rentals:  readDataSheet(wb,'Rentals',  DATA_SHEETS.Rentals),
    expenses: readDataSheet(wb,'Expenses', DATA_SHEETS.Expenses),
    payments: readDataSheet(wb,'Payments', DATA_SHEETS.Payments),
    driverAllowances: readDataSheet(wb,'DriverAllowances', DATA_SHEETS.DriverAllowances),
    settings: { adminPin: null, chartType: 'pie', includeStatement: true, includeExpenseReport: false, includeFuelReport: false, includeTotals: true },
    nextId: 1,
    lastModified: null
  };
  const recordCollections = [newDb.vehicles,newDb.drivers,newDb.clients,newDb.bookings,newDb.rentals,newDb.expenses,newDb.payments,newDb.driverAllowances];
  recordCollections.flat().forEach(record=>{
    const numericId = Number(record.id);
    if(Number.isFinite(numericId) && numericId > 0) record.id = numericId;
  });
  newDb.vehicles.forEach(v=>{ v.rate = Number(v.rate)||0; });
  newDb.drivers.forEach(d=>{ d.allowance = Number(d.allowance)||0; });
  newDb.bookings.forEach(bk=>{
    bk.deposit = Number(bk.deposit)||0;
    bk.reminderAck = (bk.reminderAck===true || bk.reminderAck==='true' || bk.reminderAck===1 || bk.reminderAck==='1');
  });
  newDb.rentals.forEach(r=>{ r.rate=Number(r.rate)||0; r.days=Number(r.days)||0; r.amount=Number(r.amount)||0; r.fuel=Number(r.fuel)||0;
    r.fuelCharge = (r.fuelCharge===undefined || r.fuelCharge===null || r.fuelCharge==='') ? r.fuel : (Number(r.fuelCharge)||0); });
  newDb.expenses.forEach(x=>{
    x.qty=Number(x.qty)||1; x.amount=Number(x.amount)||0;
    x.billable = (x.billable===true || x.billable==='true' || x.billable===1 || x.billable==='1');
    x.chargeAmount = Number(x.chargeAmount)||0;
    x.billClientId = x.billClientId ? Number(x.billClientId)||x.billClientId : null;
    x.source = x.source==='rental' ? 'rental' : 'manual';
    x.rentalId = x.rentalId ? (Number(x.rentalId)||x.rentalId) : null;
    if(!x.billable){ x.billClientId = null; x.chargeAmount = 0; }
    if(x.source!=='rental'){ x.rentalId = null; }
  });
  newDb.payments.forEach(p=>{
    p.amount = Number(p.amount)||0;
    p.rentalId = p.rentalId ? (Number(p.rentalId)||p.rentalId) : null;
  });
  newDb.driverAllowances.forEach(a=>{ a.amount = Number(a.amount)||0; });

  const meta = readDataSheet(wb,'Meta', ['nextId']);
  const settingsRows = readDataSheet(wb,'Settings', SETTINGS_COLS);
  newDb.period = null;
  if(settingsRows[0]){
    if(settingsRows[0].adminPin) newDb.settings.adminPin = String(settingsRows[0].adminPin);
    if(settingsRows[0].chartType==='pie' || settingsRows[0].chartType==='bar') newDb.settings.chartType = settingsRows[0].chartType;
    newDb.settings.includeStatement = !(settingsRows[0].includeStatement===false || settingsRows[0].includeStatement==='false' || settingsRows[0].includeStatement===0);
    newDb.settings.includeExpenseReport = (settingsRows[0].includeExpenseReport===true || settingsRows[0].includeExpenseReport==='true' || settingsRows[0].includeExpenseReport===1);
    newDb.settings.includeFuelReport = (settingsRows[0].includeFuelReport===true || settingsRows[0].includeFuelReport==='true' || settingsRows[0].includeFuelReport===1);
    newDb.settings.includeTotals = !(settingsRows[0].includeTotals===false || settingsRows[0].includeTotals==='false' || settingsRows[0].includeTotals===0);
    if(settingsRows[0].periodStart){
      const d = new Date(settingsRows[0].periodStart+'T00:00:00');
      if(!isNaN(d)){
        const {start,end} = monthBounds(d.getFullYear(), d.getMonth());
        newDb.period = { year:d.getFullYear(), month:d.getMonth(), start, end, label: settingsRows[0].periodLabel || monthLabel(d.getFullYear(),d.getMonth()) };
      }
    }
    if(settingsRows[0].dashboardWidgets){
      try{
        const parsed = JSON.parse(settingsRows[0].dashboardWidgets);
        if(Array.isArray(parsed)) newDb.settings.dashboardWidgets = parsed;
      }catch(e){ /* malformed/old file — fall back to default layout */ }
    }
    newDb.lastModified = settingsRows[0].lastModified || null;
  }
  const allIds = [...newDb.vehicles,...newDb.drivers,...newDb.clients,...newDb.bookings,...newDb.rentals,...newDb.expenses,...newDb.payments,...newDb.driverAllowances].map(r=>Number(r.id)||0);
  const savedNextId = meta[0] && Number(meta[0].nextId);
  newDb.nextId = Math.max(Number.isFinite(savedNextId) ? savedNextId : 1, Math.max(0,...allIds)+1);
  migrateExpenseCategories(newDb);
  if(!newDb.period) newDb.period = inferPeriodFromData(newDb);
  return newDb;
}
/* One-time migration: rename old expense category labels to the current ones.
   "Repair" -> "Garage", "Airport charges - In"/"Airport charges - Out" -> "Airport". */
function migrateExpenseCategories(targetDb){
  const renameMap = {
    'Repair': 'Garage',
    'Airport charges - In': 'Airport',
    'Airport charges - Out': 'Airport'
  };
  let changed = 0;
  (targetDb.expenses || []).forEach(x=>{
    if(renameMap[x.category]){ x.category = renameMap[x.category]; changed++; }
  });
  if(changed) toast(`Updated ${changed} expense categor${changed===1?'y':'ies'} to the new names`);
}

/* ---------- save / load ---------- */
function downloadWorkbookBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
async function buildXlsxBlob(){
  if(typeof ExcelJS === 'undefined'){
    throw new Error('The Excel engine did not load (no internet connection, or it was blocked). Reconnect and refresh the page, then try again.');
  }
  const wb = await buildWorkbook();
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
/* Builds a workbook containing only the currently open period's records — vehicles,
   drivers and clients stay in full (so names/rates resolve), but bookings, rentals,
   expenses, payments and allowances are filtered down to the open month's date range.
   Temporarily swaps the global db so every existing sheet-builder (Statement, Totals,
   Fuel, etc.) just works unmodified, then restores it — the live working file, which
   keeps every record forever, is never touched by this. */
async function buildMonthOnlyXlsxBlob(period){
  const inP = d => !!d && d>=period.start && d<=period.end;
  const snapshotDb = {
    vehicles: db.vehicles, drivers: db.drivers, clients: db.clients,
    bookings: db.bookings.filter(bk=>inP(bk.pickup)),
    rentals: db.rentals.filter(r=>inP(r.pickup)),
    expenses: db.expenses.filter(x=>inP(x.date)),
    payments: db.payments.filter(p=>inP(p.date)),
    driverAllowances: db.driverAllowances.filter(a=>inP(a.weekStart)),
    settings: db.settings,
    nextId: db.nextId,
    period: period
  };
  const original = db;
  db = snapshotDb;
  try{
    return await buildXlsxBlob();
  } finally {
    db = original;
  }
}
function allDatabaseDates(){
  const dates = [];
  (db.bookings||[]).forEach(x=>x.pickup && dates.push(x.pickup));
  (db.rentals||[]).forEach(x=>x.pickup && dates.push(x.pickup));
  (db.expenses||[]).forEach(x=>x.date && dates.push(x.date));
  (db.payments||[]).forEach(x=>x.date && dates.push(x.date));
  (db.driverAllowances||[]).forEach(x=>x.weekStart && dates.push(x.weekStart));
  return dates.filter(Boolean);
}
function databaseMonthKeys(){
  return [...new Set(allDatabaseDates().map(d=>String(d).slice(0,7)))].sort();
}
function databaseYearKeys(){
  return [...new Set(databaseMonthKeys().map(k=>k.slice(0,4)))].sort();
}
function archiveYearEligible(){
  return databaseMonthKeys().length >= 10;
}
function archiveMonthLabel(key){
  const [y,m]=key.split('-').map(Number);
  return monthLabel(y,m-1);
}
function openArchiveMonthPicker(){
  const keys=databaseMonthKeys();
  ensurePeriod();
  const currentKey=`${db.period.year}-${String(db.period.month+1).padStart(2,'0')}`;
  if(!keys.includes(currentKey)) keys.push(currentKey);
  keys.sort().reverse();
  const existing=document.getElementById('archiveMonthModal'); if(existing) existing.remove();
  const overlay=document.createElement('div'); overlay.className='modal-overlay show'; overlay.id='archiveMonthModal';
  overlay.innerHTML=`<div class="modal-box" style="max-width:520px;">
    <div class="modal-head"><div><h2>Save month / previous</h2><p>Choose the month to export as a clean standalone Excel file.</p></div><button class="modal-close" id="archiveMonthClose">✕</button></div>
    <div class="modal-body">
      <label style="display:block;margin-bottom:6px;">Month</label>
      <select id="archiveMonthSelect" style="width:100%;margin-bottom:12px;">
        ${keys.map(k=>`<option value="${k}" ${k===currentKey?'selected':''}>${archiveMonthLabel(k)}${k===currentKey?' — current':''}</option>`).join('')}
      </select>
      <div class="hint" style="margin-bottom:16px;">The exported file contains that month's bookings, rentals, expenses, payments and driver allowances. Vehicles, drivers and clients remain available for reference.</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn" id="archiveMonthCancel" style="width:auto;padding:9px 16px;">Cancel</button><button class="btn primary" id="archiveMonthGo" style="width:auto;padding:9px 16px;">💾 Save selected month</button></div>
    </div></div>`;
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelector('#archiveMonthClose').onclick=close; overlay.querySelector('#archiveMonthCancel').onclick=close;
  overlay.querySelector('#archiveMonthGo').onclick=async()=>{
    const key=overlay.querySelector('#archiveMonthSelect').value; close();
    const [y,m]=key.split('-').map(Number);
    await saveArchiveMonth({year:y,month:m-1,start:monthBounds(y,m-1).start,end:monthBounds(y,m-1).end,label:monthLabel(y,m-1)});
  };
}
async function saveArchiveMonth(period){
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--mono);font-size:13px;';
  overlay.textContent=`Saving ${period.label}…`; document.body.appendChild(overlay);
  try{
    const blob=await buildMonthOnlyXlsxBlob(period);
    const filename=`Fleet Ledger - ${period.label}.xlsx`; const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast(`Saved ${period.label} (${period.start} – ${period.end}). Your working database was not changed.`);
  }catch(err){ console.error(err); toast(err.message || 'Could not save the selected month.'); }
  finally{ overlay.remove(); }
}
function updateArchiveStatus(){
  const el=document.getElementById('archiveMonthStatus'); if(!el) return;
  const count=databaseMonthKeys().length;
  el.textContent=`${count} month${count===1?'':'s'} represented in database${count>=10?' · yearly export enabled':' · '+(10-count)+' more month'+(10-count===1?'':'s')+' needed for yearly export'}`;
}
document.getElementById('btnSaveThisMonth').addEventListener('click', openArchiveMonthPicker);
document.getElementById('btnSaveYear').addEventListener('click', async ()=>{
  const count=databaseMonthKeys().length;
  if(count<10){ toast(`Save year is locked until the database contains at least 10 different months. Currently ${count} month${count===1?' is':'s are'} represented.`); return; }
  const years=databaseYearKeys();
  const defaultYear=db.period ? String(db.period.year) : years[years.length-1];
  const existing=document.getElementById('archiveYearModal'); if(existing) existing.remove();
  const overlay=document.createElement('div'); overlay.className='modal-overlay show'; overlay.id='archiveYearModal';
  overlay.innerHTML=`<div class="modal-box" style="max-width:520px;">
    <div class="modal-head"><div><h2>Save year</h2><p>The database has ${count} different calendar months.</p></div><button class="modal-close" id="archiveYearClose">✕</button></div>
    <div class="modal-body"><label style="display:block;margin-bottom:6px;">Year</label><select id="archiveYearSelect" style="width:100%;margin-bottom:12px;">${years.slice().reverse().map(y=>`<option value="${y}" ${y===defaultYear?'selected':''}>${y}</option>`).join('')}</select>
    <div class="hint" style="margin-bottom:16px;">This creates one standalone Excel archive containing records from 1 January through 31 December of the selected year.</div>
    <div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn" id="archiveYearCancel" style="width:auto;padding:9px 16px;">Cancel</button><button class="btn primary" id="archiveYearGo" style="width:auto;padding:9px 16px;">🗓 Save selected year</button></div></div></div>`;
  document.body.appendChild(overlay); const close=()=>overlay.remove(); overlay.querySelector('#archiveYearClose').onclick=close; overlay.querySelector('#archiveYearCancel').onclick=close;
  overlay.querySelector('#archiveYearGo').onclick=async()=>{ const y=Number(overlay.querySelector('#archiveYearSelect').value); close(); await saveArchiveYear(y); };
});
async function saveArchiveYear(year){
  const period={year,month:0,start:`${year}-01-01`,end:`${year}-12-31`,label:String(year)};
  const overlay=document.createElement('div'); overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--mono);font-size:13px;'; overlay.textContent=`Saving ${year}…`; document.body.appendChild(overlay);
  const inP=d=>!!d && d>=period.start && d<=period.end;
  const snapshotDb={vehicles:db.vehicles,drivers:db.drivers,clients:db.clients,bookings:db.bookings.filter(x=>inP(x.pickup)),rentals:db.rentals.filter(x=>inP(x.pickup)),expenses:db.expenses.filter(x=>inP(x.date)),payments:db.payments.filter(x=>inP(x.date)),driverAllowances:db.driverAllowances.filter(x=>inP(x.weekStart)),settings:db.settings,nextId:db.nextId,period:period};
  const original=db;
  try{ db=snapshotDb; const blob=await buildXlsxBlob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`Fleet Ledger - ${year}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast(`Saved the ${year} annual archive. Your working database was not changed.`); }
  catch(err){ console.error(err); toast(err.message || 'Could not save the yearly archive.'); }
  finally{ db=original; overlay.remove(); }
}
updateArchiveStatus();

document.getElementById('btnSaveThisMonth').addEventListener('click', async ()=>{
  ensurePeriod();
  const period = db.period;
  // buildMonthOnlyXlsxBlob briefly swaps the global db for a filtered snapshot; block
  // interaction for that window so nothing the user adds/edits in the meantime can land
  // in the throwaway snapshot copy and get lost when db is restored.
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--mono);font-size:13px;';
  overlay.textContent = `Saving ${period.label}…`;
  document.body.appendChild(overlay);
  try{
    const blob = await buildMonthOnlyXlsxBlob(period);
    const filename = `Fleet Ledger - ${period.label}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
    toast(`Saved a clean ${period.label} file (${period.start} – ${period.end}). Your working file still has everything.`);
  }catch(err){
    console.error(err);
    toast(err.message || "Could not save this month's file.");
  } finally {
    overlay.remove();
  }
});
document.getElementById('btnSave').addEventListener('click', async ()=>{
  try{
    const blob = await buildXlsxBlob();
    ensurePeriod();
    const suggested = currentFileName || `Fleet Ledger - ${db.period.label}.xlsx`;
    if(window.showSaveFilePicker){
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types:[{description:'Excel Workbook', accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        currentFileHandle = handle;
        currentFileName = handle.name;
        dirty = false; renderFileStatus();
        await persistLocalDatabase();
        toast('Saved ' + currentFileName + ' — "Update existing file" will now overwrite it directly');
        return;
      }catch(err){ if(err.name==='AbortError') return; /* fall through to download */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = suggested;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    currentFileName = suggested;
    currentFileHandle = null;
    dirty = false; renderFileStatus();
    await persistLocalDatabase();
    toast('Saved ' + suggested + ' to your Downloads folder');
  }catch(err){
    console.error('Save failed:', err);
    toast('Save failed: ' + (err && err.message ? err.message : 'unknown error') + ' — check the browser console for details.');
  }
});

document.getElementById('btnUpdate').addEventListener('click', async ()=>{
  if(!currentFileHandle){
    try{
      const blob = await buildXlsxBlob();
      ensurePeriod();
      const filename = currentFileName || `Fleet Ledger - ${db.period.label}.xlsx`;
      downloadWorkbookBlob(blob, filename);
      currentFileName = filename;
      dirty = false; renderFileStatus();
      await persistLocalDatabase();
      toast('Downloaded updated copy as ' + filename + '. This preview cannot overwrite the original file directly.');
    }catch(err){
      console.error('Update download failed:', err);
      toast('Could not download the updated file: ' + (err && err.message ? err.message : 'unknown error'));
    }
    return;
  }
  let blob;
  try{
    blob = await buildXlsxBlob();
    const writable = await currentFileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    dirty = false; renderFileStatus();
    await persistLocalDatabase();
    toast('Updated ' + currentFileName);
  }catch(err){
    console.error('Update failed:', err);
    try{
      if(!blob) blob = await buildXlsxBlob();
      ensurePeriod();
      const filename = currentFileName || `Fleet Ledger - ${db.period.label}.xlsx`;
      downloadWorkbookBlob(blob, filename);
      currentFileHandle = null;
      currentFileName = filename;
      dirty = false; renderFileStatus();
      await persistLocalDatabase();
      toast('Could not overwrite the original here. Downloaded an updated copy as ' + filename);
    }catch(downloadError){
      console.error('Update download failed:', downloadError);
      toast('Could not update or download the file: ' + (downloadError && downloadError.message ? downloadError.message : 'unknown error'));
    }
  }
});

document.getElementById('btnLoad').addEventListener('click', async ()=>{
  if(typeof ExcelJS === 'undefined'){
    toast('The Excel engine did not load (no internet connection, or it was blocked). Reconnect and refresh the page, then try again.');
    return;
  }
  if(window.showOpenFilePicker){
    try{
      const [handle] = await window.showOpenFilePicker({
        types:[{description:'Excel Workbook', accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]
      });
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const loadedDb = workbookToDb(wb);
      if(!confirmLoadOverUnsaved(loadedDb)) return;
      db = loadedDb;
      syncSheetCheckboxes();
      currentFileHandle = handle; currentFileName = file.name; dirty = false;
      await persistLocalDatabase();
      rolloverPromptShownThisSession = false;
      resetPeriodToDataDefault();
      renderAll();
      checkMonthRollover();
      toast('Loaded ' + file.name);
      migratePinIfNeeded(db);
      return;
    }catch(err){
      if(err.name==='AbortError') return;
      if(err.name!=='NotAllowedError' && err.name!=='SecurityError'){
        console.error('Open failed:', err);
        toast('Could not open that file: ' + (err && err.message ? err.message : 'unknown error'));
        return;
      }
        console.warn('Direct open unavailable; using the browser file chooser:', err);
        toast('Direct file access is unavailable here. Choose the workbook in the file chooser.');
    }
  }
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', e=>{
  const f = e.target.files[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(reader.result);
      const loadedDb = workbookToDb(wb);
      if(!confirmLoadOverUnsaved(loadedDb)){ e.target.value=''; return; }
      db = loadedDb;
      syncSheetCheckboxes();
      currentFileHandle = null; currentFileName = f.name; dirty = false;
      await persistLocalDatabase();
      rolloverPromptShownThisSession = false;
      resetPeriodToDataDefault();
      renderAll();
      checkMonthRollover();
      toast('Loaded ' + f.name + ' (use Save to link it for direct updates)');
      migratePinIfNeeded(db);
    }catch(err){ console.error('Read failed:', err); toast('Could not read that file — is it a saved database file (.xlsx)?'); }
  };
  reader.readAsArrayBuffer(f);
  e.target.value = '';
});

/* ---------- dashboard: optional "compare vs another month's file" ----------
   Lets someone see live dashboard deltas against a DIFFERENT saved Fleet Ledger
   file (e.g. last month's, if months are kept as separate files rather than one
   running ledger) without touching the currently open working file. Purely a
   session-side comparison: nothing here is saved into the open file or its
   exported reports, and it clears itself on page reload. */
let compareDb = null;
let compareFileName = null;
document.getElementById('btnCompareUpload').addEventListener('click', ()=>{
  if(typeof ExcelJS === 'undefined'){
    toast('The Excel engine did not load (no internet connection, or it was blocked). Reconnect and refresh the page, then try again.');
    return;
  }
  document.getElementById('compareFileInput').click();
});
document.getElementById('compareFileInput').addEventListener('change', e=>{
  const f = e.target.files[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(reader.result);
      const loaded = workbookToDb(wb);
      compareDb = loaded;
      compareFileName = f.name;
      renderCompareStatus();
      renderDashboard();
      toast('Comparing against ' + loaded.period.label + ' (' + f.name + ')');
    }catch(err){
      console.error('Compare read failed:', err);
      toast('Could not read that file — is it a saved Fleet Ledger database file (.xlsx)?');
    }
  };
  reader.readAsArrayBuffer(f);
  e.target.value = '';
});
document.getElementById('btnCompareClear').addEventListener('click', ()=>{
  compareDb = null; compareFileName = null;
  renderCompareStatus();
  renderDashboard();
});
function renderCompareStatus(){
  const status = document.getElementById('compareStatus');
  const clearBtn = document.getElementById('btnCompareClear');
  if(compareDb){
    status.textContent = `Comparing against: ${compareDb.period.label} — ${compareFileName}`;
    clearBtn.style.display = '';
  } else {
    status.textContent = '';
    clearBtn.style.display = 'none';
  }
}
/* Pulls the same four headline figures (revenue, expenses, fuel, net) out of a
   compare file, scoped to THAT file's own open period — mirrors periodMonthRange(0)
   but against an arbitrary db object instead of the global one. */
function summarizeDbForPeriod(targetDb){
  const p = targetDb.period;
  const revenue = targetDb.rentals.filter(r=>r.status!=='Cancelled' && inRange(r.pickup,p.start,p.end)).reduce((s,r)=>s+r.amount,0);
  const expenses = targetDb.expenses.filter(x=>inRange(x.date,p.start,p.end)).reduce((s,x)=>s+x.amount,0);
  const fuel = targetDb.expenses.filter(x=>x.category==='Fuel' && inRange(x.date,p.start,p.end)).reduce((s,x)=>s+x.amount,0);
  return { revenue, expenses, fuel, net: revenue-expenses, label: p.label };
}
function syncSheetCheckboxes(){
  if(!db.settings) db.settings = { adminPin: null };
  document.getElementById('chkIncludeStatement').checked = db.settings.includeStatement !== false;
  document.getElementById('chkIncludeExpenseReport').checked = !!db.settings.includeExpenseReport;
  document.getElementById('chkIncludeFuelReport').checked = !!db.settings.includeFuelReport;
  document.getElementById('chkIncludeTotals').checked = db.settings.includeTotals !== false;
}
document.getElementById('chkIncludeStatement').addEventListener('change', e=>{
  if(!db.settings) db.settings = { adminPin: null };
  db.settings.includeStatement = e.target.checked;
  markDirty();
});
document.getElementById('chkIncludeExpenseReport').addEventListener('change', e=>{
  if(!db.settings) db.settings = { adminPin: null };
  db.settings.includeExpenseReport = e.target.checked;
  markDirty();
});
document.getElementById('chkIncludeFuelReport').addEventListener('change', e=>{
  if(!db.settings) db.settings = { adminPin: null };
  db.settings.includeFuelReport = e.target.checked;
  markDirty();
});
document.getElementById('chkIncludeTotals').addEventListener('change', e=>{
  if(!db.settings) db.settings = { adminPin: null };
  db.settings.includeTotals = e.target.checked;
  markDirty();
});
function renderFileStatus(){
  ensurePeriod();
  const el = document.getElementById('fileStatus');
  const localStatus = localSaveError
    ? '<span class="dirty">● local save failed</span>'
    : localSavePending
      ? '<span class="dirty">● saving locally…</span>'
      : '<span class="clean">● saved on this device</span>';
  const workbookStatus = dirty
    ? '<span class="dirty">Excel backup needs updating</span>'
    : currentFileName ? `Excel backup: ${escapeHTML(currentFileName)}` : 'No Excel backup yet';
  el.innerHTML = localStatus + `<br>${workbookStatus}` +
    `<br><span style="color:var(--amber);">📅 ${db.period.label}</span> <span style="color:var(--ink-faint);">(${db.period.start} – ${db.period.end})</span>`;
  const saveMonthLabel = document.getElementById('saveMonthLabel');
  if(saveMonthLabel) saveMonthLabel.textContent = db.period.label;
}
window.addEventListener('beforeunload', e=>{
  if(localSavePending){ e.preventDefault(); e.returnValue=''; }
});
window.addEventListener('pagehide', ()=>{
  if(localSavePending){
    clearTimeout(localSaveTimer);
    void saveAutosaveSnapshot();
  }
});
document.getElementById('rolloverBanner').addEventListener('click', ()=>{
  const now = new Date();
  openRolloverModal(now.getFullYear(), now.getMonth());
});
setInterval(checkMonthRollover, 30*60*1000); // re-check every 30 min, for tabs left open across midnight
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden && localSavePending){
    clearTimeout(localSaveTimer);
    void saveAutosaveSnapshot();
  }
  if(!document.hidden) checkMonthRollover();
});

/* ---------- vehicles ---------- */
document.getElementById('btnAddVehicle').addEventListener('click', ()=>{
  const reg = document.getElementById('v_reg').value.trim();
  if(!reg){ toast('Reg no. is required'); return; }
  const dupe = db.vehicles.find(v=>v.id!=editingVehicleId && v.reg.trim().toLowerCase()===reg.toLowerCase());
  if(dupe){ toast('A vehicle with reg "' + dupe.reg + '" already exists'); return; }
  const rate = parseFloat(document.getElementById('v_rate').value)||0;
  if(!isValidMoney(rate, {allowZero:true})){ toast('Daily rate can\'t be negative'); return; }
  const fields = {
    reg,
    make: document.getElementById('v_make').value.trim(),
    model: document.getElementById('v_model').value.trim(),
    year: document.getElementById('v_year').value,
    rate,
    owner: document.getElementById('v_owner').value.trim(),
    status: document.getElementById('v_status').value
  };
  const finish = ()=>{
    if(editingVehicleId){
      const v = db.vehicles.find(v=>v.id==editingVehicleId);
      Object.assign(v, fields);
      editingVehicleId = null;
      document.getElementById('btnAddVehicle').textContent = '+ Add vehicle';
    } else {
      db.vehicles.push({ id: uid(), ...fields });
    }
    ['v_reg','v_make','v_model','v_year','v_rate','v_owner'].forEach(id=>document.getElementById(id).value='');
    markDirty(); renderVehicles(); renderSelects();
  };
  if(editingVehicleId){ checkAdminPin('save changes to this vehicle', finish); }
  else { finish(); }
});
function renderVehicles(){
  refreshRentalVehicleSelect();
  const tb = document.querySelector('#vehicleTable tbody'); tb.innerHTML='';
  if(!db.vehicles.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="6">No vehicles yet — add your first car above.</td></tr>'; return; }
  db.vehicles.forEach(v=>{
    const tr = document.createElement('tr');
    tr.dataset.id = v.id;
    tr.innerHTML = `<td>${v.reg}</td><td>${v.make} ${v.model} ${v.year?('\''+String(v.year).slice(-2)):''}</td>
      <td>${v.owner||'—'}</td><td class="num">${fmt(v.rate)}</td>
      <td><span class="tag ${v.status}">${v.status}</span></td>
      <td><button class="row-edit" data-id="${v.id}">✎</button><button class="row-del" data-id="${v.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const v = db.vehicles.find(v=>v.id==b.dataset.id); if(!v) return;
    checkAdminPin('edit this vehicle', ()=>{
      editingVehicleId = v.id;
      document.getElementById('v_reg').value = v.reg;
      document.getElementById('v_make').value = v.make;
      document.getElementById('v_model').value = v.model;
      document.getElementById('v_year').value = v.year;
      document.getElementById('v_rate').value = v.rate;
      document.getElementById('v_owner').value = v.owner;
      document.getElementById('v_status').value = v.status;
      document.getElementById('btnAddVehicle').textContent = '✓ Update vehicle';
      scrollToForm('vehicleForm');
      toast('Editing ' + v.reg + ' — update the fields and click Update vehicle');
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    checkAdminPin('delete this vehicle', ()=>{
      db.vehicles = db.vehicles.filter(v=>v.id!=b.dataset.id);
      markDirty(); renderVehicles(); renderSelects();
    });
  }));
}

/* ---------- drivers ---------- */
document.getElementById('btnAddDriver').addEventListener('click', ()=>{
  const name = document.getElementById('d_name').value.trim();
  if(!name){ toast('Driver name is required'); return; }
  db.drivers.push({
    id: uid(), name,
    phone: document.getElementById('d_phone').value.trim(),
    license: document.getElementById('d_license').value.trim(),
    vehicleId: document.getElementById('d_vehicle').value,
    allowance: parseFloat(document.getElementById('d_allowance').value)||0,
    status: document.getElementById('d_status').value
  });
  ['d_name','d_phone','d_license','d_allowance'].forEach(id=>document.getElementById(id).value='');
  markDirty(); renderDrivers(); renderSelects();
});
function renderDrivers(){
  const tb = document.querySelector('#driverTable tbody'); tb.innerHTML='';
  if(!db.drivers.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="7">No drivers yet.</td></tr>'; return; }
  db.drivers.forEach(d=>{
    const v = db.vehicles.find(v=>v.id==d.vehicleId);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.name}</td><td>${d.phone||'—'}</td><td>${d.license||'—'}</td>
      <td>${v?v.reg:'—'}</td><td class="num">${fmt(d.allowance)}</td>
      <td><span class="tag ${d.status}">${d.status}</span></td>
      <td><button class="row-del" data-id="${d.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    db.drivers = db.drivers.filter(d=>d.id!=b.dataset.id);
    markDirty(); renderDrivers();
  }));
}

/* ---------- driver allowances ---------- */
document.getElementById('al_driver').addEventListener('change', ()=>{
  const d = db.drivers.find(d=>d.id==document.getElementById('al_driver').value);
  if(d && !document.getElementById('al_amount').value) document.getElementById('al_amount').value = d.allowance || '';
});
document.getElementById('btnAddAllowance').addEventListener('click', ()=>{
  const driverId = document.getElementById('al_driver').value;
  const weekStart = document.getElementById('al_week').value;
  const amount = parseFloat(document.getElementById('al_amount').value)||0;
  if(!driverId||!weekStart||!amount){ toast('Driver, week starting and amount are required'); return; }
  db.driverAllowances.push({
    id: uid(), driverId, weekStart: weekStart, amount,
    note: document.getElementById('al_note').value.trim()
  });
  ['al_week','al_amount','al_note'].forEach(id=>document.getElementById(id).value='');
  markDirty(); renderAllowances(); renderAllowanceSummary();
});
function renderAllowances(){
  const tb = document.querySelector('#allowanceTable tbody'); tb.innerHTML='';
  if(!db.driverAllowances.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="5">No allowance payments logged yet.</td></tr>'; return; }
  let lastMonth = null;
  [...db.driverAllowances].sort((a,b)=> b.weekStart<a.weekStart?-1:(b.weekStart>a.weekStart?1:0)).forEach(a=>{
    const rowMonth = monthOfDate(a.weekStart);
    if(rowMonth !== lastMonth){ tb.appendChild(monthDividerRow(5, rowMonth)); lastMonth = rowMonth; }
    const d = db.drivers.find(d=>d.id==a.driverId);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d?d.name:'—'}</td><td>${a.weekStart}${lockBadge(a.weekStart)}</td><td class="num">${fmt(a.amount)}</td>
      <td>${a.note||'—'}</td><td><button class="row-del" data-id="${a.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    const a = db.driverAllowances.find(a=>a.id==b.dataset.id); if(!a) return;
    guardClosedMonth(a.weekStart, 'delete this allowance payment', ()=>{
      checkAdminPin('delete this allowance payment', ()=>{
        db.driverAllowances = db.driverAllowances.filter(x=>x.id!=a.id);
        markDirty(); renderAllowances(); renderAllowanceSummary();
      });
    });
  }));
}
let alPeriodType = 'monthly';
document.getElementById('alPeriodSeg').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  document.querySelectorAll('#alPeriodSeg button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  alPeriodType = btn.dataset.p;
  document.getElementById('al_ref').style.display = alPeriodType==='custom' ? 'none' : 'inline-block';
  document.getElementById('alCustomRange').style.display = alPeriodType==='custom' ? 'inline-flex' : 'none';
  renderAllowanceSummary();
});
document.getElementById('al_ref').addEventListener('change', renderAllowanceSummary);
document.getElementById('al_start').addEventListener('change', renderAllowanceSummary);
document.getElementById('al_end').addEventListener('change', renderAllowanceSummary);
function renderAllowanceSummary(){
  if(!document.getElementById('al_ref').value) document.getElementById('al_ref').value = toLocalISO(new Date());
  const {start,end} = computePeriodRange(alPeriodType,
    document.getElementById('al_ref').value,
    document.getElementById('al_start').value,
    document.getElementById('al_end').value);
  document.getElementById('alPeriodLabel').textContent = 'Showing: ' + start.toDateString() + '  →  ' + end.toDateString();
  const rows = db.driverAllowances.filter(a=>inRange(a.weekStart,start,end));
  const byDriver = {};
  rows.forEach(a=>{
    if(!byDriver[a.driverId]) byDriver[a.driverId] = {count:0, total:0};
    byDriver[a.driverId].count++; byDriver[a.driverId].total += a.amount;
  });
  const tb = document.querySelector('#allowanceSummaryTable tbody'); tb.innerHTML='';
  const ids = Object.keys(byDriver);
  if(!ids.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="3">No allowance payments in this period.</td></tr>'; return; }
  ids.sort((a,b)=>byDriver[b].total-byDriver[a].total).forEach(id=>{
    const d = db.drivers.find(d=>d.id==id);
    const s = byDriver[id];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d?d.name:'—'}</td><td class="num">${s.count}</td><td class="num">${fmt(s.total)}</td>`;
    tb.appendChild(tr);
  });
}

/* ---------- clients ---------- */
document.getElementById('btnAddClient').addEventListener('click', ()=>{
  const name = document.getElementById('c_name').value.trim();
  if(!name){ toast('Name is required'); return; }
  const fields = {
    name,
    phone: document.getElementById('c_phone').value.trim(),
    idnum: document.getElementById('c_id').value.trim(),
    dl: document.getElementById('c_dl').value.trim()
  };
  const finish = ()=>{
    if(editingClientId){
      const c = db.clients.find(c=>c.id==editingClientId);
      Object.assign(c, fields);
      editingClientId = null;
      document.getElementById('btnAddClient').textContent = '+ Add client';
    } else {
      db.clients.push({ id: uid(), ...fields });
    }
    ['c_name','c_phone','c_id','c_dl'].forEach(id=>document.getElementById(id).value='');
    markDirty(); renderClients(); renderSelects();
  };
  if(editingClientId){ checkAdminPin('save changes to this client', finish); }
  else { finish(); }
});
function renderClients(){
  const tb = document.querySelector('#clientTable tbody'); tb.innerHTML='';
  if(!db.clients.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="5">No clients yet.</td></tr>'; return; }
  db.clients.forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${c.name}</td><td>${c.phone||'—'}</td><td>${c.idnum||'—'}</td><td>${c.dl||'—'}</td>
      <td><button class="row-edit" data-id="${c.id}">✎</button><button class="row-del" data-id="${c.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const c = db.clients.find(c=>c.id==b.dataset.id); if(!c) return;
    checkAdminPin('edit this client', ()=>{
      editingClientId = c.id;
      document.getElementById('c_name').value = c.name;
      document.getElementById('c_phone').value = c.phone;
      document.getElementById('c_id').value = c.idnum;
      document.getElementById('c_dl').value = c.dl;
      document.getElementById('btnAddClient').textContent = '✓ Update client';
      scrollToForm('clientForm');
      toast('Editing ' + c.name + ' — update the fields and click Update client');
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    checkAdminPin('delete this client', ()=>{
      db.clients = db.clients.filter(c=>c.id!=b.dataset.id);
      markDirty(); renderClients(); renderSelects();
    });
  }));
}

/* ---------- shared selects ---------- */
/* Rentals vehicle dropdown shows each vehicle's current status and blocks picking
   one that's already Rented or in Maintenance — the one exception being the vehicle
   already tied to the rental currently being edited, which is only "Rented" because
   of this very record. */
function buildRentalVehicleOptions(){
  const exceptId = editingRentalId ? (db.rentals.find(r=>r.id==editingRentalId)||{}).vehicleId : null;
  return db.vehicles.map(v=>{
    const status = v.status||'Available';
    const blocked = (status==='Rented' || status==='Maintenance') && v.id!=exceptId;
    return `<option value="${v.id}" ${blocked?'disabled':''}>${v.reg} — ${v.make} ${v.model} · ${status}</option>`;
  }).join('');
}
function refreshRentalVehicleSelect(){
  const sel = document.getElementById('r_vehicle'); if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = buildRentalVehicleOptions() || '<option value="">Add a vehicle first</option>';
  if(prev) sel.value = prev;
}
function renderSelects(){
  const vOpts = db.vehicles.map(v=>`<option value="${v.id}">${v.reg} — ${v.make} ${v.model}</option>`).join('');
  const cOpts = db.clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  refreshRentalVehicleSelect();
  document.getElementById('e_vehicle').innerHTML = '<option value="">— Office / General (not vehicle-specific) —</option>' + vOpts;
  document.getElementById('bk_vehicle').innerHTML = vOpts || '<option value="">Add a vehicle first</option>';
  document.getElementById('d_vehicle').innerHTML = '<option value="">Unassigned</option>' + vOpts;
  const dOpts = db.drivers.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  document.getElementById('al_driver').innerHTML = dOpts || '<option value="">Add a driver first</option>';
  document.getElementById('r_client').innerHTML = cOpts || '<option value="">Add a client first</option>';
  document.getElementById('bk_client').innerHTML = cOpts || '<option value="">Add a client first</option>';
  document.getElementById('e_billable_client').innerHTML = cOpts || '<option value="">Add a client first</option>';
  const repPick = document.getElementById('rep_vehicle_pick');
  const prevPick = repPick.value;
  repPick.innerHTML = '<option value="">Select a vehicle…</option>' + vOpts;
  if(prevPick) repPick.value = prevPick;
}
document.getElementById('r_vehicle').addEventListener('change', ()=>{
  const v = db.vehicles.find(v=>v.id==document.getElementById('r_vehicle').value);
  if(v) document.getElementById('r_rate').value = v.rate||'';
});
document.getElementById('rep_vehicle_pick').addEventListener('change', renderVehicleStatement);

/* ---------- double-booking prevention ---------- */
/* Two date ranges (inclusive, 'YYYY-MM-DD' strings) overlap if each starts on/before
   the other's end. A booking/rental whose return date equals another's pickup date
   (same-day turnover) is flagged too, since the outgoing vehicle may come back late —
   the user can still confirm and save anyway. */
function rangesOverlap(startA, endA, startB, endB){
  return startA <= endB && endA >= startB;
}
/* Checks a vehicle+date range against every other non-cancelled booking and rental
   for that vehicle. Pass excludeBookingId/excludeRentalId when editing an existing
   record so it doesn't conflict with itself. Returns a list of human-readable
   conflict descriptions (empty if the vehicle is free). */
function findVehicleConflicts(vehicleId, pickup, ret, opts){
  opts = opts || {};
  const conflicts = [];
  db.bookings.forEach(bk=>{
    if(bk.vehicleId!=vehicleId || bk.status==='Cancelled') return;
    if(opts.excludeBookingId && bk.id==opts.excludeBookingId) return;
    if(rangesOverlap(pickup, ret, bk.pickup, bk.return)){
      const c = db.clients.find(c=>c.id==bk.clientId);
      conflicts.push(`Booking (${bk.status}) for ${c?c.name:'—'}: ${bk.pickup} → ${bk.return}`);
    }
  });
  db.rentals.forEach(r=>{
    if(r.vehicleId!=vehicleId || r.status==='Cancelled') return;
    if(opts.excludeRentalId && r.id==opts.excludeRentalId) return;
    if(rangesOverlap(pickup, ret, r.pickup, r.return)){
      const c = db.clients.find(c=>c.id==r.clientId);
      conflicts.push(`Rental (${r.status}) for ${c?c.name:'—'}: ${r.pickup} → ${r.return}`);
    }
  });
  return conflicts;
}

/* ---------- bookings ---------- */
/* ---------- booking pickup reminders ---------- */
function isDueSoon(bk){
  if(bk.status==='Cancelled' || bk.reminderAck) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);
  const p = new Date(bk.pickup+'T00:00:00');
  return p.getTime()===today.getTime() || p.getTime()===tomorrow.getTime();
}
function getDueSoonBookings(){ return db.bookings.filter(isDueSoon); }
function renderBookingReminders(){
  const due = getDueSoonBookings();
  const wrap = document.getElementById('bookingReminderWrap');
  const list = document.getElementById('bookingReminderList');
  const badge = document.getElementById('navBookingsBadge');
  if(!due.length){ wrap.style.display='none'; list.innerHTML=''; badge.style.display='none'; return; }
  wrap.style.display=''; badge.style.display='';
  const today = new Date(); today.setHours(0,0,0,0);
  list.innerHTML = due.map(bk=>{
    const v = db.vehicles.find(v=>v.id==bk.vehicleId), c = db.clients.find(c=>c.id==bk.clientId);
    const p = new Date(bk.pickup+'T00:00:00');
    const when = p.getTime()===today.getTime() ? 'Today' : 'Tomorrow';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);">
      <div style="font-size:13px;"><span class="row-reminder-dot" style="cursor:default;"></span>
        <b>${when}</b> — ${v?v.reg:'—'} for ${c?c.name:'—'} <span style="color:var(--ink-faint);">(pickup ${bk.pickup})</span></div>
      <button class="row-action" data-id="${bk.id}">Got it</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.row-action').forEach(b=>b.addEventListener('click',()=>{
    const bk = db.bookings.find(bk=>bk.id==b.dataset.id);
    if(bk){ bk.reminderAck = true; markDirty(); renderBookings(); }
  }));
  if(typeof renderWatchlist==='function') renderWatchlist();
}
document.getElementById('btnAddBooking').addEventListener('click', ()=>{
  const vid = document.getElementById('bk_vehicle').value, cid = document.getElementById('bk_client').value;
  const pickup = document.getElementById('bk_pickup').value, ret = document.getElementById('bk_return').value;
  if(!vid||!cid||!pickup||!ret){ toast('Vehicle, client, planned pickup and return are required'); return; }
  if(!isReasonableDate(pickup)||!isReasonableDate(ret)){ toast('Please enter valid planned pickup and return dates'); return; }
  const bookingDate = document.getElementById('bk_date').value || toLocalISO(new Date());
  const deposit = parseFloat(document.getElementById('bk_deposit').value)||0;
  if(!isReasonableDate(bookingDate)){ toast('Booking date is invalid'); return; }
  if(!isValidMoney(deposit,{allowZero:true})){ toast('Deposit cannot be negative'); return; }
  if(new Date(ret) < new Date(pickup)){ toast('Planned return can\'t be before planned pickup'); return; }
  if(document.getElementById('bk_status').value !== 'Cancelled'){
    const conflicts = findVehicleConflicts(vid, pickup, ret, {excludeBookingId: editingBookingId});
    if(conflicts.length){
      const ok = confirm('This vehicle already has overlapping dates:\n\n' + conflicts.join('\n') +
        '\n\nSave this booking anyway?');
      if(!ok) return;
    }
  }
  const fields = {
    vehicleId: vid, clientId: cid,
    bookedOn: bookingDate,
    pickup, return: ret,
    deposit,
    status: document.getElementById('bk_status').value
  };
  const finish = ()=>{
    if(editingBookingId){
      const bk = db.bookings.find(bk=>bk.id==editingBookingId);
      if(fields.pickup !== bk.pickup) bk.reminderAck = false; // pickup date changed — reminder should fire again
      Object.assign(bk, fields);
      editingBookingId = null;
      document.getElementById('btnAddBooking').textContent = '+ Add booking';
    } else {
      db.bookings.push({ id: uid(), reminderAck: false, ...fields });
    }
    ['bk_date','bk_pickup','bk_return','bk_deposit'].forEach(id=>document.getElementById(id).value='');
    markDirty(); renderBookings(); renderDashBookings();
  };
  if(editingBookingId){ checkAdminPin('save changes to this booking', finish); }
  else { finish(); }
});
function renderBookings(){
  const tb = document.querySelector('#bookingTable tbody'); tb.innerHTML='';
  if(!db.bookings.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="8">No bookings yet.</td></tr>'; renderBookingReminders(); return; }
  let lastMonth = null;
  [...db.bookings].sort((a,b)=>new Date(b.pickup)-new Date(a.pickup)).forEach(bk=>{
    const rowMonth = monthOfDate(bk.pickup);
    if(rowMonth !== lastMonth){ tb.appendChild(monthDividerRow(11, rowMonth)); lastMonth = rowMonth; }
    const v = db.vehicles.find(v=>v.id==bk.vehicleId), c = db.clients.find(c=>c.id==bk.clientId);
    const canCancel = bk.status==='Pending' || bk.status==='Confirmed';
    const dueSoon = isDueSoon(bk);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${dueSoon?`<span class="row-reminder-dot" data-id="${bk.id}" title="Pickup ${bk.pickup} — click to dismiss reminder"></span>`:''}${v?v.reg:'—'}</td><td>${c?c.name:'—'}</td><td>${bk.bookedOn||'—'}</td>
      <td>${bk.pickup}${lockBadge(bk.pickup)}</td><td>${bk.return}</td>
      <td class="num">${bk.deposit?fmt(bk.deposit):'—'}</td>
      <td><span class="tag ${bk.status}">${bk.status}</span></td>
      <td>${bk.status!=='Cancelled'?`<button class="row-extract" data-id="${bk.id}" title="Start a rental pre-filled from this booking">⇥ Extract</button>`:''}${canCancel?`<button class="row-cancel" data-id="${bk.id}">Cancel</button>`:''}<button class="row-edit" data-id="${bk.id}">✎</button><button class="row-del" data-id="${bk.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-reminder-dot').forEach(d=>d.addEventListener('click', e=>{
    e.stopPropagation();
    const bk = db.bookings.find(bk=>bk.id==d.dataset.id);
    if(bk){ bk.reminderAck = true; markDirty(); renderBookings(); }
  }));
  tb.querySelectorAll('.row-extract').forEach(b=>b.addEventListener('click',()=>{
    const bk = db.bookings.find(bk=>bk.id==b.dataset.id); if(!bk) return;
    extractBookingToRental(bk);
  }));
  tb.querySelectorAll('.row-cancel').forEach(b=>b.addEventListener('click',()=>{
    const bk = db.bookings.find(bk=>bk.id==b.dataset.id); if(!bk) return;
    guardClosedMonth(bk.pickup, 'cancel this booking', ()=>{
      checkAdminPin('cancel this booking', ()=>{
        bk.status = 'Cancelled';
        markDirty(); renderBookings(); renderDashBookings();
        toast('Booking cancelled');
      });
    });
  }));
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const bk = db.bookings.find(bk=>bk.id==b.dataset.id); if(!bk) return;
    guardClosedMonth(bk.pickup, 'edit this booking', ()=>{
      checkAdminPin('edit this booking', ()=>{
        editingBookingId = bk.id;
        document.getElementById('bk_vehicle').value = bk.vehicleId;
        document.getElementById('bk_client').value = bk.clientId;
        document.getElementById('bk_date').value = bk.bookedOn||'';
        document.getElementById('bk_pickup').value = bk.pickup;
        document.getElementById('bk_return').value = bk.return;
        document.getElementById('bk_deposit').value = bk.deposit||'';
        document.getElementById('bk_status').value = bk.status;
        document.getElementById('btnAddBooking').textContent = '✓ Update booking';
        scrollToForm('bookingForm');
        toast('Editing booking — update the fields and click Update booking');
      });
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    const bk = db.bookings.find(bk=>bk.id==b.dataset.id); if(!bk) return;
    guardClosedMonth(bk.pickup, 'delete this booking', ()=>{
      checkAdminPin('delete this booking', ()=>{
        db.bookings = db.bookings.filter(x=>x.id!=bk.id);
        markDirty(); renderBookings(); renderDashBookings();
      });
    });
  }));
  renderBookingReminders();
}

/* ---------- extract booking → rental ----------
   Pulls the fields a booking already has (vehicle, client, planned dates, deposit)
   into the rental form, leaves everything the office still needs to key in
   (contract/invoice/receipt numbers, times, mileage, fuel) blank for the admin,
   and remembers the source booking's deposit so it's applied as a payment —
   reducing the balance owed — the moment the rental is actually saved. */
let pendingExtractedBooking = null;
function selectRentalVehicle(vehicleId){
  const sel = document.getElementById('r_vehicle');
  const opt = sel.querySelector(`option[value="${vehicleId}"]`);
  if(opt) opt.disabled = false; // this booking already reserves the vehicle for these dates
  sel.value = vehicleId;
  sel.dispatchEvent(new Event('change')); // triggers the existing listener that fills the daily rate
}
function extractBookingToRental(bk){
  const v = db.vehicles.find(v=>v.id==bk.vehicleId);
  const c = db.clients.find(c=>c.id==bk.clientId);
  document.querySelector('.nav button[data-panel="rentals"]')?.click();
  editingRentalId = null;
  document.getElementById('btnAddRental').textContent = '+ Add rental';
  refreshRentalVehicleSelect();
  ['r_contract','r_invoice','r_receipt','r_pickuptime','r_returntime','r_mileage','r_fuel','r_fuel_charge']
    .forEach(id=>document.getElementById(id).value='');
  document.getElementById('r_client').value = bk.clientId;
  document.getElementById('r_pickup').value = bk.pickup;
  document.getElementById('r_return').value = bk.return;
  document.getElementById('r_status').value = 'Active';
  selectRentalVehicle(bk.vehicleId);
  const deposit = Number(bk.deposit)||0;
  pendingExtractedBooking = { bookingId: bk.id, vehicleId: bk.vehicleId, clientId: bk.clientId, deposit };
  const hint = document.getElementById('extractDepositHint');
  if(hint){
    hint.style.display = deposit>0 ? '' : 'none';
    hint.textContent = deposit>0
      ? `Deposit of ${fmt(deposit)} from this booking will be deducted automatically and the balance shown as owed once you save this rental.`
      : '';
  }
  scrollToForm('rentalForm');
  showExtractNotice(bk, v, c, deposit);
}
function showExtractNotice(bk, v, c, deposit){
  const body = document.getElementById('extractNoticeBody'); if(!body) return;
  body.innerHTML = `
    <p>Vehicle, client and dates have been filled in from the booking for <b>${escapeHTML(v?v.reg:'—')}</b> — <b>${escapeHTML(c?c.name:'—')}</b>.</p>
    <p>Fill in the Contract No, Invoice No, Receipt No, pickup/return times and mileage, and double-check the daily rate before saving.</p>
    <p>🛢️ Don't forget: if the office fronted fuel for this pickup, add it in the Fuel field below so it's tracked and billed to the client correctly.</p>
    ${deposit>0?`<p>💰 A deposit of <b>${fmt(deposit)}</b> was recorded on this booking — it'll be applied automatically as a payment when you save, and the remaining balance will show as owed on the rental.</p>`:''}
  `;
  const ov = document.getElementById('extractNoticeOverlay');
  ov.classList.add('show'); ov.setAttribute('aria-hidden','false');
}
function closeExtractNotice(){
  const ov = document.getElementById('extractNoticeOverlay');
  ov.classList.remove('show'); ov.setAttribute('aria-hidden','true');
}

/* ---------- rentals ---------- */
function daysBetween(a,b){
  const d1=new Date(a), d2=new Date(b);
  const diff = Math.round((d2-d1)/(1000*60*60*24));
  return Math.max(diff,1);
}
document.getElementById('btnAddRental').addEventListener('click', ()=>{
  const vid = document.getElementById('r_vehicle').value, cid = document.getElementById('r_client').value;
  const pickup = document.getElementById('r_pickup').value, ret = document.getElementById('r_return').value;
  const pickupTime = document.getElementById('r_pickuptime').value, returnTime = document.getElementById('r_returntime').value;
  if(!vid||!cid||!pickup||!ret){ toast('Vehicle, client, pickup and return dates are required'); return; }
  if(!isReasonableDate(pickup)||!isReasonableDate(ret)){ toast('Please enter valid pickup and return dates'); return; }
  if(new Date(ret) < new Date(pickup)){ toast('Return date can\'t be before pickup date'); return; }
  if(pickup===ret && returnTime && pickupTime && returnTime < pickupTime){ toast('Return time can\'t be before pickup time on the same day'); return; }
  if(document.getElementById('r_status').value !== 'Cancelled'){
    const conflicts = findVehicleConflicts(vid, pickup, ret, {excludeRentalId: editingRentalId});
    if(conflicts.length){
      const ok = confirm('This vehicle already has overlapping dates:\n\n' + conflicts.join('\n') +
        '\n\nSave this rental anyway?');
      if(!ok) return;
    }
  }
  const rate = parseFloat(document.getElementById('r_rate').value)||0;
  const days = daysBetween(pickup,ret);
  const status = document.getElementById('r_status').value;
  const fuel = parseFloat(document.getElementById('r_fuel').value)||0;
  const fuelChargeRaw = document.getElementById('r_fuel_charge').value;
  const fuelCharge = fuelChargeRaw==='' ? fuel : (parseFloat(fuelChargeRaw)||0);
  const mileage = parseFloat(document.getElementById('r_mileage').value)||0;
  if(!isValidMoney(rate)){ toast('Daily rate must be a positive number'); return; }
  if(!isValidMoney(fuel, {allowZero:true}) || !isValidMoney(fuelCharge, {allowZero:true})){ toast('Fuel amounts can\'t be negative'); return; }
  if(mileage < 0){ toast('Mileage can\'t be negative'); return; }
  const fields = {
    vehicleId: vid, clientId: cid,
    contract: document.getElementById('r_contract').value.trim(),
    invoice: document.getElementById('r_invoice').value.trim(),
    receipt: document.getElementById('r_receipt').value.trim(),
    pickup, pickupTime, return: ret, returnTime,
    rate, days, mileage, amount: rate*days, status, fuel, fuelCharge
  };
  const finish = ()=>{
    let rental;
    if(editingRentalId){
      rental = db.rentals.find(r=>r.id==editingRentalId);
      Object.assign(rental, fields);
      editingRentalId = null;
      document.getElementById('btnAddRental').textContent = '+ Add rental';
    } else {
      rental = { id: uid(), ...fields };
      db.rentals.push(rental);
      if(pendingExtractedBooking && pendingExtractedBooking.vehicleId==vid && pendingExtractedBooking.clientId==cid){
        if(pendingExtractedBooking.deposit>0){
          db.payments.push({ id: uid(), rentalId: rental.id, date: pickup, amount: pendingExtractedBooking.deposit,
            method: 'Deposit', note: 'Deposit carried over from booking' });
        }
        const srcBk = db.bookings.find(x=>x.id==pendingExtractedBooking.bookingId);
        if(srcBk) srcBk.status = 'Confirmed';
      }
    }
    if(pendingExtractedBooking){
      pendingExtractedBooking = null;
      const hint = document.getElementById('extractDepositHint');
      if(hint){ hint.style.display='none'; hint.textContent=''; }
    }
    const v = db.vehicles.find(v=>v.id==vid);
    if(v && status==='Active') v.status = 'Rented';
    syncRentalFuelExpense(rental);
    ['r_contract','r_invoice','r_receipt','r_pickup','r_pickuptime','r_return','r_returntime','r_rate','r_mileage','r_fuel','r_fuel_charge'].forEach(id=>document.getElementById(id).value='');
    markDirty(); renderRentals(); renderVehicles(); renderDashboard(); renderExpenses(); renderPayments(); renderBookings();
  };
  if(editingRentalId){ checkAdminPin('save changes to this rental', finish); }
  else { finish(); }
});
/* Keep a rental's fronted fuel in sync with a linked, billable Fuel expense —
   charged to client in full, tagged so reports can tell it apart from manually logged fuel. */
function syncRentalFuelExpense(rental){
  const existing = db.expenses.find(x=>x.source==='rental' && x.rentalId==rental.id);
  const amt = Number(rental.fuel)||0;
  const chargeAmt = rental.fuelCharge!=null ? Number(rental.fuelCharge)||0 : amt;
  if(amt > 0){
    const data = {
      vehicleId: rental.vehicleId, date: rental.pickup, category: 'Fuel',
      desc: 'Fuel — rental' + (rental.contract ? ' ' + rental.contract : ''),
      qty: 1, amount: amt,
      billable: true, billClientId: rental.clientId, chargeAmount: chargeAmt,
      source: 'rental', rentalId: rental.id
    };
    if(existing){ Object.assign(existing, data); }
    else { db.expenses.push({ id: uid(), ...data }); }
  } else if(existing){
    db.expenses = db.expenses.filter(x=>x.id!==existing.id);
  }
}
function renderRentals(){
  const tb = document.querySelector('#rentalTable tbody'); tb.innerHTML='';
  if(!db.rentals.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="17">No rentals recorded yet.</td></tr>'; return; }
  let lastMonth = null;
  [...db.rentals].sort((a,b)=>new Date(b.pickup)-new Date(a.pickup)).forEach(r=>{
    const rowMonth = monthOfDate(r.pickup);
    if(rowMonth !== lastMonth){ tb.appendChild(monthDividerRow(17, rowMonth)); lastMonth = rowMonth; }
    const v = db.vehicles.find(v=>v.id==r.vehicleId), c = db.clients.find(c=>c.id==r.clientId);
    const pickupCell = r.pickup + (r.pickupTime?(' '+r.pickupTime):'');
    const returnCell = r.return + (r.returnTime?(' '+r.returnTime):'');
    const paid = paidForRental(r.id), owed = owedForRental(r);
    const cancelled = r.status === 'Cancelled';
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if(cancelled) tr.classList.add('rental-cancelled');
    tr.innerHTML = `<td>${v?v.reg:'—'}</td><td>${c?c.name:'—'}</td>
      <td>${r.contract||'—'}</td><td>${r.invoice||'—'}</td><td>${r.receipt||'—'}</td>
      <td>${pickupCell}${lockBadge(r.pickup)}</td><td>${returnCell}</td>
      <td class="num">${r.days}</td><td class="num">${r.mileage ? r.mileage.toLocaleString() : '—'}</td>
      <td class="num" style="color:${cancelled?'var(--red)':'inherit'};" title="${cancelled?'Cancelled — not counted in totals':''}">${fmt(r.amount)}</td>
      <td class="num" style="color:${cancelled?'var(--red)':'var(--green)'};">${paid ? fmt(paid) : '—'}</td>
      <td class="num" style="color:${cancelled?'var(--red)':(owed>0?'var(--red)':'var(--ink-faint)')};">${owed ? fmt(owed) : '—'}</td><td>${cancelled ? '<span class="status-unpaid">Cancelled</span>' : paymentStatus(r)}</td>
      <td class="num" style="color:${cancelled&&r.fuel?'var(--red)':'inherit'};">${r.fuel ? fmt(r.fuel) : '—'}</td>
      <td class="num" style="color:${cancelled&&r.fuel?'var(--red)':'inherit'};" title="${r.fuel && r.fuelCharge!==r.fuel ? 'Office-set amount, differs from fronted' : ''}">${r.fuel ? fmt(r.fuelCharge!=null?r.fuelCharge:r.fuel) : '—'}</td>
      <td><span class="tag ${r.status}">${r.status}</span></td>
      <td>${r.status==='Active'?`<button class="row-action" data-id="${r.id}">Check-in</button>`:''}<button class="row-edit" data-id="${r.id}">✎</button><button class="row-del" data-id="${r.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-action').forEach(b=>b.addEventListener('click',()=>{
    const r = db.rentals.find(r=>r.id==b.dataset.id);
    if(!r) return;
    guardClosedMonth(r.pickup, 'check in this rental', ()=>{
      r.status = 'Completed';
      const v = db.vehicles.find(v=>v.id==r.vehicleId);
      if(v) v.status = 'Available';
      markDirty(); renderRentals(); renderVehicles(); renderDashboard();
      toast('Vehicle checked in and marked Available');
    });
  }));
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const r = db.rentals.find(r=>r.id==b.dataset.id); if(!r) return;
    guardClosedMonth(r.pickup, 'edit this rental', ()=>{
      checkAdminPin('edit this rental', ()=>{
        editingRentalId = r.id;
        refreshRentalVehicleSelect();
        document.getElementById('r_vehicle').value = r.vehicleId;
        document.getElementById('r_client').value = r.clientId;
        document.getElementById('r_contract').value = r.contract||'';
        document.getElementById('r_invoice').value = r.invoice||'';
        document.getElementById('r_receipt').value = r.receipt||'';
        document.getElementById('r_pickup').value = r.pickup;
        document.getElementById('r_pickuptime').value = r.pickupTime||'';
        document.getElementById('r_return').value = r.return;
        document.getElementById('r_returntime').value = r.returnTime||'';
        document.getElementById('r_rate').value = r.rate;
        document.getElementById('r_mileage').value = r.mileage||'';
        document.getElementById('r_fuel').value = r.fuel||'';
        document.getElementById('r_fuel_charge').value = (r.fuelCharge!=null && r.fuelCharge!==r.fuel) ? r.fuelCharge : '';
        document.getElementById('r_status').value = r.status;
        document.getElementById('btnAddRental').textContent = '✓ Update rental';
        scrollToForm('rentalForm');
        toast('Editing rental — update the fields and click Update rental');
      });
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    const r = db.rentals.find(r=>r.id==b.dataset.id); if(!r) return;
    guardClosedMonth(r.pickup, 'delete this rental', ()=>{
      checkAdminPin('delete this rental', ()=>{
        db.rentals = db.rentals.filter(x=>x.id!=r.id);
        db.expenses = db.expenses.filter(x=>!(x.source==='rental' && x.rentalId==r.id));
        db.payments = db.payments.filter(p=>p.rentalId!=r.id);
        markDirty(); renderRentals(); renderExpenses(); renderPayments(); renderDashboard();
      });
    });
  }));
}

/* ---------- expenses ---------- */
function syncBillableRow(){
  const isFuel = document.getElementById('e_cat').value === 'Fuel';
  document.getElementById('e_billable_row').style.display = isFuel ? '' : 'none';
  if(!isFuel){
    document.getElementById('e_billable').checked = false;
  }
  toggleBillableFields();
}
function toggleBillableFields(){
  const on = document.getElementById('e_cat').value === 'Fuel' && document.getElementById('e_billable').checked;
  document.getElementById('e_billable_fields').style.display = on ? '' : 'none';
}
document.getElementById('e_cat').addEventListener('change', syncBillableRow);
document.getElementById('e_billable').addEventListener('change', toggleBillableFields);
syncBillableRow();

document.getElementById('btnAddExpense').addEventListener('click', ()=>{
  const vid = document.getElementById('e_vehicle').value, date = document.getElementById('e_date').value;
  const amountRaw = document.getElementById('e_amount').value;
  const amount = parseFloat(amountRaw)||0;
  if(!date||!amountRaw){ toast('Date and amount are required'); return; }
  if(!isReasonableDate(date)){ toast('That date doesn\'t look right — check it and try again'); return; }
  if(!isValidMoney(amount)){ toast('Amount must be a positive number'); return; }
  const category = document.getElementById('e_cat').value;
  const billable = category === 'Fuel' && document.getElementById('e_billable').checked;
  let billClientId = null, chargeAmount = 0;
  if(billable){
    billClientId = document.getElementById('e_billable_client').value;
    chargeAmount = parseFloat(document.getElementById('e_billable_amount').value)||0;
    if(!billClientId){ toast('Select a client to bill this fuel to'); return; }
    if(!isValidMoney(chargeAmount, {allowZero:true})){ toast('Amount to charge client must be zero or a positive number'); return; }
  }
  const fields = {
    vehicleId: vid, date, category,
    desc: document.getElementById('e_desc').value.trim(),
    qty: parseFloat(document.getElementById('e_qty').value)||1,
    amount, billable, billClientId, chargeAmount, source: 'manual', rentalId: null
  };
  const finish = ()=>{
    if(editingExpenseId){
      const x = db.expenses.find(x=>x.id==editingExpenseId);
      Object.assign(x, fields);
      editingExpenseId = null;
      document.getElementById('btnAddExpense').textContent = '+ Add expense';
    } else {
      db.expenses.push({ id: uid(), ...fields });
    }
    ['e_date','e_desc','e_amount','e_billable_amount'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('e_qty').value = 1;
    document.getElementById('e_billable').checked = false;
    toggleBillableFields();
    markDirty(); renderExpenses(); renderDashboard();
  };
  if(editingExpenseId){ checkAdminPin('save changes to this expense', finish); }
  else { finish(); }
});
function billedCell(x){
  if(!x.billable) return '<span style="color:var(--ink-faint);">—</span>';
  const c = db.clients.find(c=>c.id==x.billClientId);
  return `<span class="tag Confirmed" title="Office spent ${fmt(x.amount)}">${c?c.name:'Client'} · ${fmt(x.chargeAmount||0)}</span>`;
}
function renderExpenses(){
  const tb = document.querySelector('#expenseTable tbody'); tb.innerHTML='';
  const scopeFilter = document.getElementById('e_scope_filter').value;
  let visible = db.expenses;
  if(scopeFilter==='vehicle') visible = visible.filter(x=>x.vehicleId);
  if(scopeFilter==='office') visible = visible.filter(x=>!x.vehicleId);
  if(!visible.length){
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">'+(db.expenses.length ? 'No expenses match this filter.' : 'No expenses logged yet.')+'</td></tr>';
    return;
  }
  let lastMonth = null;
  [...visible].sort((a,b)=>new Date(b.date)-new Date(a.date)).forEach(x=>{
    const rowMonth = monthOfDate(x.date);
    if(rowMonth !== lastMonth){ tb.appendChild(monthDividerRow(8, rowMonth)); lastMonth = rowMonth; }
    const v = db.vehicles.find(v=>v.id==x.vehicleId);
    const tr = document.createElement('tr');
    const actions = x.source==='rental'
      ? `<span class="tag" style="color:var(--ink-faint);" title="Linked to a rental — edit the Fuel amount on that rental instead">via rental</span>`
      : `<button class="row-edit" data-id="${x.id}">✎</button><button class="row-del" data-id="${x.id}">✕</button>`;
    const vehicleCell = v ? v.reg : '<span class="tag" style="color:var(--ink-dim);border-color:var(--line);">Office</span>';
    tr.innerHTML = `<td>${vehicleCell}</td><td>${x.date}${lockBadge(x.date)}</td><td>${x.category}</td><td>${x.desc||'—'}</td>
      <td class="num">${x.qty||1}</td><td class="num">${fmt(x.amount)}</td>
      <td>${billedCell(x)}</td>
      <td>${actions}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const x = db.expenses.find(x=>x.id==b.dataset.id); if(!x) return;
    guardClosedMonth(x.date, 'edit this expense', ()=>{
      checkAdminPin('edit this expense', ()=>{
        editingExpenseId = x.id;
        document.getElementById('e_vehicle').value = x.vehicleId;
        document.getElementById('e_date').value = x.date;
        document.getElementById('e_cat').value = x.category;
        document.getElementById('e_desc').value = x.desc||'';
        document.getElementById('e_qty').value = x.qty||1;
        document.getElementById('e_amount').value = x.amount;
        syncBillableRow();
        document.getElementById('e_billable').checked = !!x.billable;
        document.getElementById('e_billable_client').value = x.billClientId || '';
        document.getElementById('e_billable_amount').value = x.chargeAmount || '';
        toggleBillableFields();
        document.getElementById('btnAddExpense').textContent = '✓ Update expense';
        scrollToForm('expenseForm');
        toast('Editing expense — update the fields and click Update expense');
      });
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    const x = db.expenses.find(x=>x.id==b.dataset.id); if(!x) return;
    guardClosedMonth(x.date, 'delete this expense', ()=>{
      checkAdminPin('delete this expense', ()=>{
        db.expenses = db.expenses.filter(e=>e.id!=x.id);
        markDirty(); renderExpenses(); renderDashboard();
      });
    });
  }));
}
document.getElementById('e_scope_filter').addEventListener('change', renderExpenses);

/* ---------- payments ---------- */
function populatePaymentRentals(){
  const sel = document.getElementById('p_rental');
  const current = sel.value;
  const candidates = [...db.rentals].filter(r=>r.status!=='Cancelled').sort((a,b)=>new Date(b.pickup)-new Date(a.pickup));
  sel.innerHTML = candidates.map(r=>{
    const v = db.vehicles.find(v=>v.id==r.vehicleId), c = db.clients.find(c=>c.id==r.clientId);
    const owed = owedForRental(r);
    const label = `${v?v.reg:'—'} — ${c?c.name:'—'}${r.contract?' ('+r.contract+')':''} — owed ${fmt(owed)}`;
    return `<option value="${r.id}">${label}</option>`;
  }).join('') || '<option value="">Add a rental first</option>';
  if(current) sel.value = current;
  updatePaymentFormHint();
}
function updatePaymentFormHint(){
  const rid = document.getElementById('p_rental').value;
  const hint = document.getElementById('p_hint');
  const r = db.rentals.find(r=>r.id==rid);
  if(!r){ hint.textContent = ''; return; }
  hint.textContent = `Charged ${fmt(r.amount)} · paid so far ${fmt(paidForRental(r.id))} · owed ${fmt(owedForRental(r))}`;
}
document.getElementById('p_rental').addEventListener('change', updatePaymentFormHint);
document.getElementById('btnAddPayment').addEventListener('click', ()=>{
  const rentalId = document.getElementById('p_rental').value;
  const date = document.getElementById('p_date').value;
  const amountRaw = document.getElementById('p_amount').value;
  const amount = parseFloat(amountRaw)||0;
  if(!rentalId){ toast('Select the rental this payment is for'); return; }
  if(!date||!amountRaw){ toast('Date and amount are required'); return; }
  if(!isReasonableDate(date)){ toast('That date doesn\'t look right — check it and try again'); return; }
  if(!isValidMoney(amount)){ toast('Payment amount must be a positive number'); return; }
  const rental = db.rentals.find(r=>r.id==rentalId);
  if(!rental){ toast('The selected rental could not be found'); return; }
  const alreadyPaid = paymentTotalExcluding(editingPaymentId, rentalId);
  const outstandingBefore = Math.max(0,(Number(rental.amount)||0)-alreadyPaid);
  if(amount > outstandingBefore){ toast(`Payment blocked: maximum allowed is ${fmt(outstandingBefore)} for this rental`); return; }
  const fields = {
    rentalId, date, amount,
    method: document.getElementById('p_method').value,
    note: document.getElementById('p_note').value.trim()
  };
  const finish = ()=>{
    if(editingPaymentId){
      const p = db.payments.find(p=>p.id==editingPaymentId);
      Object.assign(p, fields);
      editingPaymentId = null;
      document.getElementById('btnAddPayment').textContent = '+ Add payment';
    } else {
      db.payments.push({ id: uid(), ...fields });
    }
    ['p_date','p_amount','p_note'].forEach(id=>document.getElementById(id).value='');
    markDirty(); renderPayments(); renderRentals(); renderReports();
  };
  if(editingPaymentId){ checkAdminPin('save changes to this payment', finish); }
  else { finish(); }
});
function renderPayments(){
  populatePaymentRentals();
  const tb = document.querySelector('#paymentTable tbody'); tb.innerHTML='';
  if(!db.payments.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="11">No payments logged yet.</td></tr>'; return; }
  let lastMonth = null;
  [...db.payments].sort((a,b)=>new Date(b.date)-new Date(a.date)).forEach(p=>{
    const rowMonth = monthOfDate(p.date);
    if(rowMonth !== lastMonth){ tb.appendChild(monthDividerRow(8, rowMonth)); lastMonth = rowMonth; }
    const r = db.rentals.find(r=>r.id==p.rentalId);
    const v = r ? db.vehicles.find(v=>v.id==r.vehicleId) : null;
    const c = r ? db.clients.find(c=>c.id==r.clientId) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.date}${lockBadge(p.date)}</td><td>${v?v.reg:'—'}</td><td>${c?c.name:'—'}</td><td>${r&&r.contract?r.contract:'—'}</td>
      <td class="num"><span class="green">+${fmt(p.amount)}</span></td><td class="num">${fmt(paidForRental(r.id))}</td><td class="num">${fmt(owedForRental(r))}</td>
      <td>${paymentStatus(r)}</td><td>${p.method||'—'}</td><td>${p.note||'—'}</td>
      <td><button class="row-edit" data-id="${p.id}">✎</button><button class="row-del" data-id="${p.id}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-edit').forEach(b=>b.addEventListener('click',()=>{
    const p = db.payments.find(p=>p.id==b.dataset.id); if(!p) return;
    guardClosedMonth(p.date, 'edit this payment', ()=>{
      checkAdminPin('edit this payment', ()=>{
        editingPaymentId = p.id;
        populatePaymentRentals();
        document.getElementById('p_rental').value = p.rentalId;
        document.getElementById('p_date').value = p.date;
        document.getElementById('p_amount').value = p.amount;
        document.getElementById('p_method').value = p.method || 'Cash';
        document.getElementById('p_note').value = p.note || '';
        updatePaymentFormHint();
        document.getElementById('btnAddPayment').textContent = '✓ Update payment';
        scrollToForm('paymentForm');
        toast('Editing payment — update the fields and click Update payment');
      });
    });
  }));
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    const p = db.payments.find(p=>p.id==b.dataset.id); if(!p) return;
    guardClosedMonth(p.date, 'delete this payment', ()=>{
      checkAdminPin('delete this payment', ()=>{
        db.payments = db.payments.filter(x=>x.id!=p.id);
        markDirty(); renderPayments(); renderRentals(); renderReports();
      });
    });
  }));
}

/* ---------- dashboard ---------- */
const DASH_ICONS = {
  car: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>`,
  cash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10v4M18 10v4"/></svg>`,
  receipt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.2-8.2"/><path d="m16 6 2 2M13.5 8.5l2 2"/></svg>`,
  fuel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 22V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v18"/><path d="M3 10h10"/><path d="M14 8h2l3 3v7a1 1 0 0 1-1 1h-1"/><circle cx="17.5" cy="17.5" r="1.5"/><path d="M3 22h12"/></svg>`
};
function dashCard(icon,label,valueHtml,footHtml,tint){
  return `<div class="card${tint?' tint-'+tint:''}"><div class="card-top"><div class="label">${label}</div>
    <div style="display:flex;align-items:center;gap:7px;"><button class="dash-privacy-btn" type="button" title="Show or blur dashboard value">👁</button><div class="card-icon">${DASH_ICONS[icon]}</div></div></div>
    <div class="value dash-sensitive">${valueHtml}</div>
    <div class="card-foot">${footHtml}</div></div>`;
}
function deltaFoot(cur,prev,invert,label){
  if(label==='__ALLTIME__'){
    return `<span class="delta">All-time total</span><span class="badge">every record in file</span>`;
  }
  let deltaHtml;
  if(!prev){
    deltaHtml = cur ? '<span class="delta up">New activity</span>' : '<span class="delta">No activity</span>';
  } else {
    const pct = ((cur-prev)/Math.abs(prev))*100;
    let dir = pct>=0 ? 'up' : 'down';
    if(invert) dir = dir==='up' ? 'down' : 'up';
    deltaHtml = `<span class="delta ${dir}">${pct>=0?'▲':'▼'} ${Math.abs(pct).toFixed(0)}%</span>`;
  }
  return `${deltaHtml}<span class="badge">vs ${label || 'last month'}</span>`;
}

/* ---------- customizable dashboard widgets ----------
   Each widget is a small self-contained card. The registry maps an id to a label
   (for the customize tray) and a build(ctx) function returning the card's inner
   HTML via dashCard(). Layout (order, size, visibility) lives in
   db.settings.dashboardWidgets and round-trips through the Settings sheet, same
   as any other setting — so it's saved with the file, not just this browser tab. */
const DASH_WIDGET_DEFS = {
  vehicles: { title:'Vehicles', build: ctx => dashCard('car','Vehicles', db.vehicles.length,
    `<span class="delta">Fleet size</span><span class="badge">Live</span>`) },
  revenue: { title:'Revenue', build: ctx => dashCard('cash','Revenue', `<span class="amber">${fmt(ctx.revThis)}</span>`, deltaFoot(ctx.revThis,ctx.revLast,false,ctx.compareLabel), 'amber') },
  expenses: { title:'Expenses', build: ctx => dashCard('receipt','Expenses', `<span class="red">${fmt(ctx.expThis)}</span>`, deltaFoot(ctx.expThis,ctx.expLast,true,ctx.compareLabel), 'red') },
  fuel: { title:'Fuel', build: ctx => dashCard('fuel','Fuel', `<span class="fuel">${fmt(ctx.fuelThis)}</span>`, deltaFoot(ctx.fuelThis,ctx.fuelLast,true,ctx.compareLabel), 'fuel') },
  net: { title:'Net income', build: ctx => dashCard('trend','Net income', `<span class="${ctx.netThis>=0?'green':'red'}">${fmt(ctx.netThis)}</span>`, deltaFoot(ctx.netThis,ctx.netLast,false,ctx.compareLabel), ctx.netThis>=0?'green':'red') },
  outstanding: { title:'Outstanding payments', build: ctx => dashCard('receipt','Outstanding payments', `<span class="${ctx.outstandingThis>0?'red':'green'}">${fmt(ctx.outstandingThis)}</span>`, `<span class="delta">${ctx.outstandingCount} rental${ctx.outstandingCount===1?'':'s'} with balance</span>`, ctx.outstandingThis>0?'red':'green') },
  onrent: { title:'Currently on rent', build: ctx => dashCard('key','Currently on rent', ctx.activeRentals.length,
    `<span class="delta">of ${db.vehicles.length} vehicles</span><span class="badge">Live</span>`) }
};
const DEFAULT_DASH_SIZES = ['md','md','md','lg','sm','sm','sm'];
const DEFAULT_DASH_LAYOUT = Object.keys(DASH_WIDGET_DEFS).map((id,i)=>({id, visible:true, size:DEFAULT_DASH_SIZES[i]||'md'}));
let dashEditMode = false;
let dashPrivacyRevealed = false;
let dailyInfoDate = toLocalISO(new Date());
function getDashLayout(){
  const saved = db.settings && db.settings.dashboardWidgets;
  if(!Array.isArray(saved) || !saved.length) return DEFAULT_DASH_LAYOUT.map(w=>({...w}));
  const known = saved.filter(w=>w && DASH_WIDGET_DEFS[w.id]).map(w=>({id:w.id, visible: w.visible!==false, size: ['sm','md','lg'].includes(w.size)?w.size:'md'}));
  // Any widget added to the registry after this layout was saved (future update) still shows up.
  Object.keys(DASH_WIDGET_DEFS).forEach(id=>{ if(!known.some(w=>w.id===id)) known.push({id, visible:true, size:'md'}); });
  return known;
}
function saveDashLayout(layout){
  if(!db.settings) db.settings = { adminPin: null };
  db.settings.dashboardWidgets = layout;
  markDirty();
}
function renderDashCards(ctx){
  const layout = getDashLayout();
  const container = document.getElementById('dashCards');
  container.classList.toggle('dash-editing', dashEditMode);
  container.innerHTML = layout.filter(w=>w.visible).map(w=>{
    const def = DASH_WIDGET_DEFS[w.id];
    if(!def) return '';
    const html = def.build(ctx);
    // Splice widget id, size class and (in edit mode) the drag/resize/remove tools onto
    // the card dashCard() already built, rather than changing dashCard's own signature.
    const tools = `<div class="card-tools">
        <button class="size-btn" data-size="sm" title="Small">S</button>
        <button class="size-btn" data-size="md" title="Medium">M</button>
        <button class="size-btn" data-size="lg" title="Large">L</button>
        <button class="remove-btn" title="Remove from dashboard">✕</button>
      </div>`;
    return html.replace('<div class="card-top">', tools + '<div class="card-top">')
      .replace('<div class="card', `<div data-widget-id="${w.id}" draggable="${dashEditMode}" class="card size-${w.size}`);
  }).join('');
  wireDashCardControls(layout);
  container.classList.toggle('dash-privacy-revealed', !!dashPrivacyRevealed);
  container.querySelectorAll('.dash-privacy-btn').forEach(btn=>btn.addEventListener('click',()=>{
    dashPrivacyRevealed = !dashPrivacyRevealed;
    container.classList.toggle('dash-privacy-revealed', dashPrivacyRevealed);
    container.querySelectorAll('.dash-privacy-btn').forEach(b=>b.textContent = dashPrivacyRevealed ? '🙈' : '👁');
  }));
  container.querySelectorAll('.dash-privacy-btn').forEach(b=>b.textContent = dashPrivacyRevealed ? '🙈' : '👁');
  renderHiddenWidgetsTray(layout);
}
function renderHiddenWidgetsTray(layout){
  const tray = document.getElementById('hiddenWidgetsTray');
  const hidden = layout.filter(w=>!w.visible);
  tray.classList.toggle('show', dashEditMode && hidden.length>0);
  if(!hidden.length){ tray.innerHTML=''; return; }
  tray.innerHTML = hidden.map(w=>`<button class="btn" data-add="${w.id}">+ ${DASH_WIDGET_DEFS[w.id] ? DASH_WIDGET_DEFS[w.id].title : w.id}</button>`).join('');
  tray.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const layout2 = getDashLayout();
      const w = layout2.find(w=>w.id===btn.dataset.add);
      if(w){ w.visible = true; saveDashLayout(layout2); renderDashboard(); }
    });
  });
}
function wireDashCardControls(layout){
  const container = document.getElementById('dashCards');
  container.querySelectorAll('.card').forEach(card=>{
    const id = card.dataset.widgetId;
    card.querySelectorAll('.size-btn').forEach(btn=>{
      btn.classList.toggle('active', card.classList.contains('size-'+btn.dataset.size));
      btn.addEventListener('click', ()=>{
        const layout2 = getDashLayout();
        const w = layout2.find(w=>w.id===id);
        if(w){ w.size = btn.dataset.size; saveDashLayout(layout2); renderDashboard(); }
      });
    });
    const removeBtn = card.querySelector('.remove-btn');
    if(removeBtn) removeBtn.addEventListener('click', ()=>{
      const layout2 = getDashLayout();
      const w = layout2.find(w=>w.id===id);
      if(w){ w.visible = false; saveDashLayout(layout2); renderDashboard(); }
    });
    if(!dashEditMode) return;
    card.addEventListener('dragstart', ()=>{ card.classList.add('dragging'); });
    card.addEventListener('dragend', ()=>{
      card.classList.remove('dragging');
      container.querySelectorAll('.card').forEach(c=>c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', e=>{
      e.preventDefault();
      if(!card.classList.contains('dragging')) card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', ()=> card.classList.remove('drag-over'));
    card.addEventListener('drop', e=>{
      e.preventDefault();
      card.classList.remove('drag-over');
      const draggingEl = container.querySelector('.card.dragging');
      if(!draggingEl || draggingEl===card) return;
      const fromId = draggingEl.dataset.widgetId, toId = card.dataset.widgetId;
      const layout2 = getDashLayout();
      const fromIdx = layout2.findIndex(w=>w.id===fromId), toIdx = layout2.findIndex(w=>w.id===toId);
      if(fromIdx<0 || toIdx<0) return;
      const [moved] = layout2.splice(fromIdx,1);
      layout2.splice(toIdx,0,moved);
      saveDashLayout(layout2);
      renderDashboard();
    });
  });
}
document.getElementById('btnCustomizeDash').addEventListener('click', ()=>{
  dashEditMode = !dashEditMode;
  const btn = document.getElementById('btnCustomizeDash');
  btn.textContent = dashEditMode ? '✓ Done customizing' : '🛠 Customize';
  btn.classList.toggle('primary', dashEditMode);
  document.getElementById('dashEditHint').style.display = dashEditMode ? '' : 'none';
  renderDashboard();
});

function renderDashboard(){
  const liveLabel = document.getElementById('dashLivePeriodLabel');
  const modeLabel = document.getElementById('cardsModeLabel');
  const dashModeLabel = document.getElementById('dashCardsModeLabel');
  let rentalsIn, expensesIn, compareLabel;
  let revLast=null, expLast=null, fuelLast=null, netLast=null;

  if(dashCardsAllTime){
    // All-time mode: cards read straight off every record in the file, no date
    // filter at all — whether the data spans 2 days or 4 months, it all counts.
    rentalsIn = db.rentals.filter(r=>r.status!=='Cancelled');
    expensesIn = db.expenses.slice();
    compareLabel = '__ALLTIME__';
    if(liveLabel) liveLabel.textContent = `All-time totals — every record in this file`;
    const modeText = `Cards are on: All-time totals (default). Pick a period in Reports to make them follow it instead.`;
    if(modeLabel) modeLabel.textContent = modeText;
    if(dashModeLabel) dashModeLabel.textContent = modeText;
  } else {
    const {start,end} = periodRange();
    rentalsIn = db.rentals.filter(r=>r.status!=='Cancelled' && inRange(r.pickup,start,end));
    expensesIn = db.expenses.filter(x=>inRange(x.date,start,end));
    if(liveLabel) liveLabel.textContent = `${start.toDateString()} → ${end.toDateString()}`;
    const modeText = `Cards are following the period above. Press "Restore cards to default" in Reports for all-time totals.`;
    if(modeLabel) modeLabel.textContent = modeText;
    if(dashModeLabel) dashModeLabel.textContent = modeText;

    // Compare against an uploaded reference file's own period when one is loaded;
    // otherwise fall back to the equivalent prior period (previous week/month/year/etc.,
    // matching whichever period type is currently selected).
    if(compareDb){
      const cmp = summarizeDbForPeriod(compareDb);
      revLast = cmp.revenue; expLast = cmp.expenses; fuelLast = cmp.fuel; netLast = cmp.net;
      compareLabel = cmp.label;
    } else {
      const prev = previousPeriodRange();
      const rentalsPrev = db.rentals.filter(r=>r.status!=='Cancelled' && inRange(r.pickup,prev.start,prev.end));
      const expensesPrev = db.expenses.filter(x=>inRange(x.date,prev.start,prev.end));
      revLast = rentalsPrev.reduce((s,r)=>s+r.amount,0);
      expLast = expensesPrev.reduce((s,x)=>s+x.amount,0);
      fuelLast = expensesPrev.filter(x=>x.category==='Fuel').reduce((s,x)=>s+x.amount,0);
      netLast = revLast-expLast;
      compareLabel = previousPeriodLabel();
    }
  }

  const revThis = rentalsIn.reduce((s,r)=>s+r.amount,0);
  const expThis = expensesIn.reduce((s,x)=>s+x.amount,0);
  const fuelThis = expensesIn.filter(x=>x.category==='Fuel').reduce((s,x)=>s+x.amount,0);
  const netThis = revThis-expThis;
  const collectedThis = rentalsIn.reduce((s,r)=>s+paidForRental(r.id),0);
  const outstandingThis = revThis - collectedThis;
  const outstandingCount = rentalsIn.filter(r=>(r.amount-paidForRental(r.id))>0).length;

  const activeRentals = db.rentals.filter(r=>r.status==='Active');

  renderDashCards({ revThis, revLast, expThis, expLast, fuelThis, fuelLast, netThis, netLast, outstandingThis, outstandingCount, activeRentals, compareLabel });

  renderTrendCharts();
  const tb = document.querySelector('#dashActiveTable tbody'); tb.innerHTML='';
  if(!activeRentals.length){
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">No cars are out on rent right now.</td></tr>';
  } else {
    activeRentals.forEach(r=>{
      const v = db.vehicles.find(v=>v.id==r.vehicleId), c = db.clients.find(c=>c.id==r.clientId);
      const dueBack = r.return + (r.returnTime?(' '+r.returnTime):'');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${v?v.reg:'—'}</td><td>${v?v.make+' '+v.model:'—'}</td><td>${c?c.name:'—'}</td>
        <td>${r.contract||'—'}</td><td>${dueBack}</td><td class="num">${fmt(r.rate)}</td>`;
      tb.appendChild(tr);
    });
  }
  renderDashChart();
  renderDashBookings();
  renderAlerts();
}

function monthRange(offsetMonths){
  const d = new Date(); d.setMonth(d.getMonth()+offsetMonths);
  return computePeriodRange('monthly', toLocalISO(d));
}
/* Dashboard cards now track whatever the newest dated entry in the file actually is,
   instead of the file's official db.period — so they update the moment you add a
   rental/expense/booking, with no "Start new month" click required. db.period itself
   is untouched by this: it still drives closed-month locking (guardClosedMonth) and
   the filenames used when saving/exporting, which should keep requiring an explicit
   rollover confirmation rather than silently moving whenever new data is entered. */
function periodMonthRange(offsetMonths){
  const live = inferPeriodFromData(db);
  const d = new Date(live.year, live.month + offsetMonths, 1);
  return computePeriodRange('monthly', toLocalISO(d));
}
/* ---------- global search ---------- */
document.getElementById('btnGlobalSearchToggle').addEventListener('click', ()=>{
  const box = document.getElementById('globalSearchBox');
  const opening = box.style.display === 'none';
  box.style.display = opening ? '' : 'none';
  if(opening) document.getElementById('globalSearchInput').focus();
});
document.addEventListener('click', e=>{
  const box = document.getElementById('globalSearchBox');
  const toggle = document.getElementById('btnGlobalSearchToggle');
  if(box.style.display!=='none' && !box.contains(e.target) && e.target!==toggle){
    box.style.display = 'none';
  }
});
document.getElementById('globalSearchInput').addEventListener('input', e=>{
  runGlobalSearch(e.target.value.trim());
});
/* Searches every record type by whatever text fields identify it (reg, names, phone,
   contract/invoice numbers, categories, notes...) and lists matches grouped loosely by
   kind. Clicking a result jumps to that record's panel and briefly highlights its row. */
function runGlobalSearch(q){
  const out = document.getElementById('globalSearchResults');
  if(!q){ out.innerHTML = '<div class="hint" style="margin:4px 0;">Start typing to search across the whole database.</div>'; return; }
  const ql = q.toLowerCase();
  const hits = [];
  const matches = (...parts) => parts.filter(Boolean).join(' ').toLowerCase().includes(ql);

  db.vehicles.forEach(v=>{
    if(matches(v.reg, v.make, v.model, v.owner))
      hits.push({panel:'vehicles', id:v.id, label:`${v.reg||'—'} — ${v.make||''} ${v.model||''}`.trim(), sub:'Vehicle'+(v.owner?` · owner ${v.owner}`:'')});
  });
  db.drivers.forEach(d=>{
    if(matches(d.name, d.phone, d.license))
      hits.push({panel:'drivers', id:d.id, label:d.name||'—', sub:'Driver'+(d.phone?` · ${d.phone}`:'')});
  });
  db.clients.forEach(c=>{
    if(matches(c.name, c.phone, c.idnum, c.dl))
      hits.push({panel:'clients', id:c.id, label:c.name||'—', sub:'Client'+(c.phone?` · ${c.phone}`:'')});
  });
  db.bookings.forEach(bk=>{
    const v = db.vehicles.find(v=>v.id==bk.vehicleId), c = db.clients.find(c=>c.id==bk.clientId);
    if(matches(v&&v.reg, c&&c.name, bk.status, bk.pickup, bk.return))
      hits.push({panel:'bookings', id:bk.id, label:`${v?v.reg:'—'} → ${c?c.name:'—'}`, sub:`Booking · ${bk.pickup} → ${bk.return} · ${bk.status}`});
  });
  db.rentals.forEach(r=>{
    const v = db.vehicles.find(v=>v.id==r.vehicleId), c = db.clients.find(c=>c.id==r.clientId);
    if(matches(v&&v.reg, c&&c.name, r.contract, r.invoice, r.receipt, r.status))
      hits.push({panel:'rentals', id:r.id, label:`${v?v.reg:'—'} → ${c?c.name:'—'}`, sub:`Rental · ${r.contract||'no contract#'} · ${r.status}`});
  });
  db.expenses.forEach(x=>{
    const v = db.vehicles.find(v=>v.id==x.vehicleId);
    if(matches(v&&v.reg, x.category, x.desc))
      hits.push({panel:'expenses', id:x.id, label:`${x.category}${x.desc?' — '+x.desc:''}`, sub:`Expense · ${x.date} · ${v?v.reg:'Office'}`});
  });
  db.payments.forEach(p=>{
    const r = db.rentals.find(r=>r.id==p.rentalId);
    const v = r ? db.vehicles.find(v=>v.id==r.vehicleId) : null, c = r ? db.clients.find(c=>c.id==r.clientId) : null;
    if(matches(v&&v.reg, c&&c.name, p.method, p.note))
      hits.push({panel:'payments', id:p.id, label:`${c?c.name:'—'} · ${fmt(p.amount)}`, sub:`Payment · ${p.date}${p.method?' · '+p.method:''}`});
  });
  db.driverAllowances.forEach(a=>{
    const d = db.drivers.find(d=>d.id==a.driverId);
    if(matches(d&&d.name, a.note))
      hits.push({panel:'drivers', id:a.id, label:`${d?d.name:'—'} allowance`, sub:`Allowance · ${a.weekStart} · ${fmt(a.amount)}`});
  });

  if(!hits.length){ out.innerHTML = '<div class="hint" style="margin:4px 0;">No matches.</div>'; return; }
  out.innerHTML = hits.slice(0,50).map((h,i)=>`
    <div class="search-hit" data-i="${i}" style="padding:8px 6px;border-bottom:1px solid var(--line);cursor:pointer;">
      <div style="font-size:13px;">${h.label}</div>
      <div style="font-size:11px;color:var(--ink-faint);">${h.sub}</div>
    </div>`).join('');
  out.querySelectorAll('.search-hit').forEach(el=>{
    el.addEventListener('click', ()=>{
      const h = hits[Number(el.dataset.i)];
      navigateToRecord(h.panel, {id:h.id});
    });
  });
}

/* ---------- dashboard: revenue status + cash flow ---------- */
/* The first graph is intentionally styled like the supplied reference:
   smooth filled curves with a previous/current comparison. It compares
   cumulative rental revenue day-by-day for the current open-file month
   against the previous month. */
function monthRevenueSeries(offsetMonths){
  ensurePeriod();
  const base = new Date(db.period.year, db.period.month + offsetMonths, 1);
  const year = base.getFullYear(), month = base.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const vals = Array(daysInMonth).fill(0);
  db.rentals.forEach(r=>{
    if(r.status==='Cancelled' || !r.pickup) return;
    const d = new Date(r.pickup+'T00:00:00');
    if(d.getFullYear()!==year || d.getMonth()!==month) return;
    vals[d.getDate()-1] += Number(r.amount)||0;
  });
  let running = 0;
  return vals.map(v => running += v);
}
function monthShortLabelOffset(offsetMonths){
  ensurePeriod();
  const d = new Date(db.period.year, db.period.month + offsetMonths, 1);
  return d.toLocaleDateString(undefined,{month:'short'});
}
function renderTrendCharts(){
  const current = monthRevenueSeries(0);
  const previous = monthRevenueSeries(-1);
  const days = Math.max(current.length, previous.length);
  const currentVals = Array.from({length:days},(_,i)=>current[i]||0);
  const previousVals = Array.from({length:days},(_,i)=>previous[i]||0);
  const currentTotal = current[current.length-1]||0;
  const previousTotal = previous[previous.length-1]||0;
  const lastDay = new Date().getDate();
  const currentLabel = monthShortLabelOffset(0);
  const previousLabel = monthShortLabelOffset(-1);

  document.getElementById('trendSubtitle').textContent =
    `${fmt(currentTotal)} current · ${fmt(previousTotal)} previous`;
  document.getElementById('cashFlowSubtitle').textContent =
    `${fmt(currentTotal-previousTotal)} revenue change vs previous month`;
  document.getElementById('trendChartSvg').innerHTML =
    buildAreaComparisonSvg(previousVals, currentVals, currentLabel, previousLabel, lastDay);

  /* Keep the existing cash-flow summary, but make it use the current month. */
  const expenses = {};
  for(let i=1;i<=currentVals.length;i++) expenses[i]=0;
  db.expenses.forEach(x=>{
    if(!x.date) return;
    const d = new Date(x.date+'T00:00:00');
    ensurePeriod();
    if(d.getFullYear()===db.period.year && d.getMonth()===db.period.month){
      expenses[d.getDate()] = (expenses[d.getDate()]||0) + (Number(x.amount)||0);
    }
  });
  const dailyNet = currentVals.map((v,i)=>{
    const day = i+1;
    const prev = i ? currentVals[i-1] : 0;
    return (v-prev) - (expenses[day]||0);
  });
  const flowDays = Array.from({length:currentVals.length},(_,i)=>i+1);
  document.getElementById('cashFlowSvg').innerHTML = buildBarChartSvg(dailyNet, flowDays);
}
function shortFmt(v){
  const n = Math.round(v);
  if(Math.abs(n)>=1000000) return (n/1000000).toFixed(1)+'M';
  if(Math.abs(n)>=1000) return (n/1000).toFixed(1)+'k';
  return String(n);
}
function smoothPath(vals,x,y){
  if(!vals.length) return '';
  if(vals.length===1) return `M${x(0).toFixed(1)},${y(vals[0]).toFixed(1)}`;
  let d=`M${x(0).toFixed(1)},${y(vals[0]).toFixed(1)}`;
  for(let i=1;i<vals.length;i++){
    const x0=x(i-1), x1=x(i);
    const y0=y(vals[i-1]), y1=y(vals[i]);
    const cp=(x1-x0)/3;
    d += ` C${(x0+cp).toFixed(1)},${y0.toFixed(1)} ${(x1-cp).toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
function buildAreaComparisonSvg(previousVals,currentVals,currentLabel,previousLabel,lastDay){
  const w=700,h=235,padL=48,padR=12,padT=16,padB=34;
  const n=Math.max(previousVals.length,currentVals.length,1);
  const realMax=Math.max(1,...previousVals,...currentVals);
  const plotW=w-padL-padR, plotH=h-padT-padB;
  const x=i=>padL+(i/(Math.max(1,n-1)))*plotW;
  const y=v=>padT+plotH-(v/realMax)*plotH;
  const baseY=padT+plotH;
  let grid='';
  for(let g=0;g<=4;g++){
    const gy=padT+plotH-(g/4)*plotH;
    grid += `<line x1="${padL}" y1="${gy}" x2="${w-padR}" y2="${gy}" style="stroke:var(--line);stroke-width:1;"/>`;
    grid += `<text x="${padL-8}" y="${gy+4}" text-anchor="end" font-size="10" font-family="var(--mono)" style="fill:var(--ink-faint);">${shortFmt((g/4)*realMax)}</text>`;
  }
  let labels='';
  const step=Math.max(1,Math.ceil(n/6));
  for(let i=0;i<n;i++){
    if(i%step===0 || i===n-1){
      labels += `<text x="${x(i).toFixed(1)}" y="${h-10}" text-anchor="middle" font-size="10" font-family="var(--mono)" style="fill:var(--ink-faint);">${i+1}</text>`;
    }
  }
  const prevPath=smoothPath(previousVals,x,y);
  const curPath=smoothPath(currentVals,x,y);
  const prevArea=`${prevPath} L${x(n-1).toFixed(1)},${baseY.toFixed(1)} L${x(0).toFixed(1)},${baseY.toFixed(1)} Z`;
  const curArea=`${curPath} L${x(n-1).toFixed(1)},${baseY.toFixed(1)} L${x(0).toFixed(1)},${baseY.toFixed(1)} Z`;
  const markerIndex=Math.min(Math.max(lastDay-1,0),n-1);

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Revenue status comparison">
    <defs>
      <linearGradient id="prevRevenueFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:#2E9BE6;stop-opacity:.30"/>
        <stop offset="100%" style="stop-color:#2E9BE6;stop-opacity:.02"/>
      </linearGradient>
      <linearGradient id="curRevenueFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--green);stop-opacity:.34"/>
        <stop offset="100%" style="stop-color:var(--green);stop-opacity:.03"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${prevArea}" style="fill:url(#prevRevenueFill);stroke:none;"/>
    <path d="${curArea}" style="fill:url(#curRevenueFill);stroke:none;"/>
    <path d="${prevPath}" style="fill:none;stroke:#2E9BE6;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;"/>
    <path d="${curPath}" style="fill:none;stroke:var(--green);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;"/>
    <line x1="${x(markerIndex).toFixed(1)}" y1="${padT}" x2="${x(markerIndex).toFixed(1)}" y2="${baseY}" style="stroke:var(--amber);stroke-width:1;stroke-dasharray:3 4;opacity:.7;"/>
    <circle cx="${x(markerIndex).toFixed(1)}" cy="${y(currentVals[markerIndex]||0).toFixed(1)}" r="4" style="fill:var(--green);stroke:var(--panel);stroke-width:2;"/>
    ${labels}
  </svg>`;
}
/* Day-of-month tick labels for the trend bar chart below — was referenced by
   buildBarChartSvg() but never actually defined, so every render of the
   dashboard trend chart threw a ReferenceError and crashed renderDashboard()
   entirely. Since renderDashboard() runs on every load AND on every markDirty()
   (i.e. every single add/edit/delete anywhere in the app), this was breaking
   the whole render pipeline on every data change, not just the chart. */
function xLabels(days, x){
  const y = 200 - 26 + 14; // matches buildBarChartSvg's h=200, padB=26
  const step = days <= 10 ? 1 : (days <= 20 ? 5 : 5);
  let labels = '';
  for(let i=0; i<days; i++){
    if(i % step !== 0 && i !== days-1) continue;
    labels += `<text x="${x(i).toFixed(1)}" y="${y}" text-anchor="middle" style="font-size:9px;fill:var(--ink-faint);">${i+1}</text>`;
  }
  return labels;
}
function buildBarChartSvg(netVals, days){
  const w=640,h=200,padL=44,padR=8,padT=10,padB=26;
  const maxAbs = Math.max(1, ...netVals.map(Math.abs));
  const plotW = w-padL-padR, plotH = h-padT-padB;
  const zeroY = padT + plotH/2;
  const gap = plotW/netVals.length, barW = gap*0.6;
  const x = i => padL + i*gap + gap/2;
  let bars = '';
  netVals.forEach((v,i)=>{
    if(!v) return;
    const bh = (Math.abs(v)/maxAbs)*(plotH/2);
    const bx = padL + i*gap + (gap-barW)/2;
    const by = v>=0 ? zeroY-bh : zeroY;
    bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh,1).toFixed(1)}" rx="1.5" style="fill:${v>=0?'var(--green)':'var(--red)'};"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <line x1="${padL}" y1="${zeroY}" x2="${w-padR}" y2="${zeroY}" style="stroke:var(--line);stroke-width:1;"/>
    ${bars}
    ${xLabels(days,x)}
  </svg>`;
}

/* ---------- dashboard: available (not-yet-cancelled) bookings ---------- */
function renderDashBookings(){
  const tb = document.querySelector('#dashBookingsTable tbody'); tb.innerHTML='';
  const available = db.bookings.filter(bk=>bk.status!=='Cancelled');
  if(!available.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="6">No available bookings right now.</td></tr>'; return; }
  available.forEach(bk=>{
    const v = db.vehicles.find(v=>v.id==bk.vehicleId), c = db.clients.find(c=>c.id==bk.clientId);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${v?v.reg+' — '+v.make+' '+v.model:'—'}</td><td>${c?c.name:'—'}</td>
      <td>${bk.bookedOn||'—'}</td><td>${bk.pickup||'—'}</td><td>${bk.return||'—'}</td>
      <td><span class="tag ${bk.status}">${bk.status}</span></td>`;
    tb.appendChild(tr);
  });
}

/* ---------- dashboard chart: fleet status, pie or bar (admin's choice) ---------- */
const CHART_COLORS = { Available:'#4F9E6E', Rented:'#E8A33D', Maintenance:'#D9695F', Inactive:'#5B6572' };
document.getElementById('dashChartSeg').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  db.settings.chartType = btn.dataset.c;
  markDirty();
  renderDashChart();
});
function renderDashChart(){
  const seg = document.getElementById('dashChartSeg');
  const type = (db.settings && db.settings.chartType) || 'pie';
  seg.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b.dataset.c===type));

  const statuses = ['Available','Rented','Maintenance','Inactive'];
  const counts = statuses.map(s=> db.vehicles.filter(v=>v.status===s).length);
  const total = counts.reduce((a,b)=>a+b,0);

  const canvas = document.getElementById('dashChartCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const legend = document.getElementById('dashChartLegend');
  if(!total){
    legend.innerHTML = '<div class="hint" style="margin:0;">Add vehicles to see the fleet status breakdown.</div>';
    return;
  }

  if(type==='pie'){
    const cx=130, cy=130, r=110;
    let start = -Math.PI/2;
    statuses.forEach((s,i)=>{
      if(!counts[i]) return;
      const slice = (counts[i]/total) * Math.PI*2;
      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.arc(cx,cy,r,start,start+slice);
      ctx.closePath();
      ctx.fillStyle = CHART_COLORS[s];
      ctx.fill();
      start += slice;
    });
    ctx.beginPath(); ctx.arc(cx,cy,r*0.55,0,Math.PI*2);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel') || '#171F29';
    ctx.fill();
  } else {
    const maxC = Math.max(1, ...counts);
    const barW = 42, gap = 24, baseY = 230, top = 20;
    const startX = (canvas.width - (statuses.length*barW + (statuses.length-1)*gap))/2;
    statuses.forEach((s,i)=>{
      const h = (counts[i]/maxC) * (baseY-top);
      const x = startX + i*(barW+gap);
      ctx.fillStyle = CHART_COLORS[s];
      ctx.fillRect(x, baseY-h, barW, h || 1);
      ctx.fillStyle = '#8A93A3';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(counts[i]), x+barW/2, baseY-h-6);
    });
  }

  legend.innerHTML = statuses.map((s,i)=>{
    const pct = total ? Math.round(counts[i]/total*100) : 0;
    return `<div style="display:flex;align-items:center;gap:9px;margin-bottom:9px;font-size:13.5px;">
      <span style="width:11px;height:11px;border-radius:3px;background:${CHART_COLORS[s]};flex-shrink:0;"></span>
      <span style="flex:1;">${s}</span>
      <span style="font-family:var(--mono);color:var(--ink-dim);">${counts[i]} (${pct}%)</span>
    </div>`;
  }).join('');
}

/* ---------- reports ---------- */
let periodType = 'monthly';
/* Dashboard cards can either follow the Reports/Dashboard period selector (like the
   rest of this file always did) or show all-time totals straight off the whole data
   file, independent of any period. All-time is the default on open — matching the
   "Restore cards to default" button, which flips back to it. Picking any period
   control (Daily/Weekly/Monthly/Yearly/Custom segment, or a reference/custom date)
   switches the cards to follow that period instead, until Restore is pressed again.
   Reports itself always shows the selected period's figures regardless of this flag —
   only the Dashboard summary cards read it. */
let dashCardsAllTime = true;
function setCardsFollowPeriod(){
  dashCardsAllTime = false;
}
/* The period picker is duplicated on the Dashboard (dashPeriodSeg/dash_rep_*) and on
   Reports (periodSeg/rep_*) so either panel can drive it. Both sets of controls are
   kept mirrored and both renderReports()+renderDashboard() run on every change, so
   the two panels always agree on the same numbers for the same period. */
function setPeriodType(type){
  periodType = type;
  document.querySelectorAll('#periodSeg button').forEach(b=>b.classList.toggle('active', b.dataset.p===type));
  document.querySelectorAll('#dashPeriodSeg button').forEach(b=>b.classList.toggle('active', b.dataset.p===type));
  const showCustom = type==='custom';
  document.getElementById('rep_ref').style.display = showCustom ? 'none' : 'inline-block';
  document.getElementById('customRange').style.display = showCustom ? 'inline-flex' : 'none';
  document.getElementById('dash_rep_ref').style.display = showCustom ? 'none' : 'inline-block';
  document.getElementById('dashCustomRange').style.display = showCustom ? 'inline-flex' : 'none';
}
function syncPeriodDate(sourceId, targetId){
  const src = document.getElementById(sourceId), tgt = document.getElementById(targetId);
  if(src && tgt) tgt.value = src.value;
}
document.getElementById('periodSeg').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  setPeriodType(btn.dataset.p);
  setCardsFollowPeriod();
  renderReports(); renderDashboard();
});
document.getElementById('dashPeriodSeg').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  setPeriodType(btn.dataset.p);
  setCardsFollowPeriod();
  renderReports(); renderDashboard();
});
document.getElementById('rep_ref').addEventListener('change', ()=>{ syncPeriodDate('rep_ref','dash_rep_ref'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('dash_rep_ref').addEventListener('change', ()=>{ syncPeriodDate('dash_rep_ref','rep_ref'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('rep_start').addEventListener('change', ()=>{ syncPeriodDate('rep_start','dash_rep_start'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('dash_rep_start').addEventListener('change', ()=>{ syncPeriodDate('dash_rep_start','rep_start'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('rep_end').addEventListener('change', ()=>{ syncPeriodDate('rep_end','dash_rep_end'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('dash_rep_end').addEventListener('change', ()=>{ syncPeriodDate('dash_rep_end','rep_end'); setCardsFollowPeriod(); renderReports(); renderDashboard(); });
document.getElementById('btnPrint').addEventListener('click', ()=> window.print());
document.getElementById('btnRestoreCardsDefault').addEventListener('click', ()=>{
  dashCardsAllTime = true;
  renderDashboard();
});

function computePeriodRange(type, refStr, startStr, endStr){
  const ref = refStr ? new Date(refStr) : new Date();
  let start, end;
  if(type==='daily'){ start = new Date(ref); end = new Date(ref); }
  else if(type==='weekly'){
    const day = ref.getDay(); const diffToMon = (day===0?-6:1-day);
    start = new Date(ref); start.setDate(ref.getDate()+diffToMon);
    end = new Date(start); end.setDate(start.getDate()+6);
  } else if(type==='monthly'){
    start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    end = new Date(ref.getFullYear(), ref.getMonth()+1, 0);
  } else if(type==='yearly'){
    start = new Date(ref.getFullYear(),0,1); end = new Date(ref.getFullYear(),11,31);
  } else {
    start = startStr? new Date(startStr) : new Date(0); end = endStr? new Date(endStr) : new Date();
  }
  start.setHours(0,0,0,0); end.setHours(23,59,59,999);
  return {start,end};
}
function periodRange(){
  return computePeriodRange(periodType,
    document.getElementById('rep_ref').value,
    document.getElementById('rep_start').value,
    document.getElementById('rep_end').value);
}
/* The equivalent prior period for whichever period type is currently selected —
   previous day for Daily, previous week for Weekly, previous calendar month for
   Monthly, previous year for Yearly, and an equal-length window right before the
   current range for Custom. Used to build the dashboard's "vs previous period" deltas. */
function previousPeriodRange(){
  const refStr = document.getElementById('rep_ref').value;
  const ref = refStr ? new Date(refStr) : new Date();
  if(periodType==='daily'){
    const d = new Date(ref); d.setDate(d.getDate()-1);
    return computePeriodRange('daily', toLocalISO(d));
  }
  if(periodType==='weekly'){
    const d = new Date(ref); d.setDate(d.getDate()-7);
    return computePeriodRange('weekly', toLocalISO(d));
  }
  if(periodType==='yearly'){
    const d = new Date(ref.getFullYear()-1, 0, 1);
    return computePeriodRange('yearly', toLocalISO(d));
  }
  if(periodType==='custom'){
    const {start,end} = periodRange();
    const durMs = end.getTime() - start.getTime();
    const prevEnd = new Date(start.getTime() - 24*60*60*1000);
    const prevStart = new Date(prevEnd.getTime() - durMs);
    return {start:prevStart, end:prevEnd};
  }
  // monthly (default)
  const d = new Date(ref.getFullYear(), ref.getMonth()-1, 1);
  return computePeriodRange('monthly', toLocalISO(d));
}
function previousPeriodLabel(){
  return { daily:'previous day', weekly:'previous week', monthly:'previous month', yearly:'previous year', custom:'previous period' }[periodType] || 'previous period';
}
function inRange(dateStr, start, end){
  const d = new Date(dateStr); return d>=start && d<=end;
}
function renderReports(){
  if(!document.getElementById('rep_ref').value){
    document.getElementById('rep_ref').value = toLocalISO(new Date());
    document.getElementById('dash_rep_ref').value = document.getElementById('rep_ref').value;
  }
  const {start,end} = periodRange();
  document.getElementById('periodLabel').textContent =
    'Showing: ' + start.toDateString() + '  →  ' + end.toDateString();

  const rentalsIn = db.rentals.filter(r=>r.status!=='Cancelled' && inRange(r.pickup,start,end));
  const expensesIn = db.expenses.filter(x=>inRange(x.date,start,end));

  const totalRevenue = rentalsIn.reduce((s,r)=>s+r.amount,0);
  const totalExpenses = expensesIn.reduce((s,x)=>s+x.amount,0);
  const totalFuel = expensesIn.filter(x=>x.category==='Fuel').reduce((s,x)=>s+x.amount,0);
  const totalDays = rentalsIn.reduce((s,r)=>s+r.days,0);
  /* Collected/Outstanding are tracked per rental (via linked "Payment received" entries),
     not per period — a rental invoiced this period can still be paid off later, and that
     later payment should still count against it here. */
  const totalCollected = rentalsIn.reduce((s,r)=>s+paidForRental(r.id),0);
  const totalOutstanding = totalRevenue - totalCollected;

  const perVehicle = db.vehicles.map(v=>{
    const vr = rentalsIn.filter(r=>r.vehicleId==v.id);
    const ve = expensesIn.filter(x=>x.vehicleId==v.id);
    const revenue = vr.reduce((s,r)=>s+r.amount,0);
    const collected = vr.reduce((s,r)=>s+paidForRental(r.id),0);
    const outstanding = revenue - collected;
    const days = vr.reduce((s,r)=>s+r.days,0);
    const exp = ve.reduce((s,x)=>s+x.amount,0);
    const net = revenue - exp;
    return {v,revenue,collected,outstanding,days,exp,net};
  }).filter(row=>row.revenue>0 || row.exp>0);

  document.getElementById('repCards').innerHTML = `
    <div class="card"><div class="label">Rental days</div><div class="value">${totalDays}</div></div>
    <div class="card"><div class="label">Revenue (invoiced)</div><div class="value amber">${fmt(totalRevenue)}</div></div>
    <div class="card"><div class="label">Collected</div><div class="value green">${fmt(totalCollected)}</div></div>
    <div class="card"><div class="label">Outstanding</div><div class="value ${totalOutstanding>0?'red':'green'}">${fmt(totalOutstanding)}</div></div>
    <div class="card"><div class="label">Expenses</div><div class="value red">${fmt(totalExpenses)}</div></div>
    <div class="card"><div class="label">Fuel</div><div class="value fuel">${fmt(totalFuel)}</div></div>
    <div class="card"><div class="label">Net to company</div><div class="value ${totalRevenue-totalExpenses>=0?'green':'red'}">${fmt(totalRevenue-totalExpenses)}</div></div>`;

  const tb = document.querySelector('#repTable tbody'); tb.innerHTML='';
  if(!perVehicle.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="8">No activity in this period.</td></tr>'; }
  perVehicle.forEach(row=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.v.reg}</td><td>${row.v.make} ${row.v.model}</td><td class="num">${row.days}</td>
      <td class="num">${fmt(row.revenue)}</td>
      <td class="num" style="color:var(--green);">${fmt(row.collected)}</td>
      <td class="num" style="color:${row.outstanding>0?'var(--red)':'var(--ink-faint)'};">${fmt(row.outstanding)}</td>
      <td class="num">${fmt(row.exp)}</td>
      <td class="num">${fmt(row.net)}</td>`;
    tb.appendChild(tr);
  });

  const maxRev = Math.max(1, ...perVehicle.map(r=>r.revenue));
  document.getElementById('repBars').innerHTML = perVehicle.length ? perVehicle.map(row=>`
    <div class="bar-row">
      <div class="bname">${row.v.reg}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(row.revenue/maxRev*100)}%"></div></div>
      <div class="bar-amt">${fmt(row.revenue)}</div>
    </div>`).join('') : '<div class="hint" style="margin:0;">Nothing to chart for this period yet.</div>';

  renderLeasedCars();
  renderVehicleStatement();
}

/* ---------- multi-month analysis (loads other monthly files read-only) ---------- */
let analysisFiles = []; // [{name, db}]
document.getElementById('btnLoadAnalysisFiles').addEventListener('click', ()=>{
  if(typeof ExcelJS === 'undefined'){ toast('The Excel engine did not load (no internet connection, or it was blocked). Reconnect and refresh the page, then try again.'); return; }
  document.getElementById('analysisFileInput').click();
});
document.getElementById('analysisFileInput').addEventListener('change', async e=>{
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for(const f of files){
    try{
      const buf = await f.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const parsedDb = workbookToDb(wb);
      analysisFiles.push({ name: f.name, db: parsedDb });
    }catch(err){
      console.error('Analysis load failed for', f.name, err);
      toast('Could not read ' + f.name + ' — skipped.');
    }
  }
  analysisFiles.sort((a,b)=> (a.db.period.start||'').localeCompare(b.db.period.start||''));
  renderAnalysis();
  toast(`Loaded ${files.length} file(s) for analysis`);
});
document.getElementById('btnClearAnalysisFiles').addEventListener('click', ()=>{
  analysisFiles = [];
  renderAnalysis();
});
function renderAnalysis(){
  const wrap = document.getElementById('analysisFilesWrap');
  const tb = document.querySelector('#analysisFilesTable tbody'); tb.innerHTML='';
  renderStatAnalysis();
  if(!analysisFiles.length){
    wrap.style.display='none';
    document.getElementById('analysisCards').innerHTML = '';
    document.querySelector('#analysisMonthTable tbody').innerHTML = '<tr class="empty-row"><td colspan="6">Load monthly database files above to see combined totals across them.</td></tr>';
    document.getElementById('analysisBars').innerHTML = '<div class="hint" style="margin:0;">Nothing loaded yet.</div>';
    return;
  }
  wrap.style.display = '';
  analysisFiles.forEach((f,i)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${f.name}</td><td>${f.db.period.label}</td>
      <td class="num">${f.db.bookings.length}</td><td class="num">${f.db.rentals.length}</td><td class="num">${f.db.expenses.length}</td>
      <td><button class="row-del" data-i="${i}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.row-del').forEach(b=>b.addEventListener('click',()=>{
    analysisFiles.splice(Number(b.dataset.i),1);
    renderAnalysis();
  }));

  const monthRows = analysisFiles.map(f=>{
    const rentalsOk = f.db.rentals.filter(r=>r.status!=='Cancelled');
    const revenue = rentalsOk.reduce((s,r)=>s+(Number(r.amount)||0),0);
    const cancelledRentalIds = new Set(f.db.rentals.filter(r=>r.status==='Cancelled').map(r=>r.id));
    const collected = (f.db.payments||[]).filter(p=>!cancelledRentalIds.has(p.rentalId)).reduce((s,p)=>s+(Number(p.amount)||0),0);
    const expenses = (f.db.expenses||[]).reduce((s,x)=>s+(Number(x.amount)||0),0);
    return { label: f.db.period.label, rentals: rentalsOk.length, revenue, collected, expenses, net: revenue-expenses };
  });

  const totalRentals = monthRows.reduce((s,r)=>s+r.rentals,0);
  const totalRevenue = monthRows.reduce((s,r)=>s+r.revenue,0);
  const totalCollected = monthRows.reduce((s,r)=>s+r.collected,0);
  const totalExpenses = monthRows.reduce((s,r)=>s+r.expenses,0);
  document.getElementById('analysisCards').innerHTML = `
    <div class="card"><div class="label">Months loaded</div><div class="value">${analysisFiles.length}</div></div>
    <div class="card"><div class="label">Rentals</div><div class="value">${totalRentals}</div></div>
    <div class="card"><div class="label">Revenue</div><div class="value amber">${fmt(totalRevenue)}</div></div>
    <div class="card"><div class="label">Collected</div><div class="value green">${fmt(totalCollected)}</div></div>
    <div class="card"><div class="label">Expenses</div><div class="value red">${fmt(totalExpenses)}</div></div>
    <div class="card"><div class="label">Net</div><div class="value ${totalRevenue-totalExpenses>=0?'green':'red'}">${fmt(totalRevenue-totalExpenses)}</div></div>`;

  const mtb = document.querySelector('#analysisMonthTable tbody'); mtb.innerHTML='';
  monthRows.forEach(row=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.label}</td><td class="num">${row.rentals}</td><td class="num">${fmt(row.revenue)}</td>
      <td class="num" style="color:var(--green);">${fmt(row.collected)}</td>
      <td class="num">${fmt(row.expenses)}</td>
      <td class="num" style="color:${row.net>=0?'var(--green)':'var(--red)'}">${fmt(row.net)}</td>`;
    mtb.appendChild(tr);
  });

  const maxRev = Math.max(1, ...monthRows.map(r=>r.revenue));
  document.getElementById('analysisBars').innerHTML = monthRows.length ? monthRows.map(row=>`
    <div class="bar-row">
      <div class="bname" style="width:120px;">${row.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(row.revenue/maxRev*100)}%"></div></div>
      <div class="bar-amt">${fmt(row.revenue)}</div>
    </div>`).join('') : '<div class="hint" style="margin:0;">Nothing to chart yet.</div>';
}

/* ---------- statistical analysis (fuel, other expense categories, revenue, etc.) ----------
   Works off the currently open file (db), not the multi-month loader above, so it's
   useful immediately with just one file open. "Metric" = a list of individual dated,
   per-vehicle amounts (e.g. every Fuel expense line) that count/total/average/median/
   min/max/spread get computed over, plus a per-vehicle and per-month breakdown.
   Recalculated fresh every time the Analysis tab is opened (renderAnalysis calls this),
   so it always reflects whatever is in the file at that moment. */
function statMean(vals){ return vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0; }
function statMedian(vals){
  if(!vals.length) return 0;
  const s = [...vals].sort((a,b)=>a-b), mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}
function statStdDev(vals){
  if(vals.length<2) return 0;
  const m = statMean(vals);
  return Math.sqrt(vals.reduce((s,v)=>s+(v-m)**2,0)/vals.length);
}
/* Base (non-category) metrics available regardless of what expense categories exist
   in this file. Expense-category metrics (Fuel, Maintenance, whatever the user has
   actually logged) are appended dynamically in buildStatMetrics() below. */
const STAT_BASE_METRICS = {
  allExpenses: { label:'All expenses (every category)', rows: () => db.expenses.map(x=>({amount:Number(x.amount)||0, vehicleId:x.vehicleId, date:x.date})) },
  revenue: { label:'Rental revenue', rows: () => db.rentals.filter(r=>r.status!=='Cancelled').map(r=>({amount:Number(r.amount)||0, vehicleId:r.vehicleId, date:r.pickup})) },
  rentalDays: { label:'Rental duration (days)', rows: () => db.rentals.filter(r=>r.status!=='Cancelled').map(r=>({amount:Number(r.days)||0, vehicleId:r.vehicleId, date:r.pickup})) },
  payments: { label:'Payments received', rows: () => db.payments.map(p=>{ const r=db.rentals.find(r=>r.id==p.rentalId); return {amount:Number(p.amount)||0, vehicleId: r?r.vehicleId:null, date:p.date}; }) }
};
/* Builds the full metric list for this file: the base metrics above, plus one metric
   per distinct expense category actually present in db.expenses — Fuel included, but
   also Maintenance, Repairs, or whatever categories this fleet actually logs, so the
   same tool works for any of them, not just fuel. */
function buildStatMetrics(){
  const metrics = {...STAT_BASE_METRICS};
  const categories = [...new Set(db.expenses.map(x=>x.category).filter(Boolean))].sort();
  categories.forEach(cat=>{
    metrics['cat:'+cat] = {
      label: cat + ' expenses',
      rows: () => db.expenses.filter(x=>x.category===cat).map(x=>({amount:Number(x.amount)||0, vehicleId:x.vehicleId, date:x.date}))
    };
  });
  return metrics;
}
function populateStatMetricSelect(){
  const sel = document.getElementById('statMetricSelect');
  const metrics = buildStatMetrics();
  const prevValue = sel.value;
  // Default to Fuel the first time there's fuel data to show, since it's the flagship
  // use case — otherwise fall back to the first metric in the list.
  const fallback = metrics['cat:Fuel'] ? 'cat:Fuel' : Object.keys(metrics)[0];
  sel.innerHTML = Object.entries(metrics).map(([key,m])=>`<option value="${escapeHTML(key)}">${escapeHTML(m.label)}</option>`).join('');
  sel.value = (prevValue && metrics[prevValue]) ? prevValue : fallback;
  return metrics;
}
function renderStatAnalysis(){
  const cardsEl = document.getElementById('statCards');
  const vtb = document.querySelector('#statVehicleTable tbody');
  const monthBarsEl = document.getElementById('statMonthBars');
  if(!cardsEl || !vtb || !monthBarsEl) return;

  const metrics = populateStatMetricSelect();
  const sel = document.getElementById('statMetricSelect');
  const metric = metrics[sel.value];
  const rows = metric ? metric.rows().filter(r=>r.date) : [];
  const vals = rows.map(r=>r.amount);

  const count = vals.length;
  const total = vals.reduce((s,v)=>s+v,0);
  const mean = statMean(vals);
  const median = statMedian(vals);
  const min = count ? Math.min(...vals) : 0;
  const max = count ? Math.max(...vals) : 0;
  const stdDev = statStdDev(vals);

  cardsEl.innerHTML = `
    <div class="card"><div class="label">Entries</div><div class="value">${count}</div></div>
    <div class="card"><div class="label">Total</div><div class="value amber">${fmt(total)}</div></div>
    <div class="card"><div class="label">Average</div><div class="value">${fmt(mean)}</div></div>
    <div class="card"><div class="label">Median</div><div class="value">${fmt(median)}</div></div>
    <div class="card"><div class="label">Lowest</div><div class="value">${fmt(min)}</div></div>
    <div class="card"><div class="label">Highest</div><div class="value">${fmt(max)}</div></div>
    <div class="card"><div class="label">Spread (std. dev.)</div><div class="value">${fmt(stdDev)}</div></div>`;

  // Per vehicle
  const byVehicle = new Map();
  rows.forEach(r=>{
    const key = r.vehicleId!=null ? r.vehicleId : '—';
    if(!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push(r.amount);
  });
  const vehicleRows = [...byVehicle.entries()].map(([vehicleId,amts])=>{
    const v = db.vehicles.find(v=>v.id==vehicleId);
    return { label: v ? `${v.reg} — ${v.make} ${v.model}` : 'Office / unassigned', count: amts.length, total: amts.reduce((s,a)=>s+a,0), avg: statMean(amts) };
  }).sort((a,b)=>b.total-a.total);
  vtb.innerHTML = vehicleRows.length ? vehicleRows.map(r=>`
    <tr><td>${escapeHTML(r.label)}</td><td class="num">${r.count}</td><td class="num">${fmt(r.total)}</td><td class="num">${fmt(r.avg)}</td></tr>
  `).join('') : '<tr class="empty-row"><td colspan="4">No entries for this metric yet.</td></tr>';

  // By month
  const byMonth = new Map();
  rows.forEach(r=>{
    const d = new Date(r.date+'T00:00:00');
    if(isNaN(d)) return;
    const key = `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
    if(!byMonth.has(key)) byMonth.set(key, 0);
    byMonth.set(key, byMonth.get(key)+r.amount);
  });
  const monthRows = [...byMonth.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([key,sum])=>{ const [y,m] = key.split('-').map(Number); return { label: monthLabel(y,m-1), sum }; });
  const maxMonth = Math.max(1, ...monthRows.map(r=>r.sum));
  monthBarsEl.innerHTML = monthRows.length ? monthRows.map(row=>`
    <div class="bar-row">
      <div class="bname" style="width:120px;">${row.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(row.sum/maxMonth*100)}%"></div></div>
      <div class="bar-amt">${fmt(row.sum)}</div>
    </div>`).join('') : '<div class="hint" style="margin:0;">Nothing to chart for this metric yet.</div>';
}
document.getElementById('statMetricSelect').addEventListener('change', renderStatAnalysis);


/* ---------- leased cars report ---------- */
function renderLeasedCars(){
  const tb = document.querySelector('#repLeasedTable tbody'); tb.innerHTML='';
  const active = db.rentals.filter(r=>r.status==='Active');
  if(!active.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="7">No vehicles currently leased out.</td></tr>'; return; }
  active.forEach(r=>{
    const v = db.vehicles.find(v=>v.id==r.vehicleId), c = db.clients.find(c=>c.id==r.clientId);
    const pickupCell = r.pickup + (r.pickupTime?(' '+r.pickupTime):'');
    const dueBack = r.return + (r.returnTime?(' '+r.returnTime):'');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${v?v.reg:'—'}</td><td>${v?v.make+' '+v.model:'—'}</td><td>${c?c.name:'—'}</td>
      <td>${r.contract||'—'}</td><td>${pickupCell}</td><td>${dueBack}</td><td class="num">${fmt(r.rate)}</td>`;
    tb.appendChild(tr);
  });
}

/* ---------- individual vehicle statement ---------- */
function renderVehicleStatement(){
  const vid = document.getElementById('rep_vehicle_pick').value;
  const cardsEl = document.getElementById('repVehicleCards');
  const rentalTb = document.querySelector('#repVehicleRentalTable tbody');
  const expenseTb = document.querySelector('#repVehicleExpenseTable tbody');
  if(!vid){
    cardsEl.innerHTML = '<div class="hint" style="margin:0;">Pick a vehicle above to see its statement for the selected period.</div>';
    rentalTb.innerHTML = ''; expenseTb.innerHTML = '';
    return;
  }
  const {start,end} = periodRange();
  const v = db.vehicles.find(v=>v.id==vid);
  const vr = db.rentals.filter(r=>r.vehicleId==vid && r.status!=='Cancelled' && inRange(r.pickup,start,end));
  const ve = db.expenses.filter(x=>x.vehicleId==vid && inRange(x.date,start,end));
  const revenue = vr.reduce((s,r)=>s+r.amount,0);
  const collected = vr.reduce((s,r)=>s+paidForRental(r.id),0);
  const outstanding = revenue - collected;
  const days = vr.reduce((s,r)=>s+r.days,0);
  const exp = ve.reduce((s,x)=>s+x.amount,0);
  cardsEl.innerHTML = `
    <div class="card"><div class="label">Days rented</div><div class="value">${days}</div></div>
    <div class="card"><div class="label">Revenue</div><div class="value amber">${fmt(revenue)}</div></div>
    <div class="card"><div class="label">Collected</div><div class="value green">${fmt(collected)}</div></div>
    <div class="card"><div class="label">Outstanding</div><div class="value ${outstanding>0?'red':'green'}">${fmt(outstanding)}</div></div>
    <div class="card"><div class="label">Expenses</div><div class="value red">${fmt(exp)}</div></div>
    <div class="card"><div class="label">Net</div><div class="value ${revenue-exp>=0?'green':'red'}">${fmt(revenue-exp)}</div></div>`;
  rentalTb.innerHTML = vr.length ? vr.map(r=>{
    const c = db.clients.find(c=>c.id==r.clientId);
    const paid = paidForRental(r.id), owed = owedForRental(r);
    return `<tr><td>${c?c.name:'—'}</td><td>${r.contract||'—'}</td><td>${r.pickup}</td><td>${r.return}</td>
      <td class="num">${r.days}</td><td class="num">${r.mileage ? r.mileage.toLocaleString() : '—'}</td><td class="num">${fmt(r.amount)}</td>
      <td class="num" style="color:var(--green);">${fmt(paid)}</td>
      <td class="num" style="color:${owed>0?'var(--red)':'var(--ink-faint)'};">${fmt(owed)}</td>
      <td><span class="tag ${r.status}">${r.status}</span></td></tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="9">No rentals for '+(v?v.reg:'this vehicle')+' in this period.</td></tr>';
  expenseTb.innerHTML = ve.length ? ve.map(x=>
    `<tr><td>${x.date}</td><td>${x.category}</td><td>${x.desc||'—'}</td><td class="num">${x.qty||1}</td><td class="num">${fmt(x.amount)}</td></tr>`
  ).join('') : '<tr class="empty-row"><td colspan="5">No expenses for '+(v?v.reg:'this vehicle')+' in this period.</td></tr>';
}

/* ---------- expense statement modal ---------- */
const EXP_CATEGORIES = ['Fuel','Maintenance','Garage','Insurance','Cleaning','Airport','Parking',
  'Driver allowance','Owner payout','Leased car','Other'];
let expPeriodType = 'monthly';

document.getElementById('btnExpenseStatement').addEventListener('click', ()=>{
  populateExpVehiclePick();
  if(!document.getElementById('exp_ref').value) document.getElementById('exp_ref').value = toLocalISO(new Date());
  document.getElementById('expModalOverlay').classList.add('show');
  showCategoryView();
  renderExpenseStatement();
});
document.getElementById('expModalClose').addEventListener('click', ()=>{
  document.getElementById('expModalOverlay').classList.remove('show');
});
document.getElementById('expModalOverlay').addEventListener('click', e=>{
  if(e.target.id==='expModalOverlay') document.getElementById('expModalOverlay').classList.remove('show');
});
document.getElementById('expPeriodSeg').addEventListener('click', e=>{
  const btn = e.target.closest('button'); if(!btn) return;
  document.querySelectorAll('#expPeriodSeg button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  expPeriodType = btn.dataset.p;
  document.getElementById('exp_ref').style.display = expPeriodType==='custom' ? 'none' : 'inline-block';
  document.getElementById('expCustomRange').style.display = expPeriodType==='custom' ? 'inline-flex' : 'none';
  renderExpenseStatement();
});
document.getElementById('exp_ref').addEventListener('change', renderExpenseStatement);
document.getElementById('exp_start').addEventListener('change', renderExpenseStatement);
document.getElementById('exp_end').addEventListener('change', renderExpenseStatement);
document.getElementById('exp_vehicle_pick').addEventListener('change', ()=>{ showCategoryView(); renderExpenseStatement(); });
document.getElementById('btnPrintExpense').addEventListener('click', ()=> window.print());
document.getElementById('btnExpDetailBack').addEventListener('click', showCategoryView);

function populateExpVehiclePick(){
  const sel = document.getElementById('exp_vehicle_pick');
  const current = sel.value;
  const vOpts = db.vehicles.map(v=>`<option value="${v.id}">${v.reg} — ${v.make} ${v.model}</option>`).join('');
  sel.innerHTML = '<option value="">All expenses (fleet-wide + office)</option>' + vOpts +
    '<option value="OFFICE">— Office / General only —</option>';
  sel.value = current;
}
function showCategoryView(){
  document.querySelector('#expCatTable').closest('.table-wrap').style.display = '';
  document.getElementById('expDetailWrap').style.display = 'none';
}
/* Falls back to the ledger's own working period (db.period) rather than the
   browser's real-world "today" when the Expense Statement view has never been
   opened this session. Without this, ticking only the sidebar "Fuel report
   sheet" / "Expense report sheet" checkboxes and saving — without ever visiting
   the Expense Statement screen — silently exported fuel/expense totals for
   whatever the actual calendar date happened to be, not the month the file is
   actually working in. That's the bug behind wrong/empty Fuel sheet exports:
   the fuel expenses were always in the ledger, the report was just looking at
   the wrong date range. */
function expPeriodRangeVals(){
  const refEl = document.getElementById('exp_ref');
  const startEl = document.getElementById('exp_start');
  const endEl = document.getElementById('exp_end');
  const refVal = refEl ? refEl.value : '';
  const startVal = startEl ? startEl.value : '';
  if(!refVal && !startVal){
    ensurePeriod();
    return { start: new Date(db.period.start+'T00:00:00'), end: effectivePeriodEnd(db.period) };
  }
  return computePeriodRange(expPeriodType, refVal, startVal, endEl ? endEl.value : '');
}
function renderExpenseStatement(){
  const {start,end} = expPeriodRangeVals();
  document.getElementById('expPeriodLabel').textContent =
    'Showing: ' + start.toDateString() + '  →  ' + end.toDateString();

  const vid = document.getElementById('exp_vehicle_pick').value;
  const v = (vid && vid!=='OFFICE') ? db.vehicles.find(v=>v.id==vid) : null;
  let rows = db.expenses.filter(x=>inRange(x.date,start,end));
  if(vid==='OFFICE') rows = rows.filter(x=>!x.vehicleId);
  else if(vid) rows = rows.filter(x=>x.vehicleId==vid);
  const total = rows.reduce((s,x)=>s+x.amount,0);

  const scopeLabel = v ? v.reg+' — '+v.make+' '+v.model : (vid==='OFFICE' ? 'Office / General only' : 'Whole fleet (vehicles + office)');
  document.getElementById('expTotalCards').innerHTML = `
    <div class="card"><div class="label">Scope</div><div class="value" style="font-size:16px;">${scopeLabel}</div></div>
    <div class="card"><div class="label">Transactions</div><div class="value">${rows.length}</div></div>
    <div class="card"><div class="label">Total expenses</div><div class="value red">${fmt(total)}</div></div>`;

  const byCat = {};
  EXP_CATEGORIES.forEach(c=>byCat[c]={count:0,amount:0});
  rows.forEach(x=>{
    const cat = byCat[x.category] ? x.category : 'Other';
    byCat[cat].count++; byCat[cat].amount += x.amount;
  });
  document.getElementById('expCatHeading').textContent = (v ? v.reg+' — ' : (vid==='OFFICE' ? 'Office / General — ' : 'Fleet-wide — ')) + 'expense by category';

  const tb = document.querySelector('#expCatTable tbody'); tb.innerHTML = '';
  const cats = EXP_CATEGORIES.filter(c=>byCat[c].count>0).sort((a,b)=>byCat[b].amount-byCat[a].amount);
  if(!cats.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="4">No expenses in this period.</td></tr>'; return; }
  cats.forEach(cat=>{
    const d = byCat[cat];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${cat}</td><td class="num">${d.count}</td><td class="num">${fmt(d.amount)}</td>
      <td class="num">${total ? (d.amount/total*100).toFixed(1) : '0.0'}%</td>`;
    tr.addEventListener('click', ()=> showCategoryDetail(cat));
    tb.appendChild(tr);
  });
  renderFuelRecovery(start,end,vid);
}
function renderFuelRecovery(start,end,vid){
  let rows = db.expenses.filter(x=>x.category==='Fuel' && x.billable && inRange(x.date,start,end));
  if(vid) rows = rows.filter(x=>x.vehicleId==vid);
  const officeCost = rows.reduce((s,x)=>s+x.amount,0);
  const charged = rows.reduce((s,x)=>s+(x.chargeAmount||0),0);
  const net = charged - officeCost;
  document.getElementById('fuelRecoveryCards').innerHTML = `
    <div class="card"><div class="label">Fuel fronted for clients</div><div class="value">${fmt(officeCost)}</div></div>
    <div class="card"><div class="label">Charged to clients</div><div class="value amber">${fmt(charged)}</div></div>
    <div class="card"><div class="label">Net to office</div><div class="value ${net>=0?'green':'red'}">${fmt(net)}</div></div>`;

  const byClient = {};
  rows.forEach(x=>{
    const cid = x.billClientId;
    if(!byClient[cid]) byClient[cid] = {count:0, cost:0, charged:0};
    byClient[cid].count++; byClient[cid].cost += x.amount; byClient[cid].charged += (x.chargeAmount||0);
  });
  const tb = document.querySelector('#fuelRecoveryTable tbody'); tb.innerHTML = '';
  const cids = Object.keys(byClient);
  if(!cids.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="5">No client-billed fuel in this period.</td></tr>'; }
  else {
    cids.sort((a,b)=>byClient[b].charged-byClient[a].charged).forEach(cid=>{
      const c = db.clients.find(c=>c.id==cid);
      const d = byClient[cid];
      const n = d.charged - d.cost;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${c?c.name:'—'}</td><td class="num">${d.count}</td><td class="num">${fmt(d.cost)}</td>
        <td class="num">${fmt(d.charged)}</td><td class="num" style="color:${n>=0?'var(--green)':'var(--red)'}">${fmt(n)}</td>`;
      tb.appendChild(tr);
    });
  }

  const bySource = { rental:{count:0,cost:0,charged:0}, manual:{count:0,cost:0,charged:0} };
  rows.forEach(x=>{
    const key = x.source==='rental' ? 'rental' : 'manual';
    bySource[key].count++; bySource[key].cost += x.amount; bySource[key].charged += (x.chargeAmount||0);
  });
  const tb2 = document.querySelector('#fuelSourceTable tbody'); tb2.innerHTML = '';
  const srcRows = [['rental','Rental-linked (auto)'],['manual','Manual entry']].filter(([key])=>bySource[key].count>0);
  if(!srcRows.length){ tb2.innerHTML = '<tr class="empty-row"><td colspan="5">No client-billed fuel in this period.</td></tr>'; return; }
  srcRows.forEach(([key,label])=>{
    const d = bySource[key];
    const n = d.charged - d.cost;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td class="num">${d.count}</td><td class="num">${fmt(d.cost)}</td>
      <td class="num">${fmt(d.charged)}</td><td class="num" style="color:${n>=0?'var(--green)':'var(--red)'}">${fmt(n)}</td>`;
    tb2.appendChild(tr);
  });
}
function showCategoryDetail(cat){
  const {start,end} = expPeriodRangeVals();
  const vid = document.getElementById('exp_vehicle_pick').value;
  let rows = db.expenses.filter(x=>inRange(x.date,start,end) && (byCatMatch(x.category)===cat));
  if(vid==='OFFICE') rows = rows.filter(x=>!x.vehicleId);
  else if(vid) rows = rows.filter(x=>x.vehicleId==vid);
  rows.sort((a,b)=> a.date<b.date?-1:(a.date>b.date?1:0));

  document.querySelector('#expCatTable').closest('.table-wrap').style.display = 'none';
  document.getElementById('expDetailWrap').style.display = '';
  document.getElementById('expDetailHeading').textContent = cat + ' — ' + rows.length + ' transaction' + (rows.length!==1?'s':'') +
    (rows.length ? ' — total ' + fmt(rows.reduce((s,x)=>s+x.amount,0)) : '');

  const isFuel = cat === 'Fuel';
  document.querySelector('#expDetailTable thead tr').innerHTML =
    '<th>Date</th><th>Vehicle</th><th>Description</th><th class="num">Qty</th><th class="num">Amount</th>' +
    (isFuel ? '<th>Billed to</th><th class="num">Charged</th><th class="num">Net</th><th>Source</th>' : '');

  const tb = document.querySelector('#expDetailTable tbody'); tb.innerHTML = '';
  if(!rows.length){ tb.innerHTML = '<tr class="empty-row"><td colspan="'+(isFuel?9:5)+'">No transactions.</td></tr>'; return; }
  rows.forEach(x=>{
    const veh = db.vehicles.find(v=>v.id==x.vehicleId);
    let extra = '';
    if(isFuel){
      const rental = x.rentalId ? db.rentals.find(rr=>rr.id==x.rentalId) : null;
      const srcLabel = x.source==='rental' ? ('Rental' + (rental && rental.contract ? ' ('+rental.contract+')' : '')) : 'Manual';
      if(x.billable){
        const c = db.clients.find(c=>c.id==x.billClientId);
        const n = (x.chargeAmount||0) - x.amount;
        extra = `<td>${c?c.name:'—'}</td><td class="num">${fmt(x.chargeAmount||0)}</td>
          <td class="num" style="color:${n>=0?'var(--green)':'var(--red)'}">${fmt(n)}</td><td>${srcLabel}</td>`;
      } else {
        extra = `<td>—</td><td class="num">—</td><td class="num">—</td><td>${srcLabel}</td>`;
      }
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${x.date}</td><td>${veh?veh.reg:'—'}</td><td>${x.desc||'—'}</td>
      <td class="num">${x.qty||1}</td><td class="num">${fmt(x.amount)}</td>${extra}`;
    tb.appendChild(tr);
  });
}
function byCatMatch(rawCat){
  return EXP_CATEGORIES.includes(rawCat) ? rawCat : 'Other';
}

/* ---------- daily information + alerts ---------- */
function dateIsBetween(date,start,end){ return !!date && date>=start && date<=end; }
function getDailySummary(date){
  const rentals = db.rentals.filter(r=>r.status!=='Cancelled' && r.pickup===date);
  const revenue = rentals.reduce((s,r)=>s+(Number(r.amount)||0),0);
  const payments = db.payments.filter(p=>p.date===date).reduce((s,p)=>s+(Number(p.amount)||0),0);
  const expenses = db.expenses.filter(x=>x.date===date).reduce((s,x)=>s+(Number(x.amount)||0),0);
  const activeOnDate = db.rentals.filter(r=>r.status!=='Cancelled' && r.pickup<=date && r.return>=date);
  const dueBack = db.rentals.filter(r=>r.status==='Active' && r.return===date);
  const overdue = db.rentals.filter(r=>r.status==='Active' && r.return<date);
  const unavailable = db.vehicles.filter(v=>v.status==='Maintenance' || v.status==='Inactive').length;
  const available = db.vehicles.filter(v=>v.status==='Available').length;
  const bookings = db.bookings.filter(b=>b.bookedOn===date).length;
  const outstanding = rentals.reduce((s,r)=>s+owedForRental(r),0);
  return {rentals,revenue,payments,expenses,net:revenue-expenses,activeOnDate,dueBack,overdue,unavailable,available,bookings,outstanding};
}
function renderDailyInfo(){
  const date=document.getElementById('dailyInfoDate').value || toLocalISO(new Date()); dailyInfoDate=date;
  const x=getDailySummary(date), k=document.getElementById('dailyInfoKpis');
  const card=(label,value)=>`<div class="daily-kpi"><div class="k-label">${label}</div><div class="k-value">${value}</div></div>`;
  k.innerHTML=[card('Rental revenue',fmt(x.revenue)),card('Payments received',fmt(x.payments)),card('Outstanding',fmt(x.outstanding)),card('Expenses',fmt(x.expenses)),card('Net position',fmt(x.net)),card('Vehicles rented',x.activeOnDate.length),card('Vehicles available',x.available),card('Vehicles due back',x.dueBack.length),card('Overdue rentals',x.overdue.length),card('New bookings',x.bookings)].join('');
  const tb=document.querySelector('#dailyInfoRentalTable tbody'); tb.innerHTML='';
  if(!x.rentals.length){tb.innerHTML='<tr class="empty-row"><td colspan="8">No rentals picked up on this date.</td></tr>';return;}
  x.rentals.forEach(r=>{const v=db.vehicles.find(v=>v.id==r.vehicleId),c=db.clients.find(c=>c.id==r.clientId);const tr=document.createElement('tr');tr.innerHTML=`<td>${escapeHTML(v?v.reg:'—')}</td><td>${escapeHTML(c?c.name:'—')}</td><td>${escapeHTML(r.contract||'—')}</td><td>${escapeHTML(r.pickup||'—')}</td><td>${escapeHTML(r.return||'—')}</td><td>${escapeHTML(r.status||'—')}</td><td class="num">${fmt(r.amount)}</td><td class="num">${fmt(owedForRental(r))}</td>`;tb.appendChild(tr);});
}

/* Autonomous vehicle-status conflict guard.
   Active rental = Rented; no active rental = Available for operational vehicles.
   Maintenance/Inactive statuses are preserved. */
function reconcileVehicleRentalStatuses(){
  if(!db || !Array.isArray(db.vehicles) || !Array.isArray(db.rentals)) return [];
  const conflicts = [];
  db.vehicles.forEach(v=>{
    if(v.status==='Maintenance' || v.status==='Inactive') return;
    const active = db.rentals.find(r=>r.vehicleId==v.id && r.status==='Active');
    const shouldBe = active ? 'Rented' : 'Available';
    if(v.status !== shouldBe){
      conflicts.push({vehicleId:v.id, oldStatus:v.status, newStatus:shouldBe, rentalId:active?active.id:null});
      v.status = shouldBe;
    }
  });
  if(conflicts.length){
    markDirty();
  }
  return conflicts;
}

function runVehicleStatusIntegrityCheck(showNotice=false){
  const conflicts = reconcileVehicleRentalStatuses();
  if(showNotice && conflicts.length){
    const msg = `${conflicts.length} vehicle status conflict${conflicts.length===1?'':'s'} corrected automatically.`;
    if(typeof showToast==='function') showToast(msg);
  }
  return conflicts;
}

function buildAlerts(){
  reconcileVehicleRentalStatuses();
  const today=toLocalISO(new Date()), alerts=[];
  db.rentals.filter(r=>r.status==='Active' && r.return<today).forEach(r=>{const v=db.vehicles.find(v=>v.id==r.vehicleId);alerts.push({type:'overdue',title:'Overdue rental',text:`${v?v.reg:'Vehicle'} was due back on ${r.return}.`,panel:'rentals',id:r.id,go:'Open Rentals'});});
  db.rentals.filter(r=>r.status==='Active' && r.return===today).forEach(r=>{const v=db.vehicles.find(v=>v.id==r.vehicleId);alerts.push({type:'due',title:'Vehicle due back today',text:`${v?v.reg:'Vehicle'} is scheduled for return today.`,panel:'rentals',id:r.id,go:'Open Rentals'});});
  const available=db.vehicles.filter(v=>v.status==='Available').length;
  const totalOperational=db.vehicles.filter(v=>v.status!=='Inactive').length;
  const lowThreshold=totalOperational<=3?1:Math.max(1,Math.ceil(totalOperational*0.2));
  if(totalOperational>0 && available<=lowThreshold) alerts.push({type:'low',title:'Low vehicle availability',text:`Only ${available} vehicle${available===1?' is':'s are'} currently available.`,panel:'vehicles',id:null,go:'Open Vehicles'});
  db.rentals.filter(r=>r.status!=='Cancelled' && owedForRental(r)>0).forEach(r=>{const v=db.vehicles.find(v=>v.id==r.vehicleId),c=db.clients.find(c=>c.id==r.clientId);alerts.push({type:'payment',title:'Missing or outstanding payment',text:`${c?c.name:'Client'} · ${v?v.reg:'Vehicle'} has ${fmt(owedForRental(r))} outstanding.`,panel:'rentals',id:r.id,go:'Open Rentals'});});
  return alerts;
}
function jumpToAlertSource(a){
  const navBtn=document.querySelector(`.nav button[data-panel="${a.panel}"]`);
  if(navBtn) navBtn.click();
  const findTarget=()=>{
    let target=null;
    if(a.id!=null){
      target=document.querySelector(`#panel-${a.panel} [data-id="${a.id}"]`);
      if(target && target.tagName!=='TR') target=target.closest('tr') || target;
    }
    if(!target) target=document.querySelector(`#panel-${a.panel} table`);
    if(target){
      target.scrollIntoView({behavior:'smooth',block:'center'});
      const row=target.closest('tr') || target;
      const oldBg=row.style.background;
      const oldTransition=row.style.transition;
      row.style.transition='background .2s ease, box-shadow .2s ease';
      row.style.background='rgba(214,168,79,.16)';
      row.style.boxShadow='0 0 0 1px var(--amber), 0 0 22px rgba(214,168,79,.12)';
      setTimeout(()=>{row.style.background=oldBg;row.style.boxShadow='';row.style.transition=oldTransition;},2200);
    }
  };
  setTimeout(findTarget,80);
}
function renderAlerts(){
  const alerts=buildAlerts(), count=document.getElementById('alertCount'); if(count) count.textContent=alerts.length;
  const body=document.getElementById('alertsBody'); if(!body)return;
  body.innerHTML=alerts.length?alerts.map((a,i)=>`<div class="alert-item alert-clickable" data-alert-index="${i}" tabindex="0" role="button">
    <strong>${a.type==='overdue'?'🔴':a.type==='due'?'🟠':a.type==='low'?'🟡':'🔵'} ${escapeHTML(a.title)}</strong>
    <small>${escapeHTML(a.text)}</small>
    <span class="alert-go">↗ ${escapeHTML(a.go||'Open source')}</span>
  </div>`).join(''):'<div class="hint">No current alerts. Your fleet is clear for now.</div>';

  body.querySelectorAll('.alert-clickable').forEach(el=>{
    const activate=()=>{
      const a=alerts[Number(el.dataset.alertIndex)];
      if(!a) return;
      closeAlerts();
      jumpToAlertSource(a);
    };
    el.addEventListener('click',activate);
    el.addEventListener('keydown',e=>{
      if(e.key==='Enter' || e.key===' '){e.preventDefault();activate();}
    });
  });
}
function openDailyInfo(){const ov=document.getElementById('dailyInfoOverlay');ov.classList.add('show');ov.setAttribute('aria-hidden','false');document.getElementById('dailyInfoDate').value=dailyInfoDate;renderDailyInfo();}
function closeDailyInfo(){const ov=document.getElementById('dailyInfoOverlay');ov.classList.remove('show');ov.setAttribute('aria-hidden','true');}
function openAlerts(){const ov=document.getElementById('alertsOverlay');renderAlerts();ov.classList.add('show');ov.setAttribute('aria-hidden','false');}
function closeAlerts(){const ov=document.getElementById('alertsOverlay');ov.classList.remove('show');ov.setAttribute('aria-hidden','true');}
document.getElementById('btnDailyInfo').addEventListener('click',openDailyInfo);
document.getElementById('dailyInfoClose').addEventListener('click',closeDailyInfo);
document.getElementById('dailyInfoOverlay').addEventListener('click',e=>{if(e.target.id==='dailyInfoOverlay')closeDailyInfo();});
document.getElementById('dailyInfoDate').addEventListener('change',renderDailyInfo);
document.getElementById('dailyInfoToday').addEventListener('click',()=>{document.getElementById('dailyInfoDate').value=toLocalISO(new Date());renderDailyInfo();});
document.getElementById('btnAlerts').addEventListener('click',openAlerts);
document.getElementById('alertsClose').addEventListener('click',closeAlerts);
document.getElementById('alertsOverlay').addEventListener('click',e=>{if(e.target.id==='alertsOverlay')closeAlerts();});
document.getElementById('extractNoticeClose').addEventListener('click',closeExtractNotice);
document.getElementById('extractNoticeGotIt').addEventListener('click',closeExtractNotice);
document.getElementById('extractNoticeOverlay').addEventListener('click',e=>{if(e.target.id==='extractNoticeOverlay')closeExtractNotice();});

/* ---------- init ---------- */
function renderAll(){
  renderVehicles(); renderDrivers(); renderClients(); renderSelects();
  renderBookings(); renderRentals(); renderExpenses(); renderPayments();
  renderAllowances(); renderAllowanceSummary();
  renderDashboard(); renderReports(); renderFileStatus();
}
async function initializeApp(){
  await restoreLocalDatabase();
  resetPeriodToDataDefault();
  syncSheetCheckboxes();
  ensurePeriod();
  renderAll();
  renderAnalysis();
  checkMonthRollover();
}
initializeApp().catch(err=>{
  console.error('Could not initialize the local ledger:', err);
  ensurePeriod();
  syncSheetCheckboxes();
  renderAll();
  renderAnalysis();
  checkMonthRollover();
});
