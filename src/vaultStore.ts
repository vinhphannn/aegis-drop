import { useSyncExternalStore } from 'react';
import { authStore } from './auth';
import { itemStore } from './store';
import { activateVault, clearActiveVault, createEnrollment, inspectEnrollment, releaseVault, unlockEnrollment } from './localVault';
import type { UnlockedVault } from './localVault';
import { localVaultStorage, VaultStorageError } from './localVaultStorage';
import type { VaultStorage } from './localVaultStorage';

interface VaultState {
  status: 'unauthenticated' | 'checking' | 'empty' | 'locked' | 'unlocked' | 'damaged' | 'unavailable';
  busy: boolean; error: string | null;
}
export function createVaultStore(storage: VaultStorage = localVaultStorage) {
  let state: VaultState = { status: 'unauthenticated', busy: false, error: null };
  let authenticated = false, generation = 0, handle: UnlockedVault | undefined;
  const listeners = new Set<() => void>();
  function update(patch: Partial<VaultState>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
  function discard() { clearActiveVault(); if (handle) releaseVault(handle); handle = undefined; }
  function failure(error: unknown) {
    const damaged = error instanceof VaultStorageError && error.kind === 'damaged';
    update({ status: damaged ? 'damaged' : 'unavailable', busy: false,
      error: damaged ? 'Device enrollment damaged. It has not been replaced.' : 'Local vault storage unavailable. Retry in a supported browser.' });
  }
  async function check() {
    if (!authenticated) return;
    const epoch = ++generation; discard(); update({ status: 'checking', busy: true, error: null });
    try {
      const saved = await storage.read();
      if (saved !== null) await inspectEnrollment(saved);
      if (epoch === generation) update({ status: saved === null ? 'empty' : 'locked', busy: false });
    } catch (error) { if (epoch === generation) failure(error); }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    setAuthenticated(value: boolean) {
      if (authenticated === value) return;
      authenticated = value;
      if (value) return check();
      generation++; discard(); update({ status: 'unauthenticated', busy: false, error: null });
    },
    check,
    lock() {
      if (!authenticated) return;
      // Also invalidate pending bootstrap/unlock, including late native crypto.
      void check();
    },
    async unlock() {
      if (!authenticated || state.busy || state.status !== 'locked') return;
      const epoch = ++generation; update({ busy: true, error: null });
      try {
        const saved = await storage.read();
        if (saved === null) throw new VaultStorageError('damaged');
        const opened = await unlockEnrollment(saved);
        if (epoch !== generation) { releaseVault(opened); return; }
        handle = opened; activateVault(opened); update({ status: 'unlocked', busy: false });
      } catch (error) { if (epoch === generation) failure(error); }
    },
    async bootstrap() {
      if (!authenticated || state.busy || state.status !== 'empty') return;
      const epoch = ++generation; update({ busy: true, error: null });
      try {
        // Recheck at action time: never regenerate over corruption/another tab.
        const existing = await storage.read();
        if (epoch !== generation) return;
        if (existing !== null) { await check(); return; }
        const record = await createEnrollment();
        if (epoch !== generation) return;
        await storage.create(record);
        if (epoch !== generation) return;
        const persisted = await storage.read();
        if (persisted === null) throw new VaultStorageError('damaged');
        const opened = await unlockEnrollment(persisted);
        if (epoch !== generation) { releaseVault(opened); return; }
        handle = opened; activateVault(opened); update({ status: 'unlocked', busy: false });
      } catch (error) {
        if (epoch !== generation) return;
        if (error instanceof VaultStorageError && error.kind === 'exists') await check();
        else failure(error);
      }
    },
  };
}
export const vaultStore = createVaultStore();
vaultStore.subscribe(() => { if (vaultStore.getSnapshot().status !== 'unlocked') itemStore.reset(); });
// Synchronous auth subscription invalidates secrets before React's effects run.
authStore.subscribe(() => { void vaultStore.setAuthenticated(authStore.getSnapshot().status === 'ready'); });
void vaultStore.setAuthenticated(authStore.getSnapshot().status === 'ready');
export const useVault = () => useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot);
