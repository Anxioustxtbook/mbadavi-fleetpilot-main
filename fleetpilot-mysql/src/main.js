import ExcelJS from 'exceljs';
import { registerSW } from 'virtual:pwa-register';
import { LocalFleetRepository } from './data/repository.js';
import { MySqlFleetRepository } from './data/mysqlRepository.js';

window.ExcelJS = ExcelJS;

// Set VITE_API_URL (see .env.example) to store data in MySQL; leave it blank for local-only.
const apiUrl = import.meta.env.VITE_API_URL;
window.fleetRepository = apiUrl
  ? new MySqlFleetRepository({ baseUrl: apiUrl, apiKey: import.meta.env.VITE_API_KEY || '' })
  : new LocalFleetRepository();

// Service workers only work on http(s)/localhost. Inside the Electron .exe
// (file://) there is nothing to register, so skip it and never let it block the app.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    registerSW({ immediate: true });
  } catch (err) {
    console.warn('Service worker registration skipped:', err);
  }
}

import('./ledger.js').catch((err) => {
  console.error('FleetPilot failed to start:', err);
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 14px;' +
    'background:#7a1f1f;color:#fff;font:14px system-ui,sans-serif;';
  banner.textContent = 'FleetPilot failed to start: ' + (err && err.message ? err.message : err);
  document.body.appendChild(banner);
});
