/* Today: cars going out, cars due back or late, and bookings in the next few days. Built on calendarItems (the calendar's own reading of
   bookings and rentals); late rentals use the same rule as the Alerts (an Active rental whose return date has passed). */
import { calendarItems } from './calendar.js';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export function todayData(db, today, ahead = 5){
  const to = addDays(today, ahead), items = calendarItems(db, addDays(today, -400), to);
  const open = it => it.status !== 'Cancelled' && it.status !== 'Completed' && it.status !== 'Returned' && it.status !== 'Converted';
  const out = [], back = [], late = [], next = [];
  items.forEach(it => {
    if(it.kind === 'rental'){
      if(it.from === today && it.status !== 'Completed') out.push(it);
      if(it.status === 'Active'){ if(it.to === today) back.push(it); else if(it.to < today) late.push(Object.assign({ daysLate: daysBetween(it.to, today) }, it)); }
    }else if(it.kind === 'booking' && open(it)){
      if(it.from === today) out.push(it); else if(it.from > today && it.from <= to) next.push(it);
    }
  });
  const by = (a, b) => (a.from + a.reg) < (b.from + b.reg) ? -1 : 1;
  return { today, ahead, out: out.sort(by), back: back.sort(by), late: late.sort((a, b) => b.daysLate - a.daysLate), next: next.sort(by) };
}

export function renderToday(el, db, today, nav){
  const t = todayData(db, today), sec = (title, rows, line, empty) => '<div style="min-width:220px;flex:1;"><b>' + title + ' (' + rows.length + ')</b>'
    + (rows.length ? rows.map((r, i) => '<div class="watch-item" data-tdk="' + esc(title) + '" data-i="' + i + '" style="cursor:pointer;padding:5px 0;">' + line(r) + '</div>').join('') : '<div class="subtitle" style="margin:4px 0 0;">' + empty + '</div>') + '</div>';
  const kind = r => r.kind === 'booking' ? 'booking' : 'rental';
  const who = r => '<b>' + esc(r.reg) + '</b> · ' + esc(r.client);
  const groups = { 'Going out today': t.out, 'Due back today': t.back, 'Late': t.late }; groups['Bookings, next ' + t.ahead + ' days'] = t.next;
  el.innerHTML = '<div style="display:flex;gap:18px;flex-wrap:wrap;">'
    + sec('Going out today', t.out, r => who(r) + ' <span class="subtitle">' + kind(r) + '</span>', 'No car goes out today.')
    + sec('Due back today', t.back, r => who(r), 'Nothing due back today.')
    + sec('Late', t.late, r => who(r) + ' <span style="color:var(--red);">' + r.daysLate + ' day' + (r.daysLate > 1 ? 's' : '') + ' late</span>', 'No late returns.')
    + sec('Bookings, next ' + t.ahead + ' days', t.next, r => who(r) + ' <span class="subtitle">from ' + esc(r.from) + '</span>', 'No bookings coming up.') + '</div>';
  el.onclick = e => { const x = e.target.closest('[data-tdk]'); if(!x || !nav) return; const r = groups[x.dataset.tdk][Number(x.dataset.i)]; if(r) nav(r.kind === 'booking' ? 'bookings' : 'rentals', r.id); };
  return t;
}
