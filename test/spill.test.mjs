/* Long cells survive the Excel round trip: split on save, joined on open. Uses a tiny stand-in for an ExcelJS worksheet. */
import assert from 'node:assert/strict';
import { spillLongCells, spillColumns, joinSpills, SPILL_LIMIT } from '../src/sheetSpill.js';
function fakeSheet(){
  const rows = new Map(); const cellObj = (r, c) => ({ get value(){ return (rows.get(r) || {})[c]; }, set value(v){ if(!rows.has(r)) rows.set(r, {}); rows.get(r)[c] = v; } });
  return { rows, get columnCount(){ let m = 0; rows.forEach(o => Object.keys(o).forEach(k => { m = Math.max(m, Number(k)); })); return m; },
    getRow: r => ({ getCell: c => cellObj(r, c) }), eachRow(fn){ [...rows.keys()].sort((a, b) => a - b).forEach(r => fn({ getCell: c => cellObj(r, c) }, r)); },
    addRow(arr){ const r = rows.size + 1; arr.forEach((v, i) => { if(v !== '' && v != null) cellObj(r, i + 1).value = v; }); return r; } };
}
const cols = ['adminPin', 'importDecisions', 'rowFormats', 'idle'];
const huge = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ id: i, note: 'decision ' + i + ' ☃ ' + 'x'.repeat(20) })));   // well past one cell
const huge2 = 'é'.repeat(SPILL_LIMIT * 2 + 17);                                                                                                // three pieces, non-ASCII
assert.ok(huge.length > SPILL_LIMIT);
const ws = fakeSheet(); ws.addRow(cols); ws.addRow(['', huge, huge2, 7]); ws.addRow(['x', 'short', '', 8]);
const n = spillLongCells(ws, cols.length);
assert.equal(n, 2, 'two long cells were split');
ws.rows.forEach(o => Object.values(o).forEach(v => { if(typeof v === 'string') assert.ok(v.length <= SPILL_LIMIT, 'no cell is over the limit: ' + v.length); }));
const sp = spillColumns(ws, cols); assert.ok(sp.length >= 3, 'extra columns were added: ' + sp.length);
const back = []; ws.eachRow((row, rn) => { if(rn === 1) return; const o = {}; cols.forEach((c, i) => { const v = row.getCell(i + 1).value; o[c] = v === undefined ? '' : v; }); joinSpills(o, row, sp); back.push(o); });
assert.equal(back[0].importDecisions, huge); assert.equal(back[0].rowFormats, huge2); assert.equal(back[0].idle, 7);
assert.deepEqual(JSON.parse(back[0].importDecisions).length, 4000);
assert.equal(back[1].importDecisions, 'short'); assert.equal(back[1].adminPin, 'x');
// a sheet with nothing long is untouched
const w2 = fakeSheet(); w2.addRow(cols); w2.addRow(['1', 'a', 'b', 2]); assert.equal(spillLongCells(w2, cols.length), 0); assert.equal(spillColumns(w2, cols).length, 0);
// a header that merely looks like a piece name but is not a known column is ignored
const w3 = fakeSheet(); w3.addRow(cols.concat(['bogus~2'])); w3.addRow(['1', 'a', 'b', 2, 'zzz']); assert.equal(spillColumns(w3, cols).length, 0);
console.log('spill tests passed');
