/* Idle screen: when nobody has touched the app for a while (settings.idleMinutes, default 5, 0 = never), the opening splash
   (logo, MBADAVI INVESTMENT LIMITED, "Your Most Reliable Partner") fades in over the screen and stays until someone clicks, taps or types.
   It covers the admin area too: the moment it appears Pilot is locked again, so the PIN is asked for on return.

   - It appears once per idle period, wherever the user was (Pilot included), even if the page was in a background tab or the computer slept.
   - It fades in and out (no flash) and never restarts itself while it is up: the logo glows slowly instead.
   - Only a deliberate action dismisses it (click, tap, key, scroll, or a clear mouse movement). That action is swallowed, so a dismissing
     click or key press never lands on whatever is underneath (a button in Pilot, a field being typed in). */
export function initIdle(ctx){
  const DEFAULT_MIN = 5, CHECK_MS = 5000, FADE_IN_MS = 900, FADE_OUT_MS = 650, GRACE_MS = 1200, MOVE_PX = 60;
  let last = Date.now(), showing = false, overlay = null, shownAt = 0, startX = null, startY = null, checker = null, swallowUntil = 0, removeTimer = null;

  const logoNow = () => { const l = document.querySelector('#introSplash .intro-logo') || document.querySelector('.brand-badge img'); return l ? l.getAttribute('src') : ''; };
  const LOGO = logoNow();
  const minutes = () => { const s = (ctx.getDb() || {}).settings || {}; const m = s.idleMinutes; return m === undefined || m === null || m === '' ? DEFAULT_MIN : Math.max(0, Number(m) || 0); };

  function inner(){
    return `<img class="intro-logo" alt="Mbadavi Investment Limited" src="${LOGO || logoNow()}">
      <div class="intro-words"><span>MBADAVI</span><span>INVESTMENT</span><span>LIMITED</span></div>
      <div class="intro-motto"><span class="intro-line"></span><span>Your Most Reliable Partner</span><span class="intro-line right"></span></div>`;
  }
  function show(){
    if(showing) return;
    showing = true; shownAt = Date.now(); startX = startY = null;
    clearTimeout(removeTimer); const stale = document.getElementById('idleSplash'); if(stale) stale.remove();
    try{ if(document.activeElement && document.activeElement.blur) document.activeElement.blur(); }catch(e){}   // a key press must not land in a field under the screen
    try{ if(ctx.lockAdmin) ctx.lockAdmin(); }catch(e){ console.warn('lockAdmin failed:', e); }
    overlay = document.createElement('div'); overlay.id = 'idleSplash'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Idle screen. Click or press a key to continue.');
    overlay.innerHTML = inner(); document.body.appendChild(overlay);
    void overlay.offsetWidth;                                   // let the browser paint the hidden state, so the fade-in really animates
    overlay.classList.add('on');
  }
  function hide(){
    if(!showing) return;
    showing = false; last = Date.now(); swallowUntil = Date.now() + 450;
    const o = overlay; overlay = null;
    if(o){ o.classList.remove('on'); o.classList.add('off'); removeTimer = setTimeout(() => o.remove(), FADE_OUT_MS + 80); }
  }
  function activity(e){
    if(showing){
      if(Date.now() - shownAt < GRACE_MS) return;               // the tail of what the person was doing when it appeared
      if(e.type === 'mousemove'){
        if(startX === null){ startX = e.clientX; startY = e.clientY; return; }
        if(Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < MOVE_PX) return;     // a nudge of the table is not a decision
      }
      if(BLOCKING.includes(e.type)){ if(e.cancelable) e.preventDefault(); e.stopPropagation(); }
      hide(); return;
    }
    if(Date.now() < swallowUntil && BLOCKING.includes(e.type)){ if(e.cancelable) e.preventDefault(); e.stopPropagation(); return; }
    last = Date.now();
  }
  const BLOCKING = ['mousedown', 'keydown', 'pointerdown'];       // these can be cancelled; scroll-type events stay passive so scrolling is never slowed
  ['mousemove', 'touchstart', 'wheel'].forEach(ev => window.addEventListener(ev, activity, { passive: true, capture: true }));
  BLOCKING.forEach(ev => window.addEventListener(ev, activity, { passive: false, capture: true }));
  ['click', 'mouseup', 'pointerup', 'keyup', 'touchend'].forEach(ev => window.addEventListener(ev, e => {
    if(showing || Date.now() < swallowUntil){ if(e.cancelable) e.preventDefault(); e.stopPropagation(); }
  }, { capture: true }));

  function check(){
    const m = minutes(), now = Date.now();
    if(now < last) last = now;                                  // the clock moved back: start counting again
    if(m > 0 && !showing && now - last >= m * 60000) show();
  }
  function start(){ clearInterval(checker); checker = setInterval(check, CHECK_MS); }
  document.addEventListener('visibilitychange', () => { if(!document.hidden) check(); });   // a background tab or a sleeping computer is checked the moment it is back
  start();
  return { restart(){ last = Date.now(); start(); }, show, hide, check, isShowing: () => showing };
}
