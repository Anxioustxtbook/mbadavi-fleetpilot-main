import { OWNER_SHEETS } from '../src/ownerSheets.js';
import { balanceChecks } from '../src/balance.js';
import { monthlySummary } from '../src/summary.js';
import * as CP from '../src/carPerf.js';
const N = Number(process.argv[2] || 5000);
const vehicles = Array.from({ length: 40 }, (_, i) => ({ id: 'v' + i, reg: 'KD' + i, ownership: i % 3 ? 'own' : 'subhire' }));
const clients = Array.from({ length: 300 }, (_, i) => ({ id: 'c' + i, name: 'Client ' + i, type: i % 4 ? 'walkin' : 'coop' }));
const rentals = [], payments = [], expenses = [], coops = [], invoices = [];
for(let i = 0; i < N; i++){ const m = 1 + (i % 12), d = 1 + (i % 27), date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  rentals.push({ id: 'r' + i, vehicleId: 'v' + (i % 40), clientId: 'c' + (i % 300), pickup: date, return: date, days: 1, amount: 3500, fuel: 200, status: 'Completed', invoice: 'I' + (i % 400), subhireCost: i % 3 ? 0 : 2800 });
  payments.push({ id: 'p' + i, rentalId: 'r' + i, date, amount: 3500 });
  expenses.push({ id: 'e' + i, vehicleId: 'v' + (i % 40), date, category: ['Fuel', 'Cleaning', 'Garage', 'Transport', 'Airport'][i % 5], amount: 200, desc: 'x' });
  if(i % 4 === 0) coops.push({ id: 'k' + i, name: 'N' + i, rentalId: 'r' + i, start: date, end: date, days: 1, amount: 3500, contract: String(i) });
  if(i % 12 === 0) invoices.push({ id: 'i' + i, no: 'I' + (i % 400), date, amount: 3500 }); }
const db = { vehicles, clients, drivers: [], rentals, payments, expenses, coops, invoices, insurance: [], fuelAccount: [], accounts: [], loans: [], settings: {}, nextId: 99999 };
const t = (label, f) => { const s = performance.now(); f(); console.log(label.padEnd(34), (performance.now() - s).toFixed(0).padStart(6), 'ms'); };
console.log('rentals', N, 'expenses', N, 'payments', N);
t('JSON.stringify(db) (every autosave)', () => JSON.stringify(db));
t('balanceChecks', () => balanceChecks(db));
t('monthlySummary (1 year)', () => monthlySummary(db, '2026-01', '2026-12'));
const cpf = CP.carPerformance || CP.carRows || CP.perfRows; if(cpf) t('car performance rows', () => cpf(db, '', '')); else console.log('car perf fn:', Object.keys(CP));
const mk = () => { const sheets = []; return { addWorksheet(name){ const cells = new Map(); const ws = { name, views: [], getCell(r, c){ const k = r * 100 + c; if(!cells.has(k)) cells.set(k, {}); return cells.get(k); }, getColumn(){ return {}; } }; sheets.push(ws); return ws; } }; };
for(const [key, name, build] of OWNER_SHEETS){ t('sheet ' + name, () => build(mk(), db)); }
