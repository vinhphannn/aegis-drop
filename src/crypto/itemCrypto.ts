import { assertContext, decodeEnvelope, decodeHeader, decodeManifest, domain, encodeEnvelope, encodeHeader, encodeManifest } from './format';
import type { ItemContext, Manifest, TextManifest } from './format';
import { aesKey, decrypt, encrypt, randomBytes, vaultInfo } from './keys';

export async function sealManifest(master: Uint8Array, context: ItemContext, manifest: Manifest) {
  const header = encodeHeader(context, manifest.kind === 'text' ? 0 : 1), h = decodeHeader(header);
  const plain = encodeManifest(manifest), secret = randomBytes(32);
  try {
    const wrapIv = randomBytes(12), manifestIv = randomBytes(12);
    const wrapKey = await aesKey(master, h.vaultId, vaultInfo('item-wrap', h.vaultId, h.epochId, h.itemId), ['encrypt']);
    const wrappedSecret = await encrypt(wrapKey, wrapIv, domain('key-wrap/v1', header), secret);
    const manifestKey = await aesKey(secret, h.vaultId, vaultInfo('item-manifest', h.vaultId, h.epochId, h.itemId), ['encrypt']);
    const manifestCipher = await encrypt(manifestKey, manifestIv, domain('manifest/v1', header, wrapIv, wrappedSecret), plain);
    const envelope = encodeEnvelope({ header, wrapIv, wrappedSecret, manifestIv, manifestCipher });
    const fileKey = h.storageKind === 1 ? await aesKey(secret, h.vaultId, vaultInfo('file-chunks', h.vaultId, h.epochId, h.itemId), ['encrypt']) : null;
    return { envelope, fileKey };
  } finally { secret.fill(0); plain.fill(0); }
}
export async function openManifest(master: Uint8Array, envelope: Uint8Array, expected: ItemContext, kind: 0 | 1) {
  const value = decodeEnvelope(envelope), h = decodeHeader(value.header);
  assertContext(h, expected, kind);
  const wrapKey = await aesKey(master, h.vaultId, vaultInfo('item-wrap', h.vaultId, h.epochId, h.itemId), ['decrypt']);
  const secret = await decrypt(wrapKey, value.wrapIv, domain('key-wrap/v1', value.header), value.wrappedSecret);
  try {
    const key = await aesKey(secret, h.vaultId, vaultInfo('item-manifest', h.vaultId, h.epochId, h.itemId), ['decrypt']);
    const plain = await decrypt(key, value.manifestIv, domain('manifest/v1', value.header, value.wrapIv, value.wrappedSecret), value.manifestCipher);
    try {
      const manifest = decodeManifest(plain, kind);
      const fileKey = kind === 1 ? await aesKey(secret, h.vaultId, vaultInfo('file-chunks', h.vaultId, h.epochId, h.itemId), ['decrypt']) : null;
      return { manifest, fileKey };
    } finally { plain.fill(0); }
  } finally { secret.fill(0); }
}
export async function sealText(master: Uint8Array, context: ItemContext, text: string, createdAt: number) {
  return (await sealManifest(master, context, { kind: 'text', text, createdAt })).envelope;
}
export async function openText(master: Uint8Array, envelope: Uint8Array, expected: ItemContext): Promise<TextManifest> {
  return (await openManifest(master, envelope, expected, 0)).manifest as TextManifest;
}
