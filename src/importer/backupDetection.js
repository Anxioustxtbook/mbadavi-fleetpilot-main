const headersOf = rows => (rows && rows[0] || []).map(value => String(value == null ? '' : value).trim().toLowerCase());

export function isFleetPilotBackup(sheets){
  if(!sheets || typeof sheets !== 'object') return false;
  const names = Object.keys(sheets).reduce((map, name) => {
    map[name.trim().toLowerCase()] = sheets[name];
    return map;
  }, Object.create(null));
  const meta = names.meta, settings = names.settings, rentals = names.rentals, vehicles = names.vehicles, expenses = names.expenses;
  if(!meta || !settings || !rentals || !vehicles || !expenses) return false;
  const metaHeaders = headersOf(meta), settingsHeaders = headersOf(settings);
  const rentalHeaders = headersOf(rentals), vehicleHeaders = headersOf(vehicles), expenseHeaders = headersOf(expenses);
  const nextId = Number(meta[1] && meta[1][metaHeaders.indexOf('nextid')]);
  return metaHeaders.includes('nextid')
    && Number.isFinite(nextId) && nextId > 0
    && settingsHeaders.includes('adminpin')
    && rentalHeaders.includes('id') && rentalHeaders.includes('vehicleid') && rentalHeaders.includes('clientid') && rentalHeaders.includes('pickup')
    && vehicleHeaders.includes('id') && vehicleHeaders.includes('reg')
    && expenseHeaders.includes('category') && expenseHeaders.includes('amount');
}
