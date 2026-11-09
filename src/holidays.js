/* Kenyan public holidays for any year (Public Holidays Act). Pure functions, no DOM.

   Fixed days: New Year, Labour Day, Madaraka Day, 10 October (Mazingira Day; Utamaduni Day before 2025),
   Mashujaa Day, Jamhuri Day, Christmas, Boxing Day.
   Moving days: Good Friday and Easter Monday (worked out from Easter), Idd-ul-Fitr and Idd-ul-Azha (from the Islamic calendar).
   Rule: a holiday that falls on a Sunday is observed on the Monday after (and the Monday moves on again if it is a holiday too).

   The Idd days depend on the moon and the government announces them shortly before. We start from the Umm al-Qura
   calendar (which matches 20 March and 27 May in 2026) and mark them "provisional"; the admin can correct any
   date once announced with holidayFixes = { 'idd-fitr-2027': '2027-03-11' }. */

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const isoOf = dt => iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
const plusDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = utc(y, m, d); dt.setUTCDate(dt.getUTCDate() + n); return isoOf(dt); };
const weekday = s => { const [y, m, d] = s.split('-').map(Number); return utc(y, m, d).getUTCDay(); };   // 0 = Sunday
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* Easter Sunday (Meeus/Jones/Butcher). */
export function easterSunday(y){
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

/* Islamic dates inside Gregorian year y: returns the Gregorian dates of (hMonth, hDay).
   Uses the Umm al-Qura calendar from Intl; falls back to the tabular civil calendar if the browser lacks it. */
let umalquraOk = null;
function umalquraFormatter(){
  if(umalquraOk === false) return null;
  try{ const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
    const p = f.formatToParts(utc(2026, 3, 20)); const mo = p.find(x => x.type === 'month');
    if(!mo || Number(mo.value) !== 10) throw new Error('unexpected'); umalquraOk = true; return f; }
  catch(e){ umalquraOk = false; return null; }
}
function tabularIslamic(dt){   // civil tabular calendar -> {m, d}
  const jd = Math.floor(dt.getTime() / 86400000) + 2440588;   // Julian day number at 0h UTC + .5 handled by floor
  const l = jd - 1948440 + 10632, n = Math.floor((l - 1) / 10631), l2 = l - 10631 * n + 354;
  const j = (Math.floor((10985 - l2) / 5316)) * (Math.floor((50 * l2) / 17719)) + (Math.floor(l2 / 5670)) * (Math.floor((43 * l2) / 15238));
  const l3 = l2 - (Math.floor((30 - j) / 15)) * (Math.floor((17719 * j) / 50)) - (Math.floor(j / 16)) * (Math.floor((15238 * j) / 43)) + 29;
  const m = Math.floor((24 * l3) / 709), d = l3 - Math.floor((709 * m) / 24);
  return { m, d };
}
export function islamicInGregorianYear(y, hMonth, hDay){
  const f = umalquraFormatter(), out = [];
  for(let dt = utc(y, 1, 1); dt.getUTCFullYear() === y; dt.setUTCDate(dt.getUTCDate() + 1)){
    let m, d;
    if(f){ const p = f.formatToParts(dt); m = Number(p.find(x => x.type === 'month').value); d = Number(p.find(x => x.type === 'day').value); }
    else { const t = tabularIslamic(dt); m = t.m; d = t.d; }
    if(m === hMonth && d === hDay) out.push(isoOf(dt));
  }
  return out;
}

/* All holidays in a year, in date order. fixes: { id: 'YYYY-MM-DD' } replaces the computed date of a moving holiday
   (set the value to 'removed' to drop it). Each item: { id, date, name, provisional, observedFor }. */
export function kenyaHolidays(year, fixes = {}){
  const base = [];
  const add = (id, date, name, extra) => base.push(Object.assign({ id, date, name, provisional: false, observedFor: '' }, extra || {}));
  add('new-year-' + year, iso(year, 1, 1), "New Year's Day");
  const easter = easterSunday(year);
  add('good-friday-' + year, plusDays(easter, -2), 'Good Friday');
  add('easter-monday-' + year, plusDays(easter, 1), 'Easter Monday');
  islamicInGregorianYear(year, 10, 1).forEach((d, i) => add('idd-fitr-' + year + (i ? '-' + (i + 1) : ''), d, 'Idd-ul-Fitr', { provisional: true }));
  if(year >= 2025) islamicInGregorianYear(year, 12, 10).forEach((d, i) => add('idd-azha-' + year + (i ? '-' + (i + 1) : ''), d, 'Idd-ul-Azha', { provisional: true }));
  add('labour-' + year, iso(year, 5, 1), 'Labour Day');
  add('madaraka-' + year, iso(year, 6, 1), 'Madaraka Day');
  add('oct10-' + year, iso(year, 10, 10), year >= 2025 ? 'Mazingira Day' : 'Utamaduni Day');
  add('mashujaa-' + year, iso(year, 10, 20), 'Mashujaa Day');
  add('jamhuri-' + year, iso(year, 12, 12), 'Jamhuri Day');
  add('christmas-' + year, iso(year, 12, 25), 'Christmas Day');
  add('boxing-' + year, iso(year, 12, 26), 'Boxing Day');

  const kept = [];
  base.forEach(h => {
    const fx = fixes && fixes[h.id];
    if(fx === 'removed') return;
    if(fx && /^\d{4}-\d{2}-\d{2}$/.test(fx)){ h.date = fx; h.corrected = true; h.provisional = false; }
    kept.push(h);
  });
  /* Sunday -> the Monday after; if that Monday is already a holiday, the next free day */
  const taken = new Set(kept.map(h => h.date));
  const extra = [];
  kept.slice().sort((a, b) => a.date < b.date ? -1 : 1).forEach(h => {
    if(weekday(h.date) !== 0) return;
    let d = plusDays(h.date, 1);
    while(taken.has(d)) d = plusDays(d, 1);
    taken.add(d);
    extra.push({ id: h.id + '-observed', date: d, name: h.name + ' (observed)', provisional: h.provisional, observedFor: h.date });
  });
  return kept.concat(extra).sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
}

/* date -> holiday (first one wins) for a span of years, e.g. 2026-2030. */
export function holidayMap(fromYear, toYear, fixes){
  const map = new Map();
  for(let y = fromYear; y <= toYear; y++) kenyaHolidays(y, fixes).forEach(h => { if(!map.has(h.date)) map.set(h.date, h); });
  return map;
}
