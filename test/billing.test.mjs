import assert from 'node:assert';
import { duration, charge, durationText } from '../src/billing.js';
const v = { rate: 5000, billHours: 12 };
let r = { pickup:'2026-01-06', pickupTime:'2:00PM', return:'2026-01-06', returnTime:'4:00PM', rate:5000 };
assert.deepEqual(duration(r), { ok:true, sameDay:true, calendarDays:1, hours:2 });
assert.equal(charge(r, v).amount, 5000); assert.equal(durationText(r), '2 hrs');
r = { pickup:'2026-01-01', pickupTime:'9:00AM', return:'2026-01-05', returnTime:'5:00PM', rate:5000 };
assert.equal(charge(r, v).units, 5); assert.equal(charge(r, v).amount, 25000);
assert.equal(durationText(r), '4 days 8 hrs');
assert.equal(charge({ ...r, billMode:'elapsed' }, v).units, 4);          // 104 hr = 4 days 8 hr, 8 <= 12
assert.equal(charge({ ...r, billMode:'elapsed', return:'2026-01-02', returnTime:'11:00PM' }, v).units, 2); // 38 hr = 1 day 14 hr > 12
assert.equal(charge({ ...r, billMode:'hours' }, { ...v, hourRate: 300 }).amount, 104*300);
assert.equal(charge({ ...r, billMode:'fixed', amount: 99000 }, v).amount, 99000);
assert.equal(charge({ ...r, billMode:'days', days: 3 }, v).amount, 15000);
assert.equal(charge({ pickup:'2026-01-05', return:'2026-01-01', rate:5000, days:2 }, v).label, 'dates missing');
console.log('billing ok');
