import { decodeDescriptor, domain, equal, requireValue, sha256, sized, uint } from './crypto/format';
import { createDescriptor, decrypt, encrypt, generateItemId, generateVault, randomBytes } from './crypto/keys';
import { openText, sealText } from './crypto/itemCrypto';
import { encodeTextEnvelope, itemIdString, parseTextEnvelope } from './textEnvelope';
import { decodeRootBundle, encodeRootBundle } from './crypto/recovery';
import { VaultStorageError } from './localVaultStorage';

export interface Enrollment {
  version: 1; createdAt: number; deviceKey: CryptoKey;
  vaultId: Uint8Array; epochId: Uint8Array; descriptor: Uint8Array;
  descriptorHash: Uint8Array; iv: Uint8Array; encryptedRoot: Uint8Array;
}
// Public identity only. The native root key is never returned or put in React state.
export interface UnlockedVault {
  readonly vaultId: Uint8Array; readonly epochId: Uint8Array; readonly descriptorHash: Uint8Array;
}
const roots = new WeakMap<UnlockedVault, CryptoKey>();
let active: UnlockedVault | undefined;
export function activateVault(handle: UnlockedVault) { requireValue(roots.has(handle)); active = handle; }
export function releaseVault(handle: UnlockedVault) { if (active === handle) active = undefined; roots.delete(handle); }
export function clearActiveVault() { if (active) releaseVault(active); }
export const isVaultUnlocked = (handle: UnlockedVault) => roots.has(handle);
function unlocked() {
  const handle = active, key = handle && roots.get(handle);
  requireValue(handle && key, 'Unlock your local vault first.');
  return { handle, key };
}
function stillUnlocked(handle: UnlockedVault) { requireValue(active === handle && roots.has(handle), 'Vault locked during operation.'); }
export async function encryptVaultText(text: string) {
  const { handle, key } = unlocked(), itemId = generateItemId();
  const bytes = await sealText(key, { vaultId: handle.vaultId, epochId: handle.epochId, itemId }, text, Date.now());
  stillUnlocked(handle);
  return { id: itemIdString(itemId), envelope: encodeTextEnvelope(bytes) };
}
export async function decryptVaultText(id: string, envelope: unknown) {
  const { handle, key } = unlocked(), parsed = parseTextEnvelope(id, envelope);
  const opened = await openText(key, parsed.bytes, { vaultId: handle.vaultId, epochId: handle.epochId, itemId: parsed.header.itemId });
  stillUnlocked(handle); return opened.text;
}
const damaged = () => new VaultStorageError('damaged');
function aad(record: Enrollment) {
  return domain('local-root/v1', uint(record.version, 2), record.vaultId, record.epochId,
    record.descriptorHash, uint(record.createdAt, 8));
}
export async function inspectEnrollment(input: unknown): Promise<Enrollment> {
  try {
    requireValue(typeof input === 'object' && input !== null);
    const value = input as Enrollment;
    requireValue(value.version === 1 && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0);
    const deviceKey = value.deviceKey;
    requireValue(deviceKey instanceof CryptoKey && deviceKey.type === 'secret' && !deviceKey.extractable &&
      deviceKey.algorithm.name === 'AES-GCM' && (deviceKey.algorithm as AesKeyAlgorithm).length === 256 &&
      deviceKey.usages.length === 2 && deviceKey.usages.includes('encrypt') && deviceKey.usages.includes('decrypt'));
    // Snapshot caller-owned views before the first asynchronous operation.
    const record: Enrollment = { version: 1, createdAt: value.createdAt, deviceKey,
      vaultId: sized(value.vaultId, 16), epochId: sized(value.epochId, 16), descriptor: sized(value.descriptor, 100),
      descriptorHash: sized(value.descriptorHash, 32), iv: sized(value.iv, 12), encryptedRoot: sized(value.encryptedRoot, 148) };
    const descriptor = decodeDescriptor(record.descriptor);
    requireValue(equal(descriptor.vaultId, record.vaultId) && equal(descriptor.epochId, record.epochId) &&
      equal(await sha256(record.descriptor), record.descriptorHash));
    return record;
  } catch { throw damaged(); }
}
export async function createEnrollment(): Promise<Enrollment> {
  const vault = generateVault();
  let plain: Uint8Array | undefined;
  try {
    const descriptor = await createDescriptor(vault.master, vault.vaultId, vault.epochId);
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const record: Enrollment = { version: 1, createdAt: Date.now(), deviceKey, vaultId: vault.vaultId, epochId: vault.epochId,
      descriptor, descriptorHash: await sha256(descriptor), iv: randomBytes(12), encryptedRoot: new Uint8Array() };
    plain = encodeRootBundle(vault.master, descriptor);
    record.encryptedRoot = await encrypt(deviceKey, record.iv, aad(record), plain);
    // keyCheck is validated through the same decoder used during reload/unlock.
    const handle = await unlockEnrollment(record); releaseVault(handle);
    return record;
  } finally { vault.master.fill(0); plain?.fill(0); }
}
export async function unlockEnrollment(input: unknown): Promise<UnlockedVault> {
  let plain: Uint8Array | undefined, master: Uint8Array | undefined;
  try {
    const record = await inspectEnrollment(input);
    plain = await decrypt(record.deviceKey, record.iv, aad(record), record.encryptedRoot);
    const root = await decodeRootBundle(plain); master = root.master;
    requireValue(equal(root.descriptor, record.descriptor));
    const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    const handle = Object.freeze({ get vaultId() { return record.vaultId.slice(); }, get epochId() { return record.epochId.slice(); },
      get descriptorHash() { return record.descriptorHash.slice(); } });
    roots.set(handle, key); return handle;
  } catch { throw damaged(); }
  finally { plain?.fill(0); master?.fill(0); }
}
