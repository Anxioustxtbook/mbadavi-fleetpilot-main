/* SUBHIRE DRIVER lines -> the rentals they belong to.
   A line is [driver, client, dates, days, amount, status, date]. The rental already holds the car, client, dates and days, so the line only
   brings what the rental cannot know: the amount (kept as an amount per day), the status and the date of the status.
   A line is tied to a rental of the same driver, taking the first that fits, tried in this order:
     1. same start day, same client, same days   2. same start day and client   3. same start day and days   4. the day falls inside the hire and the client matches
   Days are compared by month and day only: a typed year on these sheets is often wrong (2025 for 2026) and the review screen offers that fix separately.
   A rental is never claimed by two lines. Lines that fit nothing stay as plain Sub-hire driver costs under Expenses, listed on the review screen. */
const up = s => String(s == null ? '' : s).trim().toUpperCase();
const md = d => String(d || '').slice(5, 10);

export function statusOf(raw){
  const t = up(raw);
  if(/CANCEL/.test(t)) return 'cancelled';
  if(/PAID/.test(t) && !/NOT/.test(t)) return 'paid';
  return 'notcleared';
}

/* rentals: [{key, driver, client, pickup, return, days}]; lines: [{key, driver, client, date, days, amount, paid, paidDate, statusRaw}] */
export function matchDriverJobs(rentals, lines){
  const used = new Set(), matched = [], unmatched = [];
  const byDriver = new Map();
  rentals.forEach(r => { if(r.excluded || !up(r.driver) || up(r.driver) === 'SELF' || !r.pickup) return; const k = up(r.driver); (byDriver.get(k) || byDriver.set(k, []).get(k)).push(r); });
  lines.forEach(l => {
    if(l.excluded) return;
    const cands = (byDriver.get(up(l.driver)) || []).filter(r => !used.has(r.key));
    const day = md(l.date), cl = up(l.client);
    const same = r => md(r.pickup) === day, cm = r => up(r.client) === cl, inside = r => md(r.pickup) <= day && md(r.return || r.pickup) >= day;
    const tests = [r => same(r) && cm(r) && Number(r.days) === Number(l.days), r => same(r) && cm(r), r => same(r) && Number(r.days) === Number(l.days), r => inside(r) && cm(r)];
    let hit = null;
    if(day) tests.some(t => (hit = cands.find(t)));
    if(!hit){ unmatched.push(l); return; }
    used.add(hit.key);
    const days = Number(hit.days) > 0 ? Number(hit.days) : 1;
    matched.push({ line: l.key, rentalKey: hit.key, driver: up(l.driver), rate: Math.round((Number(l.amount) || 0) / days * 1e6) / 1e6, amount: Number(l.amount) || 0,
      status: l.statusRaw !== undefined ? statusOf(l.statusRaw) : (l.paid ? 'paid' : 'notcleared'), statusDate: l.paidDate || '', sheetRow: l.xlRow });
  });
  return { matched, unmatched };
}
