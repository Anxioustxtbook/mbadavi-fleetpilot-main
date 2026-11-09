import test from 'node:test';
import assert from 'node:assert/strict';
import { isFleetPilotBackup } from '../src/importer/backupDetection.js';

test('recognizes a FleetPilot database backup using its data tabs and metadata', () => {
  const sheets = {
    Meta: [['nextId'], [12]],
    Settings: [['adminPin', 'chartType'], ['', 'pie']],
    Rentals: [['id', 'vehicleId', 'clientId', 'pickup'], [1, 2, 3, '2026-01-01']],
    Vehicles: [['id', 'reg'], [2, 'KDA 123A']],
    Expenses: [['category', 'amount'], ['Fuel', 100]]
  };
  assert.equal(isFleetPilotBackup(sheets), true);
});

test('does not classify a source performance workbook as a FleetPilot backup', () => {
  const sheets = {
    'CAR PERFORMANCE': [['CLIENT', 'CAR REGISTRATION'], ['Example Client', 'KDA 123A']],
    FUEL: [['DATE', 'CAR', 'FILL'], ['2026-01-01', 'KDA 123A', 100]]
  };
  assert.equal(isFleetPilotBackup(sheets), false);
});
