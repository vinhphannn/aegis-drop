import { concat, decodeDescriptor, descriptorHeader, domain, encoder, equal, requireValue, sha256, sized, tuple, uint, VERSION } from './format';

export const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
export const generateMaster = () => randomBytes(32);
export function generateItemId() { const id = randomBytes(16); id[6] = (id[6] & 15) | 64; id[8] = (id[8] & 63) | 128; return id; }
export function generateVault() { return { master: generateMaster(), vaultId: randomBytes(16), epochId: randomBytes(16) }; }
export type VaultSecret = Uint8Array | CryptoKey;
export async function hkdf(secret: VaultSecret, salt: Uint8Array, info: Uint8Array, length: number) {
  const saltSnapshot = new Uint8Array(salt), infoSnapshot = new Uint8Array(info);
  const key = secret instanceof Uint8Array ? await crypto.subtle.importKey('raw', sized(secret, 32), 'HKDF', false, ['deriveBits']) : secret;
  requireValue(key.type === 'secret' && key.algorithm.name === 'HKDF' && !key.extractable && key.usages.includes('deriveBits'));
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltSnapshot, info: infoSnapshot }, key, length * 8));
}
export function vaultInfo(label: 'item-wrap' | 'item-manifest' | 'file-chunks' | 'vault-check', vaultId: Uint8Array, epochId: Uint8Array, itemId?: Uint8Array) {
  requireValue((label === 'vault-check') === (itemId === undefined));
  return tuple(encoder.encode('AEGIS-Drop'), uint(VERSION, 2), encoder.encode(label), sized(vaultId, 16), sized(epochId, 16), ...(itemId ? [sized(itemId, 16)] : []));
}
export async function aesKey(secret: VaultSecret, salt: Uint8Array, info: Uint8Array, usages: KeyUsage[]) {
  const raw = await hkdf(secret, salt, info, 32);
  try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages); }
  finally { raw.fill(0); }
}
export async function encrypt(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: sized(iv, 12), additionalData: aad, tagLength: 128 }, key, plaintext));
}
export async function decrypt(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, cipher: Uint8Array) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sized(iv, 12), additionalData: aad, tagLength: 128 }, key, cipher));
}
export async function createDescriptor(master: Uint8Array, vaultId: Uint8Array, epochId: Uint8Array) {
  const header = descriptorHeader(vaultId, epochId), iv = randomBytes(12);
  const key = await aesKey(master, vaultId, vaultInfo('vault-check', vaultId, epochId), ['encrypt']);
  const aad = domain('vault-check/v1', header);
  return concat(header, iv, await encrypt(key, iv, aad, await sha256(aad)));
}
export async function verifyDescriptor(master: Uint8Array, bytes: Uint8Array) {
  const value = decodeDescriptor(bytes);
  const key = await aesKey(master, value.vaultId, vaultInfo('vault-check', value.vaultId, value.epochId), ['decrypt']);
  const aad = domain('vault-check/v1', value.header);
  requireValue(equal(await decrypt(key, value.iv, aad, value.cipher), await sha256(aad)), 'Vault keyCheck failed.');
  return { vaultId: value.vaultId, epochId: value.epochId };
}
