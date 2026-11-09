/* Rental duration and charge. Pure functions: no DOM, no database, so they can be tested alone.
   Default (mode 'auto'): same-day hire shows its hours and is charged as 1 day; a hire that
   crosses dates is charged by calendar days, counting the day taken and the day returned
   (taken 1st, returned 5th = 5 days). A vehicle can set its own default mode, and any single
   rental can override it. The charge is only a suggestion until the user edits the amount. */

export const BILL_MODES = [
  { key: 'auto',    label: 'Automatic (hours if same day, else calendar days)' },
  { key: 'elapsed', label: 'By time: full 24-hr blocks, extra hours past the grace count as a day' },
  { key: 'hours',   label: 'By the hour' },
  { key: 'days',    label: 'Fixed number of days (I enter it)' },
  { key: 'fixed',   label: 'Agreed total (I enter the amount)' }
];

const MS_HOUR = 3600000;

function parseTime(t){
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*$/i.exec(String(t == null ? '' : t));
  if(!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3] && m[3].toUpperCase();
  if(ap === 'PM' && h < 12) h += 12;
  if(ap === 'AM' && h === 12) h = 0;
  if(h > 23 || min > 59) return null;
  return h * 60 + min;
}
function dayNumber(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
}

/* How long the rental ran. { ok, sameDay, calendarDays, hours (null when a time is missing) } */
export function duration(r){
  const a = dayNumber(r.pickup), b = dayNumber(r.return);
  if(a === null || b === null || b < a) return { ok: false, sameDay: false, calendarDays: null, hours: null };
  const t1 = parseTime(r.pickupTime), t2 = parseTime(r.returnTime);
  let hours = null;
  if(t1 !== null && t2 !== null){
    hours = Math.round(((b - a) * 1440 + (t2 - t1)) / 60 * 10) / 10;
    if(hours < 0) hours = null;
  }
  return { ok: true, sameDay: a === b, calendarDays: b - a + 1, hours };
}

/* What mode applies: the rental's own choice, else the vehicle's, else automatic. */
export function modeFor(r, vehicle){
  return (r && r.billMode) || (vehicle && vehicle.billMode) || 'auto';
}

/* { mode, unit: 'day'|'hour'|'fixed', units, label, amount } for a rental.
   rate is the day rate (rental's own, else the vehicle's); hourly rate = vehicle.hourRate if set, else rate/24. */
export function charge(r, vehicle){
  const d = duration(r);
  const mode = modeFor(r, vehicle);
  const rate = Number(r.rate) || Number(vehicle && vehicle.rate) || 0;
  const grace = Number((vehicle && vehicle.billHours) || 12);
  const out = (unit, units, label) => ({ mode, unit, units, label, amount: unit === 'fixed' ? Number(r.amount) || 0 : Math.round(units * (unit === 'hour' ? (Number(vehicle && vehicle.hourRate) || rate / 24) : rate)) });
  if(mode === 'fixed') return { mode, unit: 'fixed', units: 1, label: 'agreed amount', amount: Number(r.amount) || 0 };
  if(mode === 'days')  { const n = Number(r.days) || 0; return out('day', n, n + ' day(s) entered'); }
  if(!d.ok) return { mode, unit: 'day', units: Number(r.days) || 0, label: 'dates missing', amount: Math.round((Number(r.days) || 0) * rate) };
  if(mode === 'hours'){
    if(d.hours === null) return { mode, unit: 'hour', units: 0, label: 'times missing', amount: 0 };
    return out('hour', d.hours, d.hours + ' hr');
  }
  if(mode === 'elapsed' && d.hours !== null){
    const full = Math.floor(d.hours / 24), extra = d.hours - full * 24;
    const n = Math.max(1, full + (extra > grace ? 1 : 0));
    return out('day', n, n + ' day(s) from ' + d.hours + ' hr');
  }
  // auto (also the fallback when elapsed has no times)
  if(d.sameDay) return out('day', 1, d.hours !== null ? d.hours + ' hr, same day (1 day)' : 'same day (1 day)');
  return out('day', d.calendarDays, d.calendarDays + ' day(s)');
}

/* Text such as "3 days 4 hrs" or "5 hrs" for the rentals list. */
export function durationText(r){
  const d = duration(r);
  if(!d.ok) return '';
  if(d.hours === null) return d.sameDay ? 'same day' : d.calendarDays + ' day(s)';
  const days = Math.floor(d.hours / 24), hrs = Math.round((d.hours - days * 24) * 10) / 10;
  return (days ? days + ' day' + (days > 1 ? 's' : '') + (hrs ? ' ' : '') : '') + (hrs || !days ? hrs + ' hr' + (hrs === 1 ? '' : 's') : '');
}
