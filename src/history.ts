import { checksum, validateSendFile, MAX_TEXT_BYTES, validFile } from './peer';

export type HistoryItem = { id: string; createdAt: number; senderDeviceId: string } & (
  { type: 'text'; text: string } |
  { type: 'file'; name: string; mimeType: string; size: number; hash: string }
);
export type InventoryItem = Pick<HistoryItem, 'id' | 'createdAt' | 'type'> & { size?: number; hash?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateItem(item: HistoryItem) {
  if (!item || !uuid.test(item.id) || !uuid.test(item.senderDeviceId) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) throw new Error('Invalid item metadata.');
  if (item.type === 'text') {
    if (typeof item.text !== 'string' || new TextEncoder().encode(item.text).length > MAX_TEXT_BYTES) throw new Error('Text is limited to 12 KiB.');
  } else if (item.type === 'file') {
    validFile(item.name, item.mimeType, item.size);
    if (!/^[0-9a-f]{64}$/.test(item.hash)) throw new Error('Invalid item checksum.');
  } else throw new Error('Invalid item type.');
}
function identity(item: HistoryItem) {
  return JSON.stringify([item.id, item.createdAt, item.senderDeviceId, item.type, item.type === 'text' ? item.text : [item.name, item.mimeType, item.size, item.hash]]);
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(new Error('Local history unavailable.')); });
}
function complete(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('Could not save local history. Check browser storage.'));
  });
}

export class HistoryStore {
  private db!: IDBDatabase;
  private recent: readonly HistoryItem[] = [];
  private listeners = new Set<() => void>();
  private added = new Set<(item: HistoryItem) => void>();
  deviceId = '';
  readonly ready: Promise<void>;
  constructor(name = 'aegis-drop-history', factory: IDBFactory = indexedDB) {
    this.ready = this.open(name, factory);
  }
  private async open(name: string, factory: IDBFactory) {
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore('items', { keyPath: 'id' }).createIndex('recent', ['createdAt', 'id']);
      db.createObjectStore('blobs'); db.createObjectStore('meta');
    };
    this.db = await request(opening);
    this.db.onversionchange = () => this.db.close();
    const tx = this.db.transaction('meta', 'readwrite'), done = complete(tx);
    const store = tx.objectStore('meta');
    const result = await request(store.get('deviceId'));
    this.deviceId = result ?? crypto.randomUUID();
    if (!result) store.put(this.deviceId, 'deviceId');
    await done; await this.refresh();
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  onAdded(fn: (item: HistoryItem) => void) { this.added.add(fn); return () => { this.added.delete(fn); }; }
  getSnapshot = () => this.recent;
  async refresh() {
    const items: HistoryItem[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursor = this.db.transaction('items').objectStore('items').index('recent').openCursor(null, 'prev');
      cursor.onerror = () => reject(new Error('Could not load local history.'));
      cursor.onsuccess = () => {
        if (!cursor.result || items.length === 50) { resolve(); return; }
        items.push(cursor.result.value); cursor.result.continue();
      };
    });
    this.recent = items; this.listeners.forEach(fn => fn());
  }
  async get(id: string): Promise<HistoryItem | undefined> { await this.ready; return request(this.db.transaction('items').objectStore('items').get(id)); }
  async blob(id: string): Promise<Blob> {
    await this.ready;
    const blob = await request(this.db.transaction('blobs').objectStore('blobs').get(id));
    if (!(blob instanceof Blob)) throw new Error('Stored file unavailable.');
    return blob;
  }
  async inventoryPage(after?: string): Promise<InventoryItem[]> {
    await this.ready;
    const items: InventoryItem[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursor = this.db.transaction('items').objectStore('items').openCursor(after ? IDBKeyRange.lowerBound(after, true) : null);
      cursor.onerror = () => reject(new Error('Could not read history inventory.'));
      cursor.onsuccess = () => {
        if (!cursor.result || items.length === 48) { resolve(); return; }
        const item: HistoryItem = cursor.result.value;
        items.push({ id: item.id, createdAt: item.createdAt, type: item.type, ...(item.type === 'file' ? { size: item.size, hash: item.hash } : {}) }); cursor.result.continue();
      };
    });
    return items;
  }
  async put(item: HistoryItem, blob?: Blob) {
    await this.ready; validateItem(item);
    if (item.type === 'file' && (!blob || blob.size !== item.size)) throw new Error('Stored file size mismatch.');
    const tx = this.db.transaction(['items', 'blobs'], 'readwrite'), done = complete(tx);
    const store = tx.objectStore('items');
    const prior: HistoryItem | undefined = await request(store.get(item.id));
    if (prior && identity(prior) !== identity(item)) { tx.abort(); await done.catch(() => console.warn('Immutable item conflict', { itemId: item.id })); throw new Error('Item ID conflict.'); }
    if (!prior) { store.add(item); if (blob) tx.objectStore('blobs').add(blob, item.id); }
    await done;
    if (!prior) { await this.refresh(); this.added.forEach(fn => fn(item)); }
    return !prior;
  }
  async createText(text: string) {
    await this.ready;
    const item: HistoryItem = { id: crypto.randomUUID(), createdAt: Date.now(), senderDeviceId: this.deviceId, type: 'text', text };
    await this.put(item); return item;
  }
  async createFile(file: File) {
    await this.ready; validateSendFile(file);
    const item: HistoryItem = { id: crypto.randomUUID(), createdAt: Date.now(), senderDeviceId: this.deviceId, type: 'file', name: file.name || 'screenshot.png', mimeType: file.type || 'application/octet-stream', size: file.size, hash: await checksum(file) };
    await this.put(item, file); return item;
  }
  async close() { await this.ready; this.db.close(); }
}
