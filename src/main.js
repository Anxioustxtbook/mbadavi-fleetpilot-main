import './errors.js';   // first, so an error anywhere after it is caught and shown
import ExcelJS from 'exceljs';
import { initTableTools } from './tableTools.js';
import { initKeyNav } from './keyNav.js';

if (!window.fleetDesktop || typeof window.fleetDesktop.dbLoad !== 'function' ||
    typeof window.fleetDesktop.dbSave !== 'function' || typeof window.fleetDesktop.dbSettings !== 'function' ||
    typeof window.fleetDesktop.dbSetOpenOnce !== 'function' || typeof window.fleetDesktop.dbTakeOpenOnce !== 'function') {
  document.body.classList.remove('fp-loading');
  const notice = document.createElement('main');
  notice.style.cssText = 'min-height:100vh;display:grid;place-items:center;padding:24px;color:#fff;background:#0B0E12;font:16px/1.5 system-ui,sans-serif;text-align:center;';
  notice.innerHTML = '<div style="max-width:560px"><h1>FleetPilot desktop app required</h1><p>Your ledger is stored in the installed app’s SQLite database. Open FleetPilot from its desktop shortcut; browser storage is not used.</p></div>';
  document.body.replaceChildren(notice);
} else {
  window.ExcelJS = ExcelJS;
  initTableTools();
  initKeyNav();

  setTimeout(() => document.body.classList.remove('fp-loading'), 15000);
  import('./ledger.js').catch((err) => {
    console.error('FleetPilot failed to start:', err);
    document.body.classList.remove('fp-loading');
    const banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 14px;' +
      'background:#7a1f1f;color:#fff;font:14px system-ui,sans-serif;';
    banner.textContent = 'FleetPilot failed to start: ' + (err && err.message ? err.message : err);
    document.body.appendChild(banner);
  });
}
