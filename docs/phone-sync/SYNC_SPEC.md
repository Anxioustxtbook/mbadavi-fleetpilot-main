# FleetPilot phone sync: message spec (protocol 1)

The phone app is planned from this file. The desktop side is in `electron/phone-sync/syncServer.cjs`; `test/phone-sync/helpers.cjs` holds a simulated phone.
This protocol currently uses plain HTTP and is not suitable for untrusted networks.

## Ground rules
- The **phone starts every conversation**. The desktop only listens. The desktop connection remains off until the owner presses Connect in the *Connect phone* window; it then stays on until disconnected or FleetPilot closes.
- HTTP + JSON over a trusted private local network only. The desktop binds to one private IPv4 address, default port 47600 (tries 47600 to 47610). Header `Content-Type: application/json`. Traffic is not encrypted.
- After pairing, every request carries `x-fp-device: <phoneId>` and `x-fp-token: <token>`.
- Errors are `{ ok:false, error:'<code>', message:'<plain words to show the user>' }` with an HTTP status. Show `message` as it is.
- Protocol number: send `protocol: 1`. A different number gets `426` with `error: 'update-app'` or `'update-desktop'`.

## Finding the desktop
1. **QR code** on the desktop holds JSON: `{"fp":1,"d":"<desktopId>","n":"<pc name>","a":["192.168.1.20:47600", ...],"p":"<PIN>","db":"<database name>"}`. Try each address in `a` with `GET /fp/hello`.
2. **Typed address + PIN** if the camera is denied.
3. **Rediscovery** when the address changed: broadcast UDP `FPDISCOVER <desktopId>` to port **47599**; the desktop answers `{"fp":1,"d":"<desktopId>","a":["ip:port", ...]}`.

`GET /fp/hello` -> `{ ok, fp:1, protocol, minProtocol, desktopId, name, db, appVersion, time }`

## Pairing (once)
- `POST /fp/pair` `{ pin, name, phoneId, instance, phoneTime, appVersion, protocol }`
  - `phoneId`: permanent id of the phone app, `[A-Za-z0-9_-]{6,64}`. `instance`: a random id made when the app database is created (a restored backup brings back an old one).
  - Replies `{ ok:true, pairingId }`, or `403 bad-pin` with `tryAgain:true`. The six-digit PIN expires after five minutes. Five incorrect PIN attempts from one network address lock pairing from that address for five minutes; changing the PIN does not bypass the lock. The phone shows the message and a **Try again** button. The PIN works for one phone, once, and a guessed PIN still needs the owner's Approve on the desktop.
- `GET /fp/pair/status?id=<pairingId>` every second or two until `status` is `approved` or `rejected`.
  - `waiting`: the owner has not answered on the desktop (`clock:true` means the owner is being asked which clock is right).
  - `approved`: `{ token, range:{start,end}, desktopId, db, desktopTime, snapshotSeq }`. **The token is delivered once**; store it securely.
- Pairing does not modify the live database; the desktop makes regular SQLite safety copies.

## Record numbers
- The desktop uses 1 to 999,999,999. Each phone gets `range.start` to `range.end` (first phone 1,000,000,000 to 1,999,999,999). The phone numbers its own records from `range.start` upward and **never** uses a number outside its range.
- A record's `id` is a number. Records point at each other with `vehicleId`, `clientId`, `driverId`, `rentalId`.

## First full copy
1. `POST /fp/full/begin` `{ protocol }` -> `{ snapshotSeq, counts:{list:n}, order:[lists, parents first] }`
2. `POST /fp/full/page` `{ li:0, off:0, size:200 }` -> `{ list, records:[...], next:{li,off}, done }`. Repeat with `next` until `done`. Write each page to SQLite in one transaction.
3. `POST /fp/full/done` `{ snapshotSeq, totals }` -> `{ totalsOk, diff }`. Remember `snapshotSeq` as `ack`.
- Lists: `vehicles drivers clients bookings rentals expenses payments invoices driverAllowances accounts loans insurance chama fuelAccount coops individuals`.
- Not sent, and not synced: `settings` (admin PIN, idle and screen settings), `nextId`, `period`. The first copy gets no green dots.
- `totals` = `{ list: { n: <record count>, sum: <sum of the "amount" field, 2 decimals> } }` for every list.

## One sync (the phone's Sync button)
Keep a **session id** (`[A-Za-z0-9_-]{8,64}`) until the sync finishes; reuse it to resume.
1. `POST /fp/sync/begin` `{ session, phoneTime, appVersion, protocol, instance, phoneSeq, ack, mode? }`
   - `phoneSeq`: the phone's own change counter (goes up with every local change, never down). `ack`: the last desktop change number the phone has saved.
   - Reply `{ pullUpTo, catchup, received:[batch numbers already stored], restoredPhone, restoredDesktop }`.
   - `409 clock-pending`: the desktop is asking its owner which clock is right. Show "Answer the question on the computer", wait a few seconds, call begin again. **Sync is never blocked by a wrong clock**, only paused for that answer.
   - `catchup:true`: the phone (or desktop) went back in time. Send **every** local record, not only the changes.
