export function installMockDesktop(){
  const clone = value => JSON.parse(JSON.stringify(value));
  const empty = () => ({
    vehicles: [], drivers: [], clients: [], bookings: [], rentals: [], expenses: [], payments: [], invoices: [],
    driverAllowances: [], accounts: [], loans: [], insurance: [], chama: [], fuelAccount: [], coops: [], individuals: [],
    settings: { adminPin: null, chartType: 'pie' }, nextId: 1, period: null
  });
  const states = new Map([['Main', empty()]]);
  const settings = { lastUsed: 'Main', startWith: 'last', migrated: true };
  const copies = [{ id: 'Main - monthly 2026-10.db', db: 'Main', kind: 'monthly', tag: '2026-10', madeAt: Date.now(), savedAt: new Date().toISOString(), records: 0, size: 1024 }];
  let openOnce = '';
  const recordCount = data => Object.values(data).reduce((n, value) => n + (Array.isArray(value) ? value.length : 0), 0);
  const databaseList = () => [...states].map(([name, data]) => ({ name, modified: Date.now(), records: recordCount(data) }));
  const save = (name, data) => {
    states.set(name, clone(data));
    settings.lastUsed = name;
    return { ok: true, bytes: JSON.stringify(data).length, free: 10 * 1024 * 1024 * 1024 };
  };
  window.fleetDesktop = {
    dbSettings: async () => ({ ok: true, settings: clone(settings), databases: databaseList(), folder: 'test-data' }),
    dbSetSettings: async patch => ({ ok: true, settings: Object.assign(settings, patch) }),
    dbSetOpenOnce: async name => { openOnce = String(name || ''); return { ok: true }; },
    dbTakeOpenOnce: async () => { const name = openOnce; openOnce = ''; return { ok: true, name }; },
    dbLoad: async name => states.has(name)
      ? { ok: true, name, data: clone(states.get(name)), savedAt: new Date().toISOString() }
      : { ok: false, reason: 'missing' },
    dbSave: async (name, data) => save(name, data),
    dbSaveSync: (name, data) => save(name, data),
    dbCreate: async (name, data) => {
      if(states.has(name)) return { ok: false, error: 'already exists' };
      save(name, data);
      return { ok: true, name };
    },
    dbCopies: async () => ({ ok: true, copies: clone(copies) }),
    dbReadCopy: async () => ({ ok: false, error: 'No test copies' }),
    dbDeleteCopy: async id => {
      const index = copies.findIndex(copy => copy.id === id);
      if(index < 0) return { ok: false, error: 'not found' };
      copies.splice(index, 1);
      return { ok: true, id };
    },
    dbShowFolder: async () => ({ ok: true }),
    onFlush: () => {}
  };
}
