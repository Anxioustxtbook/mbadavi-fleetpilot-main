# FleetPilot import and admin build: where we are

Base: the "all latest files" version (File & backup window, Excel save). SQLite is dropped.
Test data: `test/workbook.json` (PERFOMANCE_2026.xlsx dumped to JSON). Run `node test/run1.mjs` to see results.

## Done (in `src/importer/`)
| File | What it does |
|---|---|
| `util.js` | Dates, times, registrations, "1ST-9TH" ranges, typo suggestions, review-item helper |
| `rentals.js` | Reads CAR PERFORMANCE and SUBHIRE, per-car month sheets; validates rentals; links sub-hire costs to SUBHIRE lines |
| `expenses.js` | Reads FUEL, CARWASH, TRANSPORT, GARAGE, AIRPORT FEE, ALLOWANCE, SUBHIRE DRIVER |
| `admin.js` | Reads LOAN (schedule to 2028, due days), INSURANCE, CHAMA (paid vs due) |
| `index.js` | `analyze()` builds clean data, review list, cross-checks; `decide()` records a fix so a re-import replays it |

Result on the real workbook: 1,194 rentals, 1,945 costs, 152 allowances, 14 loans, 11 insurance lines, 2 chama schemes. Billed 21.7M, sub-hire cost 14.5M (6.0M sub-hired plates, 8.5M the 8 own-column cars).

## Last point reached (not yet fixed)
1. 126 rows have the text TAXI in the DAYS cell, so they are wrongly flagged "Days is not a number". Treat TAXI as a one-day job (or a separate type) instead.
2. KDQ 652A sheet: month headings like "JANUARY FEBUARY" (no dash) are not recognised, so block totals compare wrongly. Fix the heading detection in `parsePerCarSheet` (`rentals.js`).
3. FUEL closing rows still differ by small amounts on 6 months. Needs a look at rows that carry balances.
4. Sheet1 monthly summary does not line up with the detail sheets (looks like a different month grouping). Shown as information only.

## Remaining steps
1. Fix the 4 points above, re-run `node test/run1.mjs`, confirm review counts.
2. `merge.js`: put `analyze()` output into the app database (vehicles, clients, drivers, rentals, expenses, allowances), skipping rows already imported and listing "changed in Excel" rows.
3. Data model: rentals get sub-hire cost, paid tick and paid date; vehicles get owner, daily cost, own or sub-hire; new database parts for loans, insurance, chama. Add these to `DATA_SHEETS`, `buildWorkbook`, `workbookToDb` in `src/ledger.js` so Save and Open keep them.
4. Import window in File & backup: choose the xlsx, read it with ExcelJS into rows, run `analyze`, show the review list with one-click fixes, "apply all suggested", then import.
5. Admin area behind the existing PIN: loans (due this month, paid, balance), insurance (dates, alerts), chama as a savings tracker (saved so far, behind by, next due, tick paid).
6. Sub-hire view: amount still owed to car owners, paid ticks, auto cost = days x vehicle daily cost on new rentals.
7. Vehicle month by month view, replacing the per-car sheets.
8. Test in a browser with the real data, then package a zip.
9. Later: INVOICE, COOP, OCHWADA sheets (client payments), so "still owed" is correct.

## Questions for the owner
- Fuel on a rental: is it already inside AMOUNT, charged on top, or only a cost you carried?
- Were rentals paid in full unless a client statement says otherwise?
- Insurance dates: payment date or expiry date? What are the small amounts (e.g. 7,600)?
- Loans: assume paid up to last month?
- Chama rows 42-74 and LOAN rows 62-87 (LAWYER, WIN, SAM...): what are they?
- Day count: do you count the first day (1-3 Jan = 3) or by return time?
- The 8 own-column cars: confirm their SUBHIRE column is treated as sub-hire cost.

## Files being edited
Existing app files are untouched so far. New work is only in `src/importer/` and `test/`. Next edits will be in `src/ledger.js` and `index.html`.

---
## Status, 24 Oct 2026 (build 3)

