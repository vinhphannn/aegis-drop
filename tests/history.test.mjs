import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import wrtc from '@roamhq/wrtc';
import { moduleUrl } from './load-ts.mjs';
globalThis.IDBKeyRange = IDBKeyRange;
const { HistoryStore } = await import(await moduleUrl('src/history.ts'));
const { HistorySync } = await import(await moduleUrl('src/sync.ts'));
const { DirectPeer, checksum } = await import(await moduleUrl('src/peer.ts'));
const factory = new IDBFactory();
const cleanup = [];
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await fn())) { assert.ok(Date.now() < deadline, 'history sync timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function history(name = crypto.randomUUID()) { const store = new HistoryStore(name, factory); await store.ready; cleanup.push(() => store.close()); return store; }
async function connect(aHistory, bHistory) {
  const errors = [];
  const feedbackA = [], feedbackB = [];
  const syncA = new HistorySync(aHistory, message => feedbackA.push(message), error => errors.push(error));
  const syncB = new HistorySync(bHistory, message => feedbackB.push(message), error => errors.push(error));
  const a = new DirectPeer({ id: aHistory.deviceId, label: 'A' }), b = new DirectPeer({ id: bHistory.deviceId, label: 'B' });
  syncA.attach(a); syncB.attach(b);
  const pcA = new wrtc.RTCPeerConnection({ iceServers: [] }), pcB = new wrtc.RTCPeerConnection({ iceServers: [] });
  const session = crypto.randomUUID(); a.session = session; b.session = session;
  pcA.onicecandidate = event => { if (event.candidate) void pcB.addIceCandidate(event.candidate); };
  pcB.onicecandidate = event => { if (event.candidate) void pcA.addIceCandidate(event.candidate); };
  pcB.ondatachannel = event => b.attach(event.channel, b.epoch);
  a.attach(pcA.createDataChannel('aegis-drop-v1', { ordered: true }), a.epoch);
  await pcA.setLocalDescription(await pcA.createOffer()); await pcB.setRemoteDescription(pcA.localDescription);
  await pcB.setLocalDescription(await pcB.createAnswer()); await pcA.setRemoteDescription(pcB.localDescription);
  await until(() => a.getSnapshot().status === 'connected' && b.getSnapshot().status === 'connected');
  let closed = false;
  const close = () => { if (closed) return; closed = true; syncA.dispose(); syncB.dispose(); a.disconnect(); b.disconnect(); pcA.close(); pcB.close(); };
  cleanup.push(close); return { a, b, close, errors, syncA, syncB, feedbackA, feedbackB };
}
async function count(store) { let n = 0, after; for (;;) { const page = await store.inventoryPage(after); n += page.length; if (page.length < 48) return n; after = page.at(-1).id; } }

test('offline creation, reload, late join, bidirectional union and verified binary sync', async t => {
  try {
    const nameA = crypto.randomUUID(), nameB = crypto.randomUUID();
    let a = await history(nameA), b = await history(nameB);
    const first = await a.createText('created alone'); const deviceId = a.deviceId;
    await a.close(); a = await history(nameA);
    assert.equal(a.deviceId, deviceId); assert.deepEqual(await a.get(first.id), first);
    const pair = await connect(a, b);
    await until(async () => !!(await b.get(first.id)));
    assert.deepEqual(await b.get(first.id), first);
    pair.close();
    const onlyA = await a.createText('A offline'), onlyB = await b.createText('B offline');
    const bytes = new Uint8Array(70001); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const binary = await a.createFile(new File([bytes], 'history.bin', { type: 'application/octet-stream' }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkZkAAAAASUVORK5CYII=', 'base64');
    const image = await b.createFile(new File([png], 'history.png', { type: 'image/png' }));
    const merged = await connect(a, b);
    await until(async () => (await count(a)) === 5 && (await count(b)) === 5);
    await until(() => !merged.a.getSnapshot().sending && !merged.b.getSnapshot().sending);
    assert.deepEqual(await b.get(onlyA.id), onlyA); assert.deepEqual(await a.get(onlyB.id), onlyB);
    assert.equal(await checksum(await b.blob(binary.id)), binary.hash);
    assert.deepEqual(new Uint8Array(await (await b.blob(binary.id)).arrayBuffer()), bytes);
    assert.equal(await checksum(await a.blob(image.id)), image.hash);
    // Production history transports never retain file object URLs or Blob content in their snapshots.
    assert.deepEqual(merged.a.getSnapshot().items, []); assert.deepEqual(merged.b.getSnapshot().items, []);
    assert.deepEqual(merged.errors, []);
    merged.close(); await a.close(); await b.close();
    a = await history(nameA); b = await history(nameB);
    assert.equal(await count(a), 5); assert.equal(await count(b), 5);
    assert.equal(await checksum(await b.blob(binary.id)), binary.hash);
    const reconnect = await connect(a, b);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(reconnect.a.getSnapshot().transfers.length, 0); assert.equal(reconnect.b.getSnapshot().transfers.length, 0);
    assert.equal(await count(a), 5); assert.equal(await count(b), 5); reconnect.close();
    await t.test('immutable duplicate IDs cannot overwrite original content', async () => {
      assert.equal(await a.put(first), false);
      await assert.rejects(a.put({ ...first, text: 'mutated' }), /conflict/);
      assert.deepEqual(await a.get(first.id), first);
    });
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});

test('only 50 recent metadata records are restored; persisted history and paged inventories retain older items', async () => {
  try {
    const a = await history(), b = await history();
    for (let i = 0; i < 105; i++) await a.createText(`offline ${i}`);
    assert.equal(a.getSnapshot().length, 50); assert.equal(await count(a), 105);
    assert.ok(a.getSnapshot().every(item => !('blob' in item) && !('url' in item)));
    const pair = await connect(a, b);
    await until(async () => (await count(b)) === 105);
    assert.equal(b.getSnapshot().length, 50); assert.deepEqual(pair.errors, []);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});

test('live offline-created items propagate automatically and corrupted sync data is never persisted', async () => {
  try {
    const aHistory = await history(), bHistory = await history();
    const pair = await connect(aHistory, bHistory);
    const live = await aHistory.createText('created after connection');
    await until(async () => !!(await bHistory.get(live.id)));
    const originalSend = pair.a.channel.send.bind(pair.a.channel);
    pair.a.channel.send = data => {
      if (data instanceof ArrayBuffer) { const corrupted = data.slice(0); new Uint8Array(corrupted)[0] ^= 255; originalSend(corrupted); }
      else originalSend(data);
    };
    const file = await aHistory.createFile(new File(['original bytes'], 'bad-sync.bin'));
    await until(() => pair.b.getSnapshot().transfers.some(transfer => transfer.id === file.id && transfer.phase === 'failed'));
    assert.equal(await bHistory.get(file.id), undefined);
    await assert.rejects(bHistory.blob(file.id), /unavailable/);
    assert.equal(await checksum(await aHistory.blob(file.id)), file.hash);
    pair.close();
    const repaired = await connect(aHistory, bHistory);
    await until(async () => !!(await bHistory.get(file.id)));
    assert.equal(await checksum(await bHistory.blob(file.id)), file.hash);
    assert.deepEqual(repaired.errors, []);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});


test('idle inventory messages do not repeatedly announce Synced', async () => {
  try {
    const a = await history(), b = await history();
    const pair = await connect(a, b);
    await until(() => pair.feedbackA.includes('Synced') && pair.feedbackB.includes('Synced'));
    const before = [pair.feedbackA.length, pair.feedbackB.length];
    for (let i = 0; i < 10; i++) {
      pair.syncA.status(); pair.syncB.status();
      pair.a.sendHistory({ type: 'inventory', items: [], complete: true });
      pair.b.sendHistory({ type: 'inventory', items: [], complete: true });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual([pair.feedbackA.length, pair.feedbackB.length], before);
    assert.equal(pair.feedbackA.filter(value => value === 'Synced').length, 1);
    const item = await a.createText('one new sync cycle');
    await until(async () => !!(await b.get(item.id)));
    await until(() => pair.feedbackB.filter(value => value === 'Synced').length === 2);
    assert.deepEqual(pair.errors, []);
  } finally { for (const close of cleanup.splice(0).reverse()) await close(); }
});
