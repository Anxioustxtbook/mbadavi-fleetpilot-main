/* Payments found in the workbook: everything the files list as PAID becomes a payment, so Billed, Collected and Owed can be worked out
   from the Payments table like every other rental.  Pure functions: nothing here touches the database.

   Sources, strongest first:
     1. INVOICE sheet (status PAID).  An invoice is matched to the client's rentals whose amounts add up exactly to the invoice before VAT
        ("exact"). If no exact set exists, the money is applied to that client's oldest unpaid rentals ("approx") and anything left over is kept
        as a payment that is "not linked" to a rental.  Unpaid invoices only reserve their rentals (set the Invoice No) and add no payment.
     2. OCHWADA statement payments, applied to his oldest rentals after the balance brought forward.
   (The per-car sheets such as KDQ 652A also say PAID, but their amounts are the car owner's share, so they are about sub-hire paid out, not client payments.)
   Payments are in the same terms as Billed (rental amount, VAT excluded); VAT stays on the invoice record.
   Every payment carries `source` (where in the Excel it was listed) so it can be opened from the Payments table. */
import { addDays, diffDays } from './util.js';

const MAX_SUMS = 250000;   // safety limit for the subset search

function subsetSum(cands, target){
  /* cands: [{key, amt}] in date order. First try the oldest-first run (the normal way invoices are raised), then any subset. */
  let s = 0; const run = [];
  for(const c of cands){ run.push(c); s += c.amt; if(s === target) return run; if(s > target) break; }
  const reach = new Map([[0, null]]);          // sum -> [prev sum, index]
  for(let i = 0; i < cands.length; i++){
    const a = cands[i].amt; if(!(a > 0) || a > target) continue;
    for(const sum of [...reach.keys()]){ const ns = sum + a; if(ns <= target && !reach.has(ns)) reach.set(ns, [sum, i]); }
    if(reach.has(target)) break;
    if(reach.size > MAX_SUMS) return null;
  }
  if(!reach.has(target)) return null;
  const out = []; let cur = target;
  while(cur !== 0){ const [prev, i] = reach.get(cur); out.push(cands[i]); cur = prev; }
  return out.reverse();
}

const SRC = {
  invoice: i => `INVOICE row ${i.xlRow} · invoice ${i.no} · ${i.client}`,
  ochwada: e => `OCHWADA row ${e.xlRow}`,
  percar: (sheet, l) => `${sheet} row ${l.row}`
};

