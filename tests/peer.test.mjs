import assert from 'node:assert/strict';
import test from 'node:test';
import wrtc from '@roamhq/wrtc';
import { moduleUrl } from './load-ts.mjs';
const { DirectPeer, validFile, MAX_FILE_BYTES, MAX_TEXT_BYTES, CHUNK_BYTES } = await import(await moduleUrl('src/peer.ts'));
const peers = [], connections = [];
const make = () => { const peer = new DirectPeer(); peers.push(peer); return peer; };
async function until(predicate, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'timed out waiting for the real RTC peer'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function connect() {
  const a = make(), b = make();
  const pcA = new wrtc.RTCPeerConnection({ iceServers: [] }), pcB = new wrtc.RTCPeerConnection({ iceServers: [] });
  connections.push(pcA, pcB);
  const session = crypto.randomUUID(); a.session = session; b.session = session;
  pcA.onicecandidate = event => { if (event.candidate) void pcB.addIceCandidate(event.candidate); };
  pcB.onicecandidate = event => { if (event.candidate) void pcA.addIceCandidate(event.candidate); };
  pcB.ondatachannel = event => b.attach(event.channel, b.epoch);
  a.attach(pcA.createDataChannel('aegis-drop-v1', { ordered: true }), a.epoch);
  await pcA.setLocalDescription(await pcA.createOffer()); await pcB.setRemoteDescription(pcA.localDescription);
  await pcB.setLocalDescription(await pcB.createAnswer()); await pcA.setRemoteDescription(pcB.localDescription);
  await until(() => a.getSnapshot().status === 'connected' && b.getSnapshot().status === 'connected');
  return { a, b };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkZkAAAAASUVORK5CYII=', 'base64');

test('two native WebRTC peers, real encrypted DataChannel transfers', async t => {
  try {
    const { a, b } = await connect();
    await t.test('text travels in both directions, including exact Unicode and whitespace', async () => {
      a.sendText('  Xin chào 🌿\n漢字  '); b.sendText('reply from B');
      await until(() => b.getSnapshot().items.length === 2 && a.getSnapshot().items.length === 2);
      assert.equal(b.getSnapshot().items[0].text, '  Xin chào 🌿\n漢字  ');
      assert.equal(a.getSnapshot().items[0].text, 'reply from B');
    });
    await t.test('small PNG is byte-identical, has a local preview and an original Unicode name', async () => {
      await a.sendFile(new File([png], 'ảnh riêng.png', { type: 'image/png' }));
      const item = b.getSnapshot().items[0]; assert.equal(item.name, 'ảnh riêng.png');
      assert.equal(item.mimeType, 'image/png'); assert.ok(item.previewUrl?.startsWith('blob:'));
      assert.deepEqual(Buffer.from(await (await fetch(item.url)).arrayBuffer()), png);
      assert.deepEqual(Buffer.from(await (await fetch(item.previewUrl)).arrayBuffer()), png);
      assert.equal((await fetch(item.url)).headers.get('content-type'), 'application/octet-stream');
      assert.equal(a.getSnapshot().sending, null); assert.equal(b.getSnapshot().receiving, null);
    });
    for (const size of [0, 37, CHUNK_BYTES, CHUNK_BYTES + 1, 1024 * 1024 + 7]) await t.test(`binary file ${size} bytes is reconstructed exactly`, async () => {
      const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 3) & 255;
      let reported = false; const off = a.subscribe(() => { if (a.getSnapshot().sending?.bytes > 0) reported = true; });
      try { await a.sendFile(new File([bytes], `firmware-${size}.bin`, { type: 'application/octet-stream' })); }
      finally { off(); }
      const item = b.getSnapshot().items[0]; assert.equal(item.size, size);
      assert.deepEqual(new Uint8Array(await (await fetch(item.url)).arrayBuffer()), bytes);
      if (size > 0) assert.equal(reported, true);
    });
    await t.test('opposite directions can transfer files simultaneously', async () => {
      await Promise.all([a.sendFile(new File(['from A'], 'a.bin')), b.sendFile(new File(['from B'], 'b.bin'))]);
      assert.equal(await (await fetch(b.getSnapshot().items.find(item => item.name === 'a.bin').url)).text(), 'from A');
      assert.equal(await (await fetch(a.getSnapshot().items.find(item => item.name === 'b.bin').url)).text(), 'from B');
    });
    await t.test('HTML/SVG remain generic downloads with no previews', async () => {
      for (const mime of ['text/html', 'image/svg+xml']) {
        await a.sendFile(new File(['<script>test</script>'], 'untrusted.bin', { type: mime }));
        const item = b.getSnapshot().items[0]; assert.equal(item.previewUrl, undefined);
        assert.equal((await fetch(item.url)).headers.get('content-type'), 'application/octet-stream');
      }
    });
    await t.test('bounded history removes oldest URLs; remove and disconnect revoke URLs', async () => {
      const prior = b.getSnapshot().items[0], oldUrl = prior.url;
      for (let i = 0; i < 6; i++) a.sendText(`item ${i}`);
      await until(() => b.getSnapshot().items[0].text === 'item 5'); assert.equal(b.getSnapshot().items.length, 5);
      await assert.rejects(fetch(oldUrl));
      await a.sendFile(new File(['remove'], 'remove.bin')); const item = b.getSnapshot().items[0]; b.remove(item.id); await assert.rejects(fetch(item.url));
      await a.sendFile(new File(['close'], 'close.bin')); const url = b.getSnapshot().items[0].url;
      a.disconnect(); await until(() => b.getSnapshot().status !== 'connected'); await assert.rejects(fetch(url));
      assert.deepEqual(b.getSnapshot().items, []);
    });
  } finally { peers.splice(0).forEach(peer => peer.disconnect()); connections.splice(0).forEach(pc => pc.close()); }
});

test('limits reject malformed inputs', async () => {
  for (const size of [-1, 0.5, MAX_FILE_BYTES + 1]) assert.throws(() => validFile('file.bin', 'application/octet-stream', size));
  for (const name of ['', '../escape', 'bad\nname', 'x'.repeat(4097)]) assert.throws(() => validFile(name, 'application/octet-stream', 0));
  const peer = make(); assert.throws(() => peer.sendText('not connected'), /Connect/); peer.disconnect();
});

test('real RTC rejects oversized sends, cross-session frames, orphan/oversized binary and incomplete file completion', async () => {
  try {
    const pair = await connect();
    assert.throws(() => pair.a.sendText('x'.repeat(MAX_TEXT_BYTES + 1)), /12 KiB/);
    const huge = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'large.bin'); huge.slice = () => { throw new Error('must not read'); };
    await assert.rejects(pair.a.sendFile(huge), /32 MiB/); assert.equal(pair.b.getSnapshot().status, 'connected');
    pair.a.channel.send(JSON.stringify({ v: 1, session: crypto.randomUUID(), type: 'text', id: crypto.randomUUID(), text: 'wrong-session' }));
    await until(() => pair.b.getSnapshot().status === 'failed'); assert.deepEqual(pair.b.getSnapshot().items, []);
    for (const mode of ['orphan', 'oversized', 'tiny', 'incomplete', 'unknown', 'bad-json']) {
      const { a, b } = await connect(), session = a.session, id = crypto.randomUUID();
      const send = value => a.channel.send(JSON.stringify({ v: 1, session, ...value }));
      if (mode === 'orphan') a.channel.send(new ArrayBuffer(1));
      if (mode === 'oversized') { send({ type: 'file-start', id, name: 'x.bin', mime: 'application/octet-stream', size: CHUNK_BYTES + 1 }); a.channel.send(new ArrayBuffer(CHUNK_BYTES + 1)); }
      if (mode === 'tiny') { send({ type: 'file-start', id, name: 'x.bin', mime: 'application/octet-stream', size: CHUNK_BYTES }); a.channel.send(new ArrayBuffer(1)); }
      if (mode === 'incomplete') { send({ type: 'file-start', id, name: 'x.bin', mime: 'application/octet-stream', size: 2 }); a.channel.send(new ArrayBuffer(1)); send({ type: 'file-end', id }); }
      if (mode === 'unknown') send({ type: 'surprise' });
      if (mode === 'bad-json') a.channel.send('{');
      await until(() => b.getSnapshot().status === 'failed'); assert.deepEqual(b.getSnapshot().items, []);
    }
  } finally { peers.splice(0).forEach(peer => peer.disconnect()); connections.splice(0).forEach(pc => pc.close()); }
});

