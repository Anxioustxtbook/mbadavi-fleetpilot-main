/* The page's side of the database (inside the FleetPilot .exe). SQLite work is done by electron/ledgerFile.cjs.

   START-UP  startDatabase(): opens the database chosen in Pilot (default: the last one used) before the ledger is shown.
   SAVING    DesktopDb.save(): one write per change (the page waits about half a second for further changes), once more when the window closes.
             A failed write is retried; a lasting failure becomes a visible problem. */

export const DEFAULT_NAME = 'Main';
export const hasDesktopDb = b => !!(b && typeof b.dbLoad === 'function' && typeof b.dbSave === 'function' &&
  typeof b.dbSettings === 'function' && typeof b.dbSetOpenOnce === 'function' && typeof b.dbTakeOpenOnce === 'function');
const LOW_FREE = 300 * 1024 * 1024;
/* the disk is "nearly full" when under 300 MB are left, or under 20 times the size of the database file */
export const lowDisk = (free, size) => free != null && Number.isFinite(free) && (free < LOW_FREE || free < (Number(size) || 0) * 20);
export const mb = n => Math.max(1, Math.round(n / 1048576)) + ' MB';
const when = iso => { try{ return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }catch(e){ return String(iso || ''); } };

export async function startDatabase({ bridge, confirmFn, openOnce }){
  const out = { name: DEFAULT_NAME, data: null, source: 'empty', notices: [], blocked: null, needsFirstSave: false };
  const st = await bridge.dbSettings();
  if(!st || !st.ok) throw new Error((st && st.error) || 'the data folder could not be read');
  const { settings, databases } = st, find = n => databases.find(d => String(d.name).toLowerCase() === String(n || '').toLowerCase());
  out.folder = st.folder;
  const desiredName = settings.startWith && settings.startWith !== 'last' ? settings.startWith : settings.lastUsed;
  const hasPriorDatabase = !!(settings.migrated || settings.lastUsed || (settings.startWith && settings.startWith !== 'last'));
  let name = '';
  if(openOnce && find(openOnce)) name = find(openOnce).name;                              // chosen with "Open" in Pilot a moment ago
  else if(settings.startWith && settings.startWith !== 'last' && find(settings.startWith)) name = find(settings.startWith).name;
  else if(find(settings.lastUsed)) name = find(settings.lastUsed).name;
  else if(databases.length) name = databases.slice().sort((a, b) => b.modified - a.modified)[0].name;

  let r = null;
  if(name){
    out.name = name;
    r = await bridge.dbLoad(name);
    if(r && r.ok){ out.data = r.data; out.source = 'file'; out.name = r.name; out.savedAt = r.savedAt || ''; out.syncRev = r.syncRev == null ? null : r.syncRev;
      if(r.movedFrom) out.notices.push({ level: 'info', kind: 'tosqlite', text: 'Your database "' + r.name + '" now lives in SQLite (databases\\' + r.name + '.db). The old file was kept, unchanged, in the old-files folder. Nothing was lost.' });
      if(r.upgradedFrom != null) out.notices.push({ level: 'info', kind: 'upgraded', text: 'Your database was brought up to this version of FleetPilot (file format ' + r.upgradedFrom + ' to ' + r.formatVersion + '). The old file was kept once in the copies folder. Nothing was lost.' });
      return out; }
    if(r && (r.reason === 'newer' || r.reason === 'unreadable' || r.reason === 'upgrade-failed')){
      out.blocked = { reason: r.reason, message: r.message || ('The database "' + name + '" could not be opened: ' + (r.error || 'unknown problem') + '. Nothing was changed and nothing will be written to it.') };
      return out;
    }
    if(r && r.reason !== 'damaged' && r.reason !== 'missing'){
      out.blocked = { reason: 'load-failed', message: 'The database "' + name + '" could not be opened: ' + (r.error || 'unknown problem') + '. Nothing was changed and nothing will be written.' };
      return out;
    }
    if(r && r.reason === 'damaged'){
      out.notices.push({ level: 'info', kind: 'damaged', text: 'The database file "' + name + '" could not be read' + (r.setAside ? ' and was set aside (not deleted) in ' + r.setAside : '') + '.' });
    }
  }
  if(!hasPriorDatabase && databases.length === 0){
    out.needsFirstSave = true;
    return out;
  }

  const recoveryName = name || desiredName || DEFAULT_NAME;
  const missingMessage = name
    ? 'The SQLite database "' + name + '" could not be opened.'
    : 'The previously used SQLite database "' + recoveryName + '" is missing.';
  const copiesResult = await bridge.dbCopies();
  if(!copiesResult || !copiesResult.ok) throw new Error((copiesResult && copiesResult.error) || 'the SQLite safety copies could not be read');
  const monthlyCopies = (copiesResult.copies || [])
    .filter(x => x.kind === 'monthly' && String(x.db).toLowerCase() === recoveryName.toLowerCase())
    .sort((a, b) => b.madeAt - a.madeAt);
  const latestCopy = monthlyCopies[0];
  if(latestCopy && confirmFn(missingMessage + '\n\nLoad the monthly SQLite safety copy made ' + when(latestCopy.madeAt) + ' (data saved through ' + when(latestCopy.savedAt) + ')?\n\nChoose Cancel to create a new empty database. The copy will remain untouched.')){
    const restored = await bridge.dbReadCopy(latestCopy.id);
    if(!restored || !restored.ok){
      out.blocked = { reason: 'recovery-failed', message: (restored && restored.error) || 'The SQLite safety copy could not be opened. No new database was created.' };
      return out;
    }
    out.name = recoveryName;
    out.data = restored.data;
    out.source = 'copy';
    out.needsFirstSave = true;
    out.notices.push({ level: 'info', kind: 'fromcopy', text: 'Loaded a monthly SQLite safety copy made ' + when(latestCopy.madeAt) + '. The original copy remains unchanged.' });
    return out;
  }

  if(hasPriorDatabase && !confirmFn(missingMessage + '\n\nCreate a new, empty SQLite database? Existing safety copies will not be changed.')){
    out.blocked = { reason: 'missing', message: missingMessage + ' No data was changed. Choose Recover an earlier copy or create a new database after confirming.' };
    return out;
  }

  out.name = recoveryName;
  out.needsFirstSave = true;
  if(hasPriorDatabase) out.notices.push({ level: 'info', kind: 'fresh-database', text: 'A new empty SQLite database was selected. Existing monthly safety copies were left untouched.' });
  return out;
}

