# Mbadavi Fleetpilot

Vite-based installable web app built from the existing Fleet Ledger. The current vanilla JavaScript UI and ledger rules are retained in `src/ledger.js`; Vite/PWA setup and ExcelJS are kept outside that ledger module.

## Run locally

```powershell
npm install
npm run dev
```

Create and inspect a production build with `npm run build` and `npm run preview`. Service workers are generated for production builds; browsers require HTTPS or localhost for installation and offline use.

## Data boundary

`src/data/repository.js` is the local persistence boundary. The full working ledger is saved to IndexedDB after changes and restored automatically when the app opens. Excel workbooks remain the portable import/export and backup format. The current ledger rules remain in `src/ledger.js`.

A future repository implementation can replace `LocalFleetRepository` behind the `load()` and `save(state, metadata)` contract. Cloud storage and sync are not implemented yet. The current admin PIN is not authentication.

The Vite foundation can host a React entry later, allowing screens to be migrated incrementally without rewriting ledger rules or the repository boundary. React is intentionally not introduced during this preservation-focused migration.

## Build Roadmap

1. Keep IndexedDB as the on-device source of truth and validate workbook import/export against real ledger files.
2. Add secure sign-in for one Mbadavi owner account and a hosted database.
3. Add retryable offline-to-cloud sync, conflict handling, and recovery tests across desktop and phone.
4. Package the web app for Android with Capacitor after local storage and sync behavior are stable.

For now, data is local to each browser/device. Excel export is the way to move a backup between devices until cloud sync is built.