test('backpressure waits for bufferedamountlow rather than reading the whole file', async () => {
  // Controlled queue pressure exercises the real sendFile loop; transfer tests
  // above use native ICE/DTLS/SCTP rather than a simulated transport.
  const peer = make(), channel = new EventTarget();
  channel.readyState = 'open'; channel.bufferedAmount = 256 * 1024; channel.sent = [];
  channel.send = data => {
    channel.sent.push(data);
    if (typeof data === 'string' && JSON.parse(data).type === 'file-end') queueMicrotask(() => { peer.ack.resolve(); peer.ack = undefined; });
  };
  peer.channel = channel; peer.hello = true; peer.state = { ...peer.state, status: 'connected' }; peer.session = crypto.randomUUID();
  let reads = 0; const file = new File([new Uint8Array(CHUNK_BYTES * 3)], 'pressure.bin'), slice = file.slice.bind(file);
  file.slice = (...args) => { reads++; return slice(...args); };
  try {
    const sending = peer.sendFile(file); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(reads, 0);
    channel.bufferedAmount = 0; channel.dispatchEvent(new Event('bufferedamountlow')); await sending;
    assert.equal(reads, 4); assert.equal(channel.sent.filter(value => value instanceof ArrayBuffer).length, 3);
    assert.ok(channel.sent.filter(value => value instanceof ArrayBuffer).every(value => value.byteLength <= CHUNK_BYTES));
  } finally { peer.channel = undefined; peer.disconnect(); peers.splice(0).forEach(peer => peer.disconnect()); connections.splice(0).forEach(pc => pc.close()); }
});
