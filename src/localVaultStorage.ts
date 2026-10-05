import type { Enrollment } from './localVault';

// One record makes device-key/root persistence atomic. No deletion/reset API.
export const VAULT_DATABASE = 'aegis-drop-local-vault';
export const VAULT_STORE = 'enrollment';
export const VAULT_RECORD = 'current';
export interface VaultStorage {
  read(): Promise<unknown | null>;
  create(enrollment: Enrollment): Promise<void>;
}
export class VaultStorageError extends Error {
  constructor(readonly kind: 'damaged' | 'unavailable' | 'exists') {
    super(kind === 'damaged' ? 'Device enrollment damaged.' : kind === 'exists' ? 'Device enrollment already exists.' : 'Local vault storage unavailable.');
  }
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new VaultStorageError('unavailable')); return; }
    const request = indexedDB.open(VAULT_DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(VAULT_STORE); };
    request.onerror = () => reject(new VaultStorageError(request.error?.name === 'VersionError' ? 'damaged' : 'unavailable'));
    request.onblocked = () => { blocked = true; reject(new VaultStorageError('unavailable')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      if (!db.objectStoreNames.contains(VAULT_STORE)) { db.close(); reject(new VaultStorageError('damaged')); }
      else resolve(db);
    };
  });
}
export const localVaultStorage: VaultStorage = {
  async read() {
    const db = await open();
    try {
      return await new Promise<unknown | null>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readonly'), store = tx.objectStore(VAULT_STORE);
        const keys = store.getAllKeys(undefined, 2), values = store.getAll(undefined, 2);
        tx.oncomplete = () => {
          if (!keys.result.length) resolve(null);
          else if (keys.result.length !== 1 || keys.result[0] !== VAULT_RECORD) reject(new VaultStorageError('damaged'));
          else if (values.result[0] == null) reject(new VaultStorageError('damaged'));
          else resolve(values.result[0]);
        };
        tx.onabort = () => reject(new VaultStorageError('unavailable'));
      });
    } finally { db.close(); }
  },
  async create(enrollment) {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readwrite'), store = tx.objectStore(VAULT_STORE);
        let reason: 'exists' | 'unavailable' = 'unavailable';
        // No await inside a live transaction. Concurrent tabs serialize here.
        const count = store.count();
        count.onsuccess = () => {
          if (count.result) { reason = 'exists'; tx.abort(); }
          else {
            try { store.add(enrollment, VAULT_RECORD); }
            catch { tx.abort(); }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new VaultStorageError(reason));
      });
    } finally { db.close(); }
  },
};
