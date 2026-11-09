/* One call that keeps every table pointing at things that exist and the Coop table in step with Rentals.
   Runs after every change (ledger.js markDirty) and when a file is opened. Cheap: a few passes over the lists. */
import { repair, repairedCount } from './cascade.js';
import { syncCoopsFromRentals } from './coop.js';

export function housekeeping(db, uid){
  ['coops', 'individuals'].forEach(k => { if(!Array.isArray(db[k])) db[k] = []; });
  const fixed = repair(db), sync = syncCoopsFromRentals(db, uid);
  return { fixed: repairedCount(fixed) + sync.made + sync.joined, repair: fixed, sync };
}
