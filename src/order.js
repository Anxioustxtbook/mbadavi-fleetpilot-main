/* Table order used everywhere: the newest record first.
   Every record gets the next number from db.nextId when it is made (uid()), and that counter is shared by all lists,
   so a higher id means it was entered later. Rows without a numeric id come after the numbered ones, in the order given. */
const idNum = r => { const n = Number(r && r.id); return r && r.id !== '' && r.id != null && Number.isFinite(n) ? n : null; };
const byNewest = (a, b) => {
  if(a.n !== null && b.n !== null) return b.n - a.n || a.i - b.i;
  if(a.n !== null) return -1;
  if(b.n !== null) return 1;
  return a.i - b.i;
};

export function newestFirst(list){
  return (list || []).map((r, i) => ({ r, i, n: idNum(r) })).sort(byNewest).map(x => x.r);
}

/* For tables grouped under month headers: newest month first, and inside each month the newest record first.
   monthOf(record) gives a sortable month key such as '2026-11' ('' for no date, shown last). */
export function newestFirstByMonth(list, monthOf){
  return (list || []).map((r, i) => { const m = monthOf(r); return { r, i, n: idNum(r), m: m == null ? '' : String(m) }; })
    .sort((a, b) => a.m !== b.m ? (a.m < b.m ? 1 : -1) : byNewest(a, b)).map(x => x.r);
}