2. `POST /fp/sync/push` `{ session, batch:1.., changes:[...] }` in small batches (200 records is fine). Resend freely: the same batch number replaces itself. Skip batches listed in `received` when resuming.
3. `POST /fp/sync/commit` `{ session, batches:<N> }` -> `{ summary:{added,updated,deleted,held,conflicts,reviews}, pullUpTo, heldKeys, integrity }`.
   - `409 missing-batch` (`missing`): send that batch again, then commit again.
   - The desktop applies the whole sync in **one transaction**, parents first, checks the file before and after, and reads the records back. Any failure changes nothing.
4. `POST /fp/sync/pull` `{ session, cursor:-1, limit:200 }` -> `{ changes, next, done, pullUpTo }`. Repeat with `cursor = next` until `done`. Read only.
5. Apply every pulled change to the phone SQLite in **one transaction**, read back, then:
6. `POST /fp/sync/finish` `{ session, ack:<pullUpTo>, totals }` -> `{ totalsOk, diff, held, integrity }`. Only now does the desktop mark its changes as delivered. Show a warning if `totalsOk` is false.
7. Keep `pushedSeq = phoneSeq` after a successful commit; the next sync sends only what changed after that.

If anything fails before step 6, run the same sync again: nothing is lost and nothing is applied twice.

### A change
```
{ list, id, deleted:false, at:"<ISO time, phone clock>", dev:"<phoneId>", data:{...whole record...}, restore?:true }
{ list, id, deleted:true,  at, dev }
```
- Send the **whole record** every time, never part of it. `at` is when the edit was made (UTC ISO with milliseconds).
- `restore:true` is only used when the owner chose Restore on an item that was deleted; the phone applies such an upsert even though it holds a delete for that record.

### What the phone does with pulled changes
- Upsert by `(list,id)`; delete by `(list,id)`.
- **A delete stays a delete.** If the phone holds a delete for a record and a pulled upsert has no `restore:true`, ignore it.
- Keep the phone's own record when it was **held aside** by the desktop (`heldKeys`); the desktop will retry it at the next sync.
- Records the phone itself sent are not sent back unless the owner changed them since.
- Show a green dot on records that arrived by pull; clear it the next day. Do not save the dot in the record.

## Rules the desktop applies (the phone must expect them)
- Same record edited on both sides: the newest edit wins; the other version goes to the desktop's review list.
- Edit against delete: the delete stands; the edit goes to the review list (the owner may Restore).
- A record whose vehicle, client, driver or rental is missing is **held aside** (not applied) and retried at every later sync. Send parents before children when you can.
- Nothing is deleted by sync on its own. Overlapping bookings, duplicate entries and broken links are reported to the owner, never changed.
- Clock: at pairing and whenever the difference changes by more than two minutes, the owner is asked which clock is right; the difference is then used when deciding which edit is newest.

## Phone backup (on request, under Advanced)
`POST /fp/backup` with headers `x-fp-device`, `x-fp-token`, `x-fp-name: <label>` and the whole phone data as the body. It is stored in the desktop's safety copies folder and **never** replaces the live database.

## Checks every phone must do (the same as the desktop)
- Every phone write is one transaction; after a write, read the records back and compare. A mismatch is an error, and the data is not marked as saved.
- Stop cleanly when storage is full, leaving the phone as it was.
- Local SQLite writes: `PRAGMA synchronous = FULL`, check the file when it opens.


## Staying connected (the green bar)
- `POST /fp/ping` (headers `x-fp-device`, `x-fp-token`, empty body `{}`) replies `{ ok:true, time, desktopId }`, or `401 not-paired`.
- While the phone app is open and paired, call it about **every 15 seconds**. Any other call from a paired phone also counts. The desktop bar shows **green "Phone connected"** while the phone has spoken within the last **45 seconds**, and **"Syncing…"** during a sync. Stop pinging when the app goes to the background; the bar then returns to "Ready for a phone".
- A pairing request or a clock question turns the desktop bar amber ("A phone is waiting for your answer"), so it is not missed when the owner is on another screen.

## Developer backup (desktop and phone)
- **Desktop** (already built): `developer/<database> - developer.db` + `<database> - developer.json`, refreshed in place every 14 days, never shown on a screen, log in `backup-log.txt`. No safety copy is made at pairing any more.
- **Phone** (Step 2): the phone app keeps the same pair of files for its own database, in its app folder, refreshed in place every 14 days (checked when the app opens and after a successful sync), never shown on any screen, written to a temporary name, checked, then swapped in so a failed refresh keeps the old pair. The `.json` has the same shape as the desktop's (`{ app, kind:'developer-backup', database, madeAt, device, counts, data }`). The folder is the app's external files folder so the developer can reach it by USB or `adb pull` and open the `.db` in DB Browser for SQLite.
