import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { moduleUrl } from './load-ts.mjs';

test('local browser vault enrollment', async t => {
  const F = await import(await moduleUrl('src/crypto/format.ts'));
  const K = await import(await moduleUrl('src/crypto/keys.ts'));
  const L = await import(await moduleUrl('src/localVault.ts'));
  const S = await import(await moduleUrl('src/localVaultStorage.ts'));
  const V = await import(await moduleUrl('src/vaultStore.ts'));
  const { authStore } = await import(await moduleUrl('src/auth.ts'));
  const { itemStore } = await import(await moduleUrl('src/store.ts'));
  const originalIDB = globalThis.indexedDB, originalFetch = globalThis.fetch;
  const fresh = () => { globalThis.indexedDB = new IDBFactory(); };
  const state = store => store.getSnapshot();
  const corrupt = value => { const out = new Uint8Array(value); out[out.length - 1] ^= 1; return out; };
  const localAad = record => F.domain('local-root/v1', F.uint(record.version, 2), record.vaultId,
    record.epochId, record.descriptorHash, F.uint(record.createdAt, 8));
  async function rawWrite(value, key = S.VAULT_RECORD) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(S.VAULT_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(S.VAULT_STORE);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(S.VAULT_STORE, 'readwrite'); tx.objectStore(S.VAULT_STORE).put(value, key);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function enrolled() {
    fresh(); const store = V.createVaultStore(); await store.setAuthenticated(true); await store.bootstrap();
    assert.equal(state(store).status, 'unlocked'); return store;
  }
  async function settle(store) {
    if (!state(store).busy) return;
    await new Promise(resolve => {
      const off = store.subscribe(() => { if (!state(store).busy) { off(); resolve(); } });
    });
  }
  try {
    await t.test('authenticated first-device bootstrap persists a single complete record', async () => {
      fresh(); const store = V.createVaultStore();
      await store.bootstrap(); assert.equal(await S.localVaultStorage.read(), null);
      await store.setAuthenticated(true); assert.equal(state(store).status, 'empty');
      await Promise.all([store.bootstrap(), store.bootstrap()]); assert.equal(state(store).status, 'unlocked');
      const saved = await S.localVaultStorage.read();
      assert.deepEqual(Object.keys(saved).sort(), ['version', 'createdAt', 'deviceKey', 'vaultId', 'epochId', 'descriptor', 'descriptorHash', 'iv', 'encryptedRoot'].sort());
      assert.equal(saved.encryptedRoot.length, 148); assert.equal(saved.descriptor.length, 100);
      assert.equal(saved.deviceKey.extractable, false);
      await assert.rejects(crypto.subtle.exportKey('raw', saved.deviceKey));
      assert.equal(state(store).master, undefined); assert.equal(state(store).handle, undefined);
    });
    await t.test('persisted reload preserves the identity and requires explicit unlock', async () => {
      await enrolled(); const before = await S.localVaultStorage.read();
      const reload = V.createVaultStore(); await reload.setAuthenticated(true); assert.equal(state(reload).status, 'locked');
      await reload.unlock(); assert.equal(state(reload).status, 'unlocked');
      const after = await S.localVaultStorage.read();
      assert.deepEqual(after.vaultId, before.vaultId); assert.deepEqual(after.encryptedRoot, before.encryptedRoot);
      assert.notEqual(after.deviceKey, before.deviceKey, 'IndexedDB returns structured-cloned native keys');
      const handle = await L.unlockEnrollment(after);
      assert.equal(L.isVaultUnlocked(handle), true); assert.equal(handle.master, undefined); assert.equal(handle.key, undefined);
      assert.deepEqual(handle.vaultId, before.vaultId); L.releaseVault(handle); assert.equal(L.isVaultUnlocked(handle), false);
    });
    await t.test('lock then unlock retains encrypted enrollment and revokes the in-memory handle', async () => {
      const store = await enrolled(), before = await S.localVaultStorage.read();
      store.lock(); assert.equal(state(store).status, 'checking'); await settle(store);
      assert.equal(state(store).status, 'locked'); await store.unlock(); assert.equal(state(store).status, 'unlocked');
      assert.deepEqual((await S.localVaultStorage.read()).encryptedRoot, before.encryptedRoot);
    });
    await t.test('corrupted ciphertext fails closed without regenerating or returning a root', async () => {
      const store = await enrolled(), saved = await S.localVaultStorage.read();
      saved.encryptedRoot = corrupt(saved.encryptedRoot); await rawWrite(saved); store.lock(); await settle(store);
      await store.unlock(); assert.equal(state(store).status, 'damaged'); assert.match(state(store).error, /enrollment damaged/i);
      await store.bootstrap(); assert.deepEqual((await S.localVaultStorage.read()).encryptedRoot, saved.encryptedRoot);
      await assert.rejects(L.unlockEnrollment(saved), /Device enrollment damaged\./);
    });
    await t.test('descriptor, descriptor hash, IDs and authenticated metadata tampering reject', async () => {
      await enrolled(); const saved = await S.localVaultStorage.read();
      for (const field of ['descriptor', 'descriptorHash', 'vaultId', 'epochId', 'iv']) {
        const bad = { ...saved, [field]: corrupt(saved[field]) };
        await assert.rejects(L.unlockEnrollment(bad), /Device enrollment damaged\./);
        await rawWrite(bad); const store = V.createVaultStore(); await store.setAuthenticated(true);
        if (state(store).status === 'locked') await store.unlock();
        assert.equal(state(store).status, 'damaged'); await store.bootstrap();
        assert.deepEqual((await S.localVaultStorage.read())[field], bad[field]);
      }
      await assert.rejects(L.unlockEnrollment({ ...saved, createdAt: saved.createdAt + 1 }));
    });
    await t.test('missing, extractable or wrong-purpose Ldevice is damaged enrollment', async () => {
      await enrolled(); const saved = await S.localVaultStorage.read();
      const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const wrong = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      for (const deviceKey of [undefined, {}, extractable, wrong, other]) {
        const bad = { ...saved, deviceKey }; await assert.rejects(L.unlockEnrollment(bad));
        await rawWrite(bad); const store = V.createVaultStore(); await store.setAuthenticated(true);
        if (state(store).status === 'locked') await store.unlock();
        assert.equal(state(store).status, 'damaged');
      }
    });
    await t.test('unsupported versions and partial record shapes never trigger bootstrap', async () => {
      const valid = await L.createEnrollment();
      for (const bad of [{ ...valid, version: 2 }, {}, { deviceKey: valid.deviceKey }, { ...valid, encryptedRoot: new Uint8Array(147) }, { ...valid, createdAt: NaN }]) {
        fresh(); await rawWrite(bad); const store = V.createVaultStore(); await store.setAuthenticated(true);
        assert.equal(state(store).status, 'damaged'); await store.bootstrap();
        assert.deepEqual(await S.localVaultStorage.read(), bad);
      }
      fresh(); await rawWrite(valid, 'orphan-device-key');
      const store = V.createVaultStore(); await store.setAuthenticated(true); assert.equal(state(store).status, 'damaged');
      fresh(); await rawWrite(null); const nullStore = V.createVaultStore(); await nullStore.setAuthenticated(true);
      assert.equal(state(nullStore).status, 'damaged'); await nullStore.bootstrap();
      await assert.rejects(S.localVaultStorage.read(), /enrollment damaged/i);
    });
    await t.test('valid outer AEAD cannot bypass inner root keyCheck or descriptor pinning', async () => {
      await enrolled(); const saved = await S.localVaultStorage.read();
      const original = await K.decrypt(saved.deviceKey, saved.iv, localAad(saved), saved.encryptedRoot);
      for (const offset of [0, 131]) {
        const plain = new Uint8Array(original); plain[offset] ^= 1;
        const bad = { ...saved, iv: K.randomBytes(12) };
        bad.encryptedRoot = await K.encrypt(saved.deviceKey, bad.iv, localAad(bad), plain);
        await assert.rejects(L.unlockEnrollment(bad), /Device enrollment damaged\./); plain.fill(0);
      }
      const other = K.generateVault(), descriptor = await K.createDescriptor(other.master, saved.vaultId, saved.epochId);
      const bad = { ...saved, iv: K.randomBytes(12) };
      const bundle = F.concat(other.master, descriptor);
      bad.encryptedRoot = await K.encrypt(saved.deviceKey, bad.iv, localAad(bad), bundle);
      await assert.rejects(L.unlockEnrollment(bad), /Device enrollment damaged\./);
      original.fill(0); other.master.fill(0); bundle.fill(0);
    });
    await t.test('no plaintext M is persisted; native key and snapshots cross a real serialization boundary', async () => {
      fresh(); const record = await L.createEnrollment(); await S.localVaultStorage.create(record);
      const saved = await S.localVaultStorage.read();
      const plain = await K.decrypt(saved.deviceKey, saved.iv, localAad(saved), saved.encryptedRoot), master = plain.slice(0, 32);
      for (const value of Object.values(saved)) if (value instanceof Uint8Array) assert.ok(!Buffer.from(value).includes(Buffer.from(master)));
      assert.ok(!JSON.stringify(saved).includes(Buffer.from(master).toString('hex')));
      record.descriptor.fill(0); record.encryptedRoot.fill(0);
      const handle = await L.unlockEnrollment(saved); handle.vaultId.fill(0); assert.deepEqual(handle.vaultId, saved.vaultId);
      assert.ok(!JSON.stringify(handle).includes(Buffer.from(master).toString('hex')));
      const input = structuredClone(saved), pending = L.unlockEnrollment(input); input.descriptor.fill(0); input.encryptedRoot.fill(0);
      const copied = await pending; assert.deepEqual(copied.vaultId, saved.vaultId);
      L.releaseVault(copied); L.releaseVault(handle); plain.fill(0); master.fill(0);
    });
    await t.test('simultaneous tabs cannot replace the winning enrollment', async () => {
      fresh(); const a = V.createVaultStore(), b = V.createVaultStore();
      await Promise.all([a.setAuthenticated(true), b.setAuthenticated(true)]);
      await Promise.all([a.bootstrap(), b.bootstrap()]);
      assert.equal([state(a).status, state(b).status].filter(x => x === 'unlocked').length, 1);
      assert.equal([state(a).status, state(b).status].filter(x => x === 'locked').length, 1);
      const winner = await S.localVaultStorage.read();
      await assert.rejects(S.localVaultStorage.create(await L.createEnrollment()), /already exists/);
      assert.deepEqual((await S.localVaultStorage.read()).encryptedRoot, winner.encryptedRoot);
    });
    await t.test('an aborted structured-clone write leaves no partial key or ciphertext', async () => {
      fresh(); const record = await L.createEnrollment();
      await assert.rejects(S.localVaultStorage.create({ ...record, uncloneable: () => {} }), /storage unavailable/);
      assert.equal(await S.localVaultStorage.read(), null);
      await S.localVaultStorage.create(record); assert.ok(await S.localVaultStorage.read());
    });
    await t.test('corruption introduced after the empty-state check is never overwritten', async () => {
      fresh(); const store = V.createVaultStore(); await store.setAuthenticated(true); await rawWrite({ version: 1 });
      await store.bootstrap(); assert.equal(state(store).status, 'damaged');
      assert.deepEqual(await S.localVaultStorage.read(), { version: 1 });
    });
    await t.test('logout during an in-flight commit retains only locked encrypted enrollment', async () => {
      fresh(); let release, entered;
      const committing = new Promise(resolve => { entered = resolve; });
      const storage = { ...S.localVaultStorage, create: async record => {
        entered(); await new Promise(resolve => { release = resolve; }); await S.localVaultStorage.create(record);
      } };
      const store = V.createVaultStore(storage); await store.setAuthenticated(true);
      const pending = store.bootstrap(); await committing; store.setAuthenticated(false); release(); await pending;
      assert.equal(state(store).status, 'unauthenticated'); assert.ok(await S.localVaultStorage.read());
      await store.setAuthenticated(true); assert.equal(state(store).status, 'locked');
    });
    await t.test('logout during a pending unlock cannot restore an unlocked state', async () => {
      await enrolled(); let release;
      const heldStorage = { ...S.localVaultStorage, read: async () => { await new Promise(resolve => { release = resolve; }); return S.localVaultStorage.read(); } };
      const store = V.createVaultStore(heldStorage), checking = store.setAuthenticated(true); release(); await checking;
      const pending = store.unlock(); store.setAuthenticated(false); release(); await pending;
      assert.equal(state(store).status, 'unauthenticated'); assert.ok(await S.localVaultStorage.read());
    });
    await t.test('lock during native crypto invalidates the late unlocked handle', async () => {
      const store = await enrolled(); store.lock(); await settle(store);
      const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'decrypt'), native = crypto.subtle.decrypt.bind(crypto.subtle);
      let release, enter;
      const entered = new Promise(resolve => { enter = resolve; });
      Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
        if (args[2].byteLength === 148) { enter(); await new Promise(resolve => { release = resolve; }); }
        return native(...args);
      } });
      try { const pending = store.unlock(); await entered; store.lock(); await settle(store); release(); await pending; assert.equal(state(store).status, 'locked'); }
      finally { if (original) Object.defineProperty(crypto.subtle, 'decrypt', original); else delete crypto.subtle.decrypt; }
    });
    await t.test('Phase 3 logout and expiry synchronously lock vault but retain enrollment', async () => {
      fresh(); globalThis.fetch = async () => Response.json({ authenticated: true });
      await authStore.check(); await settle(V.vaultStore); await V.vaultStore.bootstrap();
      assert.equal(state(V.vaultStore).status, 'unlocked'); const before = await S.localVaultStorage.read();
      globalThis.fetch = async path => path.startsWith('/api/items')
        ? Response.json({ items: [{ id: 'legacy', type: 'text', text: 'legacy plaintext', createdAt: 1 }], nextCursor: null })
        : Response.json({ authenticated: true });
      await itemStore.load(); assert.equal(itemStore.getSnapshot().items.length, 1);
      V.vaultStore.lock(); assert.deepEqual(itemStore.getSnapshot().items, []); await settle(V.vaultStore); await V.vaultStore.unlock();
      await authStore.logout(); assert.equal(state(V.vaultStore).status, 'unauthenticated');
      assert.deepEqual((await S.localVaultStorage.read()).encryptedRoot, before.encryptedRoot);
      await authStore.login('test-only-access-key'); await settle(V.vaultStore); assert.equal(state(V.vaultStore).status, 'locked');
      await V.vaultStore.unlock(); authStore.expire(); assert.equal(state(V.vaultStore).status, 'unauthenticated');
      assert.deepEqual((await S.localVaultStorage.read()).encryptedRoot, before.encryptedRoot);
    });
    await t.test('unavailable IndexedDB blocks operations rather than using plaintext storage', async () => {
      globalThis.indexedDB = undefined; const store = V.createVaultStore(); await store.setAuthenticated(true);
      assert.equal(state(store).status, 'unavailable'); await store.bootstrap(); assert.equal(state(store).status, 'unavailable');
    });
    await t.test('damaged enrollment failures and successful unlocks emit no logs or secret-bearing errors', async () => {
      await enrolled(); const saved = await S.localVaultStorage.read(), logs = [], originals = {};
      for (const name of ['log', 'warn', 'error', 'info', 'debug']) { originals[name] = console[name]; console[name] = (...args) => logs.push(args); }
      try {
        await assert.rejects(L.unlockEnrollment({ ...saved, encryptedRoot: corrupt(saved.encryptedRoot) }), error => {
          assert.equal(error.message, 'Device enrollment damaged.'); assert.equal(error.cause, undefined); return true;
        });
        L.releaseVault(await L.unlockEnrollment(saved)); assert.deepEqual(logs, []);
      } finally { for (const name of Object.keys(originals)) console[name] = originals[name]; }
    });
  } finally { globalThis.indexedDB = originalIDB; globalThis.fetch = originalFetch; V.vaultStore.setAuthenticated(false); }
});
