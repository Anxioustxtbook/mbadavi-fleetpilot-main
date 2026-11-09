# Mbadavi Fleetpilot

Fleet and rental ledger for Mbadavi Investment Limited. It is a Windows desktop app packaged with Electron; the ledger uses the app's local SQLite database.

## Commands

```powershell
npm install
npm run dev                # Vite dev server; ledger data is available only in the desktop app
npm run desktop            # build, then open the desktop app
npm start                  # open the desktop app using the existing dist/ build
npm run desktop:portable   # build release/FleetPilot <version>.exe (single portable file)
npm run desktop:installer  # build release/FleetPilot Setup <version>.exe (NSIS installer)
npm run build              # production web build in dist/
npm run preview            # serve dist/ locally
npm run test:sync          # phone-sync protocol tests with a simulated phone
```

## Project layout

The app source is the current desktop update (see `docs/CHANGES-v22.txt` for historical changes from v3 to v22).
The previous modular version is kept untouched in `backup-before-v22/`.

```
electron/
  main.cjs              Electron main process: window, single-instance lock, link handling
  ledgerFile.cjs        SQLite database in %APPDATA%\FleetPilot (save on every change, monthly copies, format upgrades)
  ledgerPreload.cjs     Preload: gives the page window.fleetDesktop (the only door to that folder)
  phone-sync/           Desktop sync server, merge engine, SQLite tracking and developer backups
index.html              App markup and styles (Vite entry, self-contained)
public/                 Icons copied as-is into the build
build/                  electron-builder resources (app icon)
src/
  main.js               Bootstrap: desktop SQLite bridge, ExcelJS, table tools, keyboard nav, then ledger.js
  ledger.js             The app core: state, screens, save/open, dashboard, reports
  dbPersist.js          Opens/saves the desktop SQLite database and recovers SQLite safety copies
  phone-sync/           Connect phone UI, pairing help and QR generator
  order.js              Table order: newest record first (inside each month for month-grouped tables)
  importer/             Excel import of the PERFOMANCE workbook (rentals, expenses, invoices, payments, admin sheets)
  calendar.js, holidays.js, today.js, idle.js           Calendar, Kenyan holidays, Today box, idle screen
  performance.js, carPerf.js, balance.js, chips.js      Performance, per-car figures, balance check, filter chips
  fuel*.js, coop.js, subhire*.js, loans.js              Fuel account, Coop, Sub-hire, Loans
  payRoute.js, payUi.js                                 Payments hub (money in / money out)
  pilot*.js, pages.js, ownerSheets.js, fileLayout.js    Admin (Pilot), Pages, Excel save layout
test/                   Node tests (*.test.mjs), phone-sync tests (phone-sync/), and older headless-browser scripts (*.py)
server/                 Old optional SQLite API: no longer used by the app
docs/                   CHANGES-v22.txt, WORKFLOW.md, desktop-database.txt, phone-sync/ and excel/
```

### Tests

Run each from inside `test/`, e.g. `cd test; node yearround.test.mjs`. All 25 `*.test.mjs` files pass.

## Troubleshooting

- **`EPERM: operation not permitted, rename ...win-unpacked.tmp` when packaging.** Something is locking new folders inside the project, usually Windows Defender's Controlled Folder Access or antivirus scanning the freshly extracted `electron.exe`. Allow Node/electron-builder in that tool, or build to another folder, e.g. `npx electron-builder --win portable --config.directories.output=C:\fleetpilot-release`.
- **The app starts as plain Node from a VS Code terminal.** VS Code sets `ELECTRON_RUN_AS_NODE`. Run `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) first.

## Data

In the desktop app the ledger is a SQLite database: `%APPDATA%\FleetPilot\databases\<name>.db`, using the `node:sqlite` module built into Electron (nothing to install). Each record is a row in the `records` table. Every save is one transaction, about half a second after each change and again when the window closes. One safety copy per month goes to `copies\`. Installing a newer version never touches this folder. Pilot > Database chooses which database opens at start.

On the first start of this version, any `.fpdb.json` database from v21 or earlier is moved into SQLite once. The old file is kept, unchanged, in `old-files\`. Old monthly `.fpdb.json` copies can still be opened from Recover an earlier copy.

The browser development page does not load or save ledger data; it displays a message requiring the installed desktop app. No IndexedDB or localStorage ledger fallback is used.

SQLite autosaves ledger changes. Excel is only used when you ask: File & backup > Save Excel backup / Open Excel backup / Import.

The admin PIN is not authentication.

## Roadmap

1. Validate workbook import/export against real ledger files.
2. Add secure sign-in for the Mbadavi owner account and a hosted database.
3. Build and test the FleetPilot mobile app against docs/phone-sync/SYNC_SPEC.md.
4. Add encrypted transport before pairing on untrusted networks or using sync with production data.
