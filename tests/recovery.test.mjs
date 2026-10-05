import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { moduleUrl } from './load-ts.mjs';
import { B, referenceVectors, recoveryKeyReference, aes, kdf, tlv, label, number } from './protocol-reference.mjs';

test('isolated v1 recovery validation', async t => {
  const F = await import(await moduleUrl('src/crypto/format.ts'));
  const K = await import(await moduleUrl('src/crypto/keys.ts'));
  const R = await import(await moduleUrl('src/crypto/recovery.ts'));
  const all = JSON.parse(await readFile('tests/vectors/e2ee-v1.json', 'utf8'));
  const v = all.recovery, master = B(all.identity.master_hex), descriptor = B(all.vault.descriptor_hex);
  const key = B(v.key_hex), bytes = B(v.package_hex), hex = value => Buffer.from(value).toString('hex');
  const corrupt = (value, offset) => { const result = Buffer.from(value); result[offset] ^= 1; return result; };
  async function fixedEntropy(action) {
    const real = crypto, original = Object.getOwnPropertyDescriptor(real, 'getRandomValues');
    const queue = [v.salt_hex, v.iv_hex, v.key_hex].map(B);
    Object.defineProperty(real, 'getRandomValues', { configurable: true, value(array) {
      const next = queue.shift(); assert.ok(next); assert.equal(array.length, next.length); array.set(next); return array;
    } });
    try { const result = await action(); assert.equal(queue.length, 0); return result; }
    finally { if (original) Object.defineProperty(real, 'getRandomValues', original); else delete real.getRandomValues; }
  }
  async function expectRejected(action, message = 'Invalid recovery package or key.') {
    let output;
    await assert.rejects(async () => { output = await action(); }, error => {
      assert.equal(error.message, message);
      for (const secret of [hex(master), hex(key), v.human_key]) assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(output, undefined, 'failures never resolve with partial recovered material');
  }
  // Deliberately authenticate invalid inner payloads with public test keys. This
  // tests validation after AEAD succeeds rather than making every failure a bad tag.
  function authenticatedPackage(bundle, header = bytes.subarray(0, 88)) {
    const info = tlv(Buffer.from('AEGIS-Drop'), number(1, 2), Buffer.from('recovery/v1'), header.subarray(8, 24), header.subarray(24, 40));
    const derived = kdf(key, header.subarray(40, 56), info), iv = bytes.subarray(88, 100);
    return Buffer.concat([header, iv, aes(derived, iv, label('recovery/v1', header), bundle)]);
  }

  await t.test('deterministic wrap and human key reproduce independent Node/OpenSSL vectors', async () => {
    assert.deepEqual(referenceVectors().recovery, v);
    const wrapped = await fixedEntropy(() => R.wrapRecovery(master, descriptor));
    assert.equal(hex(wrapped.recoveryKey), v.key_hex);
    assert.equal(hex(wrapped.package), v.package_hex);
    assert.equal(wrapped.package.length, R.RECOVERY_PACKAGE_BYTES);
    assert.equal(await R.encodeRecoveryKey(key), v.human_key);
    assert.deepEqual(recoveryKeyReference(key), { human_key: v.human_key, checksum_hex: v.checksum_hex });
    assert.equal(hex(await R.decodeRecoveryKey(v.human_key)), v.key_hex);
    assert.equal(hex(await R.decodeRecoveryKey(v.human_key.toLowerCase())), v.key_hex);
  });

  await t.test('recovery restores exact root, identity and descriptor and validates keyCheck', async () => {
    const root = await R.unwrapRecovery(await R.decodeRecoveryKey(v.human_key), bytes);
    assert.equal(hex(root.master), hex(master)); assert.equal(hex(root.descriptor), hex(descriptor));
    assert.equal(hex(root.vaultId), all.identity.vault_id_hex); assert.equal(hex(root.epochId), all.identity.epoch_id_hex);
    assert.equal(hex(root.descriptorHash), hex(await F.sha256(descriptor)));
    const identity = await K.verifyDescriptor(root.master, root.descriptor);
    assert.equal(hex(identity.vaultId), hex(root.vaultId)); assert.equal(hex(identity.epochId), hex(root.epochId));
    assert.ok(!bytes.includes(master), 'M is not present verbatim in serialized package');
    assert.ok(!bytes.includes(key), 'R is not present verbatim in serialized package');
  });

  await t.test('CSPRNG recovery key, salt and IV are fresh across wraps of the same vault', async () => {
    const first = await R.wrapRecovery(master, descriptor), second = await R.wrapRecovery(master, descriptor);
    assert.equal(first.recoveryKey.length, 32);
    assert.notEqual(hex(first.recoveryKey), hex(second.recoveryKey));
    assert.notEqual(hex(first.package.subarray(40, 56)), hex(second.package.subarray(40, 56)));
    assert.notEqual(hex(first.package.subarray(88, 100)), hex(second.package.subarray(88, 100)));
    assert.equal(hex((await R.unwrapRecovery(first.recoveryKey, first.package)).master), hex(master));
    assert.equal(hex((await R.unwrapRecovery(second.recoveryKey, second.package)).master), hex(master));
  });

  await t.test('key parser rejects corruption, wrong checksum, noncanonical padding and ambiguous formatting', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const badCharacter = v.human_key.slice(0, 9) + (v.human_key[9] === 'A' ? 'B' : 'A') + v.human_key.slice(10);
    const last = alphabet.indexOf(v.human_key.at(-1));
    const wrongChecksum = v.human_key.slice(0, -1) + alphabet[last ^ 4];
    const wrongPadding = v.human_key.slice(0, -1) + alphabet[last | 1];
    for (const invalid of [badCharacter, wrongChecksum, wrongPadding, '', ' ' + v.human_key, v.human_key + '\n',
      v.human_key.replace('AEGIS-R1', 'AEGIS-R2'), v.human_key.replaceAll('-', ''),
      v.human_key.replaceAll('-', ' '), v.human_key.replaceAll('-', '–'),
      v.human_key.slice(0, 9) + '0' + v.human_key.slice(10), v.human_key.slice(0, 9) + '1' + v.human_key.slice(10),
      v.human_key + '=', v.human_key.slice(0, -1), v.human_key + 'A', null, 123]) {
      await expectRejected(() => R.decodeRecoveryKey(invalid), 'Invalid recovery key.');
    }
    assert.equal(hex(key), v.key_hex, 'encoding/decoding does not erase caller-owned R');
  });

  await t.test('package rejects wrong key, changed salt/IV/ciphertext/IDs/hash/version/reserved bytes', async () => {
    await expectRejected(() => R.unwrapRecovery(corrupt(key, 0), bytes));
    for (const offset of [0, 5, 6, 7, 8, 24, 40, 55, 56, 87, 88, 99, 100, 247]) {
      await expectRejected(() => R.unwrapRecovery(key, corrupt(bytes, offset)));
    }
    for (const length of [0, 1, 99, 247, 249, 65536]) await expectRejected(() => R.unwrapRecovery(key, Buffer.alloc(length)));
    await expectRejected(() => R.unwrapRecovery(key, bytes.subarray(0, -1)));
    await expectRejected(() => R.unwrapRecovery(key, Buffer.concat([bytes, Buffer.from([0])])));
    for (const length of [0, 31, 33]) await expectRejected(() => R.unwrapRecovery(Buffer.alloc(length), bytes));
  });

  await t.test('valid outer AEAD does not bypass inner keyCheck, identity, hash or length validation', async () => {
    const bundle = Buffer.concat([master, descriptor]);
    await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(corrupt(bundle, 0))), 'Invalid recovery package or key.');
    await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(corrupt(bundle, 32 + 5))));
    await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(corrupt(bundle, 131))));
    for (const field of [8, 24, 56]) {
      await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(bundle, corrupt(bytes.subarray(0, 88), field))));
    }
    await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(bundle.subarray(0, -1))));
    await expectRejected(() => R.unwrapRecovery(key, authenticatedPackage(Buffer.concat([bundle, Buffer.from([0])]))));
    await expectRejected(() => R.wrapRecovery(corrupt(master, 0), descriptor));
  });

  await t.test('wrap snapshots root and descriptor before await and keeps caller material intact', async () => {
    const m = Buffer.from(master), d = Buffer.from(descriptor), pending = R.wrapRecovery(m, d);
    m.fill(0); d.fill(0);
    const result = await pending;
    const recovered = await R.unwrapRecovery(result.recoveryKey, result.package);
    assert.equal(hex(recovered.master), hex(master)); assert.equal(hex(recovered.descriptor), hex(descriptor));
    await R.wrapRecovery(master, descriptor);
    assert.equal(hex(master), all.identity.master_hex); assert.equal(hex(descriptor), all.vault.descriptor_hex);
  });

  await t.test('unwrap and human encoding snapshot buffer-backed views and reject without logging secrets', async () => {
    const backing = Buffer.concat([Buffer.alloc(23), bytes, Buffer.alloc(7)]), view = backing.subarray(23, 271);
    const r = Buffer.from(key), pending = R.unwrapRecovery(r, view);
    r.fill(0); view.fill(0);
    const recovered = await pending; assert.equal(hex(recovered.master), hex(master));
    const mutable = Buffer.from(key), encoded = R.encodeRecoveryKey(mutable); mutable.fill(0);
    assert.equal(await encoded, v.human_key);
    const calls = [], originals = {};
    for (const name of ['log', 'error', 'warn', 'debug', 'info']) { originals[name] = console[name]; console[name] = (...args) => calls.push(args); }
    try {
      await expectRejected(() => R.unwrapRecovery(corrupt(key, 0), bytes));
      await expectRejected(() => R.decodeRecoveryKey('bad-key'), 'Invalid recovery key.');
      await R.unwrapRecovery(key, bytes);
      assert.deepEqual(calls, []);
    } finally { for (const name of Object.keys(originals)) console[name] = originals[name]; }
  });
});
