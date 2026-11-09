# FleetPilot desktop phone sync

This folder documents the desktop sync implementation and the protocol for a future mobile app. The mobile app is not included, and real-phone pairing has not been tested. SQLite remains the desktop's primary database; Excel stays a manual export/import workflow.

## Code and tests

- `electron/phone-sync/`: desktop sync server, merge engine, SQLite tracking, developer backups
- `src/phone-sync/`: Connect phone UI, help, QR code generator
- `test/phone-sync/`: simulated-phone and cascade tests
- `docs/phone-sync/SYNC_SPEC.md`: protocol specification for the mobile app
- `docs/excel/README.md`: Excel export changes
- `npm run test:sync`: run phone-sync tests without Electron

The listener is **off until you open File & backup > Connect phone and press Connect**. It stays on until you disconnect or close FleetPilot. Pair only over a trusted private network: current HTTP sync traffic is not encrypted, so do not use public or guest Wi-Fi. Allow FleetPilot through Windows Firewall only on private networks.

## Pairing protection

- The six-digit PIN expires after five minutes.
- Five wrong PINs from one network address lock pairing from that address for five minutes. Changing the PIN does not bypass an active lockout.
- An approved phone receives a long random token; pairing still requires approval on the desktop.
- Phone records use IDs starting at 1,000,000,000; desktop-created records use IDs below 1,000,000,000.

## Database copies

The sync engine has a developer backup feature under `%APPDATA%\FleetPilot\developer\`: a full `.db` copy and a plain-text `.json` copy, refreshed every 14 days. The JSON file contains readable ledger data; protect that folder as sensitive information. Regular safety copies remain in `%APPDATA%\FleetPilot\copies\`.

## Validation status

The sync tests use a simulated phone and do not verify a real mobile app, Windows Firewall behavior, or encrypted transport. The current protocol uses plain HTTP on a private IPv4 interface. Secure/encrypted transport must be addressed before using this for sensitive production data or pairing on untrusted networks.
