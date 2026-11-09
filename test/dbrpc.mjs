/* Test helper: the real desktop store (electron/ledgerFile.cjs) behind a tiny local HTTP door, so a headless browser can use it as window.fleetDesktop.
   node test/dbrpc.mjs <rootFolder> <port> */
import http from 'http'; import { createRequire } from 'module';
const { createStore } = createRequire(import.meta.url)('../electron/ledgerFile.cjs');
const store = createStore({ root: process.argv[2] });
const api = { dbSettings: () => ({ ok: true, settings: store.getSettings(), databases: store.list(), folder: store.root }), dbSetSettings: p => ({ ok: true, settings: store.setSettings(p) }),
  dbLoad: n => store.load(n), dbSave: (n, d) => store.save(n, d), dbSaveSync: (n, d) => store.saveSync(n, d), dbCreate: (n, d) => store.create(n, d), dbCopies: () => ({ ok: true, copies: store.copies() }), dbReadCopy: id => store.readCopy(id), dbShowFolder: () => ({ ok: true }) };
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); if(req.method === 'OPTIONS'){ res.end(); return; }
  let b = ''; req.on('data', c => b += c); req.on('end', async () => { try{ const { fn, args } = JSON.parse(b); res.end(JSON.stringify(await api[fn](...args))); }catch(e){ res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) })); } });
}).listen(Number(process.argv[3]), () => console.log('ready'));
