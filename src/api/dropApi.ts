import { authStore } from '../auth';
import type { DropItem, ItemPage } from '../model';
import { DEFAULT_PAGE_SIZE } from '../model';

function isItem(value: unknown): value is DropItem {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
    !('createdAt' in value) || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) ||
    Math.abs(value.createdAt) > 8.64e15 || !('type' in value)) return false;
  if (value.type === 'text') return 'text' in value && typeof value.text === 'string';
  return value.type === 'file' && 'name' in value && typeof value.name === 'string' &&
    'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 &&
    'mimeType' in value && typeof value.mimeType === 'string' &&
    'url' in value && value.url === `/api/items/${value.id}/file`;
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
    return { items: data.items, nextCursor: data.nextCursor as string | null };
  },
  async addText(text: string) {
    await request('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  },
  async addFile(file: File) {
    await request('/api/items/file', { method: 'POST', body: file, headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'clipboard-image.png'),
      'X-File-Size': String(file.size),
    } });
  },
  async remove(id: string) { await request(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
};
