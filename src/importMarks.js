/* Imported records: a guard (nothing is shown in the lists) so a later import never overwrites or removes a record you edited.
   - A record is "imported" when it carries xlRef (its place in the Excel file); this survives saving to Excel and opening again.
   - When an import adds a rental, expense or payment, what it looked like is remembered (settings.importMarks, a short fingerprint).
     Later, a record whose content no longer matches its fingerprint was edited by you. A record with no fingerprint (imported before this
     version, or after the file went through Excel) cannot be proven edited, so it is handled as before. The fingerprint never leaves the database file. */
const SKIP = new Set(['paid', 'paidDate']);          // worked out from the payments, not typed by anyone
const MARKED = ['rentals', 'expenses', 'payments'];  // the lists an import can later change or remove from

export function fingerprint(rec){
  const keys = Object.keys(rec || {}).filter(k => !SKIP.has(k)).sort();
  const text = keys.map(k => k + '=' + JSON.stringify(rec[k])).join('|');
  let h = 0x811c9dc5; for(let i = 0; i < text.length; i++){ h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const marksOf = db => { db.settings = db.settings || {}; return db.settings.importMarks || (db.settings.importMarks = {}); };
const keyOf = (list, rec) => list + ':' + rec.id;

/* remember how an imported record looked when it was added (call once the whole import has finished with it) */
export function markImported(db, list, rec, today){
  if(!MARKED.includes(list) || !rec || rec.id == null) return;
  marksOf(db)[keyOf(list, rec)] = { at: today || new Date().toISOString().slice(0, 10), sig: fingerprint(rec) };
}
export const isImported = (db, list, rec) => !!(rec && (rec.xlRef || (db.settings && db.settings.importMarks && db.settings.importMarks[keyOf(list, rec)])));
/* true when the record is known to have been changed by a person since it was imported */
export function isEdited(db, list, rec){
  const m = db.settings && db.settings.importMarks && db.settings.importMarks[keyOf(list, rec)];
  return !!m && m.sig !== fingerprint(rec);
}
