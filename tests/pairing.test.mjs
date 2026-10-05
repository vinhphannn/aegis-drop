import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createECDH, createHmac } from 'node:crypto';
import { moduleUrl } from './load-ts.mjs';
import { B, referenceVectors, kdf, hash, tlv, number, label, aes } from './protocol-reference.mjs';

test('isolated v1 pairing validation', async t => {
  const K = await import(await moduleUrl('src/crypto/keys.ts'));
  const P = await import(await moduleUrl('src/crypto/pairing.ts'));
  const all = JSON.parse(await readFile('tests/vectors/e2ee-v1.json', 'utf8')), v = all.pairing;
  const master = B(all.identity.master_hex), descriptor = B(all.vault.descriptor_hex);
  const hex = value => Buffer.from(value).toString('hex');
  const change = (value, at = 0) => { const next = Buffer.from(value); next[at] ^= 1; return next; };
  function transcript() { return {
    origin: v.origin, vaultId: B(all.identity.vault_id_hex), epochId: B(all.identity.epoch_id_hex), descriptorHash: hash(descriptor), pairId: B(v.pair_id_hex),
    newPublic: B(v.new_public_hex), trustedPublic: B(v.trusted_public_hex), newNonce: B(v.new_nonce_hex), trustedNonce: B(v.trusted_nonce_hex), created: v.created, expires: v.expires,
  }; }
  async function withClock(action) {
    const originalDate = Date.now, originalPerf = Object.getOwnPropertyDescriptor(performance, 'now');
    const clock = { wall: (v.created + 100) * 1000, monotonic: 1000 };
    Date.now = () => clock.wall;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.monotonic });
    try { return await action(clock); }
    finally { Date.now = originalDate; if (originalPerf) Object.defineProperty(performance, 'now', originalPerf); else delete performance.now; }
  }
  async function fixtureEphemeral(scalarHex) {
    // Fixed keys exist only in tests. Production generateEphemeral uses native CSPRNG.
    const d = B(scalarHex), node = createECDH('prime256v1'); node.setPrivateKey(d); const point = node.getPublicKey();
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: d.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), key_ops: ['deriveBits'], ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'generateKey');
    Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: async (algorithm, extractable, usages) => {
      assert.deepEqual(algorithm, { name: 'ECDH', namedCurve: 'P-256' }); assert.equal(extractable, false); assert.deepEqual(usages, ['deriveBits']);
      return { privateKey, publicKey };
    } });
    try { return await P.generateEphemeral(); }
    finally { if (original) Object.defineProperty(crypto.subtle, 'generateKey', original); else delete crypto.subtle.generateKey; }
  }
  async function fixedIv(action) {
    const original = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues'); let calls = 0;
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: array => {
      assert.equal(array.length, 12); assert.equal(calls++, 0); array.set(B(v.provision_iv_hex)); return array;
    } });
    try { const value = await action(); assert.equal(calls, 1); return value; }
    finally { if (original) Object.defineProperty(crypto, 'getRandomValues', original); else delete crypto.getRandomValues; }
  }
  async function contexts(nTranscript = transcript(), tTranscript = transcript()) {
    const n = await fixtureEphemeral(v.new_scalar_hex), trusted = await fixtureEphemeral(v.trusted_scalar_hex);
    return { n, trusted, newKeys: await P.derivePairKeys(n, 'new', P.encodeTranscript(nTranscript)),
      trustedKeys: await P.derivePairKeys(trusted, 'trusted', P.encodeTranscript(tTranscript)) };
  }
  async function approveReady(pair) {
    P.approvePairing(pair.newKeys, pair.newKeys.sas);
    const ready = await P.confirmMac(pair.newKeys, 'new-ready');
    await P.verifyConfirm(pair.trustedKeys, 'new-ready', ready);
    P.approvePairing(pair.trustedKeys, pair.trustedKeys.sas); return ready;
  }
  async function rejectsWithoutRoot(action) {
    let result;
    await assert.rejects(async () => { result = await action(); }, error => {
      for (const secret of [hex(master), v.new_scalar_hex, v.trusted_scalar_hex, v.shared_secret_hex, v.provision_key_hex, v.confirm_key_hex]) assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(result, undefined);
  }

  await t.test('native ephemeral keys are fresh, opaque and copied; private keys cannot be exported or serialized', async () => {
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'generateKey'), native = crypto.subtle.generateKey.bind(crypto.subtle), captured = [];
    Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: async (...args) => { const pair = await native(...args); captured.push(pair); return pair; } });
    let n, trusted;
    try { n = await P.generateEphemeral(); trusted = await P.generateEphemeral(); }
    finally { if (original) Object.defineProperty(crypto.subtle, 'generateKey', original); else delete crypto.subtle.generateKey; }
    assert.notEqual(hex(n.publicKey), hex(trusted.publicKey));
    assert.deepEqual(Object.keys(n), ['publicKey']); assert.equal(n.privateKey, undefined);
    for (const pair of captured) { assert.equal(pair.privateKey.extractable, false); await assert.rejects(crypto.subtle.exportKey('jwk', pair.privateKey)); }
    assert.ok(!JSON.stringify(n).includes('private'));
    const expected = hex(n.publicKey); n.publicKey.fill(0); assert.equal(hex(n.publicKey), expected);
    assert.equal(hex(await P.deriveSharedSecret(n, trusted.publicKey)), hex(await P.deriveSharedSecret(trusted, n.publicKey)));
  });

  await t.test('both sides reproduce exact transcript, ECDH, domain-separated keys/SAS, MACs and provisioning vector', () => withClock(async () => {
    assert.deepEqual(referenceVectors().pairing, v);
    const n = await fixtureEphemeral(v.new_scalar_hex), trusted = await fixtureEphemeral(v.trusted_scalar_hex);
    // Each endpoint assembles its own fields/public views, without borrowing the
    // other endpoint's serialized transcript or decoding its output.
    const a = P.encodeTranscript({ ...transcript(), newPublic: n.publicKey, trustedPublic: trusted.publicKey });
    const b = P.encodeTranscript({ ...transcript(), trustedPublic: trusted.publicKey, newPublic: n.publicKey });
    assert.equal(hex(a), v.transcript_hex); assert.equal(hex(b), hex(a));
    assert.equal(hex(P.encodeTranscript(P.decodeTranscript(a))), hex(a));
    const zn = await P.deriveSharedSecret(n, trusted.publicKey), zt = await P.deriveSharedSecret(trusted, n.publicKey);
    assert.equal(hex(zn), v.shared_secret_hex); assert.equal(hex(zt), hex(zn));
    const digest = hash(a), info = purpose => tlv(Buffer.from('AEGIS-pair'), number(1, 2), Buffer.from(purpose), digest);
    for (const [purpose, expected] of [['provision', v.provision_key_hex], ['confirm', v.confirm_key_hex], ['sas', v.sas_bytes_hex]]) {
      const size = purpose === 'sas' ? 8 : 32;
      assert.equal(hex(await K.hkdf(zn, digest, info(purpose), size)), expected);
      assert.equal(hex(await K.hkdf(zt, digest, info(purpose), size)), expected);
    }
    const pair = { newKeys: await P.derivePairKeys(n, 'new', a), trustedKeys: await P.derivePairKeys(trusted, 'trusted', b) };
    assert.equal(pair.newKeys.sas, v.sas); assert.equal(pair.trustedKeys.sas, v.sas);
    const ready = await approveReady(pair); assert.equal(hex(ready), v.ready_mac_hex);
    const sealed = await fixedIv(() => P.sealProvision(pair.trustedKeys, master, descriptor)); assert.equal(hex(sealed), v.sealed_hex);
    const recovered = await P.openProvision(pair.newKeys, sealed); assert.equal(hex(recovered.master), hex(master)); assert.equal(hex(recovered.descriptor), hex(descriptor));
    const consumed = await P.confirmMac(pair.newKeys, 'new-consumed', sealed); assert.equal(hex(consumed), v.consumed_mac_hex);
    await P.verifyConfirm(pair.trustedKeys, 'new-consumed', consumed, sealed);
    // Identical acknowledgement retries are harmless; root release is not replayable.
    assert.equal(hex(await P.confirmMac(pair.newKeys, 'new-consumed', sealed)), v.consumed_mac_hex);
    await P.verifyConfirm(pair.trustedKeys, 'new-consumed', consumed, sealed);
    await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, sealed));
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
  }));

  await t.test('root release requires role, explicit SAS approval and verified ready state', () => withClock(async () => {
    const pair = await contexts();
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
    await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, B(v.sealed_hex)));
    await assert.rejects(P.confirmMac(pair.newKeys, 'new-ready'));
    assert.throws(() => P.approvePairing(pair.newKeys, 'AAAA AAAA AAAA'));
    P.approvePairing(pair.newKeys, v.sas); P.approvePairing(pair.trustedKeys, v.sas);
    await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, B(v.sealed_hex)), 'no ready generated');
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor), 'no ready verified');
    const ready = await P.confirmMac(pair.newKeys, 'new-ready');
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-ready', change(ready)));
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
    await P.verifyConfirm(pair.trustedKeys, 'new-ready', ready);
    await assert.rejects(P.confirmMac(pair.newKeys, 'new-consumed', B(v.sealed_hex)));
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-consumed', B(v.consumed_mac_hex), B(v.sealed_hex)));
    await rejectsWithoutRoot(() => P.sealProvision(pair.newKeys, master, descriptor));
    const sealed = await P.sealProvision(pair.trustedKeys, master, descriptor);
    await rejectsWithoutRoot(() => P.openProvision(pair.trustedKeys, sealed));
    await P.openProvision(pair.newKeys, sealed);
  }));

  await t.test('all transcript context substitutions change secret-derived SAS and fail peer MAC/provisioning', () => withClock(async () => {
    const third = createECDH('prime256v1'); third.setPrivateKey(B('03'.padStart(64, '0')));
    const changes = [
      { ...transcript(), vaultId: change(transcript().vaultId) }, { ...transcript(), epochId: change(transcript().epochId) },
      { ...transcript(), descriptorHash: change(transcript().descriptorHash) }, { ...transcript(), pairId: change(transcript().pairId) },
      { ...transcript(), origin: 'https://other.example' }, { ...transcript(), newNonce: change(transcript().newNonce) },
      { ...transcript(), trustedNonce: change(transcript().trustedNonce) }, { ...transcript(), created: v.created + 1, expires: v.expires + 1 },
      { ...transcript(), trustedPublic: third.getPublicKey() },
    ];
    for (const changed of changes) {
      const pair = await contexts(changed);
      assert.notEqual(pair.newKeys.sas, pair.trustedKeys.sas);
      P.approvePairing(pair.newKeys, pair.newKeys.sas); P.approvePairing(pair.trustedKeys, pair.trustedKeys.sas);
      const ready = await P.confirmMac(pair.newKeys, 'new-ready');
      await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-ready', ready));
      assert.throws(() => P.approvePairing(pair.newKeys, v.sas));
      await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, B(v.sealed_hex)));
    }
    const wrongNew = { ...transcript(), newPublic: third.getPublicKey() };
    const pair = await contexts(undefined, wrongNew);
    assert.notEqual(pair.newKeys.sas, pair.trustedKeys.sas);
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral(v.new_scalar_hex), 'new', P.encodeTranscript(wrongNew)));
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral('03'.padStart(64, '0')), 'new', B(v.transcript_hex)), 'wrong private key/registered point');
  }));

  await t.test('strict transcript and point parsers reject versions, roles, origins, malformed/off-curve public keys', () => withClock(async () => {
    const bytes = B(v.transcript_hex), l = Buffer.byteLength(v.origin), roleNew = 106 + l, roleTrusted = 204 + l;
    for (const at of [0, 5, 6, 7, roleNew, roleTrusted]) assert.throws(() => P.decodeTranscript(change(bytes, at)));
    for (const bad of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from([0])])]) assert.throws(() => P.decodeTranscript(bad));
    const length = Buffer.from(bytes); length.writeUInt16BE(513, 8); assert.throws(() => P.decodeTranscript(length));
    for (const origin of ['http://aegis.example', 'https://AEGIS.example', 'https://aegis.example/', 'https://aegis.example:443', 'https://user@aegis.example', 'https://aegis.example?q=1']) assert.throws(() => P.encodeTranscript({ ...transcript(), origin }));
    assert.throws(() => P.encodeTranscript({ ...transcript(), expires: v.expires - 1 }));
    assert.throws(() => P.encodeTranscript({ ...transcript(), trustedPublic: transcript().newPublic }));
    assert.throws(() => P.encodeTranscript({ ...transcript(), trustedNonce: transcript().newNonce }));
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral(v.new_scalar_hex), 'trusted', bytes));
    const reversed = { ...transcript(), newPublic: transcript().trustedPublic, trustedPublic: transcript().newPublic };
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral(v.new_scalar_hex), 'new', P.encodeTranscript(reversed)));
    for (const key of [Buffer.alloc(0), Buffer.alloc(64), Buffer.alloc(66), Buffer.alloc(65), Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]), Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 255)])]) {
      await assert.rejects(P.deriveSharedSecret(await fixtureEphemeral(v.new_scalar_hex), key));
    }
    const invalid = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]);
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral(v.new_scalar_hex), 'new', P.encodeTranscript({ ...transcript(), trustedPublic: invalid })));
    await assert.rejects(P.deriveSharedSecret({ publicKey: transcript().newPublic, privateKey: {} }, transcript().trustedPublic));
  }));

  await t.test('ephemeral reuse and parallel derivation are rejected; opaque contexts cannot be forged or mutated', () => withClock(async () => {
    const n = await fixtureEphemeral(v.new_scalar_hex), bytes = B(v.transcript_hex);
    const results = await Promise.allSettled([P.derivePairKeys(n, 'new', bytes), P.derivePairKeys(n, 'new', bytes)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    const keys = results.find(x => x.status === 'fulfilled').value;
    await assert.rejects(P.deriveSharedSecret(n, transcript().trustedPublic));
    await assert.rejects(P.derivePairKeys(n, 'new', P.encodeTranscript({ ...transcript(), pairId: change(transcript().pairId) })));
    assert.equal(keys.provision, undefined); assert.equal(keys.confirm, undefined);
    keys.transcript.fill(0); keys.hash.fill(0);
    assert.equal(hex(keys.transcript), v.transcript_hex); assert.equal(keys.sas, v.sas);
    assert.throws(() => P.approvePairing({ ...keys }, v.sas));
    const second = await fixtureEphemeral(v.new_scalar_hex), third = createECDH('prime256v1'); third.setPrivateKey(B('03'.padStart(64, '0')));
    await P.deriveSharedSecret(second, transcript().trustedPublic);
    await assert.rejects(P.deriveSharedSecret(second, third.getPublicKey()));
  }));

  await t.test('expiry and monotonic deadline prevent late root release even if wall clock rolls back', () => withClock(async clock => {
    const pair = await contexts(); await approveReady(pair);
    clock.wall = v.expires * 1000;
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
    assert.throws(() => P.approvePairing(pair.newKeys, v.sas));
    clock.wall = (v.created + 100) * 1000; clock.monotonic += 200000;
    await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, B(v.sealed_hex)));
    await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
    await assert.rejects(P.derivePairKeys(await fixtureEphemeral(v.new_scalar_hex), 'new', P.encodeTranscript({ ...transcript(), created: v.created + 200, expires: v.expires + 200 })));
  }));

  await t.test('provisioning rejects modified bytes, wrong root/descriptor and valid AEAD with bad inner roots', () => withClock(async () => {
    for (const at of [0, 5, 6, 8, 19, 20, 167]) {
      const pair = await contexts(); await approveReady(pair);
      await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, change(B(v.sealed_hex), at)));
      await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, B(v.sealed_hex)), 'failed operation cannot be retried');
    }
    for (const size of [0, 167, 169]) {
      const pair = await contexts(); await approveReady(pair); await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, Buffer.alloc(size)));
    }
    for (const [m, d] of [[change(master), descriptor], [master, change(descriptor, 99)]]) {
      const pair = await contexts(); await approveReady(pair); await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, m, d));
    }
    const bundle = Buffer.concat([master, descriptor]);
    for (const bad of [change(bundle), change(bundle, 37), change(bundle, 131)]) {
      const pair = await contexts(); await approveReady(pair);
      const forged = Buffer.concat([B(v.sealed_hex).subarray(0, 20), aes(B(v.provision_key_hex), B(v.provision_iv_hex), label('provision/v1', hash(B(v.transcript_hex))), bad)]);
      await rejectsWithoutRoot(() => P.openProvision(pair.newKeys, forged));
    }
  }));

  await t.test('consumed MAC binds exact sealed response and cannot be forged, changed or used as ready', () => withClock(async () => {
    const pair = await contexts(); await approveReady(pair);
    const sealed = await fixedIv(() => P.sealProvision(pair.trustedKeys, master, descriptor)); await P.openProvision(pair.newKeys, sealed);
    const mac = await P.confirmMac(pair.newKeys, 'new-consumed', sealed);
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-consumed', change(mac), sealed));
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-consumed', mac, change(sealed)));
    await assert.rejects(P.confirmMac(pair.newKeys, 'new-consumed', change(sealed)));
    const ready = createHmac('sha256', B(v.confirm_key_hex)).update(label('new-ready', hash(B(v.transcript_hex)))).digest();
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-consumed', ready, sealed));
    await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-consumed', mac));
    await P.verifyConfirm(pair.trustedKeys, 'new-consumed', mac, sealed);
  }));

  await t.test('input snapshots and synchronous reservations protect mutable views and concurrent provisioning', () => withClock(async () => {
    const n = await fixtureEphemeral(v.new_scalar_hex), input = B(v.transcript_hex), pending = P.derivePairKeys(n, 'new', input); input.fill(0);
    const nk = await pending; assert.equal(hex(nk.transcript), v.transcript_hex);
    const trusted = await fixtureEphemeral(v.trusted_scalar_hex), tk = await P.derivePairKeys(trusted, 'trusted', B(v.transcript_hex));
    const pair = { newKeys: nk, trustedKeys: tk }; await approveReady(pair);
    const m = Buffer.from(master), d = Buffer.from(descriptor), first = P.sealProvision(tk, m, d); m.fill(0); d.fill(0);
    await rejectsWithoutRoot(() => P.sealProvision(tk, master, descriptor));
    const sealed = await first, bytes = Buffer.from(sealed), opening = P.openProvision(nk, bytes); bytes.fill(0);
    await rejectsWithoutRoot(() => P.openProvision(nk, sealed));
    assert.equal(hex((await opening).master), hex(master));
    assert.equal(hex(master), all.identity.master_hex); assert.equal(hex(descriptor), all.vault.descriptor_hex);
  }));

  await t.test('failed confirmation/provisioning and successful protocol operations do not log secrets', () => withClock(async () => {
    const original = {}, logs = [];
    for (const name of ['log', 'warn', 'error', 'debug', 'info']) { original[name] = console[name]; console[name] = (...args) => logs.push(args); }
    try {
      const pair = await contexts(); P.approvePairing(pair.trustedKeys, v.sas);
      await assert.rejects(P.verifyConfirm(pair.trustedKeys, 'new-ready', change(B(v.ready_mac_hex))));
      await rejectsWithoutRoot(() => P.sealProvision(pair.trustedKeys, master, descriptor));
      await approveReady(pair); const sealed = await P.sealProvision(pair.trustedKeys, master, descriptor);
      await P.openProvision(pair.newKeys, sealed);
      assert.deepEqual(logs, []);
    } finally { for (const name of Object.keys(original)) console[name] = original[name]; }
  }));
  await t.test('a pending ready MAC cannot complete after the local phase has advanced', () => withClock(async () => {
    const pair = await contexts(); await approveReady(pair);
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'sign'), native = crypto.subtle.sign.bind(crypto.subtle);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    Object.defineProperty(crypto.subtle, 'sign', { configurable: true, value: async (...args) => {
      started(); await new Promise(resolve => { release = resolve; }); return native(...args);
    } });
    let pending;
    try {
      pending = P.confirmMac(pair.newKeys, 'new-ready');
      const rejected = rejectsWithoutRoot(() => pending);
      await entered;
      const sealed = await P.sealProvision(pair.trustedKeys, master, descriptor);
      await P.openProvision(pair.newKeys, sealed);
      release(); await rejected;
    } finally { if (original) Object.defineProperty(crypto.subtle, 'sign', original); else delete crypto.subtle.sign; }
  }));

  await t.test('expiry during authenticated decryption returns no root material', () => withClock(async clock => {
    const pair = await contexts(); await approveReady(pair);
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'decrypt'), native = crypto.subtle.decrypt.bind(crypto.subtle);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
      if (args[2].byteLength === 148) { started(); await new Promise(resolve => { release = resolve; }); }
      return native(...args);
    } });
    try {
      const opening = P.openProvision(pair.newKeys, B(v.sealed_hex));
      const rejected = rejectsWithoutRoot(() => opening);
      await entered; clock.monotonic += 200000;
      release(); await rejected;
    } finally { if (original) Object.defineProperty(crypto.subtle, 'decrypt', original); else delete crypto.subtle.decrypt; }
  }));

});
