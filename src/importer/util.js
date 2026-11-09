/* Shared helpers for the Excel importer. Pure functions only - no DOM, no ExcelJS.
   Every sheet is handed in as an array of rows, every row an array of cells (0-based).
   Cells may be Date, number, string, or an ExcelJS object ({formula,result}, {richText}, ...). */

const MONTH_ALIASES = {
  JAN:0, JANUARY:0, FEB:1, FEBUARY:1, FEBRUARY:1, MAR:2, MARCH:2, APR:3, APRIL:3, MAY:4,
  JUN:5, JUNE:5, JUL:6, JULY:6, AUG:7, AUGUST:7, SEP:8, SEPT:8, SEPTEMBER:8,
  OCT:9, OCTOBER:9, NOV:10, NOVEMBER:10, DEC:11, DECEMBER:11
};
export const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* Month number (0-11) for a heading such as "JANUARY", "FEBUARY", "DEC"; -1 if it is not a month. */
export function monthIndex(text){
  const t = String(text == null ? '' : text).trim().toUpperCase().replace(/[^A-Z]/g, '');
  return Object.prototype.hasOwnProperty.call(MONTH_ALIASES, t) ? MONTH_ALIASES[t] : -1;
}

/* Turn whatever a cell holds into a plain value: Date | number | string | null. */
export function plain(v){
  if(v === undefined || v === null) return null;
  if(v instanceof Date) return isNaN(v) ? null : v;
  if(typeof v === 'object'){
    if('$d' in v) return new Date(v.$d);          // test fixtures
    if('$t' in v) return v.$t;
    if('result' in v) return plain(v.result);     // ExcelJS formula cell
    if(Array.isArray(v.richText)) return plain(v.richText.map(t=>t.text).join(''));
    if('text' in v) return plain(v.text);
    return null;                                    // errors, unknown objects
  }
  if(typeof v === 'string'){ const s = v.replace(/\s+/g, ' ').trim(); return s === '' ? null : s; }
  return v;
}

export function plainRows(rows){ return (rows || []).map(r => (r || []).map(plain)); }

export const isNum = v => typeof v === 'number' && isFinite(v);
export const isDate = v => v instanceof Date;
export const isStr = v => typeof v === 'string';
export const num = v => isNum(v) ? v : (isStr(v) && /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')) ? Number(v.replace(/,/g, '')) : null);

export function pad2(n){ return String(n).padStart(2, '0'); }
export function iso(d){ return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
export function isoFromParts(y, m, d){ return y + '-' + pad2(m + 1) + '-' + pad2(d); }
export function parseIso(s){ const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
export function addDays(isoStr, n){ const d = parseIso(isoStr); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
export function diffDays(a, b){ return Math.round((parseIso(b) - parseIso(a)) / 86400000); }
export function daysInMonth(y, m){ return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
export function monthKey(isoStr){ return isoStr.slice(0, 7); }

/* A date cell -> 'YYYY-MM-DD', or null when the cell is not a real date. Text such as
   "2026-01-03" or "03/01/2026" is accepted; anything else (e.g. "1ST-9TH") is not. */
export function dateOf(v){
  v = plain(v);
  if(isDate(v)) return iso(v);
  if(isStr(v)){
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m) return isoFromParts(+m[1], +m[2] - 1, +m[3]);
    m = v.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
    if(m) return isoFromParts(+m[3], +m[2] - 1, +m[1]);
  }
  return null;
}

/* "7:00AM", "7:30PM", "19:00" or an Excel time -> 'HH:MM'. */
export function timeOf(v){
  v = plain(v);
  if(isDate(v)) return pad2(v.getUTCHours()) + ':' + pad2(v.getUTCMinutes());
  if(isNum(v) && v >= 0 && v < 1){ const mins = Math.round(v * 1440); return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }
  if(!isStr(v)) return '';
  const m = v.toUpperCase().replace(/\s/g, '').match(/^(\d{1,2})[:.]?(\d{2})?(AM|PM)?$/);
  if(!m) return '';
  let h = +m[1]; const mi = +(m[2] || 0);
  if(m[3] === 'PM' && h < 12) h += 12;
  if(m[3] === 'AM' && h === 12) h = 0;
  if(h > 23 || mi > 59) return '';
  return pad2(h) + ':' + pad2(mi);
}

/* "1ST-9TH", "20TH-1ST", "26TH-31TH", "7TH", "22ND-24TH" in the context of a month.
   Returns {start,end} as ISO strings, or null. A range that runs backwards (20TH-1ST)
   crosses into the next month. */
export function parseDayRange(text, year, month){
  if(!isStr(text)) return null;
  const nums = (text.toUpperCase().match(/\d{1,2}(?=\s*(ST|ND|RD|TH))/g) || []).map(Number);
  if(!nums.length || nums.length > 2) return null;
  const d1 = nums[0], d2 = nums.length === 2 ? nums[1] : nums[0];
  if(d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) return null;
  const start = isoFromParts(year, month, Math.min(d1, daysInMonth(year, month)));
  let ey = year, em = month;
  if(d2 < d1){ em = month + 1; if(em > 11){ em = 0; ey++; } }
  const end = isoFromParts(ey, em, Math.min(d2, daysInMonth(ey, em)));
  return { start, end };
}

/* Vehicle registration: "kdu  714h" -> "KDU 714H". */
export function normReg(v){
  v = plain(v);
  if(!isStr(v)) return '';
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]{3})(\d{3}[A-Z]?)$/, '$1 $2') || v.toUpperCase();
}
export const REG_RE = /^K[A-Z]{2} \d{3}[A-Z]$/;
export const looksLikeReg = r => REG_RE.test(r);

export function normName(v){
  v = plain(v);
  return isStr(v) ? v.toUpperCase().replace(/\s+/g, ' ').trim() : '';
}

export function editDistance(a, b){
  const m = a.length, n = b.length;
  if(Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for(let j = 1; j <= n; j++) d[0][j] = j;
  for(let i = 1; i <= m; i++) for(let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}

/* Closest known registration to a suspicious one (typo, extra letter, truncated). */
export function suggestReg(reg, known){
  if(!reg) return null;
  let best = null, bestD = 99;
  for(const k of known){
    if(k === reg) continue;
    let dist = editDistance(reg, k);
    if(reg.length >= 6 && k.startsWith(reg)) dist = Math.min(dist, 1);
    if(dist < bestD){ bestD = dist; best = k; }
  }
  return bestD <= 1 ? best : null;
}

export function sum(arr, f){ return arr.reduce((s, x) => s + (Number(f ? f(x) : x) || 0), 0); }
export function mode(arr){
  const c = new Map(); let best = null, n = 0;
  arr.forEach(x => { const k = c.get(x) || 0; c.set(x, k + 1); if(k + 1 > n){ n = k + 1; best = x; } });
  return best;
}

/* Review-item factory. `choices` are the one-click fixes: {label, set:{field:value}} or {label, remove:true}.
   An item with no choices is an information-only question for the admin. */
export function makeReview(list, item){
  const r = Object.assign({ id: 'RV' + (list.length + 1), severity: 'medium', status: 'open', choices: [] }, item);
  list.push(r);
  return r;
}
