import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ts from 'typescript';

const accessKey = randomBytes(32).toString('hex');
const verifier = createHash('sha256').update(accessKey).digest('hex');
const secret = randomBytes(32).toString('hex');
const cookieName = '__Host-aegis-session';

// Run the real Worker code against workerd's SQLite D1 and local R2 bindings.
const modules = await Promise.all(['worker/index.ts', 'worker/storage.ts', 'worker/auth.ts', 'src/model.ts'].map(async path => ({
  type: 'ESModule', path: resolve(path.replace(/\.ts$/, '.js')),
  contents: ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from ['"](\.[^'"]+)['"]/g, "from '$1.js'"),
})));
// Inject transport failures around real D1/R2 operations; storage logic is not mocked.
modules.unshift({ type: 'ESModule', path: resolve('worker/test-entry.js'), contents: `
import worker from './index.js';
export default {
  fetch(request, env) {
    const db = env.DB;
    const bucket = env.FILES;
    env = { ...env, DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (request.headers.get('x-test-fail-cleanup-query') && sql.includes('SELECT id, file_key')) {
          return { all: async () => { throw new Error('injected cleanup read failure'); } };
        }
        if (request.headers.get('x-test-fail-owner-read') && sql.includes('WHERE file_key =')) {
          return { bind: () => ({ first: async () => { throw new Error('injected ownership read failure'); } }) };
        }
        if (request.headers.get('x-test-lost-commit-ack') && sql.includes('INSERT INTO items')) {
          const wrap = statement => ({
            bind: (...values) => wrap(statement.bind(...values)),
            async run() {
              await statement.run();
              throw new Error('injected lost commit acknowledgement');
            }
          });
          return wrap(statement);
        }
        return statement;
      },
    }, FILES: {
      put: request.headers.get('x-test-fail-put')
        ? async () => { throw new Error('injected early R2 put failure'); }
        : bucket.put.bind(bucket),
      get: bucket.get.bind(bucket),
      delete: request.headers.get('x-test-fail-delete')
        ? async () => { throw new Error('injected R2 deletion failure'); }
        : bucket.delete.bind(bucket)
    }};
    if (request.headers.get('x-test-missing-auth')) env.SESSION_SECRET = undefined;
    if (request.headers.get('x-test-rotate-secret')) env.SESSION_SECRET = 'f'.repeat(64);
    if (request.headers.get('x-test-rotate-verifier')) env.ACCESS_KEY_SHA256 = 'f'.repeat(64);
    return worker.fetch(request, env);
  }
};` });

