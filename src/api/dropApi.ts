import { authStore } from '../auth';
import type { DropItem, FileItem, ItemPage } from '../model';
import { DEFAULT_PAGE_SIZE } from '../model';
import { openVaultFile, decryptVaultText, encryptVaultText } from '../localVault';

import { decryptedDownload, encryptedUpload, localPreview } from '../fileIO';

type RemoteItem = { id: string; type: 'text' | 'file'; createdAt: number; envelope?: unknown; url?: unknown };
function isItem(value: unknown): value is RemoteItem {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
    !('createdAt' in value) || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) ||
    Math.abs(value.createdAt) > 8.64e15 || !('type' in value)) return false;
  return value.type === 'text' || value.type === 'file'; // Each envelope is independently authenticated below.
}

async function request(path: string, options?: RequestInit) {
  const epoch = authStore.getGeneration();
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401) authStore.expire(epoch);
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return response;
}
export const dropApi = {
  async list(cursor?: string): Promise<ItemPage> {
    const params = new URLSearchParams({ limit: String(DEFAULT_PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const data: unknown = await (await request(`/api/items?${params}`)).json();
    if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items) ||
      data.items.length > DEFAULT_PAGE_SIZE || !data.items.every(isItem) || !('nextCursor' in data) ||
      (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor))) throw new Error('Invalid item list response.');
    const items: DropItem[] = await Promise.all(data.items.map(async value => {
      if (value.type === 'file') {
        const base: FileItem = { id: value.id, type: 'file', createdAt: value.createdAt, name: 'Encrypted file', size: 0,
          mimeType: 'application/octet-stream', envelope: typeof value.envelope === 'string' ? value.envelope : '',
          url: `/api/items/${value.id}/file` };
        try {
          if (value.url !== base.url) throw new Error('Invalid file route.');
          const opened = await openVaultFile(value.id, value.envelope);
          const item = { ...base, name: opened.manifest.name, size: opened.manifest.size, mimeType: opened.manifest.mimeType };
          return { ...item, previewUrl: await localPreview(item, (url, signal) => request(url, { signal })) };
        } catch { return { ...base, decryptionError: true }; }
      }
      const base = { id: value.id, type: 'text' as const, createdAt: value.createdAt };
      try { return { ...base, text: await decryptVaultText(value.id, value.envelope) }; }
      catch { return { ...base, text: '', decryptionError: true }; }
    }));
    return { items, nextCursor: data.nextCursor as string | null };
  },
  async addText(text: string) {
    const payload = await encryptVaultText(text);
    await request('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  },
  async addFile(file: File) {
    const encrypted = await encryptedUpload(file);
    await request('/api/items/file', { method: 'POST', body: encrypted.body, headers: {
      'Content-Type': 'application/octet-stream', 'X-Item-Id': encrypted.id, 'X-Ciphertext-Size': String(encrypted.ciphertextSize),
    } });
  },
  async downloadFile(item: FileItem, signal?: AbortSignal) {
    return decryptedDownload(item, (url, signal) => request(url, { signal }), signal);
  },
  async remove(id: string) { await request(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
};
