/* Account statement with brought-forward (BF) support, used for OCHWADA.
   Each month: opening + charges (positive amounts) + payments (negative amounts) = closing.
   carryBF = true: the opening is the previous month's closing, so a mistyped BF cannot spread.
   carryBF = false: the opening is the BF figure typed on the sheet. Either way the difference is reported. */
export function statement(blocks, { carryBF = true } = {}){
  let prev = null;
  return blocks.map(b => {
    const typed = Number(b.bf) || 0;
    const opening = (carryBF && prev !== null) ? prev : typed;
    const charges = b.entries.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const payments = b.entries.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const closing = opening + charges + payments;
    prev = closing;
    return { month: b.month, opening, typedBF: typed, bfDiff: opening - typed, charges, payments, closing,
      sheetTotal: b.sheetTotal, totalDiff: b.sheetTotal === null || b.sheetTotal === undefined ? null : closing - b.sheetTotal };
  });
}
