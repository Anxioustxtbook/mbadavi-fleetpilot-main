import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
export const dbFile = resolve(here, process.env.DB_FILE || 'data/fleetpilot.db');
mkdirSync(dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
