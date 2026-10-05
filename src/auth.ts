import { useSyncExternalStore } from 'react';

interface AuthState { status: 'checking' | 'locked' | 'ready'; busy: boolean; error: string | null }
let state: AuthState = { status: 'checking', busy: false, error: null };
const listeners = new Set<() => void>();
let generation = 0;
let pending: Promise<void> | null = null;
function update(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}
async function request(path: string, options?: RequestInit) {
  let response: Response, body: string;
  try {
    response = await fetch(`/api/auth/${path}`, { ...options, credentials: 'same-origin', cache: 'no-store' });
    body = await response.text();
  } catch { throw new Error('Cannot reach the authentication backend. Start npm run dev:worker and check its terminal.'); }
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const http = `HTTP ${response.status}`;
  if (response.status === 204 || !body.trim()) {
    throw new Error(response.ok ? `Authentication server returned an empty response (${http}).` :
      `Authentication backend unavailable (${http}, empty response). Start npm run dev:worker and check its terminal.`);
  }
  if (type !== 'application/json' && !type?.endsWith('+json')) {
    const detail = !response.ok && type === 'text/plain' ? ` ${body.trim().slice(0, 200)}` : '';
    throw new Error(`Authentication server returned ${http} with ${type || 'no content type'}; expected JSON.${detail} Check the backend terminal.`);
  }
  let data: unknown;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Authentication server returned invalid JSON (${http}). Check the backend terminal.`); }
  if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
    ? data.error : `Authentication request failed (${http}).`);
  if (!data || typeof data !== 'object' || !('authenticated' in data) || typeof data.authenticated !== 'boolean') throw new Error('Invalid authentication response.');
  return data.authenticated;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Authentication request failed.';
export const authStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  getGeneration: () => generation,
  expire(epoch = generation) {
    if (epoch !== generation) return;
    generation++;
    update({ status: 'locked', error: 'Session expired. Unlock to continue.' });
  },
  check(): Promise<void> {
    if (pending) return pending;
    if (state.busy) return Promise.resolve();
    const epoch = ++generation;
    update({ status: 'checking', error: null });
    pending = request('session').then(authenticated => { if (epoch === generation) update({ status: authenticated ? 'ready' : 'locked' }); })
      .catch(error => { if (epoch === generation) update({ status: 'locked', error: message(error) }); })
      .finally(() => { pending = null; });
    return pending;
  },
  async login(accessKey: string) {
    if (state.busy || state.status === 'checking') return;
    update({ busy: true, error: null });
    try {
      if (!await request('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) })) throw new Error('Unlock failed.');
      generation++;
      update({ status: 'ready' });
    } catch (error) { update({ error: message(error) }); throw error; }
    finally { update({ busy: false }); }
  },
  async logout() {
    if (state.busy) return;
    update({ busy: true, error: null });
    try {
      await request('logout', { method: 'POST' });
      generation++;
      update({ status: 'locked' });
    } catch (error) { update({ error: message(error) }); }
    finally { update({ busy: false }); }
  },
};
export const useAuth = () => useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
