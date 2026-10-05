import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createECDH, createHmac } from 'node:crypto';
import { moduleUrl } from './load-ts.mjs';
import { B, hash, kdf, tlv, number } from './protocol-reference.mjs';

test('attacker review of v1 pairing', async t => {
  const K = await import(await moduleUrl('src/crypto/keys.ts'));
  const P = await import(await moduleUrl('src/crypto/pairing.ts'));
  const all = JSON.parse(await readFile('tests/vectors/e2ee-v1.json', 'utf8')), vector = all.pairing;
  const master = B(all.identity.master_hex), descriptor = B(all.vault.descriptor_hex);
  const hex = data => Buffer.from(data).toString('hex');
  const flip = (data, at = 0) => { const copy = Buffer.from(data); copy[at] ^= 1; return copy; };
  const random = size => crypto.getRandomValues(new Uint8Array(size));
  function context(overrides = {}) {
    return { origin: 'https://aegis.example', vaultId: B(all.identity.vault_id_hex), epochId: B(all.identity.epoch_id_hex), descriptorHash: hash(descriptor),
      pairId: random(32), newNonce: random(32), trustedNonce: random(32), created: vector.created, expires: vector.expires, ...overrides };
  }
  async function withClock(action) {
    const date = Date.now, perf = Object.getOwnPropertyDescriptor(performance, 'now');
    const clock = { wall: (vector.created + 100) * 1000, mono: 1000 };
    Date.now = () => clock.wall;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.mono });
    try { return await action(clock); }
    finally { Date.now = date; if (perf) Object.defineProperty(performance, 'now', perf); else delete performance.now; }
  }
  async function rejected(action) {
    let result;
    await assert.rejects(async () => { result = await action(); });
    assert.equal(result, undefined, 'an attack must not return root material');
  }
  async function fixedEphemeral(scalar) {
    // Public deterministic private scalars are isolated test-only material.
    const d = B(scalar), reference = createECDH('prime256v1'); reference.setPrivateKey(d); const point = reference.getPublicKey();
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), ext: true, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'generateKey');
    Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: async () => ({ privateKey, publicKey }) });
    try { return await P.generateEphemeral(); }
    finally { if (original) Object.defineProperty(crypto.subtle, 'generateKey', original); else delete crypto.subtle.generateKey; }
  }
  async function session(overrides = {}, fixed = false) {
    const n = fixed ? await fixedEphemeral(vector.new_scalar_hex) : await P.generateEphemeral();
    const trusted = fixed ? await fixedEphemeral(vector.trusted_scalar_hex) : await P.generateEphemeral();
    const fields = context({ newPublic: n.publicKey, trustedPublic: trusted.publicKey, ...overrides }), bytes = P.encodeTranscript(fields);
    const newKeys = await P.derivePairKeys(n, 'new', P.encodeTranscript({ ...fields }));
    const trustedKeys = await P.derivePairKeys(trusted, 'trusted', P.encodeTranscript({ ...fields }));
    return { n, trusted, fields, bytes, newKeys, trustedKeys };
  }
  async function approval(s) {
    P.approvePairing(s.newKeys, s.trustedKeys.sas);
    P.approvePairing(s.trustedKeys, s.newKeys.sas);
    const ready = await P.confirmMac(s.newKeys, 'new-ready');
    await P.verifyConfirm(s.trustedKeys, 'new-ready', ready); return ready;
  }
  async function complete(s, d = descriptor) {
    const ready = await approval(s), sealed = await P.sealProvision(s.trustedKeys, master, d);
    const root = await P.openProvision(s.newKeys, sealed); assert.equal(hex(root.master), hex(master)); root.master.fill(0);
    const consumed = await P.confirmMac(s.newKeys, 'new-consumed', sealed);
    await P.verifyConfirm(s.trustedKeys, 'new-consumed', consumed, sealed);
    return { ready, sealed, consumed };
  }

  await t.test('two-key active MITM splits real honest sessions, and physical SAS comparison prevents root release', () => withClock(async () => {
    const n = await P.generateEphemeral(), trusted = await P.generateEphemeral();
    const attackerAsNew = await P.generateEphemeral(), attackerAsTrusted = await P.generateEphemeral();
    const base = context();
    const newView = P.encodeTranscript({ ...base, newPublic: n.publicKey, trustedPublic: attackerAsTrusted.publicKey });
    const trustedView = P.encodeTranscript({ ...base, newPublic: attackerAsNew.publicKey, trustedPublic: trusted.publicKey });
    const honestN = await P.derivePairKeys(n, 'new', newView), honestT = await P.derivePairKeys(trusted, 'trusted', trustedView);
    const attackerN = await P.derivePairKeys(attackerAsNew, 'new', trustedView), attackerT = await P.derivePairKeys(attackerAsTrusted, 'trusted', newView);
    assert.equal(honestN.sas, attackerT.sas); assert.equal(honestT.sas, attackerN.sas);
    assert.notEqual(honestN.sas, honestT.sas, 'two independent ECDH channels must not accidentally match in this concrete attack');
    assert.throws(() => P.approvePairing(honestN, honestT.sas));
    assert.throws(() => P.approvePairing(honestT, honestN.sas));
    // Mallory can authenticate his own channel: a valid MAC alone cannot replace
    // human authentication of the intended peer.
    P.approvePairing(attackerN, attackerN.sas);
    const maliciousReady = await P.confirmMac(attackerN, 'new-ready');
    await P.verifyConfirm(honestT, 'new-ready', maliciousReady);
    await rejected(() => P.sealProvision(honestT, master, descriptor));
    await rejected(() => P.openProvision(honestN, B(vector.sealed_hex)));
    // Deliberately dishonest caller approval demonstrates the essential assumption.
    // This is NOT a silent acceptance path: it explicitly lies about comparison.
    P.approvePairing(honestT, honestT.sas);
    const intercepted = await P.sealProvision(honestT, master, descriptor);
    const stolen = await P.openProvision(attackerN, intercepted); assert.equal(hex(stolen.master), hex(master));
    P.approvePairing(honestN, honestN.sas); P.approvePairing(attackerT, attackerT.sas);
    await P.verifyConfirm(attackerT, 'new-ready', await P.confirmMac(honestN, 'new-ready'));
    const forwarded = await P.sealProvision(attackerT, stolen.master, stolen.descriptor);
    const delivered = await P.openProvision(honestN, forwarded); assert.equal(hex(delivered.master), hex(master));
    stolen.master.fill(0); delivered.master.fill(0);
  }));

  await t.test('all critical fields bind actual SAS, confirmation key and provisioning key for fixed test ECDH', () => withClock(async () => {
    const original = context({ pairId: B(vector.pair_id_hex), newNonce: B(vector.new_nonce_hex), trustedNonce: B(vector.trusted_nonce_hex), newPublic: B(vector.new_public_hex), trustedPublic: B(vector.trusted_public_hex) });
    const changes = [
      ['pairId', flip(original.pairId)], ['newNonce', flip(original.newNonce)], ['trustedNonce', flip(original.trustedNonce)],
      ['origin', 'https://other.example'], ['vaultId', flip(original.vaultId)], ['epochId', flip(original.epochId)],
      ['descriptorHash', flip(original.descriptorHash)], ['created', original.created + 1],
    ];
    for (const [field, value] of changes) {
      const fields = { ...original, [field]: value, ...(field === 'created' ? { expires: original.expires + 1 } : {}) };
      const n = await fixedEphemeral(vector.new_scalar_hex), peer = await fixedEphemeral(vector.trusted_scalar_hex);
      const z = await P.deriveSharedSecret(n, peer.publicKey), bytes = P.encodeTranscript(fields), digest = hash(bytes);
      const keys = await P.derivePairKeys(n, 'new', bytes);
      assert.equal(hex(keys.hash), hex(digest)); assert.notEqual(hex(keys.hash), vector.transcript_hash_hex);
      assert.notEqual(keys.sas, vector.sas);
      const info = purpose => tlv(Buffer.from('AEGIS-pair'), number(1, 2), Buffer.from(purpose), digest);
      for (const purpose of ['provision', 'confirm']) assert.notEqual(hex(kdf(z, digest, info(purpose))), vector[purpose + '_key_hex']);
      P.approvePairing(keys, keys.sas);
      const actualMac = await P.confirmMac(keys, 'new-ready');
      const expectedMac = createHmac('sha256', kdf(z, digest, info('confirm'))).update(tlv(Buffer.from('new-ready'), digest)).digest();
      assert.equal(hex(actualMac), hex(expectedMac)); assert.notEqual(hex(actualMac), vector.ready_mac_hex); z.fill(0);
    }
    // Public transcript hash alone is not the KDF secret: a public-only guess
    // produces unrelated output, while native key agreement is required in code.
    const publicHash = hash(B(vector.transcript_hex));
    const guessed = kdf(Buffer.alloc(32), publicHash, tlv(Buffer.from('AEGIS-pair'), number(1, 2), Buffer.from('sas'), publicHash), 8);
    assert.notEqual(hex(guessed), vector.sas_bytes_hex);
  }));

  await t.test('old ready and consumed messages fail in a new session, even if root/vault stay identical', () => withClock(async () => {
    const old = await session({}, true), messages = await complete(old);
    const fresh = await session({ pairId: flip(old.fields.pairId), newNonce: old.fields.newNonce, trustedNonce: old.fields.trustedNonce }, true);
    await assert.rejects(P.verifyConfirm(fresh.trustedKeys, 'new-ready', messages.ready));
    const newMessages = await complete(fresh);
    await assert.rejects(P.verifyConfirm(fresh.trustedKeys, 'new-consumed', messages.consumed, newMessages.sealed));
    await assert.rejects(P.verifyConfirm(fresh.trustedKeys, 'new-consumed', newMessages.consumed, messages.sealed));
    await rejected(() => P.derivePairKeys(old.n, 'new', old.bytes));
    await rejected(() => P.openProvision(old.newKeys, messages.sealed));
  }));

  await t.test('old envelope with new pairId, cross-origin, cross-vault and cross-epoch replay returns no root', () => withClock(async () => {
    const old = await session({}, true), messages = await complete(old);
    const differentVault = flip(old.fields.vaultId), differentEpoch = flip(old.fields.epochId);
    const descriptorB = await K.createDescriptor(master, differentVault, old.fields.epochId);
    const descriptorC = await K.createDescriptor(master, old.fields.vaultId, differentEpoch);
    const changes = [
      { pairId: flip(old.fields.pairId) }, { origin: 'https://other.example' },
      { vaultId: differentVault, descriptorHash: hash(descriptorB) }, { epochId: differentEpoch, descriptorHash: hash(descriptorC) },
      { descriptorHash: flip(old.fields.descriptorHash) }, { newNonce: flip(old.fields.newNonce) },
      { trustedNonce: flip(old.fields.trustedNonce) }, { created: old.fields.created + 1, expires: old.fields.expires + 1 },
    ];
    for (const changed of changes) {
      const s = await session({ ...old.fields, ...changed }, true); await approval(s);
      await rejected(() => P.openProvision(s.newKeys, messages.sealed));
      await rejected(() => P.openProvision(s.newKeys, messages.sealed));
    }
  }));

  await t.test('two simultaneous pairings reject envelope swaps and public-key swaps', () => withClock(async () => {
    const a = await session(), b = await session(); await approval(a); await approval(b);
    const sealedA = await P.sealProvision(a.trustedKeys, master, descriptor), sealedB = await P.sealProvision(b.trustedKeys, master, descriptor);
    await rejected(() => P.openProvision(a.newKeys, sealedB)); await rejected(() => P.openProvision(b.newKeys, sealedA));
    const n = await P.generateEphemeral(), peer = await P.generateEphemeral();
    const wrongLocal = P.encodeTranscript({ ...a.fields, trustedPublic: peer.publicKey });
    await rejected(() => P.derivePairKeys(n, 'new', wrongLocal));
    const relaySwap = context({ newPublic: n.publicKey, trustedPublic: a.trusted.publicKey });
    const local = await P.derivePairKeys(n, 'new', P.encodeTranscript(relaySwap));
    assert.notEqual(local.sas, a.trustedKeys.sas);
    P.approvePairing(local, local.sas); await assert.rejects(P.verifyConfirm(a.trustedKeys, 'new-ready', await P.confirmMac(local, 'new-ready')));
  }));

  await t.test('reflection and role confusion reject wrong MAC purposes and wrong-direction operations', () => withClock(async () => {
    const s = await session(), ready = await approval(s);
    await rejected(() => P.sealProvision(s.newKeys, master, descriptor));
    await rejected(() => P.openProvision(s.trustedKeys, B(vector.sealed_hex)));
    await assert.rejects(P.verifyConfirm(s.newKeys, 'new-ready', ready));
    await assert.rejects(P.confirmMac(s.trustedKeys, 'new-ready'));
    await assert.rejects(P.verifyConfirm(s.trustedKeys, 'new-consumed', ready, B(vector.sealed_hex)));
    const sealed = await P.sealProvision(s.trustedKeys, master, descriptor); const root = await P.openProvision(s.newKeys, sealed); root.master.fill(0);
    const consumed = await P.confirmMac(s.newKeys, 'new-consumed', sealed);
    const newContext = await session();
    await assert.rejects(P.verifyConfirm(newContext.trustedKeys, 'new-ready', consumed));
    await assert.rejects(P.verifyConfirm(s.trustedKeys, 'new-consumed', ready, sealed));
    await rejected(async () => P.derivePairKeys(await P.generateEphemeral(), 'trusted', s.bytes));
    assert.throws(() => P.encodeTranscript({ ...s.fields, trustedPublic: s.fields.newPublic }));
  }));

  await t.test('message reordering, duplicate opens, failure retries and concurrent approve/open/consume fail safely', () => withClock(async () => {
    const s = await session();
    await rejected(() => P.openProvision(s.newKeys, B(vector.sealed_hex))); await assert.rejects(P.confirmMac(s.newKeys, 'new-consumed', B(vector.sealed_hex)));
    await approval(s); const sealed = await P.sealProvision(s.trustedKeys, master, descriptor);
    const opens = await Promise.allSettled([P.openProvision(s.newKeys, sealed), P.openProvision(s.newKeys, sealed), P.confirmMac(s.newKeys, 'new-consumed', sealed)]);
    assert.equal(opens[0].status, 'fulfilled'); opens[0].value.master.fill(0);
    assert.equal(opens[1].status, 'rejected'); assert.equal(opens[2].status, 'rejected');
    assert.throws(() => P.approvePairing(s.newKeys, s.trustedKeys.sas));
    await rejected(() => P.openProvision(s.newKeys, sealed));
    const consumed = await P.confirmMac(s.newKeys, 'new-consumed', sealed); await P.verifyConfirm(s.trustedKeys, 'new-consumed', consumed, sealed);
    await rejected(() => P.sealProvision(s.trustedKeys, master, descriptor));
    const failed = await session(); await approval(failed);
    await rejected(() => P.openProvision(failed.newKeys, flip(sealed, 20)));
    await rejected(() => P.openProvision(failed.newKeys, sealed));
    assert.throws(() => P.approvePairing(failed.newKeys, failed.newKeys.sas));
  }));

  await t.test('withheld messages and expired state cannot be revived by wall-clock rollback', () => withClock(async clock => {
    const s = await session(); await approval(s);
    const sealed = await P.sealProvision(s.trustedKeys, master, descriptor);
    clock.wall = vector.expires * 1000;
    await rejected(() => P.openProvision(s.newKeys, sealed));
    assert.throws(() => P.approvePairing(s.trustedKeys, s.trustedKeys.sas));
    clock.wall = (vector.created + 100) * 1000; // monotonic deadline has NOT expired
    await rejected(() => P.openProvision(s.newKeys, sealed));
    assert.throws(() => P.approvePairing(s.trustedKeys, s.trustedKeys.sas));
  }));

  await t.test('malformed input matrix: origins, point representations, bounds, timestamps, versions and trailing bytes', () => withClock(async () => {
    const s = await session(), fields = s.fields, bytes = s.bytes;
    for (const origin of ['', 'https://' + 'a'.repeat(505), 'http://aegis.example', 'https://aegis.example/path', 'https://aegis.example?x=1', 'https://aegis.example#x', 'https://AEGIS.example', 'https://aegis.example:443', 'https://aegis.example/', 'https://user:pass@aegis.example']) assert.throws(() => P.encodeTranscript({ ...fields, origin }));
    for (const created of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => P.encodeTranscript({ ...fields, created, expires: created + 300 }));
    for (const expires of [fields.created - 1, fields.created, fields.created + 1, fields.created + 301, Infinity]) assert.throws(() => P.encodeTranscript({ ...fields, expires }));
    const future = { ...fields, created: vector.expires + 1, expires: vector.expires + 301 };
    await rejected(async () => P.derivePairKeys(await P.generateEphemeral(), 'new', P.encodeTranscript(future)));
    for (const length of [0, 326, 831, 4096]) assert.throws(() => P.decodeTranscript(new Uint8Array(length)));
    for (const at of [0, 4, 5, 6, 7, 106 + Buffer.byteLength(fields.origin), 204 + Buffer.byteLength(fields.origin)]) assert.throws(() => P.decodeTranscript(flip(bytes, at)));
    assert.throws(() => P.decodeTranscript(bytes.subarray(0, -1))); assert.throws(() => P.decodeTranscript(Buffer.concat([bytes, Buffer.from([0])])));
    const zero = Buffer.from(bytes); zero.writeUInt16BE(0, 8); assert.throws(() => P.decodeTranscript(zero));
    const huge = Buffer.from(bytes); huge.writeUInt16BE(65535, 8); assert.throws(() => P.decodeTranscript(huge));
    const unsafe = Buffer.from(bytes); unsafe.fill(255, unsafe.length - 16, unsafe.length - 8); assert.throws(() => P.decodeTranscript(unsafe));
    const compressed = Buffer.concat([Buffer.from([2]), fields.newPublic.subarray(1, 33)]);
    for (const point of [compressed, fields.newPublic.subarray(0, 64), Buffer.alloc(66), Buffer.concat([Buffer.from([6]), fields.newPublic.subarray(1)]), Buffer.concat([Buffer.from([4]), Buffer.alloc(64)])]) await rejected(async () => P.deriveSharedSecret(await P.generateEphemeral(), point));
    for (const length of [0, 167, 169, 4096]) {
      const pair = await session(); await approval(pair); await rejected(() => P.openProvision(pair.newKeys, new Uint8Array(length)));
    }
  }));

  await t.test('oversized transcript is rejected BEFORE making its owned copy', async () => {
    const n = await P.generateEphemeral(), input = new Uint8Array(831), Original = Uint8Array; let copied = false;
    const replacement = new Proxy(Original, { construct(target, args, newTarget) {
      if (args[0] === input) { copied = true; throw new Error('oversized copy attempted'); }
      return Reflect.construct(target, args, newTarget);
    } });
    globalThis.Uint8Array = replacement;
    try { await assert.rejects(P.derivePairKeys(n, 'new', input), /Invalid encrypted format/); assert.equal(copied, false); }
    finally { globalThis.Uint8Array = Original; }
  });

  await t.test('oversized origin is rejected BEFORE UTF-8 encoding', async () => {
    const n = await P.generateEphemeral(), trusted = await P.generateEphemeral();
    const fields = context({ newPublic: n.publicKey, trustedPublic: trusted.publicKey }), origin = 'https://' + 'a'.repeat(505), original = TextEncoder.prototype.encode; let encoded = false;
    TextEncoder.prototype.encode = function(value) {
      if (value === origin) { encoded = true; throw new Error('oversized encoding attempted'); }
      return original.call(this, value);
    };
    try { assert.throws(() => P.encodeTranscript({ ...fields, origin }), /Invalid encrypted format/); assert.equal(encoded, false); }
    finally { TextEncoder.prototype.encode = original; }
  });
  await t.test('public-key swap between active pairings fails cryptographic MAC verification', () => withClock(async () => {
    const nA = await P.generateEphemeral(), tA = await P.generateEphemeral(), tB = await P.generateEphemeral();
    const fields = context({ newPublic: nA.publicKey, trustedPublic: tA.publicKey });
    const relayView = { ...fields, trustedPublic: tB.publicKey };
    const nk = await P.derivePairKeys(nA, 'new', P.encodeTranscript(relayView));
    const tk = await P.derivePairKeys(tA, 'trusted', P.encodeTranscript(fields));
    P.approvePairing(nk, nk.sas);
    const mac = await P.confirmMac(nk, 'new-ready');
    await assert.rejects(P.verifyConfirm(tk, 'new-ready', mac), /Pairing confirmation failed/);
    assert.notEqual(nk.sas, tk.sas);
    await rejected(() => P.sealProvision(tk, master, descriptor));
  }));

  await t.test('an active trusted context cannot seal after observed expiry followed by clock correction', () => withClock(async clock => {
    const s = await session(); await approval(s);
    clock.wall = vector.expires * 1000;
    await rejected(() => P.sealProvision(s.trustedKeys, master, descriptor));
    clock.wall = (vector.created + 100) * 1000;
    await rejected(() => P.sealProvision(s.trustedKeys, master, descriptor));
  }));

});
