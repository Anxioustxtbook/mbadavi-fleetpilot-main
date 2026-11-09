/* Booking calendar: a month grid with a thin line per car (its own colour) for every booking and rental,
   a car drop-down (one car or all), Free / Booked per day, and Kenyan public holidays for any year.
   The pure helpers at the top are used by the tests; initCalendar() draws into #panel-calendar. */
import { kenyaHolidays, holidayMap, DAY_NAMES } from './holidays.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d);
const todayIso = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); };

/* A stable colour per registration: the same car always gets the same line colour. */
export function vehicleColor(db, vehicleId){
  const ids = [...(db.vehicles || [])].map(v => v.id).sort((a, b) => a - b);
  const i = Math.max(0, ids.findIndex(id => id == vehicleId));
  return 'hsl(' + Math.round((i * 137.508) % 360) + ' 74% 58%)';
}

/* Every booking / rental that touches [from, to] (ISO dates), optionally for one car. */
export function calendarItems(db, from, to, opts = {}){
  const vid = opts.vehicleId || null, out = [];
  const reg = id => { const v = (db.vehicles || []).find(v => v.id == id); return v ? v.reg : '—'; };
  const cli = id => { const c = (db.clients || []).find(c => c.id == id); return c ? c.name : '—'; };
  const take = (kind, r, a, b) => { if(!a || !b || r.status === 'Cancelled' || (vid && r.vehicleId != vid)) return; const end = b < a ? a : b; if(end < from || a > to) return;
    out.push({ kind, id: r.id, vehicleId: r.vehicleId, reg: reg(r.vehicleId), client: cli(r.clientId), from: a, to: end, status: r.status }); };
  if(opts.bookings !== false) (db.bookings || []).forEach(b => take('booking', b, b.pickup, b.return));
  if(opts.rentals !== false) (db.rentals || []).forEach(r => take('rental', r, r.pickup, r.return));
  return out;
}
export const coversDay = (it, day) => it.from <= day && day <= it.to;

/* For one car over a month: how many days are booked and how many are free. */
export function carMonthSummary(db, vehicleId, year, month, opts = {}){
  const last = new Date(year, month + 1, 0).getDate();
  const items = calendarItems(db, iso(year, month, 1), iso(year, month, last), Object.assign({}, opts, { vehicleId }));
  let booked = 0; const freeDays = [];
  for(let d = 1; d <= last; d++){ const day = iso(year, month, d); if(items.some(it => coversDay(it, day))) booked++; else freeDays.push(day); }
  return { booked, free: last - booked, freeDays, items: items.length };
}