test('Worker API with real local D1 and R2', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules, compatibilityDate: '2026-10-05', d1Databases: { DB: 'test-db' },
    r2Buckets: { FILES: 'test-files' }, bindings: { ACCESS_KEY_SHA256: verifier, SESSION_SECRET: secret },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('FILES');
    async function migrate(path) {
      // D1 exec expects one statement per line; use prepare for multiline SQL.
      const sql = await readFile(path, 'utf8');
      for (const statement of sql.split(';').filter(part => part.trim())) await db.prepare(statement).run();
    }
    await migrate('migrations/0001_items.sql');
    const existingId = crypto.randomUUID();
    await bucket.put(`items/${existingId}`, 'existing bytes');
    await db.prepare("INSERT INTO items (id,type,file_key,file_name,mime_type,size) VALUES (?, 'file', ?, 'existing.bin', 'application/octet-stream', 14)").bind(existingId, `items/${existingId}`).run();
    await migrate('migrations/0002_history_index.sql');
    await t.test('history index upgrade preserves existing rows and uses an indexed cursor seek', async () => {
      assert.equal((await db.prepare('SELECT file_key FROM items WHERE id = ?').bind(existingId).first()).file_key, `items/${existingId}`);
      assert.equal(await (await bucket.get(`items/${existingId}`)).text(), 'existing bytes');
      const plan = (await db.prepare('EXPLAIN QUERY PLAN SELECT * FROM items WHERE pending_delete = 0 AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?').bind(Date.now(), existingId, 6).all()).results;
      assert.ok(plan.some(row => row.detail.includes('items_recent')));
      assert.ok(!plan.some(row => row.detail.includes('TEMP B-TREE')), 'no whole-history sort for an older page');
    });
    const rawFetch = (path, options) => mf.dispatchFetch(`https://localhost${path}`, options);
    let sessionCookie;
    const fetch = (path, options = {}) => rawFetch(path, { ...options, headers: { cookie: sessionCookie, ...options.headers } });
    const login = (key, extra = {}) => rawFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ accessKey: key }) });
    await t.test('login verifies the key, sets a private secure session without credential disclosure', async () => {
      const wrong = await login('incorrect-key');
      assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('set-cookie'), null);
      const correct = await login(accessKey);
      assert.equal(correct.status, 200); assert.equal(correct.headers.get('cache-control'), 'no-store');
      const header = correct.headers.get('set-cookie');
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(header.includes(attribute));
      assert.ok(!header.includes('Domain='));
      sessionCookie = header.split(';')[0];
      assert.ok(!sessionCookie.includes(accessKey)); assert.ok(!sessionCookie.includes(verifier));
      assert.ok(!sessionCookie.includes(secret));
      assert.deepEqual(await correct.json(), { authenticated: true });
      const status = await fetch('/api/auth/session');
      assert.deepEqual(await status.json(), { authenticated: true });
      assert.equal(status.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch('/api/items')).status, 200);
    });
    await t.test('malformed and oversized login requests fail without setting cookies', async () => {
      for (const body of ['{', '{}', 'null', '{"accessKey":1}', '{"accessKey":""}']) {
        const response = await rawFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        assert.equal(response.status, 400); assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await rawFetch('/api/auth/login', { method: 'POST', body: 'key' })).status, 415);
      assert.equal((await rawFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'a'.repeat(8193) })).status, 413);
      for (const [route, method, allow] of [['login', 'GET', 'POST'], ['session', 'POST', 'GET'], ['logout', 'GET', 'POST']]) {
        const response = await rawFetch(`/api/auth/${route}`, { method });
        assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allow);
      }
    });
    await t.test('every item route rejects missing authentication before touching storage', async () => {
      for (const [path, method] of [['/api/items', 'GET'], ['/api/items/text', 'POST'], ['/api/items/file', 'POST'], [`/api/items/${existingId}/file`, 'GET'], [`/api/items/${existingId}`, 'DELETE']]) {
        const response = await rawFetch(path, { method });
        assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.ok(await bucket.head(`items/${existingId}`));
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM items').first()).n, 1);
      assert.deepEqual(await (await rawFetch('/api/auth/session')).json(), { authenticated: false });
    });
    await t.test('forged, expired, future and malformed cookies are rejected; rotation invalidates sessions', async () => {
      const now = Math.floor(Date.now() / 1000);
      const signed = (issued, expires) => {
        const payload = `v1.${issued}.${expires}.${'a'.repeat(32)}`;
        return `${cookieName}=${payload}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(`aegis-session:${verifier}:${payload}`).digest('hex')}`;
      };
      const valid = signed(now, now + 2592000);
      assert.deepEqual(await (await rawFetch('/api/auth/session', { headers: { cookie: valid } })).json(), { authenticated: true });
      const token = sessionCookie.slice(cookieName.length + 1);
      const forged = `${cookieName}=${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
      for (const cookie of ['garbage', `${cookieName}=`, `${cookieName}=bad`, `${cookieName}=%FF`, `${cookieName}=${'a'.repeat(257)}`, `${sessionCookie}; ${sessionCookie}`, forged,
        signed(now - 2592001, now - 1), signed(now + 10, now + 2592010), signed(now, now + 1)]) {
        const response = await rawFetch('/api/items', { headers: { cookie } });
        assert.equal(response.status, 401, 'invalid cookie');
      }
      for (const flag of ['X-Test-Rotate-Secret', 'X-Test-Rotate-Verifier']) {
        assert.equal((await fetch('/api/items', { headers: { [flag]: '1' } })).status, 401);
      }
      assert.equal((await fetch('/api/items', { headers: { 'X-Test-Missing-Auth': '1' } })).status, 503);
      assert.equal((await login(accessKey, { 'X-Test-Missing-Auth': '1' })).status, 503);
    });
    await t.test('logout clears the host-only cookie and cross-origin mutations are rejected', async () => {
      const logout = await fetch('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://localhost' } });
      assert.equal(logout.status, 200); assert.equal(logout.headers.get('cache-control'), 'no-store');
      assert.ok(logout.headers.get('set-cookie').includes(`${cookieName}=;`));
      assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
      assert.deepEqual(await logout.json(), { authenticated: false });
      const clearedCookie = logout.headers.get('set-cookie').split(';')[0];
      assert.equal((await rawFetch('/api/items', { headers: { cookie: clearedCookie } })).status, 401);
      // Stateless logout cannot revoke a copied old token; documented explicitly.
      assert.equal((await fetch('/api/items')).status, 200);
      for (const path of ['/api/auth/login', '/api/auth/logout', '/api/items/text', `/api/items/${existingId}`]) {
        const response = await fetch(path, { method: path.endsWith(existingId) ? 'DELETE' : 'POST', headers: { Origin: 'https://other.example' } });
        assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      assert.equal((await fetch('/api/auth/logout', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    });
    const page = async (query = '') => { const response = await fetch(`/api/items${query}`); assert.equal(response.status, 200); return response.json(); };
    const list = async () => (await page()).items;
    const text = value => fetch('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
    const file = (name, body, headers = {}) => fetch('/api/items/file', { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name),
        'X-File-Size': String(Buffer.byteLength(body)), ...headers }, body });
    async function reset() {
      await db.prepare('DELETE FROM items').run();
      const objects = await bucket.list();
      if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
    }

    await t.test('more than five mixed items persist, page newest first, old file deletes explicitly', async () => {
      await reset();
      await file('old.bin', 'old bytes');
      const old = (await list())[0];
      const row = await db.prepare('SELECT file_key FROM items WHERE id = ?').bind(old.id).first();
      await db.prepare('UPDATE items SET created_at = 0 WHERE id = ?').bind(old.id).run();
      for (let i = 1; i <= 7; i++) {
        assert.equal((await text(`text ${i}`)).status, 201);
        await db.prepare('UPDATE items SET created_at = ? WHERE text_content = ?').bind(i, `text ${i}`).run();
      }
      const first = await page();
      assert.deepEqual(first.items.map(item => item.text), ['text 7', 'text 6', 'text 5', 'text 4', 'text 3']);
      const older = await page(`?cursor=${first.nextCursor}`);
      assert.deepEqual(older.items.map(item => item.id), [
        ...(await db.prepare("SELECT id FROM items WHERE type = 'text' AND created_at < 3 ORDER BY created_at DESC").all()).results.map(row => row.id), old.id]);
      assert.equal(older.nextCursor, null);
      assert.equal(new Set([...first.items, ...older.items].map(item => item.id)).size, 8);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM items').first()).n, 8);
      assert.equal(await (await fetch(old.url)).text(), 'old bytes');
      assert.ok(await bucket.head(row.file_key));
      assert.equal((await fetch(`/api/items/${old.id}`, { method: 'DELETE' })).status, 200);
      assert.equal(await bucket.head(row.file_key), null);
      assert.equal(await db.prepare('SELECT id FROM items WHERE id = ?').bind(old.id).first(), null);
    });
    await t.test('concurrent timestamp-colliding uploads persist and paginate deterministically', async () => {
      await reset();
      await db.prepare(`CREATE TRIGGER collide_time AFTER INSERT ON items BEGIN
        UPDATE items SET created_at = 123456789 WHERE id = NEW.id;
      END`).run();
      try {
        const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2 ? text(`text ${i}`) : file(`${i}.bin`, `file ${i}`)));
        assert.ok(responses.every(response => response.status === 201));
        const rows = (await db.prepare('SELECT id, type, file_key FROM items').all()).results;
        const expected = rows.map(row => row.id).sort().reverse();
        const items = [];
        let cursor = null;
        do {
          const result = await page(cursor ? `?cursor=${cursor}` : '');
          items.push(...result.items); cursor = result.nextCursor;
        } while (cursor);
        assert.deepEqual(items.map(item => item.id), expected);
        assert.equal(new Set(items.map(item => item.id)).size, 12);
        assert.ok(items.every(item => item.createdAt === 123456789));
        assert.deepEqual((await bucket.list()).objects.map(object => object.key).sort(), rows.filter(row => row.type === 'file').map(row => row.file_key).sort());
        for (const item of items.filter(item => item.type === 'file')) {
          assert.equal(await (await fetch(item.url)).text(), `file ${parseInt(item.name, 10)}`);
        }
      } finally { await db.prepare('DROP TRIGGER collide_time').run(); }
    });
    await t.test('cursor survives anchor deletion and newer inserts without repeating the first page', async () => {
      await reset();
      for (let i = 1; i <= 10; i++) {
        await text(`history ${i}`);
        await db.prepare('UPDATE items SET created_at = ? WHERE text_content = ?').bind(i, `history ${i}`).run();
      }
      const first = await page();
      await text('new arrival');
      const anchor = first.items.at(-1);
      assert.equal((await fetch(`/api/items/${anchor.id}`, { method: 'DELETE' })).status, 200);
      const older = await page(`?cursor=${first.nextCursor}`);
      assert.deepEqual(older.items.map(item => item.text), ['history 5', 'history 4', 'history 3', 'history 2', 'history 1']);
      assert.equal(older.nextCursor, null);
      assert.ok(!older.items.some(item => first.items.some(previous => previous.id === item.id)));
      assert.equal((await list())[0].text, 'new arrival');
    });
    await t.test('pagination validates limits and opaque cursors and signals end of history', async () => {
      await reset();
      for (let i = 0; i < 6; i++) await text(`item ${i}`);
      for (const limit of ['0', '-1', '51', '1.5', 'NaN', '01', '', '5&limit=5']) {
        assert.equal((await fetch(`/api/items?limit=${limit}`)).status, 400, limit);
      }
      for (const cursor of ['', 'invalid', '%ZZ', 'a'.repeat(257), Buffer.from(JSON.stringify({ v: 1, t: -1, id: crypto.randomUUID() })).toString('base64url'), Buffer.from(JSON.stringify({ v: 2, t: 1, id: crypto.randomUUID() })).toString('base64url')]) {
        assert.equal((await fetch(`/api/items?cursor=${cursor}`)).status, 400, cursor);
      }
      const first = await page('?limit=1');
      assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
      assert.equal((await fetch(`/api/items?cursor=${first.nextCursor}&cursor=${first.nextCursor}`)).status, 400);
      for (const limit of [20, 50]) {
        const result = await page(`?limit=${limit}`);
        assert.equal(result.items.length, 6); assert.equal(result.nextCursor, null);
      }
      const rest = await page(`?limit=50&cursor=${first.nextCursor}`);
      assert.equal(rest.items.length, 5); assert.equal(rest.nextCursor, null);
    });
    await t.test('binary roundtrip, Unicode filename and attachment/security headers', async () => {
      await reset();
      const bytes = Buffer.from([0, 255, 128, 1, 42]);
      const name = 'ảnh "firmware".bin';
      assert.equal((await file(name, bytes)).status, 201);
      const item = (await list())[0];
      assert.equal(item.name, name); assert.equal(item.size, bytes.length);
      const response = await fetch(item.url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
      assert.ok(response.headers.get('content-disposition').includes('filename*=UTF-8'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('content-security-policy').includes('sandbox'));
    });
    await t.test('HTML and SVG remain downloads; empty file supported', async () => {
      await reset();
      for (const mime of ['text/html', 'image/svg+xml']) {
        assert.equal((await file('unsafe-file', '<script>alert(1)</script>', { 'Content-Type': mime })).status, 201);
        const response = await fetch((await list())[0].url);
        assert.equal(response.headers.get('content-type'), mime);
        assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
      }
      assert.equal((await file('empty.bin', '')).status, 201);
      const response = await fetch((await list())[0].url);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    });
    await t.test('delete text/file, repeated delete and invalid file lookup', async () => {
      await reset();
      await text('delete me');
      const textItem = (await list())[0];
      assert.equal((await fetch(`/api/items/${textItem.id}/file`)).status, 404);
      assert.equal((await fetch(`/api/items/${textItem.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await fetch(`/api/items/${textItem.id}`, { method: 'DELETE' })).status, 404);
      await file('delete.bin', 'bytes');
      const item = (await list())[0];
      assert.equal((await fetch(`/api/items/${item.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await list()).length, 0);
      assert.equal((await bucket.list()).objects.length, 0);
      assert.equal((await fetch(item.url)).status, 404);
    });
    await t.test('concurrent duplicate deletes and upload/delete overlap do not remove another object', async () => {
      await reset();
      await file('delete.bin', 'delete bytes');
      const deleted = (await list())[0];
      await file('keep.bin', 'keep bytes');
      const kept = (await list())[0];
      const responses = await Promise.all([
        ...Array.from({ length: 6 }, () => fetch(`/api/items/${deleted.id}`, { method: 'DELETE' })),
        file('new.bin', 'new bytes'),
      ]);
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      assert.equal(responses.filter(response => response.status === 404).length, 5);
      assert.equal(responses[6].status, 201);
      assert.equal((await fetch(deleted.url)).status, 404);
      assert.equal(await (await fetch(kept.url)).text(), 'keep bytes');
      const rows = (await db.prepare('SELECT file_key FROM items WHERE pending_delete = 0').all()).results;
      assert.deepEqual((await bucket.list()).objects.map(object => object.key).sort(), rows.map(row => row.file_key).sort());
    });
    await t.test('filename injection, Content-Type and method errors use safe consistent headers', async () => {
      await reset();
      for (const name of ['bad\r\nX-Evil: value.bin', 'bad\u0000.bin']) {
        assert.equal((await file(name, 'bytes')).status, 400);
      }
      const name = 'a;"\\%file-é.bin';
      assert.equal((await file(name, 'bytes')).status, 201);
      const response = await fetch((await list())[0].url);
      const disposition = response.headers.get('content-disposition');
      assert.ok(disposition.startsWith('attachment; filename="'));
      assert.ok(!disposition.includes('\r') && !disposition.includes('\n'));
      assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
      assert.equal((await fetch('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'application/jsonp' }, body: '{"text":"wrong mime"}' })).status, 415);
      assert.equal((await fetch('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'Application/JSON; charset=utf-8' }, body: '{"text":"valid mime"}' })).status, 201);
      for (const [path, method, allow] of [['/api/items/file', 'GET', 'POST'], ['/api/items/text', 'DELETE', 'POST'], ['/api/items', 'POST', 'GET']]) {
        const denied = await fetch(path, { method });
        assert.equal(denied.status, 405); assert.equal(denied.headers.get('allow'), allow);
      }
    });
    await t.test('oversized headers, mismatched bytes, malformed payloads and invalid IDs/types', async () => {
      await reset();
      assert.equal((await file('huge.bin', '', { 'X-File-Size': String(100 * 1024 * 1024 + 1) })).status, 413);
      assert.equal((await file('lie.bin', '123', { 'X-File-Size': '2' })).status, 400);
      assert.equal((await file('lie.bin', '1', { 'X-File-Size': '2' })).status, 400);
      assert.equal((await file('bad.bin', '1', { 'X-File-Name': '%ZZ' })).status, 400);
      assert.equal((await file('bad.bin', '1', { 'X-File-Size': '-1' })).status, 400);
      assert.equal((await file('bad.bin', '1', { 'Content-Type': 'invalid' })).status, 400);
      assert.equal((await text('  ')).status, 400);
      assert.equal((await text('a'.repeat(65537))).status, 413);
      for (const body of ['{', '{}', '{"text":1}', '{"text":"hello","type":"file"}']) {
        assert.equal((await fetch('/api/items/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
      }
      assert.equal((await fetch('/api/items/text', { method: 'POST', body: 'hello' })).status, 415);
      assert.equal((await fetch('/api/items/not-an-id', { method: 'DELETE' })).status, 400);
      assert.equal((await fetch('/api/items', { method: 'POST' })).status, 405);
      assert.equal((await fetch('/api/missing')).status, 404);
      assert.equal((await list()).length, 0);
      assert.equal((await bucket.list()).objects.length, 0);
      await assert.rejects(db.prepare("INSERT INTO items (id,type,size) VALUES ('invalid','other',0)").run());
    });
    await t.test('streamed upload accepts exactly 100 MiB without a full-file JS buffer', async () => {
      await reset();
      const size = 100 * 1024 * 1024;
      let remaining = size;
      const expectedHash = createHash('sha256');
      let chunkIndex = 0;
      const body = new ReadableStream({ pull(controller) {
        if (!remaining) { controller.close(); return; }
        const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
        chunk.fill(chunkIndex++ % 251);
        expectedHash.update(chunk);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
      } });
      const response = await fetch('/api/items/file', { method: 'POST',
        headers: { 'X-File-Name': 'limit.bin', 'X-File-Size': String(size), 'Content-Type': 'application/octet-stream' }, body, duplex: 'half' });
      assert.equal(response.status, 201, await response.text());
      const item = (await list())[0];
      assert.equal(item.size, size);
      const row = await db.prepare('SELECT file_key FROM items WHERE id = ?').bind(item.id).first();
      assert.equal((await bucket.head(row.file_key)).size, size);
      const download = await fetch(item.url);
      assert.equal(download.status, 200);
      const actualHash = createHash('sha256');
      let received = 0;
      for await (const chunk of download.body) { actualHash.update(chunk); received += chunk.byteLength; }
      assert.equal(received, size);
      assert.equal(actualHash.digest('hex'), expectedHash.digest('hex'));
    });
    await t.test('stream rejects a lying byte count even without Content-Length', async () => {
      await reset();
      const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.close(); } });
      const response = await fetch('/api/items/file', { method: 'POST',
        headers: { 'X-File-Name': 'lie.bin', 'X-File-Size': '2', 'Content-Type': 'application/octet-stream' }, body, duplex: 'half' });
      assert.equal(response.status, 400);
      assert.equal((await list()).length, 0);
      assert.equal((await bucket.list()).objects.length, 0);
    });
    await t.test('D1 insertion failure compensates R2 upload and preserves prior items', async () => {
      await reset();
      await text('keep');
      await db.prepare("CREATE TRIGGER reject_file BEFORE INSERT ON items WHEN NEW.type = 'file' BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
      try {
        assert.equal((await file('rollback.bin', 'bytes')).status, 500);
        assert.equal((await bucket.list()).objects.length, 0);
        assert.equal((await list())[0].text, 'keep');
      } finally { await db.prepare('DROP TRIGGER reject_file').run(); }
    });
    await t.test('early R2 failure settles the upload instead of leaving the producer blocked', async () => {
      await reset();
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024)); controller.close();
      } });
      const response = await fetch('/api/items/file', { method: 'POST',
        headers: { 'X-File-Name': 'failed.bin', 'X-File-Size': '65536', 'Content-Type': 'application/octet-stream', 'X-Test-Fail-Put': '1' },
        body, duplex: 'half', signal: AbortSignal.timeout(1500) });
      assert.equal(response.status, 500);
      assert.equal((await bucket.list()).objects.length, 0);
      assert.equal((await list()).length, 0);
    });
    await t.test('unknown D1 ownership preserves possibly committed bytes', async () => {
      await reset();
      assert.equal((await file('uncertain.bin', 'keep if uncertain', { 'X-Test-Lost-Commit-Ack': '1', 'X-Test-Fail-Owner-Read': '1' })).status, 500);
      const item = (await list())[0];
      assert.equal(await (await fetch(item.url)).text(), 'keep if uncertain');
    });
    await t.test('cleanup batches stay within free-plan budgets and drain a backlog across requests', async () => {
      await reset();
      for (let i = 0; i < 25; i++) {
        const id = crypto.randomUUID();
        await bucket.put(`items/${id}`, 'pending');
        await db.prepare('INSERT INTO items (id,type,file_key,file_name,mime_type,size,pending_delete) VALUES (?,\'file\',?,\'pending.bin\',\'application/octet-stream\',7,1)').bind(id, `items/${id}`).run();
      }
      assert.equal((await list()).length, 0);
      assert.equal((await bucket.list()).objects.length, 15, 'one request processes at most ten pending objects');
      await list(); await list();
      assert.equal((await bucket.list()).objects.length, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM items').first()).n, 0);
    });
    await t.test('lost D1 commit acknowledgement must not destroy committed file bytes', async () => {
      await reset();
      assert.equal((await file('committed.bin', 'keep bytes', { 'X-Test-Lost-Commit-Ack': '1' })).status, 500);
      const item = (await list())[0];
      assert.equal(item.name, 'committed.bin');
      const response = await fetch(item.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'keep bytes');
    });
    await t.test('cleanup query failure does not misreport a committed mutation', async () => {
      await reset();
      const response = await fetch('/api/items/text', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Fail-Cleanup-Query': '1' },
        body: JSON.stringify({ text: 'saved despite cleanup outage' }) });
      assert.equal(response.status, 201);
      assert.equal((await list())[0].text, 'saved despite cleanup outage');
    });
    await t.test('metadata deletion failure retains a retryable tombstone after R2 removal', async () => {
      await reset();
      await file('retry-metadata.bin', 'delete bytes');
      const item = (await list())[0];
      await db.prepare("CREATE TRIGGER reject_cleanup BEFORE DELETE ON items WHEN OLD.pending_delete = 1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
      try {
        assert.equal((await fetch(`/api/items/${item.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await bucket.list()).objects.length, 0);
        assert.equal((await db.prepare('SELECT pending_delete FROM items WHERE id = ?').bind(item.id).first()).pending_delete, 1);
        assert.equal((await fetch(item.url)).status, 404);
      } finally { await db.prepare('DROP TRIGGER reject_cleanup').run(); }
      assert.equal((await list()).length, 0);
      assert.equal(await db.prepare('SELECT id FROM items WHERE id = ?').bind(item.id).first(), null);
    });
    await t.test('failed R2 deletion stays hidden and retries on next request', async () => {
      await reset();
      await file('retry.bin', 'bytes');
      const item = (await list())[0];
      assert.equal((await fetch(`/api/items/${item.id}`, { method: 'DELETE', headers: { 'X-Test-Fail-Delete': '1' } })).status, 200);
      assert.equal((await db.prepare('SELECT pending_delete FROM items WHERE id = ?').bind(item.id).first()).pending_delete, 1);
      assert.equal((await bucket.list()).objects.length, 1);
      assert.equal((await fetch(item.url)).status, 404);
      assert.equal((await list()).length, 0);
      assert.equal((await bucket.list()).objects.length, 0);
      assert.equal(await db.prepare('SELECT id FROM items WHERE id = ?').bind(item.id).first(), null);
    });
  } finally { await mf.dispose(); }
});
