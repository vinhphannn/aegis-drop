import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './load-ts.mjs';

test('Vite proxy uses HTTP Worker and translates only same-origin browser mutations', async () => {
  const { default: config } = await import(await moduleUrl('vite.config.ts'));
  const proxy = config.server.proxy['/api'];
  assert.equal(proxy.target, 'http://127.0.0.1:8787');
  assert.equal(proxy.changeOrigin, true);
  let callback;
  proxy.configure({ on(event, handler) { assert.equal(event, 'proxyReq'); callback = handler; } });
  for (const [origin, expected] of [['http://localhost:5173', 'http://127.0.0.1:8787'], ['https://foreign.example', null], [undefined, null]]) {
    const changes = [];
    callback({ setHeader(name, value) { changes.push([name, value]); } }, { headers: { host: 'localhost:5173', origin } });
    assert.deepEqual(changes, expected ? [['Origin', expected]] : []);
  }
});
