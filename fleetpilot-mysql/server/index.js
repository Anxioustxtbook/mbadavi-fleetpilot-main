import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { pool } from './db.js';
import { loadState, saveState, RevisionConflict } from './ledgerStore.js';

const app = express();
const origins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// shared-secret check for everything except /api/health
app.use('/api', (req, res, next) => {
  const key = process.env.API_KEY;
  if (key && req.get('x-api-key') !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/api/ledger', async (_req, res) => {
  try { res.json(await loadState()); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/ledger', async (req, res) => {
  const { state, fileName, workbookDirty, baseRevision, force } = req.body || {};
  if (!state || !Array.isArray(state.vehicles)) return res.status(400).json({ error: 'Body must contain { state }' });
  try {
    res.json(await saveState(state, { fileName, workbookDirty, baseRevision, force: !!force }));
  } catch (e) {
    if (e instanceof RevisionConflict) return res.status(409).json({ error: e.message, serverRevision: e.current });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`FleetPilot API on http://localhost:${port}`));
