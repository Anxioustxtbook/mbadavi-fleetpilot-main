/* Excel refuses to keep more than 32,767 characters in one cell and silently cuts the rest (or reports the file as damaged).
   Some saved values can grow past that (the import decisions, row formats, a long loan schedule). So any text cell on a data sheet that is longer than
   SPILL_LIMIT is written in pieces: the first piece stays in its own cell, the next pieces go into extra columns after the sheet's normal columns,
   headed "<column>~2", "<column>~3" ... Opening the file joins the pieces again, so nothing is lost. Sheets with no long cell are written exactly as before. */
export const SPILL_LIMIT = 30000;

/* ws needs: eachRow(fn(row, rowNumber)), getRow(n).getCell(i).value (read/write). ncols = the sheet's normal column count. Returns how many cells were split. */
export function spillLongCells(ws, ncols, limit = SPILL_LIMIT){
  const extra = new Map();       // "col:piece" -> column index
  let next = ncols + 1, split = 0;
  const rowsToDo = [];
  ws.eachRow((row, rowNumber) => { if(rowNumber > 1) rowsToDo.push(rowNumber); });
  rowsToDo.forEach(rn => {
    const row = ws.getRow(rn);
    for(let c = 1; c <= ncols; c++){
      const cell = row.getCell(c), v = cell.value;
      if(typeof v !== 'string' || v.length <= limit) continue;
      const parts = []; for(let i = 0; i < v.length; i += limit) parts.push(v.slice(i, i + limit));
      cell.value = parts[0]; split++;
      parts.slice(1).forEach((p, k) => {
        const key = c + ':' + (k + 2); let idx = extra.get(key);
        if(!idx){ idx = next++; extra.set(key, idx); const head = String(ws.getRow(1).getCell(c).value || ''); ws.getRow(1).getCell(idx).value = head + '~' + (k + 2); }
        row.getCell(idx).value = p;
      });
    }
  });
  return split;
}

/* The extra columns of a sheet, in the order the pieces must be joined: [{ col:'importDecisions', idx:15, k:2 }, ...] */
export function spillColumns(ws, cols){
  const out = [], hdr = ws.getRow(1), n = ws.columnCount || 0;
  for(let i = cols.length + 1; i <= n; i++){
    let h = hdr.getCell(i).value; if(h && typeof h === 'object' && 'text' in h) h = h.text;
    const m = /^(.+)~(\d+)$/.exec(String(h || '')); if(m && cols.includes(m[1])) out.push({ col: m[1], idx: i, k: Number(m[2]) });
  }
  return out.sort((a, b) => a.k - b.k || a.idx - b.idx);
}
export function joinSpills(obj, row, spills){
  spills.forEach(s => {
    let part = row.getCell(s.idx).value; if(part && typeof part === 'object' && 'text' in part) part = part.text;
    if(typeof part === 'string' && part !== '') obj[s.col] = String(obj[s.col] == null ? '' : obj[s.col]) + part;
  });
}
