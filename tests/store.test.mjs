import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './load-ts.mjs';

const { itemStore } = await import(await moduleUrl('src/store.ts'));

test('remote store uses the API and authoritative lists, preserves text and handles failure', async () => {
  const originalFetch = globalThis.fetch;
  let serverItems = [];
  const calls = [];
  let failMutation = false;
  let failList = false;
  let failListOnce = false;
  let notifications = 0;
  let malformedList = false;
  let holdMutation = false;
  let releaseMutation;
  const unsubscribe = itemStore.subscribe(() => notifications++);
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith('/api/items?')) {
      if (failListOnce) { failListOnce = false; throw new Error('List temporarily unavailable'); }
      if (failList) throw new Error('Network unavailable');
      return Response.json(malformedList ? { items: [{ type: 'file' }] } : { items: serverItems, nextCursor: null });
    }
    if (failMutation) return Response.json({ error: 'Upload rejected' }, { status: 413 });
    if (path === '/api/items/text') {
      if (holdMutation) await new Promise(resolve => { releaseMutation = resolve; });
      const { text } = JSON.parse(options.body);
      serverItems = [{ id: 'text-id', type: 'text', text, createdAt: 1 }];
    } else if (path === '/api/items/file') {
      assert.ok(options.body instanceof File, 'send binary File without base64 or multipart');
      assert.equal(options.headers['X-File-Size'], String(options.body.size));
      assert.equal(options.headers['X-File-Name'], encodeURIComponent(options.body.name));
      serverItems = [{ id: 'file-id', type: 'file', name: options.body.name,
        mimeType: options.body.type, size: options.body.size, url: '/api/items/file-id/file', createdAt: 2 }];
    } else if (options.method === 'DELETE') serverItems = [];
    return Response.json({ ok: true });
  };
  try {
    await Promise.all([itemStore.load(), itemStore.load()]);
    assert.equal(calls.length, 1, 'deduplicate StrictMode startup requests');
    assert.equal(itemStore.getSnapshot().loading, false);
    await itemStore.addText(' \n ');
    assert.equal(calls.length, 1);
    const text = '  preserve whitespace\n' + 'long-text'.repeat(1000);
    await itemStore.addText(text);
    assert.equal(itemStore.getSnapshot().items[0].text, text);
    assert.deepEqual(calls.slice(-2).map(call => call.path), ['/api/items/text', '/api/items?limit=5']);
    await itemStore.addFiles([new File(['binary'], 'ảnh.png', { type: 'image/png' })]);
    assert.equal(itemStore.getSnapshot().items.length, 1, 'use server list rather than merge local items');
    assert.equal(itemStore.getSnapshot().items[0].name, 'ảnh.png');
    await itemStore.remove('file-id');
    assert.equal(itemStore.getSnapshot().items.length, 0);
    failListOnce = true;
    await itemStore.addText('already saved');
    assert.ok(itemStore.getSnapshot().error?.includes('Saved'), 'successful POST must not reject merely because refresh failed');
    await itemStore.load();
    assert.equal(itemStore.getSnapshot().items[0].text, 'already saved');
    malformedList = true;
    const savedItems = itemStore.getSnapshot().items;
    await itemStore.load();
    assert.equal(itemStore.getSnapshot().error, 'Invalid item list response.');
    assert.equal(itemStore.getSnapshot().items, savedItems, 'malformed responses never replace a usable snapshot');
    malformedList = false;
    await itemStore.load();
    holdMutation = true;
    const send = itemStore.addText('one send');
    const countWhileBusy = calls.length;
    await assert.rejects(itemStore.addText('duplicate'), /Please wait/);
    await itemStore.load();
    assert.equal(calls.length, countWhileBusy, 'no overlapping reload or duplicate POST while busy');
    releaseMutation();
    await send;
    holdMutation = false;
    failMutation = true;
    await assert.rejects(itemStore.addText('retry me'), /Upload rejected/);
    assert.equal(itemStore.getSnapshot().error, 'Upload rejected');
    assert.equal(itemStore.getSnapshot().busy, false);
    failList = true;
    await itemStore.load();
    assert.equal(itemStore.getSnapshot().error, 'Network unavailable');
    assert.equal(itemStore.getSnapshot().loading, false);
    failList = false;
    await itemStore.load();
    assert.equal(itemStore.getSnapshot().error, null);
    assert.ok(notifications > 0);
    unsubscribe();
    const count = notifications;
    await itemStore.load();
    assert.equal(notifications, count);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('history loads only on request, appends and deduplicates, retries failures and serializes requests', async () => {
  const originalFetch = globalThis.fetch;
  const item = (id, createdAt) => ({ id, createdAt, type: 'text', text: id });
  const calls = [];
  let failOlder = false;
  let release;
  let hold = false;
  globalThis.fetch = async path => {
    calls.push(path);
    const cursor = new URL(path, 'http://localhost').searchParams.get('cursor');
    if (!cursor) return Response.json({ items: [item('b', 10), item('a', 10)], nextCursor: 'older-token' });
    assert.equal(cursor, 'older-token');
    if (hold) await new Promise(resolve => { release = resolve; });
    if (failOlder) throw new Error('Older page unavailable');
    // Deliberate overlap exercises defensive deduplication, independent of SQL.
    return Response.json({ items: [item('a', 10), item('z', 9), item('y', 9)], nextCursor: null });
  };
  try {
    await itemStore.load();
    assert.deepEqual(calls, ['/api/items?limit=5'], 'startup never auto-fetches history');
    const initial = itemStore.getSnapshot().items;
    failOlder = true;
    await itemStore.loadOlder();
    assert.equal(itemStore.getSnapshot().items, initial);
    assert.equal(itemStore.getSnapshot().nextCursor, 'older-token');
    assert.equal(itemStore.getSnapshot().error, 'Older page unavailable');
    failOlder = false; hold = true;
    const older = itemStore.loadOlder();
    assert.equal(itemStore.getSnapshot().loadingOlder, true);
    const count = calls.length;
    await itemStore.loadOlder();
    await itemStore.load();
    await assert.rejects(itemStore.addText('overlap'), /Please wait/);
    assert.equal(calls.length, count, 'no overlapping requests can overwrite an older-page result');
    release(); await older;
    assert.deepEqual(itemStore.getSnapshot().items.map(item => item.id), ['b', 'a', 'z', 'y']);
    assert.equal(itemStore.getSnapshot().nextCursor, null);
    assert.equal(itemStore.getSnapshot().loadingOlder, false);
    assert.equal(itemStore.getSnapshot().error, null);
    await itemStore.loadOlder();
    assert.equal(calls.length, count, 'end of history makes no request');
    await itemStore.load();
    assert.deepEqual(itemStore.getSnapshot().items.map(item => item.id), ['b', 'a'], 'Refresh deliberately starts at the newest page');
  } finally { globalThis.fetch = originalFetch; }
});
