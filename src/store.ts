import { useSyncExternalStore } from 'react';

interface BaseItem { id: string; createdAt: number }
export interface TextItem extends BaseItem { type: 'text'; text: string }
export interface FileItem extends BaseItem {
  type: 'file'; file: File; name: string; size: number; mimeType: string; url: string;
}
export type DropItem = TextItem | FileItem;
export const MAX_ITEMS = 5;

// This module owns the data and object URL lifetime. Replace its implementation
// with an API-backed store later; components only consume items and actions.
let items: readonly DropItem[] = [];
const listeners = new Set<() => void>();
function release(item: DropItem) {
  if (item.type === 'file') URL.revokeObjectURL(item.url);
}
function update(next: DropItem[]) {
  const retained = next.slice(0, MAX_ITEMS);
  const ids = new Set(retained.map(item => item.id));
  const candidates = new Map([...items, ...next].map(item => [item.id, item]));
  for (const item of candidates.values()) {
    if (!ids.has(item.id)) release(item);
  }
  items = retained;
  listeners.forEach(listener => listener());
}
export const itemStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => items,
  addText(text: string) {
    if (!text.trim()) return;
    update([{ id: crypto.randomUUID(), createdAt: Date.now(), type: 'text', text }, ...items]);
  },
  addFiles(files: readonly File[]) {
    const incoming: FileItem[] = files.map(file => ({
      id: crypto.randomUUID(), createdAt: Date.now(), type: 'file', file,
      name: file.name || 'clipboard-image.png', size: file.size,
      mimeType: file.type, url: URL.createObjectURL(file),
    }));
    // Last selected file is newest, including when a batch exceeds the limit.
    update([...incoming.reverse(), ...items]);
  },
  remove(id: string) { update(items.filter(item => item.id !== id)); },
};
export function useItems() {
  return useSyncExternalStore(itemStore.subscribe, itemStore.getSnapshot);
}