export function allocatePayments({ rentals, invoices, ochwada }){
  const R = (rentals || []).filter(r => !r.excluded && r.amount > 0);
  const byKey = new Map(R.map(r => [r.key, r]));
  const paid = new Map(R.map(r => [r.key, 0]));
  const claimed = new Set();                                     // rentals tied to an invoice (paid or not) by an exact match
  const out = [], review = [];
  const stats = { exact: { invoices: 0, payments: 0, amount: 0 }, approx: { invoices: 0, payments: 0, amount: 0 }, unlinked: { payments: 0, amount: 0 },
    ochwada: { payments: 0, amount: 0 }, invoicesOnRentals: 0 };
  const owedOf = r => Math.max(0, r.amount - paid.get(r.key));
  const rentalInvoice = new Map();
  const push = p => { out.push(p); };

  /* ---- 1. invoices ---- */
  const inv = [...(invoices || [])].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : a.xlRow - b.xlRow));
  const window = (i, back) => R.filter(r => r.client === i.client && r.pickup && r.pickup >= addDays(i.date, -back) && r.pickup <= addDays(i.date, 3))
    .sort((a, b) => a.pickup < b.pickup ? -1 : (a.pickup > b.pickup ? 1 : a.xlRow - b.xlRow));
  const exactDone = new Set();
  inv.forEach(i => {
    const cands = window(i, 75).filter(r => !claimed.has(r.key)).map(r => ({ key: r.key, amt: r.amount }));
    let hit = null;
    for(const t of [...new Set([i.net, i.amount])]){ if(t > 0 && cands.length){ hit = subsetSum(cands, t); if(hit) break; } }
    if(!hit) return;
    exactDone.add(i.key);
    hit.forEach(c => { claimed.add(c.key); rentalInvoice.set(c.key, String(i.no)); });
    stats.invoicesOnRentals += hit.length;
    if(!i.paid) return;
    stats.exact.invoices++;
    hit.forEach(c => { const r = byKey.get(c.key);
      push({ ref: 'INVOICE!' + i.key + '#' + c.key, rentalKey: c.key, date: i.date, amount: r.amount, method: 'Invoice', invoiceNo: String(i.no), linkKind: 'exact',
        sheet: 'INVOICE', row: i.xlRow, source: SRC.invoice(i), note: 'Invoice ' + i.no + ' · ' + i.client });
      paid.set(c.key, paid.get(c.key) + r.amount); stats.exact.payments++; stats.exact.amount += r.amount; });
  });
  inv.forEach(i => {
    if(!i.paid || exactDone.has(i.key)) return;
    let left = i.net > 0 ? i.net : i.amount, any = false;
    const cands = window(i, 120).filter(r => !claimed.has(r.key) && owedOf(r) > 0);
    cands.forEach(r => {
      if(left <= 0) return;
      const part = Math.min(left, owedOf(r)); if(part <= 0) return;
      push({ ref: 'INVOICE!' + i.key + '#' + r.key, rentalKey: r.key, date: i.date, amount: part, method: 'Invoice', invoiceNo: String(i.no), linkKind: 'approx',
        sheet: 'INVOICE', row: i.xlRow, source: SRC.invoice(i), note: 'Invoice ' + i.no + ' · ' + i.client + ' · matched by client and date' });
      paid.set(r.key, paid.get(r.key) + part); left -= part; any = true; stats.approx.payments++; stats.approx.amount += part;
    });
    if(any) stats.approx.invoices++;
    if(left > 0){
      push({ ref: 'INVOICE!' + i.key + '#unlinked', rentalKey: '', date: i.date, amount: left, method: 'Invoice', invoiceNo: String(i.no), linkKind: 'unlinked',
        sheet: 'INVOICE', row: i.xlRow, source: SRC.invoice(i), note: 'Invoice ' + i.no + ' · ' + i.client + ' · no rental found for this amount' });
      stats.unlinked.payments++; stats.unlinked.amount += left;
    }
  });

  /* ---- 2. OCHWADA statement ---- */
  const oc = (ochwada || []);
  if(oc.length){
    const entries = [];
    oc.forEach(b => (b.entries || []).forEach(e => entries.push(e)));
    const pays = entries.filter(e => e.kind === 'payment' && e.amount < 0 && e.date).sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : a.xlRow - b.xlRow));
    const firstBf = (oc.find(b => b.bf !== null && b.bf !== undefined) || {}).bf || 0;
    let bfLeft = Math.max(0, firstBf);
    const mine = R.filter(r => r.client === 'OCHWADA' && !claimed.has(r.key)).sort((a, b) => a.pickup < b.pickup ? -1 : 1);
    pays.forEach(e => {
      let left = -e.amount;
      const toBf = Math.min(left, bfLeft); bfLeft -= toBf; left -= toBf;
      if(toBf > 0){ push({ ref: 'OCHWADA!' + e.xlRow + '#bf', rentalKey: '', date: e.date, amount: toBf, method: 'Account statement', invoiceNo: '', linkKind: 'unlinked',
        sheet: 'OCHWADA', row: e.xlRow, source: SRC.ochwada(e), note: 'OCHWADA · against the balance brought forward' }); stats.unlinked.payments++; stats.unlinked.amount += toBf; }
      mine.forEach(r => { if(left <= 0) return; const part = Math.min(left, owedOf(r)); if(part <= 0) return;
        push({ ref: 'OCHWADA!' + e.xlRow + '#' + r.key, rentalKey: r.key, date: e.date, amount: part, method: 'Account statement', invoiceNo: '', linkKind: 'approx',
          sheet: 'OCHWADA', row: e.xlRow, source: SRC.ochwada(e), note: 'OCHWADA statement · oldest rental first' });
        paid.set(r.key, paid.get(r.key) + part); left -= part; stats.ochwada.payments++; stats.ochwada.amount += part; });
      if(left > 0){ push({ ref: 'OCHWADA!' + e.xlRow + '#unlinked', rentalKey: '', date: e.date, amount: left, method: 'Account statement', invoiceNo: '', linkKind: 'unlinked',
        sheet: 'OCHWADA', row: e.xlRow, source: SRC.ochwada(e), note: 'OCHWADA · more than the rentals read so far' }); stats.unlinked.payments++; stats.unlinked.amount += left; }
    });
  }

  const total = R.reduce((s, r) => s + r.amount, 0), collected = R.reduce((s, r) => s + paid.get(r.key), 0);
  const noEvidence = R.filter(r => paid.get(r.key) === 0);
  stats.rentals = R.length; stats.billed = total; stats.collected = collected; stats.owed = total - collected;
  stats.fullyPaid = R.filter(r => owedOf(r) === 0).length; stats.partPaid = R.filter(r => paid.get(r.key) > 0 && owedOf(r) > 0).length;
  stats.noEvidence = noEvidence.length; stats.noEvidenceAmount = noEvidence.reduce((s, r) => s + r.amount, 0);
  return { payments: out, rentalInvoice, stats, paid };
}