export function initCalendar(ctx){
  const root = document.getElementById('panel-calendar');
  const now = new Date();
  const st = { year: now.getFullYear(), month: now.getMonth(), vehicleId: '', bookings: true, rentals: false, selected: todayIso() };
  const db = () => ctx.getDb();
  const fixes = () => (db().settings && db().settings.holidayFixes) || {};

  function grid(){
    const d = db(), hol = holidayMap(st.year - 1, st.year + 1, fixes());
    const first = new Date(st.year, st.month, 1), lead = (first.getDay() + 6) % 7;           // Monday first
    const last = new Date(st.year, st.month + 1, 0).getDate(), cells = Math.ceil((lead + last) / 7) * 7;
    const start = new Date(st.year, st.month, 1 - lead), end = new Date(start); end.setDate(start.getDate() + cells - 1);
    const from = iso(start.getFullYear(), start.getMonth(), start.getDate()), to = iso(end.getFullYear(), end.getMonth(), end.getDate());
    const items = calendarItems(d, from, to, { vehicleId: st.vehicleId, bookings: st.bookings, rentals: st.rentals });
    const today = todayIso(), oneCar = !!st.vehicleId;
    let html = '<div class="cal-grid">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => `<div class="cal-dow">${n}</div>`).join('');
    for(let i = 0; i < cells; i++){
      const dt = new Date(start); dt.setDate(start.getDate() + i);
      const day = iso(dt.getFullYear(), dt.getMonth(), dt.getDate()), inMonth = dt.getMonth() === st.month, wd = dt.getDay();
      const h = hol.get(day), todays = items.filter(it => coversDay(it, day));
      /* one thin line per car and kind, even when a car has two entries on the day */
      const seen = new Set(), lines = [];
      todays.forEach(it => { const k = it.vehicleId + '|' + it.kind; if(seen.has(k)) return; seen.add(k); lines.push(it); });
      const shown = lines.slice(0, 8), more = lines.length - shown.length;
      const bars = shown.map(it => `<span class="cal-line ${it.kind}" style="--c:${vehicleColor(d, it.vehicleId)}" title="${esc(it.reg + ' · ' + it.client + ' · ' + it.from + ' to ' + it.to + ' · ' + (it.kind === 'booking' ? 'booking ' : 'rental ') + it.status)}"></span>`).join('');
      const tag = oneCar ? (todays.length ? '<span class="cal-state booked">Booked</span>' : '<span class="cal-state free">Free</span>') : '';
      html += `<button type="button" class="cal-day ${inMonth ? '' : 'out'} ${wd === 0 || wd === 6 ? 'wkend' : ''} ${h ? 'holiday' : ''} ${day === today ? 'today' : ''} ${day === st.selected ? 'sel' : ''}" data-cal="day" data-day="${day}">
        <span class="cal-n">${dt.getDate()}</span>${h ? `<span class="cal-hol" title="${esc(h.name + (h.provisional ? ' (date to be confirmed)' : ''))}">${esc(h.name)}</span>` : ''}${tag}<span class="cal-lines">${bars}${more > 0 ? `<span class="cal-more">+${more}</span>` : ''}</span></button>`;
    }
    return html + '</div>';
  }

  function dayPanel(){
    const d = db(), day = st.selected; if(!day) return '';
    const hol = holidayMap(st.year - 1, st.year + 1, fixes()).get(day) || holidayMap(Number(day.slice(0, 4)), Number(day.slice(0, 4)), fixes()).get(day);
    const items = calendarItems(d, day, day, { vehicleId: st.vehicleId, bookings: st.bookings, rentals: st.rentals }).filter(it => coversDay(it, day));
    const wd = DAY_NAMES[new Date(day + 'T00:00:00').getDay()];
    const busy = new Set(calendarItems(d, day, day, { bookings: true, rentals: true }).filter(it => coversDay(it, day)).map(it => String(it.vehicleId)));
    const cars = [...(d.vehicles || [])].sort((a, b) => a.reg < b.reg ? -1 : 1);
    const free = cars.filter(v => !busy.has(String(v.id)));
    const car = st.vehicleId ? cars.find(v => v.id == st.vehicleId) : null;
    const list = items.map(it => `<li><span class="cal-dot" style="background:${vehicleColor(d, it.vehicleId)}"></span><b>${esc(it.reg)}</b> · ${esc(it.client)} · ${esc(it.from)} → ${esc(it.to)} · ${it.kind === 'booking' ? 'booking' : 'rental'} (${esc(it.status)})
      <button type="button" class="row-edit" data-cal="open" data-kind="${it.kind}" data-id="${it.id}">Open ↗</button></li>`).join('');
    const bookable = !car || !busy.has(String(car.id));
    return `<div class="table-wrap cal-day-panel"><div class="table-head"><h3>${wd} ${esc(day)}${hol ? ' · <span style="color:var(--amber);">' + esc(hol.name) + (hol.provisional ? ' (date to be confirmed)' : '') + '</span>' : ''}</h3></div>
      <div style="padding:6px 16px 14px;">
        ${car ? `<p style="margin:4px 0 8px;"><b>${esc(car.reg)}</b> is <b style="color:var(--${busy.has(String(car.id)) ? 'red' : 'green'});">${busy.has(String(car.id)) ? 'booked' : 'free'}</b> on this day.</p>` : `<p style="margin:4px 0 8px;"><b>${free.length}</b> of ${cars.length} cars are free on this day${free.length ? ' (' + free.slice(0, 12).map(v => esc(v.reg)).join(', ') + (free.length > 12 ? ', …' : '') + ')' : ''}.</p>`}
        ${list ? `<ul class="cal-list">${list}</ul>` : '<p class="subtitle" style="margin:0 0 8px;">Nothing booked or out on this day' + (car ? ' for this car.' : '.') + '</p>'}
        ${bookable ? `<button type="button" class="btn primary" data-cal="book" style="width:auto;padding:8px 16px;">+ Book for this day${car ? ' (' + esc(car.reg) + ')' : ''}</button>` : '<span class="subtitle">This car is already taken on this day.</span>'}
      </div></div>`;
  }

  function holidayList(){
    const hs = kenyaHolidays(st.year, fixes());
    return `<div class="table-wrap"><div class="table-head"><h3>Kenyan public holidays ${st.year}</h3></div><div style="padding:4px 14px 12px;">
      ${hs.map(h => { const dt = new Date(h.date + 'T00:00:00'); return `<div class="cal-hrow ${h.date.slice(0, 7) === iso(st.year, st.month, 1).slice(0, 7) ? 'thism' : ''}"><div><b>${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}</b> <span class="subtitle" style="margin:0;">${DAY_NAMES[dt.getDay()].slice(0, 3)}</span> · ${esc(h.name)}
        ${h.provisional && !h.corrected ? ` <span title="The Idd dates depend on the moon sighting. Correct the date here once it is announced." style="color:var(--amber);">⚠ confirm</span>` : ''}${h.corrected ? ' <span style="color:var(--green);">✓ corrected</span>' : ''}</div>
        ${/^idd-/.test(h.id) && !/observed/.test(h.id) ? `<div><input type="date" value="${h.date}" data-cal-fix="${h.id}" style="width:150px;">${h.corrected ? ` <button type="button" class="row-edit" data-cal="resetfix" data-id="${h.id}">reset</button>` : ''}</div>` : ''}</div>`; }).join('')}
      <p class="subtitle" style="margin:10px 0 0;">A holiday on a Sunday is observed on the Monday after. Idd dates are estimates until announced.</p></div></div>`;
  }

  function render(){
    const d = db(), cars = [...(d.vehicles || [])].sort((a, b) => a.reg < b.reg ? -1 : 1);
    const years = []; for(let y = now.getFullYear() - 1; y <= now.getFullYear() + 9; y++) years.push(y);
    let summary = '';
    if(st.vehicleId){ const s = carMonthSummary(d, st.vehicleId, st.year, st.month, { bookings: st.bookings, rentals: st.rentals }), car = cars.find(v => v.id == st.vehicleId);
      summary = `<p class="subtitle" style="margin:6px 0 10px;"><b>${esc(car ? car.reg : '')}</b> in ${MONTHS[st.month]} ${st.year}: <b>${s.booked}</b> day${s.booked === 1 ? '' : 's'} booked, <b>${s.free}</b> free.${s.booked === 0 ? ' No booking this month.' : ''}</p>`; }
    /* legend: the cars that appear this month */
    const lastDay = new Date(st.year, st.month + 1, 0).getDate();
    const monthItems = calendarItems(d, iso(st.year, st.month, 1), iso(st.year, st.month, lastDay), { vehicleId: st.vehicleId, bookings: st.bookings, rentals: st.rentals });
    const seen = new Map(); monthItems.forEach(it => seen.set(it.vehicleId, it.reg));
    const legend = [...seen.entries()].sort((a, b) => a[1] < b[1] ? -1 : 1).slice(0, 40).map(([id, reg]) => `<span class="cal-leg"><i style="background:${vehicleColor(d, id)}"></i>${esc(reg)}</span>`).join('');
    root.innerHTML = `<h1>Calendar</h1><p class="subtitle">Bookings and rentals by car, with Kenyan public holidays. Each coloured line is one car.</p>
      <div class="cal-bar-top">
        <button type="button" class="btn" data-cal="prev" style="width:auto;padding:8px 12px;">‹</button>
        <h2 class="cal-title">${MONTHS[st.month]} ${st.year}</h2>
        <button type="button" class="btn" data-cal="next" style="width:auto;padding:8px 12px;">›</button>
        <select data-cal-set="year" style="width:auto;">${years.map(y => `<option ${y === st.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button type="button" class="btn" data-cal="today" style="width:auto;padding:8px 12px;">Today</button>
        <select data-cal-set="vehicleId" style="width:auto;max-width:200px;"><option value="">All cars</option>${cars.map(v => `<option value="${v.id}" ${String(st.vehicleId) === String(v.id) ? 'selected' : ''}>${esc(v.reg)}</option>`).join('')}</select>
        <label class="fm-check" style="margin:0;"><input type="checkbox" data-cal-set="bookings" ${st.bookings ? 'checked' : ''}><span>Bookings</span></label>
        <label class="fm-check" style="margin:0;"><input type="checkbox" data-cal-set="rentals" ${st.rentals ? 'checked' : ''}><span>Rentals (cars out)</span></label>
        <button type="button" class="btn" data-cal="tobookings" style="width:auto;padding:8px 12px;margin-left:auto;">← Bookings list</button>
      </div>${summary}
      <div class="cal-layout"><div>${grid()}<div class="cal-legend">${legend || '<span class="subtitle">No bookings this month.</span>'}${legend ? '<span class="cal-leg"><i class="solid"></i>booking</span><span class="cal-leg"><i class="striped"></i>rental (car out)</span>' : ''}</div>${dayPanel()}</div><div>${holidayList()}</div></div>`;
  }

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-cal]'); if(!t) return;
    const a = t.dataset.cal;
    if(a === 'prev'){ st.month--; if(st.month < 0){ st.month = 11; st.year--; } }
    else if(a === 'next'){ st.month++; if(st.month > 11){ st.month = 0; st.year++; } }
    else if(a === 'today'){ st.year = now.getFullYear(); st.month = now.getMonth(); st.selected = todayIso(); }
    else if(a === 'day'){ st.selected = t.dataset.day; const dt = new Date(st.selected + 'T00:00:00'); if(dt.getMonth() !== st.month){ st.month = dt.getMonth(); st.year = dt.getFullYear(); } }
    else if(a === 'book'){ ctx.nav.newBooking({ vehicleId: st.vehicleId, date: st.selected }); return; }
    else if(a === 'open'){ ctx.nav.openRecord({ panel: t.dataset.kind === 'booking' ? 'bookings' : 'rentals', id: Number(t.dataset.id) || t.dataset.id }); return; }
    else if(a === 'tobookings'){ document.querySelector('.nav button[data-panel="bookings"]').click(); return; }
    else if(a === 'resetfix'){ const f = db().settings.holidayFixes || {}; delete f[t.dataset.id]; db().settings.holidayFixes = f; ctx.markDirty(); }
    render();
  });
  root.addEventListener('change', e => {
    const fix = e.target.closest('[data-cal-fix]');
    if(fix){ const s = db().settings = db().settings || {}; s.holidayFixes = s.holidayFixes || {}; if(fix.value) s.holidayFixes[fix.dataset.calFix] = fix.value; ctx.markDirty(); ctx.toast('Holiday date updated'); render(); return; }
    const t = e.target.closest('[data-cal-set]'); if(!t) return;
    const k = t.dataset.calSet;
    if(k === 'year') st.year = Number(t.value); else if(k === 'vehicleId'){ st.vehicleId = t.value; st.rentals = !!t.value; } else st[k] = t.checked;
    render();
  });
  return { render, show: o => { if(o && o.vehicleId !== undefined) st.vehicleId = o.vehicleId; if(o && o.date){ st.selected = o.date; st.year = Number(o.date.slice(0, 4)); st.month = Number(o.date.slice(5, 7)) - 1; } render(); }, state: st };
}
