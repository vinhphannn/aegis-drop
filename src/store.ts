import { useSyncExternalStore } from 'react';
import { dropApi } from './api/dropApi';
import type { DropItem } from './model';
export { MAX_FILE_SIZE } from './model';
export type { DropItem, TextItem, FileItem } from './model';

interface StoreState { items: readonly DropItem[]; nextCursor: string | null; loading: boolean; loadingOlder: boolean; busy: boolean; error: string | null }
// Cache only the pages the user requests; the server keeps persistent history.
let state: StoreState = { items: [], nextCursor: null, loading: true, loadingOlder: false, busy: false, error: null };
const listeners = new Set<() => void>();
let generation = 0;
let pendingLoad: Promise<void> | null = null;
function update(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Request failed.'; }
async function refresh(epoch = generation) {
  if (epoch !== generation) return;
  const page = await dropApi.list();
  if (epoch === generation) update({ ...page, error: null });
}
async function mutate(action: () => Promise<void>) {
  if (state.busy || state.loading || state.loadingOlder) throw new Error('Please wait for the current request.');
  const epoch = generation;
  const patch = (value: Partial<StoreState>) => { if (epoch === generation) update(value); };
  patch({ busy: true, error: null });
  let saved = false;
  try {
    await action();
    saved = true;
    await refresh(epoch);
  } catch (error) {
    if (saved) {
      // Resolve the successful mutation so the UI clears its submitted draft.
      // A failed list request is not a reason to submit those bytes again.
      patch({ error: `Saved, but could not refresh. Use Refresh to reload. ${message(error)}` });
      return;
    }
    // A batch may have partially uploaded, or a mutation may have succeeded
    // before its list request failed. Reconcile, while preserving the error.
    try { await refresh(epoch); } catch { /* Keep the last known list. */ }
    patch({ error: message(error) });
    throw error;
  } finally { patch({ busy: false }); }
}
export const itemStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  reset() {
    generation++;
    pendingLoad = null;
    update({ items: [], nextCursor: null, loading: true, loadingOlder: false, busy: false, error: null });
  },
  load(): Promise<void> {
    if (state.busy || state.loadingOlder) return Promise.resolve();
    if (pendingLoad) return pendingLoad;
    const epoch = generation;
    update({ loading: true, error: null });
    pendingLoad = refresh(epoch).catch(error => { if (epoch === generation) update({ error: message(error) }); })
      .finally(() => { if (epoch === generation) { pendingLoad = null; update({ loading: false }); } });
    return pendingLoad;
  },
  async loadOlder() {
    if (state.busy || state.loading || state.loadingOlder || !state.nextCursor) return;
    const epoch = generation;
    const cursor = state.nextCursor;
    update({ loadingOlder: true, error: null });
    try {
      const page = await dropApi.list(cursor);
      if (epoch !== generation) return;
      const unique = new Map(state.items.map(item => [item.id, item]));
      for (const item of page.items) if (!unique.has(item.id)) unique.set(item.id, item);
      const items = [...unique.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      update({ items, nextCursor: page.nextCursor });
    } catch (error) { if (epoch === generation) update({ error: message(error) }); }
    finally { if (epoch === generation) update({ loadingOlder: false }); }
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
