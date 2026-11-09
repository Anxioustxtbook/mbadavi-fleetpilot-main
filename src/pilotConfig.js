/* Pilot display settings: which sections, pages and Overview columns are shown, in what order, and what they are called.
   Only the display changes: hiding an Overview column never changes a total, and hiding a section never deletes data.
   Saved in settings.pilotConfig = { tabs:[{id,label,hidden}], pages:[...], cols:[...] } (and in the saved Excel file's Settings sheet).
   A list that is saved is merged with the program's own list, so a section added in a later version still shows up (at the end),
   and an entry the program no longer has is dropped. */

const MAX_LABEL = 32;

export function cleanLabel(text, fallback){
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return t || fallback;
}

/* defaults: [{id,label}]   saved: [{id,label?,hidden?}] or undefined   ->   [{id,label,defLabel,hidden}] in display order */
export function resolveList(defaults, saved){
  const byId = new Map(defaults.map(d => [d.id, d]));
  const out = [], seen = new Set();
  (Array.isArray(saved) ? saved : []).forEach(s => {
    if(!s || !byId.has(s.id) || seen.has(s.id)) return;
    seen.add(s.id); const d = byId.get(s.id);
    out.push({ id: s.id, label: cleanLabel(s.label, d.label), defLabel: d.label, hidden: !!s.hidden });
  });
  defaults.forEach(d => { if(!seen.has(d.id)) out.push({ id: d.id, label: d.label, defLabel: d.label, hidden: false }); });
  if(out.length && out.every(x => x.hidden)) out[0].hidden = false;       // never an empty row of buttons
  return out;
}
/* what is stored: only what differs from the program's own list */
export function compact(list){ return list.map(x => ({ id: x.id, label: x.label, hidden: !!x.hidden })); }
export function isDefault(defaults, saved){
  const r = resolveList(defaults, saved);
  return r.length === defaults.length && r.every((x, i) => x.id === defaults[i].id && x.label === defaults[i].label && !x.hidden);
}

export function move(list, id, delta){
  const i = list.findIndex(x => x.id === id), j = i + delta;
  if(i < 0 || j < 0 || j >= list.length) return list;
  const out = list.slice(); const [x] = out.splice(i, 1); out.splice(j, 0, x); return out;
}
export function rename(list, id, label){ return list.map(x => x.id === id ? Object.assign({}, x, { label: cleanLabel(label, x.defLabel) }) : x); }
/* hide (remove from view) or show (add back). The last visible entry cannot be removed. */
export function setHidden(list, id, hidden){
  if(hidden && list.filter(x => !x.hidden && x.id !== id).length === 0) return list;
  return list.map(x => x.id === id ? Object.assign({}, x, { hidden: !!hidden }) : x);
}
export function reset(defaults){ return defaults.map(d => ({ id: d.id, label: d.label, defLabel: d.label, hidden: false })); }

/* ---------- the shortcut links under "Pilot" in the left menu: the person can add, remove, rename and reorder them ----------
   A link is { id, label, dest } where dest is 'tab:<tab>' (a section of Pilot) or 'page:<page>' (a page inside Pages). */
export const DEFAULT_LINKS = [
  { id: 'l-overview', label: 'Overview', dest: 'tab:overview' }, { id: 'l-fuel', label: 'Fuel', dest: 'page:fuel' }, { id: 'l-subhire', label: 'Sub-hire', dest: 'tab:subhire' },
  { id: 'l-loans', label: 'Loans', dest: 'tab:loans' }, { id: 'l-insurance', label: 'Insurance', dest: 'tab:insurance' },
  { id: 'l-ochwada', label: 'OCHWADA', dest: 'tab:ochwada' }, { id: 'l-pages', label: 'All pages', dest: 'page:progress' }
];
export function destOf(dest){ const m = /^(tab|page):([A-Za-z0-9_-]+)$/.exec(String(dest || '')); return m ? { kind: m[1], key: m[2] } : null; }
/* saved: the stored array (or undefined = the program's own list). validDests: array of dest strings that exist. */
export function resolveLinks(saved, validDests){
  if(!Array.isArray(saved)) return DEFAULT_LINKS.map(x => Object.assign({}, x));
  const ok = new Set(validDests), seen = new Set(), out = [];
  saved.forEach(s => { if(!s || !ok.has(s.dest)) return; let id = String(s.id || ''); if(!id || seen.has(id)) id = 'l-' + out.length + '-' + Math.random().toString(36).slice(2, 6); seen.add(id); out.push({ id, label: cleanLabel(s.label, s.dest), dest: s.dest }); });
  return out;
}
export function addLink(list, dest, label, defLabel){
  const id = 'l-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  return list.concat([{ id, label: cleanLabel(label, defLabel || dest), dest }]);
}
export const removeLink = (list, id) => list.filter(x => x.id !== id);
export const renameLink = (list, id, label) => list.map(x => x.id === id ? Object.assign({}, x, { label: cleanLabel(label, x.label) }) : x);
export const moveLink = (list, id, delta) => move(list, id, delta);