export class DesktopDb {
  constructor(bridge, name){ this.b = bridge; this.name = name; this.failCount = 0; this.lastError = ''; this.blocked = ''; this.lowDisk = false; this.free = null; this.size = 0; this.marked = false; this.lastSavedAt = null; this.rev = null; this.stale = false; }
  async markUsed(){ if(this.marked) return; this.marked = true; try{ await this.b.dbSetSettings({ lastUsed: this.name, migrated: true }); }catch(e){ this.marked = false; } }
  _ok(r){ this.failCount = 0; this.lastError = ''; this.lastSavedAt = new Date(); this.size = r.bytes || this.size; this.free = r.free == null ? null : r.free; this.lowDisk = lowDisk(this.free, this.size); }
  _bad(r){ this.failCount++; this.lastError = (r && r.error) || 'the file could not be written'; if(r && r.locked) this.blocked = this.lastError; }
  async save(data){
    if(this.blocked) return { ok: false, locked: true, error: this.blocked };
    let r; try{ r = await this.b.dbSave(this.name, data, this.rev); }catch(e){ r = { ok: false, error: String(e && e.message || e) }; }
    if(r && r.stale){ this.stale = true; return r; }                      // a phone sync wrote underneath this screen: not a failed save, the screen reloads
    if(r && r.ok){ this._ok(r); await this.markUsed(); return r; }
    this._bad(r); return r || { ok: false, error: this.lastError };
  }
  /* for the moment the window closes: the page may be gone before an asynchronous write finishes */
  saveSync(data){
    if(this.blocked || typeof this.b.dbSaveSync !== 'function') return { ok: false, error: this.blocked || 'not available' };
    let r; try{ r = this.b.dbSaveSync(this.name, data, this.rev); }catch(e){ r = { ok: false, error: String(e && e.message || e) }; }
    if(r && r.ok) this._ok(r); else if(r && r.stale) this.stale = true; else this._bad(r);
    return r || { ok: false };
  }
  /* red only when the app truly cannot save: the same failure twice in a row, or a file it must not write to */
  problem(){ return this.blocked || (this.failCount >= 2 ? this.lastError : ''); }
  diskNote(){ return this.lowDisk && this.free != null ? 'The disk is nearly full (about ' + mb(this.free) + ' left). Free some space soon so FleetPilot can keep saving.' : ''; }
}

