import { useSyncExternalStore } from 'react';
import { dropApi } from './api/dropApi';
import type { DropItem } from './model';
export { MAX_FILE_SIZE } from './model';
export type { DropItem, TextItem, FileItem } from './model';

interface StoreState { items: readonly DropItem[]; nextCursor: string | null; loading: boolean; loadingOlder: boolean; busy: boolean; error: string | null }
// Cache only the pages the user requests; the server keeps persistent history.
let state: StoreState = { items: [], nextCursor: null, loading: true, loadingOlder: false, busy: false, error: null };
const listeners = new Set<() => void>();
let pendingLoad: Promise<void> | null = null;
function update(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Request failed.'; }
async function refresh() { update({ ...await dropApi.list(), error: null }); }
async function mutate(action: () => Promise<void>) {
  if (state.busy || state.loading || state.loadingOlder) throw new Error('Please wait for the current request.');
  update({ busy: true, error: null });
  let saved = false;
  try {
    await action();
    saved = true;
    await refresh();
  } catch (error) {
    if (saved) {
      // Resolve the successful mutation so the UI clears its submitted draft.
      // A failed list request is not a reason to submit those bytes again.
      update({ error: `Saved, but could not refresh. Use Refresh to reload. ${message(error)}` });
      return;
    }
    // A batch may have partially uploaded, or a mutation may have succeeded
    // before its list request failed. Reconcile, while preserving the error.
    try { await refresh(); } catch { /* Keep the last known list. */ }
    update({ error: message(error) });
    throw error;
  } finally { update({ busy: false }); }
}
export const itemStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  load(): Promise<void> {
    if (state.busy || state.loadingOlder) return Promise.resolve();
    if (pendingLoad) return pendingLoad;
    update({ loading: true, error: null });
    pendingLoad = refresh().catch(error => { update({ error: message(error) }); })
      .finally(() => { pendingLoad = null; update({ loading: false }); });
    return pendingLoad;
  },
  async loadOlder() {
    if (state.busy || state.loading || state.loadingOlder || !state.nextCursor) return;
    const cursor = state.nextCursor;
    update({ loadingOlder: true, error: null });
    try {
      const page = await dropApi.list(cursor);
      const unique = new Map(state.items.map(item => [item.id, item]));
      for (const item of page.items) if (!unique.has(item.id)) unique.set(item.id, item);
      const items = [...unique.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      update({ items, nextCursor: page.nextCursor });
    } catch (error) { update({ error: message(error) }); }
    finally { update({ loadingOlder: false }); }
  },
  async addText(text: string) {
    if (!text.trim()) return;
    await mutate(() => dropApi.addText(text));
  },
  async addFiles(files: readonly File[]) {
    if (!files.length) return;
    await mutate(async () => { for (const file of files) await dropApi.addFile(file); });
  },
  async remove(id: string) { await mutate(() => dropApi.remove(id)); },
};
export function useItems() {
  return useSyncExternalStore(itemStore.subscribe, itemStore.getSnapshot);
}
