/* INVOICE sheet: blocks headed JANUARY, FEBUARY, ... (some blocks are mis-headed: the month comes from the invoice date, not the heading).
   Columns: B CLIENT | C AMOUNT | D INVOICE | E DATE | F STATUS (PAID or empty) | G VAT.  Each block ends with a TOTAL row (amount, VAT).
   Read only. Numbers further right on the same rows belong to side tables and are ignored. */
import { isNum, isStr, dateOf, monthKey } from './util.js';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

export function parseInvoices(rows){
  const invoices = [], blocks = [], review = [];
  let cur = null;
  rows.forEach((r, i) => {
    if(!r) return;
    const label = isStr(r[1]) ? r[1].trim().toUpperCase() : '';
    if(label === 'TOTAL'){
      if(cur){ cur.total = { row: i + 1, amount: isNum(r[2]) ? r[2] : null, vat: isNum(r[6]) ? r[6] : null }; cur = null; }
      return;
    }
    if(label === 'CLIENT') return;                                   // header row
    const date = dateOf(r[4]);
    if(isStr(r[1]) && isNum(r[2]) && isNum(r[3]) && date){
      if(!cur){ cur = { startRow: i + 1, invoices: [], total: null }; blocks.push(cur); }
      const status = isStr(r[5]) ? r[5].trim().toUpperCase() : '';
      const inv = { key: 'I' + (i + 1), xlRow: i + 1, client: clean(r[1]).toUpperCase(), amount: r[2], no: r[3], date, month: monthKey(date),
        paid: status === 'PAID', status, vat: isNum(r[6]) ? r[6] : 0, net: r[2] - (isNum(r[6]) ? r[6] : 0) };
      /* a garbled client name: more than a few characters of the same letter, or not a plausible name */
      if(inv.client.length > 24 || /([A-Z\[\]])\1{3,}/.test(inv.client) || /[\[\]]/.test(inv.client)) inv.garbled = true;
      cur.invoices.push(inv); invoices.push(inv);
    }
  });
  return { invoices, blocks };
}

/* Totals check, one entry per block: the sheet's own TOTAL row against the invoices read. */
export function invoiceChecks(parsed){
  const out = [];
  parsed.blocks.forEach(b => {
    if(!b.total || !b.invoices.length) return;
    const sum = k => b.invoices.reduce((s, x) => s + (x[k] || 0), 0);
    const cnt = {}; b.invoices.forEach(x => { cnt[x.month] = (cnt[x.month] || 0) + 1; });
    const label = Object.keys(cnt).sort((a, c) => cnt[c] - cnt[a])[0];
    if(b.total.amount !== null) out.push({ group: 'Invoices', label: 'Invoices ' + label + ' (amount)', excel: b.total.amount, imported: sum('amount'), diff: sum('amount') - b.total.amount, ok: Math.abs(sum('amount') - b.total.amount) < 1 });
    if(b.total.vat !== null) out.push({ group: 'Invoices', label: 'Invoices ' + label + ' (VAT)', excel: b.total.vat, imported: sum('vat'), diff: sum('vat') - b.total.vat, ok: Math.abs(sum('vat') - b.total.vat) < 1 });
  });
  return out;
}
