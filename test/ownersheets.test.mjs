import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { OWNER_SHEETS } from '../src/ownerSheets.js';
class Cell { constructor(){ this.value = null; } }
function mkWb(){ const sheets = [];
  return { sheets, addWorksheet(name){ const cells = new Map(), cols = {}; const ws = { name, cells, cols, views: [], getCell(r, c){ const k = r + ',' + c; if(!cells.has(k)) cells.set(k, new Cell()); return cells.get(k); }, getColumn(i){ return cols[i] = cols[i] || {}; } }; sheets.push(ws); return ws; } }; }
const db = {
  vehicles: [{ id: 1, reg: 'KDU 714H', make: 'Toyota', model: 'Rav4' }, { id: 2, reg: 'KDG 700H' }],
  clients: [{ id: 1, name: 'COOP BANK', type: 'coop' }, { id: 2, name: 'JOHN', type: 'walkin' }],
  drivers: [{ id: 1, name: 'WILLICE' }],
  rentals: [
    { id: 1, vehicleId: 1, clientId: 1, pickup: '2026-09-01', return: '2026-09-03', pickupTime: '7:00AM', returnTime: '6:00PM', days: 3, amount: 10500, fuel: 2000, allowance: 1000, driverId: 1, status: 'Completed', subhireCost: 8100 },
    { id: 2, vehicleId: 2, clientId: 2, pickup: '2026-09-05', return: '2026-09-05', days: 1, amount: 3500, status: 'Completed' },
    { id: 3, vehicleId: 2, clientId: 2, pickup: '2026-10-02', return: '2026-10-21', days: 20, amount: 70000, status: 'Cancelled' }],
  coops: [{ id: 1, name: 'TEVINE', start: '2026-09-01', end: '2026-09-03', days: 3, amount: 10500, contract: '5509', department: 'Sales', kmOut: 138295, kmIn: 138650, rentalId: 1 }],
  expenses: [{ id: 1, vehicleId: 1, date: '2026-09-02', category: 'Fuel', amount: 5000, account: 'Ola', rentalId: 1 }, { id: 2, vehicleId: 2, date: '2026-09-04', category: 'Cleaning', amount: 200 },
    { id: 3, vehicleId: 2, date: '2026-09-06', category: 'Garage', desc: 'D BUSHES', amount: 4000 }, { id: 4, date: '2026-09-07', category: 'Transport', desc: 'WILLICE', amount: 100 }, { id: 5, vehicleId: 1, date: '2026-09-09', category: 'Airport', desc: 'PARKING', amount: 113 }],
  invoices: [{ id: 1, client: 'COOP', no: '1128', date: '2026-09-05', amount: 314495, vat: 39280, status: 'paid' }],
  insurance: [{ id: 1, vehicleId: 1, amount: 7600, paidDate: '2026-09-03' }], fuelAccount: [{ id: 1, date: '2026-09-01', kind: 'topup', amount: 5000 }],
  accounts: [{ id: 1, account: 'OCHWADA', kind: 'bf', amount: 128768, month: '2026-09' }, { id: 2, account: 'OCHWADA', kind: 'payment', amount: -10000, date: '2026-09-02' }], settings: {} };
const wb = mkWb(); const out = {};
for(const [key, name, build] of OWNER_SHEETS){ build(wb, db); }
wb.sheets.forEach(ws => { const rows = {}; ws.cells.forEach((c, k) => { const [r, cc] = k.split(',').map(Number); (rows[r] = rows[r] || {})[cc] = c.value instanceof Date ? '@@' + c.value.toISOString().slice(0, 10) : c.value; }); out[ws.name] = rows; });
fs.writeFileSync(path.join(os.tmpdir(), 'own.json'), JSON.stringify(out));
console.log('sheets:', Object.keys(out).join(' | '));
