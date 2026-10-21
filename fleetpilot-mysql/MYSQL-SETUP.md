# FleetPilot on MySQL

Browsers cannot talk to MySQL directly, so this adds a small API between the app and the database:

    FleetPilot (browser / .exe)  --HTTP-->  server/ (Node + Express)  --SQL-->  MySQL

IndexedDB stays on as an offline cache. If the server is unreachable the app keeps working and
re-syncs automatically when it is back.

## What's in this folder
| File | Purpose |
|---|---|
| `server/schema.sql` | Creates the `fleetpilot` database: vehicles, drivers, clients, bookings, rentals, expenses, payments, driver_allowances, app_state |
| `server/index.js`, `ledgerStore.js`, `db.js` | The API (`GET/PUT /api/ledger`, `GET /api/health`) |
| `server/import-xlsx.js` | Loads an existing FleetPilot Excel export into MySQL |
| `src/data/mysqlRepository.js` | New repository, drop-in for `LocalFleetRepository` (same `load()` / `save()`) |
| `src/main.js` | Your fixed main.js, now choosing the repository from `VITE_API_URL` |
| `.env.example`, `server/.env.example` | Settings |

## Steps
1. **Database** (MySQL 8+ or MariaDB 10.5+):
   `mysql -u root -p < server/schema.sql`
   Then create a limited user (commands are at the bottom of schema.sql, change the password).
2. **Server**:
   ```
   cd server
   copy .env.example .env      (fill in DB_USER / DB_PASSWORD, optionally API_KEY)
   npm install
   npm start
   ```
   Check http://localhost:3001/api/health shows `{"ok":true}`.
3. **Move your existing data** (use an Excel export from the app):
   `npm run import -- "C:\path\to\Fleet Ledger.xlsx"`
4. **App**: copy `src/main.js` and `src/data/mysqlRepository.js` into your project, copy `.env.example`
   to `.env.local` in the project root, set `VITE_API_URL=http://localhost:3001`, then rebuild/run as usual.

Leave `VITE_API_URL` empty to go back to local-only mode.

## How it behaves
- **Save**: every change is written to IndexedDB first, then pushed to MySQL (whole ledger, one transaction).
- **Two devices**: each save carries the revision it last saw. If another device saved in between, the
  server answers 409 and the app stops pushing (console message + `fleetpilot:sync` event with
  `status: 'conflict'`). Resolve in the browser console:
  `fleetRepository.pull()` takes the server copy, `fleetRepository.forcePush()` overwrites the server.
- **First run**: if the server is empty and this device already has data, that data is uploaded automatically.
  If the server already has data and you also have older local-only data, the server copy wins, so import first.
- **Bad references** (e.g. an expense pointing at a deleted vehicle) are cleared to NULL and listed as warnings.

## Security notes
- The admin PIN in this app is not authentication, and `API_KEY` is a shared secret that ends up inside the
  built JavaScript. Fine for your own LAN/VPN; before exposing this on the internet put it behind HTTPS and
  add real sign-in (the README roadmap already lists this).
- Never expose port 3306 publicly; only the API needs to reach MySQL.
- Back up with `mysqldump fleetpilot > backup.sql`.
