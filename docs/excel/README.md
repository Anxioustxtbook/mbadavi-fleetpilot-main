# FleetPilot: Excel save, month by month and plain (on top of Sync 1C)

Only the saved Excel file changed. The database, the sync and the data tabs are untouched, so Open restores exactly as before.

## What was wrong
- **Statement** and **Fleet Summary** only wrote the one "open" month (January), so a yearly Save gave January and nothing else.
- **Totals** was cut to that same month.

## What changed (src/ledger.js, src/ownerSheets.js, src/fileLayout.js)
- **Statement**: car by car, and inside each car every month that has a rental or expense ("KDQ 652A STATEMENT FOR MARCH 2026"), then a **Fleet-wide total by month** table with a TOTAL line.
- **Fleet Summary**: one block per month (every car, with a fleet total), then a **WHOLE PERIOD** block for the full span.
- **Totals**: now covers the whole span of the data (title shows e.g. JANUARY 2026 TO OCTOBER 2026).
- **Fuel**: now covers the full data span rather than only the currently open month, with a monthly fuel-cost, client-charge and net-recovery table plus a period total.
- **Plain layout, coloured numbers**: tab colours, grey header fills and amber month bands are gone; headings and totals are bold with thin borders. Money figures keep their green/red/orange text. Month lines stay (bold, underlined) so long sheets still show which month each record is for.
- "LESS EXPENSES" now reads **EXPENSES**; "Net total (revenue less expenses)" now reads "revenue minus expenses".
- Amounts in the Statement and Fleet Summary have thousands separators.
- Month limits are compared as dates in text form, so rentals on the last day of a month are always counted in that month.

## Not changed on purpose
- The **COOP "Excel schedule"** export (coop.js) keeps its blue/grey header because it copies your client's Car_hire_schedule format.
- Save scope **current month / previous month** still limits the file to that month, as chosen. Only the full/yearly Save writes all months.

## Tested here / not tested
- Tested: the new Statement and Fleet Summary code on a 10-month, 3-car test year (every month appears, cancelled rentals excluded, last-day rentals counted, no coloured cells, no "LESS EXPENSES").
- NOT tested: a real Save from FleetPilot with your real data and a look at the result in Excel. Please save a yearly file and tell me what you see.

## Found, not changed
The older `inRange()` compares a date typed as text against a local-midnight end date. In a time zone ahead of UTC (Kenya), a rental on the last day of a month can fall just outside the month in Dashboard and Reports. I did not change it because it would alter figures on screens you did not ask about.

## Update 1D-2
- Number colours are back (revenue/collected green, expenses red, and so on); tabs, fills and month bands stay plain.
- No new tabs: the year file has the same sheets as before.
- Per-month Save (current or previous month) uses the same builders, so it reads the same way: that one month's Statement per car, one Fleet Summary block, no "whole period" block.
- A FleetPilot-generated workbook is a database backup, not a source workbook: use **Open Excel backup** to restore it. **Import Excel** now detects and blocks that backup format before any records can be added.
- Shorter reading: in each car's monthly block the expenses are one line per kind (for example Garage, 3 items, total) instead of one line per receipt. The full list stays on GARAGE, FUEL SHEET, CARWASH, TRANSPORT and the data tabs. Rental lines are grouped so Excel's outline buttons can fold them. Blank gaps between blocks are smaller.
