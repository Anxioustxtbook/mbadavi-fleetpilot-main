# SQLite server prototype (not the current app)

The files in `server/` are an experimental prototype and are not used or packaged by the desktop app. Do not configure this prototype to connect the desktop and mobile apps.

The current desktop app stores its working ledger in a local SQLite database managed by Electron. The browser development page does not read or write ledger data. Phone pairing and synchronization are not implemented yet; they require the mobile app and an agreed secure sync protocol.
