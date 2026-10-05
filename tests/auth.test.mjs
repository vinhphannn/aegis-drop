import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './load-ts.mjs';
const { authStore } = await import(await moduleUrl('src/auth.ts'));
const { dropApi } = await import(await moduleUrl('src/api/dropApi.ts'));
const { itemStore } = await import(await moduleUrl('src/store.ts'));

test('auth distinguishes unavailable, empty, non-JSON and malformed backend responses without hiding server errors', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    [() => new Response(null, { status: 500, headers: { 'Content-Type': 'text/plain' } }), /backend unavailable.*HTTP 500/i],
    [() => new Response(null, { status: 204 }), /empty response.*HTTP 204/i],
    [() => new Response('  ', { headers: { 'Content-Type': 'application/json' } }), /empty response.*HTTP 200/i],
    [() => new Response('<html>upstream failure</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), /HTTP 502.*text\/html/],
    [() => new Response('Upstream is offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }), /Upstream is offline/],
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), /invalid JSON/],
    [() => Response.json({ error: 'Authentication is not configured.' }, { status: 503 }), /Authentication is not configured\./],
    [() => Response.json({ error: 'Invalid access key.' }, { status: 401 }), /Invalid access key\./],
    [() => { throw new TypeError('Failed to fetch'); }, /Cannot reach the authentication backend/],
  ];
  try {
    for (const [response, expected] of cases) {
      globalThis.fetch = async () => response(); await authStore.check();
      assert.equal(authStore.getSnapshot().status, 'locked');
      assert.match(authStore.getSnapshot().error, expected);
      assert.ok(!authStore.getSnapshot().error.includes('JSON.parse'));
    }
    globalThis.fetch = async () => Response.json({ authenticated: false });
    await authStore.check(); assert.equal(authStore.getSnapshot().error, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('auth startup is deduplicated, login/logout use cookies, errors and expired sessions lock the UI', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let failLogin = false;
  let failLogout = false;
  let unauthorized = false;
  let release;
  let holdItems = false;
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    if (path === '/api/auth/session') return Response.json({ authenticated: false });
    if (path === '/api/auth/login') return failLogin ? Response.json({ error: 'Invalid access key.' }, { status: 401 }) : Response.json({ authenticated: true });
    if (path === '/api/auth/logout') {
      if (failLogout) throw new Error('Network unavailable');
      return Response.json({ authenticated: false });
    }
    if (holdItems) await new Promise(resolve => { release = resolve; });
    if (unauthorized) return Response.json({ error: 'Authentication required.' }, { status: 401 });
    return Response.json({ items: [{ id: 'private-item', type: 'text', text: 'private', createdAt: 1 }], nextCursor: null });
  };
  try {
    await Promise.all([authStore.check(), authStore.check()]);
    assert.equal(calls.length, 1);
    assert.equal(authStore.getSnapshot().status, 'locked');
    failLogin = true;
    await assert.rejects(authStore.login('test-only-key'), /Invalid access key/);
    assert.equal(authStore.getSnapshot().status, 'locked');
    assert.equal(authStore.getSnapshot().busy, false);
    failLogin = false;
    await authStore.login('test-only-key');
    assert.equal(authStore.getSnapshot().status, 'ready');
    assert.ok(!JSON.stringify(authStore.getSnapshot()).includes('test-only-key'), 'no credential stored in auth state');
    itemStore.reset();
    await itemStore.load();
    assert.equal(itemStore.getSnapshot().items[0].decryptionError, true, 'plaintext-only server rows are never displayed');
    failLogout = true;
    await authStore.logout();
    assert.equal(authStore.getSnapshot().status, 'ready', 'failed logout is not reported as clearing the cookie');
    assert.match(authStore.getSnapshot().error, /Cannot reach the authentication backend/);
    failLogout = false;
    await authStore.logout();
    assert.equal(authStore.getSnapshot().status, 'locked');
    await authStore.login('test-only-key');
    unauthorized = true;
    await assert.rejects(dropApi.list(), /Authentication required/);
    assert.equal(authStore.getSnapshot().status, 'locked');
    unauthorized = false;
    await authStore.login('test-only-key');
    holdItems = true;
    const stale = dropApi.list();
    await authStore.logout();
    await authStore.login('test-only-key');
    unauthorized = true;
    release();
    await assert.rejects(stale, /Authentication required/);
    assert.equal(authStore.getSnapshot().status, 'ready', 'an old 401 cannot lock a newly authenticated session');
  } finally { globalThis.fetch = originalFetch; }
});

test('cache reset prevents late private responses from restoring data after locking', async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async () => {
    await new Promise(resolve => { release = resolve; });
    return Response.json({ items: [{ id: 'old-private-item', type: 'text', text: 'private', createdAt: 1 }], nextCursor: null });
  };
  try {
    itemStore.reset();
    const load = itemStore.load();
    itemStore.reset();
    release(); await load;
    assert.deepEqual(itemStore.getSnapshot().items, []);
    assert.equal(itemStore.getSnapshot().nextCursor, null);
  } finally { globalThis.fetch = originalFetch; }
});
