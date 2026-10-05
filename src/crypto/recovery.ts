import { concat, decodeDescriptor, domain, encoder, equal, Reader, requireValue, sha256, sized, tuple, uint, VERSION } from './format';
import { aesKey, decrypt, encrypt, randomBytes, verifyDescriptor } from './keys';

export const RECOVERY_PACKAGE_BYTES = 248;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'AEGIS-R1-';
const invalidPackage = () => new Error('Invalid recovery package or key.');
const invalidKey = () => new Error('Invalid recovery key.');

export function encodeRootBundle(master: Uint8Array, descriptor: Uint8Array) {
  decodeDescriptor(descriptor); return concat(sized(master, 32), descriptor);
}
export async function decodeRootBundle(bytes: Uint8Array) {
  const snapshot = sized(bytes, 132), r = new Reader(snapshot), master = r.take(32), descriptor = r.take(100); r.end();
  try { await verifyDescriptor(master, descriptor); return { master, descriptor }; }
  catch { master.fill(0); throw invalidPackage(); }
  finally { snapshot.fill(0); }
}
function recoveryInfo(vaultId: Uint8Array, epochId: Uint8Array) {
  return tuple(encoder.encode('AEGIS-Drop'), uint(VERSION, 2), encoder.encode('recovery/v1'), vaultId, epochId);
}
export async function wrapRecovery(master: Uint8Array, descriptor: Uint8Array) {
  // Snapshot all caller-owned bytes before the first await, including Buffer views.
  let masterSnapshot: Uint8Array | undefined;
  let recoveryKey: Uint8Array | undefined, bundle: Uint8Array | undefined, success = false;
  try {
    masterSnapshot = sized(master, 32);
    const descriptorSnapshot = sized(descriptor, 100);
    const verified = await verifyDescriptor(masterSnapshot, descriptorSnapshot);
    const salt = randomBytes(16), iv = randomBytes(12);
    recoveryKey = randomBytes(32); // Independent CSPRNG, never derived from M/authentication.
    const header = concat(encoder.encode('AGR1'), uint(VERSION, 2), uint(0, 2), verified.vaultId, verified.epochId, salt, await sha256(descriptorSnapshot));
    const key = await aesKey(recoveryKey, salt, recoveryInfo(verified.vaultId, verified.epochId), ['encrypt']);
    bundle = encodeRootBundle(masterSnapshot, descriptorSnapshot);
    const bytes = concat(header, iv, await encrypt(key, iv, domain('recovery/v1', header), bundle));
    success = true;
    return { recoveryKey, package: bytes };
  } catch { throw invalidPackage(); }
  finally { masterSnapshot?.fill(0); bundle?.fill(0); if (!success) recoveryKey?.fill(0); }
}
export async function unwrapRecovery(recoveryKey: Uint8Array, bytes: Uint8Array) {
  let keySnapshot: Uint8Array | undefined, plain: Uint8Array | undefined;
  let bundle: { master: Uint8Array; descriptor: Uint8Array } | undefined, success = false;
  try {
    const snapshot = sized(bytes, RECOVERY_PACKAGE_BYTES);
    keySnapshot = sized(recoveryKey, 32);
    const r = new Reader(snapshot); r.magic('AGR1'); requireValue(r.number(2) === VERSION && r.number(2) === 0);
    const vaultId = r.take(16), epochId = r.take(16), salt = r.take(16), descriptorHash = r.take(32), iv = r.take(12), cipher = r.take(148); r.end();
    const key = await aesKey(keySnapshot, salt, recoveryInfo(vaultId, epochId), ['decrypt']);
    plain = await decrypt(key, iv, domain('recovery/v1', snapshot.subarray(0, 88)), cipher);
    bundle = await decodeRootBundle(plain);
    const descriptor = decodeDescriptor(bundle.descriptor);
    requireValue(equal(descriptor.vaultId, vaultId) && equal(descriptor.epochId, epochId) && equal(await sha256(bundle.descriptor), descriptorHash));
    success = true;
    return { ...bundle, vaultId, epochId, descriptorHash };
  } catch { throw invalidPackage(); }
  finally { keySnapshot?.fill(0); plain?.fill(0); if (!success) bundle?.master.fill(0); }
}

export async function encodeRecoveryKey(recoveryKey: Uint8Array) {
  const key = sized(recoveryKey, 32);
  let bytes: Uint8Array | undefined;
  try {
    const checksum = (await sha256(domain('recovery-check/v1', key))).subarray(0, 4);
    bytes = concat(key, checksum);
    let encoded = '', accumulator = 0, bits = 0;
    for (const byte of bytes) {
      accumulator = (accumulator << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; encoded += ALPHABET[(accumulator >>> bits) & 31]; }
      accumulator &= (1 << bits) - 1;
    }
    if (bits) encoded += ALPHABET[(accumulator << (5 - bits)) & 31];
    return PREFIX + encoded.match(/.{1,4}/g)!.join('-');
  } finally { key.fill(0); bytes?.fill(0); }
}
export async function decodeRecoveryKey(value: string) {
  let bytes: Uint8Array | undefined, key: Uint8Array | undefined, success = false;
  try {
    requireValue(typeof value === 'string' && value.length <= 81);
    // Only ASCII case is tolerated. No whitespace, arbitrary separators or confusable aliases.
    requireValue(/^[A-Za-z0-9-]+$/.test(value));
    const normalized = value.toUpperCase();
    requireValue(/^AEGIS-R1-(?:[A-Z2-7]{4}-){14}[A-Z2-7]{2}$/.test(normalized));
    const raw = normalized.slice(PREFIX.length).replace(/-/g, '');
    bytes = new Uint8Array(36); let offset = 0, accumulator = 0, bits = 0;
    for (const character of raw) {
      accumulator = (accumulator << 5) | ALPHABET.indexOf(character); bits += 5;
      if (bits >= 8) { bits -= 8; bytes[offset++] = (accumulator >>> bits) & 255; }
      accumulator &= (1 << bits) - 1;
    }
    requireValue(offset === 36 && bits === 2 && accumulator === 0, 'Noncanonical base32 padding.');
    key = bytes.slice(0, 32);
    const checksum = (await sha256(domain('recovery-check/v1', key))).subarray(0, 4);
    if (!equal(checksum, bytes.subarray(32))) { key.fill(0); throw invalidKey(); }
    success = true; return key;
  } catch { throw invalidKey(); }
  finally { bytes?.fill(0); if (!success) key?.fill(0); }
}
