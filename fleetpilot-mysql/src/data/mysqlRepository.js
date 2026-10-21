import { LocalFleetRepository } from './repository.js';

const UNSYNCED_KEY = 'fleetpilot.unsynced';   // '1' while local edits haven't reached MySQL
const REV_KEY = 'fleetpilot.revision';

/**
 * MySQL-backed repository (through the FleetPilot API in /server).
 *
 * Same contract as LocalFleetRepository: load() and save(state, metadata).
 * IndexedDB stays as an offline cache, so the app keeps working with no network;
 * changes are pushed to MySQL whenever the server is reachable.
 */
export class MySqlFleetRepository {
  constructor({ baseUrl, apiKey = '' } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.apiKey = apiKey;
    this.local = new LocalFleetRepository();
    this.revision = this.readKey(REV_KEY);   // last server revision this device has seen (survives reloads)
    this.pending = null;         // latest unsent { state, metadata }
    this.pushing = false;
    this.conflict = false;
    this.status = 'idle';        // idle | synced | offline | conflict
    window.addEventListener('online', () => this.flush());
  }

  readKey(k) { try { const v = localStorage.getItem(k); return v === null ? null : (k === REV_KEY ? Number(v) : v); } catch { return null; } }
  writeKey(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch { /* storage unavailable */ } }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  setStatus(status, detail) {
    this.status = status;
    window.dispatchEvent(new CustomEvent('fleetpilot:sync', { detail: { status, ...detail } }));
  }

  async load() {
    const localSnap = await this.local.load().catch(() => null);
    try {
      const res = await fetch(`${this.baseUrl}/api/ledger`, { headers: this.headers() });
      if (!res.ok) throw new Error('Server responded ' + res.status);
      const remote = await res.json();
      this.setStatus('synced');

      const remoteHasData = remote.revision > 0;
      // Local copy holds edits that never reached the server -> keep it and push it.
      const localNewer = !!localSnap && this.readKey(UNSYNCED_KEY) === '1';
      if (remoteHasData && !localNewer) {
        this.revision = remote.revision; this.writeKey(REV_KEY, remote.revision);
        const snap = {
          id: 'latest', savedAt: remote.savedAt, fileName: remote.fileName,
          workbookDirty: remote.workbookDirty, data: JSON.stringify(remote.state)
        };
        await this.local.save(remote.state, { fileName: remote.fileName, workbookDirty: remote.workbookDirty }).catch(() => {});
        return snap;
      }
      if (localSnap && localSnap.data) {
        this.pending = { state: JSON.parse(localSnap.data), metadata: { fileName: localSnap.fileName, workbookDirty: localSnap.workbookDirty } };
        this.flush();
      }
      return localSnap;
    } catch (err) {
      console.warn('FleetPilot server unreachable, using local copy:', err);
      this.setStatus('offline');
      return localSnap;
    }
  }

  async save(state, metadata = {}) {
    await this.local.save(state, metadata);       // never lose data: local first
    this.writeKey(UNSYNCED_KEY, '1');
    this.pending = { state, metadata };
    this.flush();                                 // fire and forget
  }

  async flush({ force = false } = {}) {
    if (this.pushing || !this.pending || (this.conflict && !force)) return;
    this.pushing = true;
    try {
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        const res = await fetch(`${this.baseUrl}/api/ledger`, {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({
            state: job.state,
            fileName: job.metadata.fileName ?? null,
            workbookDirty: job.metadata.workbookDirty !== false,
            baseRevision: force ? null : this.revision,
            force
          })
        });
        if (res.status === 409) {
          this.conflict = true;
          this.pending = job;
          this.setStatus('conflict');
          console.warn('Another device saved newer data. Call fleetRepository.forcePush() to overwrite the server, or fleetRepository.pull() to take the server copy.');
          return;
        }
        if (!res.ok) throw new Error('Server responded ' + res.status);
        const out = await res.json();
        this.revision = out.revision; this.writeKey(REV_KEY, out.revision);
        this.conflict = false;
        if (!this.pending) this.writeKey(UNSYNCED_KEY, null);
        if (out.warnings && out.warnings.length) console.warn('FleetPilot sync warnings:', out.warnings);
        this.setStatus('synced');
      }
    } catch (err) {
      console.warn('Sync to MySQL failed, will retry:', err);
      this.setStatus('offline');
      setTimeout(() => this.flush(), 15000);
    } finally {
      this.pushing = false;
    }
  }

  /** Overwrite the server with this device's data. */
  forcePush() { this.conflict = false; return this.flush({ force: true }); }

  /** Replace this device's data with the server copy (then reload the page). */
  async pull() {
    const res = await fetch(`${this.baseUrl}/api/ledger`, { headers: this.headers() });
    const remote = await res.json();
    this.pending = null; this.conflict = false; this.revision = remote.revision;
    this.writeKey(REV_KEY, remote.revision); this.writeKey(UNSYNCED_KEY, null);
    await this.local.save(remote.state, { fileName: remote.fileName, workbookDirty: remote.workbookDirty });
    location.reload();
  }
}
