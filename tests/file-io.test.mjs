import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './load-ts.mjs';

test('bounded operational encrypted file I/O', async t => {
  const L = await import(await moduleUrl('src/localVault.ts'));
  const IO = await import(await moduleUrl('src/fileIO.ts'));
  const { BROWSER_FILE_LIMIT } = await import(await moduleUrl('src/model.ts'));
  const enrollment = await L.createEnrollment(); let handle = await L.unlockEnrollment(enrollment); L.activateVault(handle);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkZkAAAAASUVORK5CYII=', 'base64');
  async function fixture(bytes, name = 'ảnh — firmware.bin', type = 'application/octet-stream') {
    const upload = await IO.encryptedUpload(new File([bytes], name, { type }));
    const wire = new Uint8Array(await upload.body.arrayBuffer()), n = new DataView(wire.buffer).getUint32(0);
    const envelope = Buffer.from(wire.subarray(4, 4 + n)).toString('base64url'), object = wire.slice(4 + n);
    const { manifest } = await L.openVaultFile(upload.id, envelope);
    const item = { id: upload.id, type: 'file', createdAt: 1, name: manifest.name, size: manifest.size, mimeType: manifest.mimeType,
      url: `/api/items/${upload.id}/file`, envelope };
    return { upload, item, object };
  }
  const response = object => new Response(object, { headers: { 'Content-Type': 'application/octet-stream' } });
  try {
    for (const size of [0, 37, 1048575, 1048576, 1048577, 2097189]) await t.test(`full verified roundtrip at ${size} bytes with Unicode filename`, async () => {
      const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 3) & 255;
      const { upload, item, object } = await fixture(bytes);
      assert.equal(upload.ciphertextSize, size + 92 + 20 * Math.ceil(size / 1048576));
      assert.equal(item.name, 'ảnh — firmware.bin'); assert.equal(item.size, size);
      const blob = await IO.decryptedDownload(item, async () => response(object));
      assert.equal(blob.type, 'application/octet-stream'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
      assert.notDeepEqual(object, bytes);
    });
    await t.test('image uses the file crypto path and creates a verified bounded local preview', async () => {
      const { item, object } = await fixture(png, 'ảnh.png', 'image/png');
      const url = await IO.localPreview(item, async () => response(object)); assert.ok(url?.startsWith('blob:'));
      assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), png);
      IO.disposePreviews([{ ...item, previewUrl: url }]);
    });
    await t.test('HTML/SVG and oversized pixel claims never create previews', async () => {
      for (const type of ['text/html', 'image/svg+xml']) {
        const { item, object } = await fixture(Buffer.from('<script>secret</script>'), 'unsafe.bin', type);
        assert.equal(await IO.localPreview(item, async () => response(object)), undefined);
      }
      const big = Buffer.from(png); big.writeUInt32BE(100000, 16);
      const { item, object } = await fixture(big, 'big.png', 'image/png');
      assert.equal(await IO.localPreview(item, async () => response(object)), undefined);
    });
    await t.test('wrong vault and modified/unsupported manifests fail before fetching plaintext', async () => {
      const { item, object } = await fixture(new Uint8Array(37));
      const foreign = await L.unlockEnrollment(await L.createEnrollment()); L.activateVault(foreign);
      await assert.rejects(IO.decryptedDownload(item, async () => response(object)));
      L.releaseVault(foreign); handle = await L.unlockEnrollment(enrollment); L.activateVault(handle);
      const changed = Buffer.from(item.envelope, 'base64url'); changed[changed.length - 1] ^= 1;
      await assert.rejects(IO.decryptedDownload({ ...item, envelope: changed.toString('base64url') }, async () => response(object)));
      changed[5] = 2;
      await assert.rejects(IO.decryptedDownload({ ...item, envelope: changed.toString('base64url') }, async () => response(object)));
    });
    await t.test('user save URL uses generic binary MIME and is revoked on lock', async () => {
      const original = globalThis.document; let link;
      globalThis.document = { createElement(tag) { assert.equal(tag, 'a'); link = { click() {} }; return link; } };
      try {
        IO.exposeDownload(new Blob(['<script>test</script>'], { type: 'text/html' }), 'original.html');
        assert.equal(link.download, 'original.html');
        const response = await fetch(link.href); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.equal(await response.text(), '<script>test</script>');
        IO.clearFileOutput(); await assert.rejects(fetch(link.href));
      } finally { globalThis.document = original; }
    });
    await t.test('corrupted, reordered, duplicated, missing, truncated and trailing chunks never return a Blob', async () => {
      const { item, object } = await fixture(new Uint8Array(2097189));
      const end = 92 + 1048576 + 20, second = end + 1048576 + 20;
      const changed = object.slice(); changed[100] ^= 1;
      const concat = (...parts) => Buffer.concat(parts.map(part => Buffer.from(part)));
      const attacks = [changed, object.subarray(0, -1), object.subarray(0, second), concat(object, [0]),
        concat(object.subarray(0, 92), object.subarray(end, second), object.subarray(92, end), object.subarray(second)),
        concat(object.subarray(0, 92), object.subarray(92, end), object.subarray(92, end), object.subarray(second))];
      for (const attack of attacks) { let output; await assert.rejects(async () => { output = await IO.decryptedDownload(item, async () => response(attack)); }); assert.equal(output, undefined); }
    });
    await t.test('pre-abort and cancellation during network read clear output and permit a later download', async () => {
      const { item, object } = await fixture(new Uint8Array(37));
      const early = new AbortController(); early.abort(); await assert.rejects(IO.decryptedDownload(item, async () => response(object), early.signal));
      const abort = new AbortController(); let entered, cancelled = false;
      const started = new Promise(resolve => { entered = resolve; });
      const pending = IO.decryptedDownload(item, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(object.subarray(0, 92)); entered(); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/octet-stream' } }), abort.signal);
      const rejected = assert.rejects(pending); await started; abort.abort(); await rejected; assert.equal(cancelled, true);
      assert.equal((await IO.decryptedDownload(item, async () => response(object))).size, 37);
    });
    await t.test('upload failure requires frozen ciphertext or a new operation, never handle reuse', async () => {
      const op = await L.prepareVaultFile({ name: 'file.bin', size: 37, mimeType: 'application/octet-stream', createdAt: 0 });
      const iter = op.encrypt((async function* () { yield new Uint8Array(36); })());
      await iter.next(); await assert.rejects(iter.next());
      await assert.rejects(op.encrypt((async function* () { yield new Uint8Array(37); })()).next(), /single-use/);
      const a = await fixture(new Uint8Array(37)), b = await fixture(new Uint8Array(37));
      assert.notEqual(a.item.id, b.item.id); assert.notDeepEqual(a.object, b.object);
      assert.deepEqual(new Uint8Array(await a.upload.body.arrayBuffer()), new Uint8Array(await a.upload.body.arrayBuffer()), 'frozen payload can be resent verbatim');
    });
    await t.test('8 MiB cap rejects before reading, lock blocks decrypt/encrypt and revokes previews', async () => {
      const file = new File([new Uint8Array(BROWSER_FILE_LIMIT + 1)], 'large.bin');
      file.slice = () => { throw new Error('must not read oversized file'); };
      await assert.rejects(IO.encryptedUpload(file), /limited to 8 MiB/);
      const large = await L.prepareVaultFile({ name: 'large.bin', size: BROWSER_FILE_LIMIT + 1, mimeType: 'application/octet-stream', createdAt: 0 });
      await assert.rejects(IO.decryptedDownload({ id: large.id, envelope: Buffer.from(large.envelope).toString('base64url'), url: '/must-not-fetch' },
        async () => { throw new Error('must not fetch oversized file'); }), /limited to 8 MiB/);
      const { item, object } = await fixture(png, 'image.png', 'image/png');
      const url = await IO.localPreview(item, async () => response(object)); assert.ok(url);
      L.clearActiveVault(); IO.clearFileOutput(); await assert.rejects(fetch(url));
      await assert.rejects(IO.decryptedDownload(item, async () => response(object)), /Unlock/);
      await assert.rejects(IO.encryptedUpload(new File(['x'], 'x.bin')), /Unlock/);
    });
  } finally { IO.clearFileOutput(); L.releaseVault(handle); }
});
