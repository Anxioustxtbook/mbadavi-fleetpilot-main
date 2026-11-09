/* FleetPilot phone sync: the Electron wiring. Connects the sync server to the window (the screen saves first, shows "Syncing...", reloads after)
   and gives the page its doors (see ledgerPreload.cjs). Needs Electron; the tests use syncServer.cjs directly. */
'use strict';
const path = require('node:path'), fs = require('node:fs');
const { createSync } = require('./syncServer.cjs');
const { createDevBackup } = require('./devBackup.cjs');

function registerSync(store){
  const { app, ipcMain, BrowserWindow } = require('electron');
  const win = () => BrowserWindow.getAllWindows()[0] || null;
  /* ask the page to do something and wait until it says it is done (a lost answer must never leave the app stuck, so it times out) */
  const ask = (channel, ack, payload, ms) => new Promise(resolve => {
    const w = win(); if(!w || w.isDestroyed()) return resolve(false);
    let done = false;
    const finish = ok => { if(done) return; done = true; clearTimeout(t); ipcMain.removeListener(ack, onAck); resolve(ok); };
    const onAck = (ev, ok) => finish(ok !== false);
    const t = setTimeout(() => finish(false), ms || 20000);
    ipcMain.on(ack, onAck);
    try{ w.webContents.send(channel, payload || {}); }catch(e){ finish(false); }
  });
  const sync = createSync({ store, hooks: {
    beforeApply: () => ask('sync:prepare', 'sync:prepared', {}, 20000),
    afterApply: info => ask('sync:reload', 'sync:reloaded', info, 20000)
  } });
  const dev = createDevBackup({ store });                                           // the quiet developer backup (.db + .json), refreshed every 14 days; never shown
  const safe = fn => async (...a) => { try{ return await fn(...a); }catch(e){ return { ok: false, error: String(e && e.message || e) }; } };
  ipcMain.handle('sync:open', safe((ev, name) => { if(name) dev.watch(name); return sync.ensure(name); }));              // starts the connection once; already running = nothing changes
  ipcMain.handle('sync:stop', safe(() => sync.stop()));                              // the owner pressed Disconnect
  ipcMain.handle('sync:restart', safe((ev, name) => { if(name) dev.watch(name); return sync.start(name); }));
  ipcMain.handle('sync:newPin', safe(() => sync.refreshPin()));
  ipcMain.handle('sync:bar', safe(() => ({ ok: true, bar: sync.barStatus() })));
  ipcMain.handle('sync:status', safe(() => ({ ok: true, status: sync.status() })));
  ipcMain.handle('sync:approve', safe((ev, id, choice) => sync.approve(id, choice)));
  ipcMain.handle('sync:reject', safe((ev, id) => sync.reject(id)));
  ipcMain.handle('sync:clock', safe((ev, deviceId, ref) => sync.setClock(deviceId, ref)));
  ipcMain.handle('sync:review', safe(() => ({ ok: true, items: sync.reviewList() })));
  ipcMain.handle('sync:resolve', safe((ev, id, action, payload) => sync.resolve(id, action, payload)));
  ipcMain.handle('sync:arrivals', safe(() => ({ ok: true, items: sync.arrivals() })));
  ipcMain.handle('sync:health', safe(() => Object.assign({}, sync.healthCheck())));
  ipcMain.handle('sync:extras', safe(() => ({ ok: true, items: sync.phoneBackups() })));
  ipcMain.handle('sync:deleteExtra', safe((ev, name) => {                     // only ever on request, and only the files sync itself made
    const base = path.basename(String(name || ''));
    if(base !== String(name) || !/ - (phone backup|before pairing) /.test(base)) return { ok: false, error: 'not a file made by phone sync' };
    fs.unlinkSync(path.join(store.dirs.copies, base)); return { ok: true };
  }));
  app.on('will-quit', () => { try{ dev.stop(); sync.stop(); }catch(e){} });
  return sync;
}
module.exports = { registerSync };
