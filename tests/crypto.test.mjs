import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { moduleUrl } from './load-ts.mjs';
import { referenceVectors, B, pattern, vaultInfo as refInfo, kdf, hash, unAes, label } from './protocol-reference.mjs';

test('isolated crypto core validation', async t => {
// Resolve modules sequentially: the shared data-URL loader caches completed modules.
const core = [];
for (const name of ['format', 'keys', 'itemCrypto', 'fileCrypto']) core.push(await import(await moduleUrl(`src/crypto/${name}.ts`)));
const [F, K, I, C] = core;
const vectors = JSON.parse(await readFile('tests/vectors/e2ee-v1.json', 'utf8'));
const h = bytes => Buffer.from(bytes).toString('hex');
const master = B(vectors.identity.master_hex);
const identity = { vaultId: B(vectors.identity.vault_id_hex), epochId: B(vectors.identity.epoch_id_hex) };
const context = fixture => ({ ...identity, itemId: B(fixture.item_id_hex) });
const entropy = [vectors.entropy.secret_hex, vectors.entropy.wrap_iv_hex, vectors.entropy.manifest_iv_hex];
// Test harness only; application code has no deterministic entropy parameter.
async function fixedEntropy(values, action) {
  const real = globalThis.crypto, original = Object.getOwnPropertyDescriptor(real, 'getRandomValues');
  const queue = values.map(B);
  Object.defineProperty(real, 'getRandomValues', { configurable: true, value(array) {
      const next = queue.shift(); assert.ok(next, 'unexpected entropy call'); assert.equal(next.length, array.length); array.set(next); return array;
    },
  });
  try { const result = await action(); assert.equal(queue.length, 0, 'unused vector entropy'); return result; }
  finally { if (original) Object.defineProperty(real, 'getRandomValues', original); else delete real.getRandomValues; }
}
async function* source(bytes, block = 65536) { for (let offset = 0; offset < bytes.length; offset += block) yield bytes.subarray(offset, offset + block); }
async function* patternSource(size) { for (let i = 0; i < size; i += 65536) yield pattern(Math.min(65536, size - i), i); }
async function collect(iterable) { const chunks = []; for await (const chunk of iterable) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function changed(bytes, offset = bytes.length - 1) { const copy = Buffer.from(bytes); copy[offset] ^= 1; return copy; }
await t.test('persisted vectors reproduce via independent Node/OpenSSL reference with no application imports', () => {
  const actual = referenceVectors();
  for (const field of ['format_version', 'identity', 'entropy', 'texts', 'files', 'vault']) assert.deepEqual(actual[field], vectors[field]);
});
await t.test('CSPRNG generation and HKDF domain separation', async () => {
  const a = K.generateVault(), b = K.generateVault(); assert.equal(a.master.length, 32); assert.notDeepEqual(a, b);
  const id = K.generateItemId(); F.encodeHeader({ ...a, itemId: id }, 0);
  const infos = ['item-wrap', 'item-manifest', 'file-chunks'].map(label => K.vaultInfo(label, identity.vaultId, identity.epochId, id));
  const outputs = await Promise.all(infos.map(info => K.hkdf(master, identity.vaultId, info, 32)));
  assert.equal(new Set(outputs.map(h)).size, 3);
  for (let i = 0; i < infos.length; i++) assert.equal(h(outputs[i]), h(kdf(master, identity.vaultId, infos[i])));

});
await t.test('text, empty text, item wrapping and manifests match byte-for-byte vectors', async () => {
  for (const fixture of vectors.texts) {
    const envelope = await fixedEntropy(entropy, () => I.sealText(master, context(fixture), fixture.text, vectors.entropy.created_at_ms));
    assert.equal(h(envelope), fixture.envelope_hex);
    assert.equal(h(F.encodeManifest({ kind: 'text', text: fixture.text, createdAt: vectors.entropy.created_at_ms })), fixture.manifest_plain_hex);
    assert.deepEqual(await I.openText(master, envelope, context(fixture)), { kind: 'text', text: fixture.text, createdAt: vectors.entropy.created_at_ms });
    const decoded = F.decodeEnvelope(envelope);
    const wrapKey = kdf(master, identity.vaultId, refInfo('item-wrap', identity.vaultId, identity.epochId, context(fixture).itemId));
    assert.equal(h(wrapKey), fixture.wrap_key_hex);
    assert.equal(h(unAes(wrapKey, decoded.wrapIv, label('key-wrap/v1', decoded.header), decoded.wrappedSecret)), vectors.entropy.secret_hex);
  }
  const tooBig = 'x'.repeat(65537);
  await assert.rejects(I.sealText(master, context(vectors.texts[0]), tooBig, 0));
  await assert.rejects(I.sealText(master, context(vectors.texts[0]), '\ud800', 0), /Unicode/);
});
await t.test('empty, partial, exactly 1 MiB, chunk+1 and multiple-chunk streams match independent vectors', async () => {
  for (const fixture of vectors.files) {
    const sealed = await fixedEntropy(entropy, () => C.sealFileManifest(master, context(fixture), {
      createdAt: vectors.entropy.created_at_ms, size: fixture.size, name: fixture.name, mimeType: fixture.mime_type }));
    assert.equal(h(sealed.envelope), fixture.envelope_hex);
    const opened = await C.openFileManifest(master, sealed.envelope, context(fixture));
    const objectHash = createHash('sha256'), plainHash = createHash('sha256'); let objectBytes = 0, plainBytes = 0, packet = 0;
    async function* tracked() {
      for await (const bytes of sealed.encrypt(patternSource(fixture.size))) {
        objectHash.update(bytes); objectBytes += bytes.length;
        if (packet === 0) assert.equal(h(bytes), fixture.prefix_hex);
        else {
          const record = fixture.records[packet - 1], cipher = bytes.subarray(4);
          assert.equal(bytes.readUInt32BE ? bytes.readUInt32BE(0) : new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), record.ciphertext_length);
          assert.equal(h(hash(cipher)), record.sha256); assert.equal(h(cipher.subarray(-16)), record.tag_hex);
        }
        packet++; yield bytes;
      }
    }
    for await (const bytes of opened.decrypt(tracked())) { plainHash.update(bytes); plainBytes += bytes.length; assert.ok(bytes.length <= F.CHUNK_SIZE); }
    assert.equal(objectBytes, fixture.object_size); assert.equal(objectHash.digest('hex'), fixture.object_sha256);
    assert.equal(plainBytes, fixture.size); assert.equal(plainHash.digest('hex'), fixture.plaintext_sha256);
    await assert.rejects(collect(sealed.encrypt(patternSource(fixture.size))), /single-use/);
  }
});
await t.test('vault keyCheck matches independent vectors and rejects tampering', async () => {
  const descriptor = await fixedEntropy([vectors.vault.iv_hex], () => K.createDescriptor(master, identity.vaultId, identity.epochId));
  assert.equal(h(descriptor), vectors.vault.descriptor_hex); const verified = await K.verifyDescriptor(master, descriptor);
  assert.equal(h(verified.vaultId), h(identity.vaultId)); assert.equal(h(verified.epochId), h(identity.epochId));
  await assert.rejects(K.verifyDescriptor(changed(master), descriptor));
  for (const at of [5, 6, 8, 24, 40, 99]) await assert.rejects(K.verifyDescriptor(master, changed(descriptor, at)));
});
await t.test('context/header/manifest/key-wrap substitution fails closed', async () => {
  const fixture = vectors.texts[0], original = B(fixture.envelope_hex);
  for (const field of ['vaultId', 'epochId', 'itemId']) {
    await assert.rejects(I.openText(master, original, { ...context(fixture), [field]: changed(context(fixture)[field], 15) }));
  }
  for (const at of [0, 5, 6, 7, 8, 24, 40, 56, 68, 115, 116, 127, 131, original.length - 1]) {
    await assert.rejects(I.openText(master, changed(original, at), context(fixture)));
  }
  await assert.rejects(I.openText(changed(master), original, context(fixture)));
  await assert.rejects(I.openText(master, Buffer.concat([original, Buffer.from([0])]), context(fixture)));
  await assert.rejects(I.openText(master, original.subarray(0, -1), context(fixture)));
  const oversized = Buffer.from(original); oversized.writeUInt32BE(0xffffffff, 128);
  assert.throws(() => F.decodeEnvelope(oversized));
});
await t.test('file parser rejects corruption, reorder, duplicate, missing/truncated final chunk and trailing/incorrect lengths', async () => {
  const fixture = vectors.files.at(-1), ctx = context(fixture);
  const sealed = await fixedEntropy(entropy, () => C.sealFileManifest(master, ctx, {
    createdAt: vectors.entropy.created_at_ms, size: fixture.size, name: fixture.name, mimeType: fixture.mime_type }));
  const bytes = await collect(sealed.encrypt(patternSource(fixture.size))), firstEnd = 92 + 4 + F.CHUNK_SIZE + 16, secondEnd = firstEnd + 4 + F.CHUNK_SIZE + 16;
  const prefix = bytes.subarray(0, 92), a = bytes.subarray(92, firstEnd), b = bytes.subarray(firstEnd, secondEnd), c = bytes.subarray(secondEnd);
  const badLength = Buffer.from(bytes); badLength.writeUInt32BE(0xffffffff, 92);
  const attacks = [changed(bytes, 100), changed(bytes, 10), changed(bytes, 91), Buffer.concat([prefix, b, a, c]),
    Buffer.concat([prefix, a, a, c]), bytes.subarray(0, secondEnd), bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from([0])]), badLength];
  for (const attack of attacks) {
    const opened = await C.openFileManifest(master, sealed.envelope, ctx);
    await assert.rejects(collect(opened.decrypt(source(attack))));
  }
  const manifest = B(fixture.manifest_plain_hex); manifest.writeUInt32BE(0, 18);
  assert.throws(() => F.decodeManifest(manifest, 1), 'wrong chunk size');
  const count = B(fixture.manifest_plain_hex); count.writeUInt32BE(1, 22);
  assert.throws(() => F.decodeManifest(count, 1), 'wrong declared count');
  assert.throws(() => F.decodeManifest(B(vectors.texts[0].manifest_plain_hex), 1));
});
await t.test('chunk nonce guards reject repeated/parallel/out-of-order encryption even after a failed source', async () => {
  const fixture = vectors.files[1], env = F.decodeEnvelope(B(fixture.envelope_hex)), secret = B(vectors.entropy.secret_hex);
  const key = await K.aesKey(secret, identity.vaultId, K.vaultInfo('file-chunks', identity.vaultId, identity.epochId, context(fixture).itemId), ['encrypt']);
  const manifest = { kind: 'file', size: 37, createdAt: 0, name: 'a.bin', mimeType: 'application/octet-stream' }, digest = await F.sha256(B(fixture.envelope_hex));
  const results = await Promise.allSettled([C.encryptChunk(key, env.header, digest, manifest, 0, pattern(37)), C.encryptChunk(key, env.header, digest, manifest, 0, pattern(37))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await assert.rejects(C.encryptChunk(key, env.header, digest, manifest, 0, pattern(37)));
  const sealed = await C.sealFileManifest(master, context(fixture), { size: 37, createdAt: 0, name: 'a.bin', mimeType: 'application/octet-stream' });
  await assert.rejects(collect(sealed.encrypt(source(Buffer.alloc(36)))));
  await assert.rejects(collect(sealed.encrypt(source(Buffer.alloc(37)))), /single-use/);
});
await t.test('codecs honor nonzero byte offsets, copy inputs and bound every declared length', async () => {
  const fixture = vectors.texts[0], bytes = B(fixture.envelope_hex);
  const padded = Buffer.concat([Buffer.alloc(23, 0xa5), bytes, Buffer.alloc(17, 0xa5)]);
  const slice = padded.subarray(23, 23 + bytes.length), decoded = F.decodeEnvelope(slice);
  assert.equal(h(F.encodeEnvelope(decoded)), fixture.envelope_hex);
  slice.fill(0);
  assert.equal(h(F.encodeEnvelope(decoded)), fixture.envelope_hex, 'decoded bytes are not aliased into caller storage');
  assert.equal(new F.Reader(Buffer.from([0xaa, 0x12, 0x34, 0xbb]).subarray(1, 3)).number(2), 0x1234);
  assert.throws(() => new F.Reader(Buffer.from('ffffffffffffffff', 'hex')).number(8), 'unsafe u64 integer');
  const hugeText = B(fixture.manifest_plain_hex); hugeText.writeUInt32BE(65537, 10);
  assert.throws(() => F.decodeManifest(hugeText, 0));
  assert.throws(() => F.decodeEnvelope(Buffer.alloc(F.MAX_ENVELOPE_BYTES + 1)));
  assert.throws(() => F.decodeEnvelope(changed(bytes, 7)), 'nonzero reserved byte');
  const bomText = '\ufeffliteral BOM\nảnh';
  const envelope = await I.sealText(master, context(fixture), bomText, 0);
  assert.equal((await I.openText(master, envelope, context(fixture))).text, bomText);
  const maximum = await I.sealText(master, context(fixture), 'x'.repeat(F.MAX_TEXT_BYTES), 0);
  assert.equal(maximum.length, F.MAX_ENVELOPE_BYTES);
  assert.equal((await I.openText(master, maximum, context(fixture))).text.length, F.MAX_TEXT_BYTES);
  for (const size of [-1, 0.5, F.MAX_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => F.chunkCount(size));
});

await t.test('HKDF copies salt/info before the asynchronous key import', async () => {
  const salt = Buffer.from(identity.vaultId), info = Buffer.from(K.vaultInfo('item-wrap', identity.vaultId, identity.epochId, context(vectors.texts[0]).itemId));
  const expected = kdf(master, salt, info);
  const pending = K.hkdf(master, salt, info, 32);
  salt.fill(0); info.fill(0);
  assert.equal(h(await pending), h(expected));
  assert.notDeepEqual(F.tuple(Buffer.from('ab'), Buffer.from('c')), F.tuple(Buffer.from('a'), Buffer.from('bc')), 'length prefixes remove concatenation ambiguity');
});

await t.test('file handles are consumed by cancellation and concurrent use; wrong-master file manifests fail', async () => {
  const fixture = vectors.files[1], metadata = { createdAt: 0, size: 37, name: 'a.bin', mimeType: 'application/octet-stream' };
  const sealed = await C.sealFileManifest(master, context(fixture), metadata);
  await assert.rejects(C.openFileManifest(changed(master), sealed.envelope, context(fixture)));
  await assert.rejects(C.openFileManifest(master, changed(sealed.envelope), context(fixture)));
  const first = sealed.encrypt(patternSource(37)), competing = sealed.encrypt(patternSource(37));
  await first.next();
  await assert.rejects(competing.next(), /single-use/);
  await first.return();
  await assert.rejects(collect(sealed.encrypt(patternSource(37))), /single-use/);
  const reopened = await C.openFileManifest(master, sealed.envelope, context(fixture));
  const aliased = Buffer.from(sealed.envelope);
  const pending = C.openFileManifest(master, aliased, context(fixture));
  aliased.fill(0);
  assert.deepEqual((await pending).manifest, reopened.manifest, 'open operation takes a stable envelope snapshot');
  const second = await C.sealFileManifest(master, context(fixture), metadata);
  await assert.rejects(collect(second.encrypt(source(Buffer.alloc(38)))), /Trailing/);
  await assert.rejects(collect(second.encrypt(patternSource(37))), /single-use/);
});

await t.test('file-key creation uses the immutable header even if caller metadata changes while awaiting', async () => {
  const fixture = vectors.files[1];
  const metadata = { kind: 'file', createdAt: 0, size: 37, name: 'a.bin', mimeType: 'application/octet-stream' };
  const pending = I.sealManifest(master, context(fixture), metadata);
  metadata.kind = 'text';
  const sealed = await pending;
  assert.ok(sealed.fileKey);
  assert.equal(sealed.fileKey.extractable, false);
  assert.deepEqual(sealed.fileKey.usages, ['encrypt']);
  const opened = await I.openManifest(master, sealed.envelope, context(fixture), 1);
  assert.equal(opened.manifest.kind, 'file');
  assert.deepEqual(opened.fileKey.usages, ['decrypt']);
});

});
