const DATABASE_NAME = 'FleetLedgerAutosave';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'latest';

export class LocalFleetRepository {
  constructor() {
    this.databasePromise = null;
  }

  openDatabase() {
    if (this.databasePromise) return this.databasePromise;
    if (!('indexedDB' in window)) {
      return Promise.reject(new Error('IndexedDB is unavailable'));
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The local ledger database is blocked'));
    });

    return this.databasePromise;
  }

  async load() {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async save(state, { fileName = null, workbookDirty = true } = {}) {
    const data = JSON.stringify(state);
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({
        id: SNAPSHOT_KEY,
        savedAt: new Date().toISOString(),
        fileName,
        workbookDirty,
        data
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
