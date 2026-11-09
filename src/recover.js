/* "Recover an earlier copy": database safety copies in the desktop app's data folder. */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export function initRecover(ctx){
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'recoverOverlay';
  overlay.innerHTML = '<div class="modal-box fm-box" role="dialog" aria-modal="true" aria-labelledby="rcTitle" style="max-width:640px;width:94vw;max-height:88vh;display:flex;flex-direction:column;"><div class="fm-head"><div><h2 id="rcTitle">Recover an earlier copy</h2><p>Safety copies of your work. Pick one to open or put back.</p></div><button type="button" class="fm-close" id="rcClose" aria-label="Close">✕</button></div><div id="rcBody" style="overflow:auto;padding:12px 18px;flex:1;"></div></div>';
  document.body.appendChild(overlay);
  const close = () => overlay.classList.remove('show');
  overlay.querySelector('#rcClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if(e.target === overlay) close(); });

  /* the safety copies in the data folder (.exe only) */
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = tag => { const m = /^(\d{4})-(\d{2})$/.exec(tag || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : tag; };
  let deskCopies = [];
  async function copiesBox(){
    const D = ctx.desktop && ctx.desktop(); if(!D) return '';
    let r; try{ r = await D.bridge.dbCopies(); }catch(e){ return '<p class="subtitle">Could not read database safety copies: ' + esc(e && e.message || e) + '</p>'; }
    if(!r || !r.ok) return '<p class="subtitle">Could not read database safety copies: ' + esc(r && r.error || 'unknown error') + '</p>';
    deskCopies = r.copies || [];
    const row = c => '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line,#30363d);padding:8px 0;flex-wrap:wrap;"><div style="min-width:0;"><b>' + esc(c.kind === 'monthly' ? 'Start of ' + monthName(c.tag) : 'Before the upgrade of the file format (was ' + c.tag + ')') + '</b> <span class="subtitle">· ' + esc(c.db) + '</span>'
      + '<div class="subtitle" style="margin:0;">Made ' + esc(when(c.madeAt)) + ' · work saved up to ' + esc(c.savedAt ? when(c.savedAt) : '—') + ' · ' + c.records + ' records · ' + kb(c.size) + '</div></div>'
      + '<div style="display:flex;gap:6px;flex:none;"><button type="button" class="btn" data-rcnew="' + esc(c.id) + '" style="width:auto;padding:5px 10px;">Open as a new database</button><button type="button" class="btn" data-rcrepl="' + esc(c.id) + '" style="width:auto;padding:5px 10px;">Replace this one</button><button type="button" class="btn" data-rcdel="' + esc(c.id) + '" style="width:auto;padding:5px 10px;color:var(--red);">Delete copy</button></div></div>';
    return '<div style="border:1px solid var(--line,#30363d);border-radius:8px;padding:9px 12px;margin-bottom:10px;"><b>Safety copies</b>'
      + '<div class="subtitle" style="margin:2px 0 4px;">One copy is made automatically on the first save of each month: the database as it stood before that save. <b>Open as a new database</b> replaces nothing (go back with Pilot &gt; Database &gt; Open). <b>Replace this one</b> puts the copy in place of the database in use; the work done since the copy is not kept.</div>'
      + '<button type="button" class="btn" data-rcfopen style="width:auto;padding:5px 10px;">Open the data folder</button>'
      + (deskCopies.length ? deskCopies.map(row).join('') : '<p class="subtitle" style="margin:6px 0 0;">No copy yet. The first one is made on the first save of a month.</p>') + '</div>';
  }
  async function open(){
    const body = overlay.querySelector('#rcBody');
    const cleanBox = '<div style="border:1px solid var(--line,#30363d);border-radius:8px;padding:9px 12px;margin-bottom:10px;"><b>Reset</b><div class="subtitle" style="margin:2px 0 6px;">Empties the database in use: every rental, booking, expense, payment, invoice, loan, fuel, coop, chama and statement record, and recurring expenses such as Rent. "Keep cars, drivers and clients" keeps only those three lists. Nothing else is kept except the monthly safety copy below. Asks for the admin PIN. Preferences (PIN, expense categories, layouts) are kept.</div><button type="button" class="btn" data-rcclean="all" style="width:auto;padding:6px 14px;">Empty everything</button> <button type="button" class="btn" data-rcclean="people" style="width:auto;padding:6px 14px;">Keep cars, drivers and clients</button></div>';
    /* v22: the window opens at once with what needs no lookup; the copies are filled in as soon as they are read */
    body.innerHTML = cleanBox + '<p class="subtitle">Looking for copies…</p>'; overlay.classList.add('show');
    body.innerHTML = cleanBox + await copiesBox();
  }
  overlay.addEventListener('click', async e => {
    const fo = e.target.closest('[data-rcfopen]');
    if(fo){ try{ await window.fleetDesktop.dbShowFolder(); }catch(err){ ctx.toast('Could not open the SQLite data folder: ' + (err && err.message || err)); } return; }
    const nw = e.target.closest('[data-rcnew]');
    if(nw){ const c = deskCopies.find(x => x.id === nw.dataset.rcnew); if(!c) return; close(); await ctx.openCopyAsNew(c); return; }
    const rp = e.target.closest('[data-rcrepl]');
    if(rp){ const c = deskCopies.find(x => x.id === rp.dataset.rcrepl); if(!c) return;
      if(!window.confirm('Put the copy made ' + when(c.madeAt) + ' (work saved up to ' + (c.savedAt ? when(c.savedAt) : 'an unknown time') + ', ' + c.records + ' records) in place of the database in use?\n\nEverything entered after that is lost, and nothing keeps it.\n\n"Open as a new database" would replace nothing.')) return;
      close(); await ctx.replaceWithCopy(c); return; }
    const del = e.target.closest('[data-rcdel]');
    if(del){
      const c = deskCopies.find(x => x.id === del.dataset.rcdel); if(!c) return;
      if(!window.confirm('Permanently delete the safety copy "' + c.db + ' — ' + (c.kind === 'monthly' ? monthName(c.tag) : 'old format ' + c.tag) + '"?\n\nThis does not delete or change the active database. This copy cannot be recovered after deletion.')) return;
      let result;
      try{ result = await window.fleetDesktop.dbDeleteCopy(c.id); }
      catch(err){ ctx.toast('Could not delete the safety copy: ' + (err && err.message || err)); return; }
      if(!result || !result.ok){ ctx.toast('Could not delete the safety copy: ' + (result && result.error || 'unknown error')); return; }
      ctx.toast('Safety copy deleted.');
      await open();
      return;
    }
    const cl = e.target.closest('[data-rcclean]');
    if(cl){ if(!window.confirm('Reset to a clean database? Everything entered is removed; only the monthly SQLite safety copy stays.')) return; close(); ctx.clean(cl.dataset.rcclean === 'people'); return; }
  });
  return { open };
}
