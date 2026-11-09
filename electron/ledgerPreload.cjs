/* FleetPilot desktop side of the database. Runs in the Electron PRELOAD script: gives the page (window.fleetDesktop) a few safe doors, nothing else.
   The page can only reach the database folder through these; it cannot read or write any other path. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fleetDesktop', {
  dbSettings: () => ipcRenderer.invoke('db:settings'),
  dbSetSettings: patch => ipcRenderer.invoke('db:setSettings', patch),
  dbSetOpenOnce: name => ipcRenderer.invoke('db:setOpenOnce', name),
  dbTakeOpenOnce: () => ipcRenderer.invoke('db:takeOpenOnce'),
  dbLoad: name => ipcRenderer.invoke('db:load', name),
  dbSave: (name, data, rev) => ipcRenderer.invoke('db:save', name, data, rev),
  dbSaveSync: (name, data, rev) => ipcRenderer.sendSync('db:saveSync', name, data, rev),   // for the moment the window closes
  dbCreate: (name, data) => ipcRenderer.invoke('db:create', name, data),
  dbDelete: (name, activeName) => ipcRenderer.invoke('db:delete', name, activeName),
  dbDaily: (name, date) => ipcRenderer.invoke('db:daily', name, date),
  dbCopies: () => ipcRenderer.invoke('db:copies'),
  dbReadCopy: id => ipcRenderer.invoke('db:readCopy', id),
  dbDeleteCopy: id => ipcRenderer.invoke('db:deleteCopy', id),
  dbShowFolder: () => ipcRenderer.invoke('db:showFolder'),
  /* phone sync (see syncMain.cjs) */
  syncOpen: name => ipcRenderer.invoke('sync:open', name),
  syncStop: () => ipcRenderer.invoke('sync:stop'),
  syncRestart: name => ipcRenderer.invoke('sync:restart', name),
  syncNewPin: () => ipcRenderer.invoke('sync:newPin'),
  syncBar: () => ipcRenderer.invoke('sync:bar'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncApprove: (id, choice) => ipcRenderer.invoke('sync:approve', id, choice),
  syncReject: id => ipcRenderer.invoke('sync:reject', id),
  syncClock: (deviceId, ref) => ipcRenderer.invoke('sync:clock', deviceId, ref),
  syncReview: () => ipcRenderer.invoke('sync:review'),
  syncResolve: (id, action, payload) => ipcRenderer.invoke('sync:resolve', id, action, payload),
  syncArrivals: () => ipcRenderer.invoke('sync:arrivals'),
  syncHealth: () => ipcRenderer.invoke('sync:health'),
  syncExtras: () => ipcRenderer.invoke('sync:extras'),
  syncDeleteExtra: name => ipcRenderer.invoke('sync:deleteExtra', name),
  /* the computer asks the screen to save and show "Syncing...", and later to reload; the screen answers when it is done */
  onSyncPrepare: cb => ipcRenderer.on('sync:prepare', async () => { let ok = true; try{ ok = (await cb()) !== false; }catch(e){ ok = false; } ipcRenderer.send('sync:prepared', ok); }),
  onSyncReload: cb => ipcRenderer.on('sync:reload', async (ev, info) => { let ok = true; try{ ok = (await cb(info || {})) !== false; }catch(e){ ok = false; } ipcRenderer.send('sync:reloaded', ok); }),
  onFlush: cb => ipcRenderer.on('db:flush', async () => { try{ await cb(); }finally{ ipcRenderer.send('db:flushed'); } })
});