/* Pilot > Database: manage the year-round ledgers, startup default, and recovery copies. */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function renderDbBox(el, api){
  let info;
  try{ info = await api.info(); }
  catch(e){ el.innerHTML = '<span class="subtitle">The database list could not be read: ' + esc(e && e.message || e) + '</span>'; return; }
  if(!info || !info.ok){ el.innerHTML = '<span class="subtitle">The database list could not be read: ' + esc(info && info.error || 'unknown error') + '</span>'; return; }
  const dbs = info.databases, start = info.settings.startWith, current = api.current();
  const startName = start === 'last' ? info.settings.lastUsed : start;
  const when = iso => { try{ return iso ? new Date(iso).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'not saved yet'; }catch(e){ return 'not saved yet'; } };
  const rows = dbs.length ? dbs.map(d=>{
    const active = d.name === current, isDefault = d.name === startName;
    return '<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid var(--line,#30363d);padding:9px 0;flex-wrap:wrap;">'
      + '<div style="min-width:220px;flex:1;"><b>' + esc(d.name) + '</b>' + (active ? ' <span class="subtitle">· in use</span>' : '') + (isDefault ? ' <span class="subtitle">· opens at start</span>' : '')
      + '<div class="subtitle" style="margin:2px 0 0;">' + Number(d.records || 0) + ' records · last saved ' + esc(when(d.savedAt)) + '</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;">'
      + (!active ? '<button type="button" class="btn" data-dbgo="' + esc(d.name) + '" style="width:auto;padding:5px 10px;">Open</button>' : '')
      + (!isDefault ? '<button type="button" class="btn" data-dbdefault="' + esc(d.name) + '" style="width:auto;padding:5px 10px;">Make default</button>' : '')
      + '<button type="button" class="btn" data-dbdelete="' + esc(d.name) + '"' + (active ? ' disabled title="Open another database before deleting this one"' : '') + ' style="width:auto;padding:5px 10px;color:var(--red);">Delete</button></div></div>';
  }).join('') : '<p class="subtitle">No SQLite database yet. Create one to start your continuous ledger.</p>';
  el.innerHTML = '<div style="border:1px solid var(--line,#30363d);border-radius:8px;padding:10px 12px;">'
    + '<div><b>Continuous SQLite ledger</b><div class="subtitle">Your active database keeps records across months and years. It saves continuously; monthly copies are recovery snapshots, not the working database.</div></div>'
    + '<div style="margin-top:8px;">' + rows + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"><button type="button" class="btn" data-dbnew style="width:auto;padding:5px 10px;">Create database…</button>'
    + '<button type="button" class="btn" data-db-recovery style="width:auto;padding:5px 10px;">Recover a copy…</button>'
    + '<button type="button" class="btn" data-dbfolder style="width:auto;padding:5px 10px;">Open the data folder</button>'
    + '<label style="margin-left:auto;">Startup choice <select data-dbstart style="width:auto;display:inline-block;"><option value="last"' + (start === 'last' ? ' selected' : '') + '>Last database used</option>'
    + dbs.map(d => '<option value="' + esc(d.name) + '"' + (start === d.name ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select></label></div></div>';
  el.onchange = async e => {
    const s = e.target.closest('[data-dbstart]');
    if(!s) return;
    const r = await api.setStart(s.value);
    if(!r || r.ok === false){ api.toast((r && r.error) || 'The startup database could not be changed.'); return; }
    api.toast(s.value === 'last' ? 'The last database used opens at start.' : '"' + s.value + '" opens at start.');
    await renderDbBox(el, api);
  };
  el.onclick = async e => {
    const go = e.target.closest('[data-dbgo]');
    if(go){ await api.open(go.dataset.dbgo); return; }
    const def = e.target.closest('[data-dbdefault]');
    if(def){
      const r = await api.setStart(def.dataset.dbdefault);
      if(!r || r.ok === false){ api.toast((r && r.error) || 'The startup database could not be changed.'); return; }
      api.toast('"' + def.dataset.dbdefault + '" will open at start.');
      await renderDbBox(el, api);
      return;
    }
    const del = e.target.closest('[data-dbdelete]');
    if(del){
      const name = del.dataset.dbdelete;
      if(!window.confirm('Delete the SQLite database "' + name + '" permanently?\n\nIts monthly recovery copies are not deleted. The database currently in use cannot be deleted.')) return;
      const r = await api.remove(name);
      if(!r || !r.ok){ api.toast((r && r.error) || 'The database could not be deleted.'); return; }
      api.toast('Database "' + name + '" deleted. Its recovery copies remain available.');
      await renderDbBox(el, api);
      return;
    }
    if(e.target.closest('[data-dbnew]')){ await api.create(); return; }
    if(e.target.closest('[data-db-recovery]')){ api.recover(); return; }
    if(e.target.closest('[data-dbfolder]')){ await api.showFolder(); }
  };
}
