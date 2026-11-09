import assert from 'node:assert/strict';
import { kenyaHolidays, easterSunday, DAY_NAMES } from '../src/holidays.js';
const show = y => kenyaHolidays(y).map(h => `${h.date} ${DAY_NAMES[new Date(h.date+'T00:00:00Z').getUTCDay()].slice(0,3)} ${h.name}${h.provisional?' (prov)':''}`);
const h26 = kenyaHolidays(2026);
// published 2026 list: 12 days
const expected26 = ['2026-01-01','2026-03-20','2026-04-03','2026-04-06','2026-05-01','2026-05-27','2026-06-01','2026-10-10','2026-10-20','2026-12-12','2026-12-25','2026-12-26'];
assert.deepEqual(h26.map(h=>h.date), expected26);
assert.equal(easterSunday(2026),'2026-04-05'); assert.equal(easterSunday(2027),'2027-03-28'); assert.equal(easterSunday(2028),'2028-04-16');
// 2027: Sunday rule (Oct 10, Dec 12, Dec 26 are Sundays)
const d27 = kenyaHolidays(2027).map(h=>h.date);
['2027-10-11','2027-12-13','2027-12-27','2027-03-26','2027-03-29','2027-06-01'].forEach(d=>assert.ok(d27.includes(d), d));
// Christmas on Sunday (2022): Boxing Monday is a holiday, so the observed day moves to Tuesday
const d22 = kenyaHolidays(2022).map(h=>h.date); assert.ok(d22.includes('2022-12-26')&&d22.includes('2022-12-27'));
// fixes
const fx = kenyaHolidays(2027,{'idd-fitr-2027':'2027-03-11','idd-azha-2027':'removed'}).map(h=>h.date);
assert.ok(fx.includes('2027-03-11')&&!fx.includes('2027-05-17')&&!fx.includes('2027-05-16'));
console.log('2026:\n'+show(2026).join('\n')); console.log('2027:\n'+show(2027).join('\n')); console.log('2028:\n'+show(2028).join('\n'));
console.log('holidays tests passed');
