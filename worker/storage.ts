import type { ItemPage } from '../src/model';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/model';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Env { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher }
export interface ItemRow {
  id: string; type: 'text' | 'file'; text_content: string | null;
  file_key: string | null; file_name: string | null; mime_type: string | null;
  size: number; created_at: number; pending_delete: number;
}
export type NewItem = Pick<ItemRow, 'id' | 'type' | 'text_content' | 'file_key' | 'file_name' | 'mime_type' | 'size'>;
interface Cursor { v: 1; t: number; id: string }
interface PageOptions { limit: number; before: Cursor | null }
function encodeCursor(t: number, id: string) {
  // An opaque versioned API token, not a secret or an authorization credential.
  // Contains only item ordering fields, not SQL/rowid/offset implementation data.
  return btoa(JSON.stringify({ v: 1, t, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function parsePage(params: URLSearchParams): PageOptions | null {
  if (params.getAll('limit').length > 1 || params.getAll('cursor').length > 1) return null;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if ((rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) || !Number.isInteger(limit) || limit > MAX_PAGE_SIZE) return null;
  const rawCursor = params.get('cursor');
  if (rawCursor === null) return { limit, before: null };
  if (rawCursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) return null;
  try {
    const value = JSON.parse(atob(rawCursor.replace(/-/g, '+').replace(/_/g, '/')));
    if (!value || value.v !== 1 || !Number.isSafeInteger(value.t) || value.t < 0 ||
      typeof value.id !== 'string' || !UUID.test(value.id) || encodeCursor(value.t, value.id) !== rawCursor) return null;
    return { limit, before: value };
  } catch { return null; }
}

export async function listItems(env: Env, page: PageOptions): Promise<ItemPage> {
  const { limit, before } = page;
  const query = env.DB.prepare(`SELECT * FROM items WHERE pending_delete = 0
    ${before ? 'AND (created_at, id) < (?, ?)' : ''}
    ORDER BY created_at DESC, id DESC LIMIT ?`);
  const { results } = await query.bind(...(before ? [before.t, before.id, limit + 1] : [limit + 1])).all<ItemRow>();
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map(row => row.type === 'text'
      ? { id: row.id, type: 'text', createdAt: row.created_at, text: row.text_content! }
      : { id: row.id, type: 'file', createdAt: row.created_at, name: row.file_name!,
        size: row.size, mimeType: row.mime_type!, url: `/api/items/${row.id}/file` }),
    nextCursor: results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export async function insertItem(env: Env, item: NewItem) {
  // One insert; history is never pruned merely because new items arrive.
  await env.DB.prepare(`INSERT INTO items (id, type, text_content, file_key, file_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(item.id, item.type, item.text_content,
    item.file_key, item.file_name, item.mime_type, item.size).run();
}

export async function cleanup(env: Env) {
  // Explicit-delete tombstones preserve object keys until cleanup succeeds.
  // Physically delete metadata only after the object is gone; later requests retry.
  let results: Pick<ItemRow, 'id' | 'file_key'>[];
  try {
    // Ten objects means at most 10 R2 deletes + 11 D1 queries, leaving room
    // for the main operation under the free plan's per-request budgets.
    ({ results } = await env.DB.prepare(
      'SELECT id, file_key FROM items WHERE pending_delete = 1 ORDER BY created_at, id LIMIT 10',
    ).all<Pick<ItemRow, 'id' | 'file_key'>>());
  } catch {
    console.warn('Cleanup scan deferred');
    return;
  }
  for (const item of results) {
    try {
      if (item.file_key) await env.FILES.delete(item.file_key);
      await env.DB.prepare('DELETE FROM items WHERE id = ? AND pending_delete = 1').bind(item.id).run();
    } catch {
      console.warn('Item cleanup deferred', item.id);
    }
  }
}

export async function markDeleted(env: Env, id: string) {
  const result = await env.DB.prepare(
    'UPDATE items SET pending_delete = 1 WHERE id = ? AND pending_delete = 0 RETURNING id',
  ).bind(id).first<{ id: string }>();
  return result !== null;
}