Done and tested (node tests + headless-browser run against PERFOMANCE_2026.xlsx):
- Four open fixes: TAXI rows (type taxi, 1 day when same date), KDQ 652A headings and totals, side-table numbers ignored.
  Fuel closing totals are the workbook's own shifting SUM ranges (rows 188/254/354/444/592/697), not an importer fault.
- Data model: client type (walk-in / coop / taxi), area; rental type, driver, billing override, hours, allowance, sub-hire cost/paid, paid, xlRef.
  Accounts (OCHWADA statement), Loans, Insurance, Chama, standing expenses (Rent), Overview snapshots. Save and Open keep all of it.
- Billing: src/billing.js. Default by day(s); same-day shows hours; per-vehicle mode, per-rental override.
- Importer: COOP sheet names + contract numbers matched to rentals (153 of 196), Sheet2 walk-in clients, OCHWADA statement, standing rent.
- Import window (File & backup > Import Excel): shows what was read, every flagged line with one-click fixes, imports only after "I have reviewed this".
  Running it again adds nothing twice (xlRef).
- Pilot (admin, PIN): Overview (was Sheet1), Loans, Insurance (expiry editable), Chama tracker, OCHWADA statement with BF carry option.
- Clients: type and area, type filter, no double add. Rentals list: type column.

Open for the owner:
- Sheet1 / Overview does not equal the detail sheets (Sheet1 is typed). Which is right?
- 41 COOP rentals and 43 COOP lines did not match: pick the person in the review list.
- Sheet rows not read: LOAN rows 62-87, CHAMA rows 47-74, SUBHIRE rows 277, 479, 588.
- Yellow cells on Sheet3 (rows 365, 369-377) and COOP (163, 167, 172): meaning?


## Status, build 4 (rental form, Performance, allowance)

Done and tested in the browser run (test/browser.py and test/browser2.py):
- Vehicles: ownership (own / sub-hire), sub-hire cost per day, how the car is billed (by day(s), by time with extra hours, by the hour), hourly rate.
- Rental form: client type (walk-in / coop / taxi) filters the client list; "or a new client" adds one without double-adding the same name;
  driver; how this rental is charged (car default, by day(s), by time, by the hour, days entered, agreed total); amount override;
  driver allowance; sub-hire cost and owner paid (shown for sub-hire cars). A live line shows the time taken and the charge.
- Client list: "↗ Rental" starts a rental for that client (type, client, usual car and driver filled in). Clients cannot be added twice by name.
- Rentals list: type filter, driver, duration and allowance columns.
- Fuel on a rental is a cost carried; "charged to client" is blank (0) unless filled in. Imported rentals do not create a second fuel expense.
- Allowance: recorded on the rental. The weekly allowance log is removed; the Drivers panel shows allowances given by driver for the period,
  and the Totals report counts them. Old entries in a saved file are still counted.
- Performance panel (was CAR PERFORMANCE): every rental, choose and add columns, filter by dates / type / vehicle / search, totals row. Column choice is saved.

Not done:
- Save then Open of the new fields in a real .xlsx (tested with a stand-in reader only).
- Review-screen choices for the 41 unnamed COOP rentals (pick the person), and the rows listed under "Open for the owner".
- Paid tick / paid date on a rental (Payments still decide Paid and Owed).

---
## Status, 25 Oct 2026 (build 4)
Done and tested in a headless browser with PERFOMANCE_2026.xlsx: calendar, holidays, idle screen, paid tick, filters, clickable dashboard cards,
Pages (drill-down), invoice import, payments from Excel. Not tested here: Save/Open of the new Invoices sheet with the real ExcelJS (npm was blocked in the build sandbox);
the columns follow the same pattern as Loans/Insurance, so please Save then Open once and check Invoices and Payments are still there.
Open questions: which of the 721 rentals with no listed payment were paid; the 56 "not linked" payments (KSh 2.75M) need linking to rentals; Idd-ul-Azha 2026 date (27 or 28 May).
