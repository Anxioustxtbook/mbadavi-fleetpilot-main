/* Error handling for the whole app.
   - Any error nobody caught (a screen that fails to draw, a promise that fails) is shown in a red bar at the bottom, in plain words, with whether your last change is saved.
     The app keeps running; nothing is thrown away.
   - The last 30 problems are kept in memory and can be copied with the bar's "Copy details" button, so a problem can be reported exactly.
   - The same problem repeating is shown once, not on every redraw.
   - safe(name, fn) runs one screen's drawing on its own: if the Rentals table fails, Payments, Dashboard and the rest still draw. */
const MAX = 30, QUIET_MS = 20000;
const IGNORE = /ResizeObserver loop|^Script error\.?$|Non-Error promise rejection/i;
const seen = new Map(); let sink = null, queue = [], history = [];
const msgOf = e => String((e && e.message) || e || 'Unknown problem').replace(/\s+/g, ' ').slice(0, 240);

export function report(kind, err, where){
  const msg = msgOf(err); if(IGNORE.test(msg)) return;
  const key = kind + '|' + (where || '') + '|' + msg, t = Date.now();
  console.error('[FleetPilot]', kind, where || '', err);
  if(seen.has(key) && t - seen.get(key) < QUIET_MS) return;
  seen.set(key, t);
  history.push({ at: new Date(t).toISOString(), kind, where: where || '', msg, stack: String(err && err.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400) });
  if(history.length > MAX) history = history.slice(-MAX);
  if(sink) sink({ kind, where, msg }); else queue.push({ kind, where, msg });
}
/* ledger.js says how to show a bar and how to find out whether the last change is saved */
export function connect(fn){ sink = fn; queue.splice(0).forEach(fn); }
export const recent = () => history.slice();
export const detailsText = () => history.map(x => `${x.at}  ${x.kind}${x.where ? ' (' + x.where + ')' : ''}: ${x.msg}${x.stack ? '\n    ' + x.stack : ''}`).join('\n') || 'No problems recorded.';
/* draw one screen on its own; returns false when it failed */
export function safe(name, fn){ try{ fn(); return true; }catch(err){ report('screen', err, name); return false; } }

if(typeof window !== 'undefined'){
  window.addEventListener('error', e => report('error', e.error || e.message, e.filename ? String(e.filename).split('/').pop() + ':' + e.lineno : ''));
  window.addEventListener('unhandledrejection', e => report('promise', e.reason, ''));
  window.fleetErrors = { report, recent, detailsText, safe };
}
