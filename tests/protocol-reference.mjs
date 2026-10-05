// Independent byte-level reference: Node/OpenSSL APIs, no application imports.
// TEST ONLY: scalar 1/2 and fixed secrets/IVs below must never be used by an app.
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync } from 'node:crypto';
export const B = value => Buffer.from(value, 'hex');
const text = value => Buffer.from(value, 'utf8');
const join = (...parts) => Buffer.concat(parts);
export function number(value, size) { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out.subarray(8 - size); }
export const tlv = (...values) => join(number(values.length, 2), ...values.flatMap(value => [number(value.length, 4), value]));
export const label = (name, ...values) => tlv(text(name), ...values);
export const hash = bytes => createHash('sha256').update(bytes).digest();
export const kdf = (secret, salt, info, length = 32) => Buffer.from(hkdfSync('sha256', secret, salt, info, length));
export const vaultInfo = (name, vault, epoch, item) => tlv(text('AEGIS-Drop'), number(1, 2), text(name), vault, epoch, ...(item ? [item] : []));
export function aes(key, iv, aad, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
  return join(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
}
export function unAes(key, iv, aad, bytes) {
  const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(-16));
  return join(cipher.update(bytes.subarray(0, -16)), cipher.final());
}
const seq = (size, start) => Buffer.from(Array.from({ length: size }, (_, i) => (start + i) & 255));
const master = seq(32, 0), vault = seq(16, 16), epoch = seq(16, 32);
const iv = seq(12, 144), secret = seq(32, 80), wrapIv = seq(12, 112), manifestIv = seq(12, 128);
const createdAt = 1700000000123, chunkSize = 1048576;
export function pattern(size, offset = 0) { return Buffer.from(Array.from({ length: size }, (_, i) => ((offset + i) * 17 + 3) & 255)); }
function itemId(index) { const id = seq(16, 48); id[6] = 0x46; id[8] = 0xb8; id[15] = index; return id; }
function item(index, manifest, storageKind) {
  const id = itemId(index), header = join(text('AGD1'), number(1, 2), number(storageKind, 1), number(0, 1), vault, epoch, id);
  const wrapKey = kdf(master, vault, vaultInfo('item-wrap', vault, epoch, id));
  const manifestKey = kdf(secret, vault, vaultInfo('item-manifest', vault, epoch, id));
  const wrapped = aes(wrapKey, wrapIv, label('key-wrap/v1', header), secret);
  const encrypted = aes(manifestKey, manifestIv, label('manifest/v1', header, wrapIv, wrapped), manifest);
  const envelope = join(header, wrapIv, wrapped, manifestIv, number(encrypted.length, 4), encrypted);
  return { id, header, envelope, fileKey: kdf(secret, vault, vaultInfo('file-chunks', vault, epoch, id)), vector: {
    item_id_hex: id.toString('hex'), manifest_plain_hex: manifest.toString('hex'), header_hex: header.toString('hex'),
    wrap_key_hex: wrapKey.toString('hex'), manifest_key_hex: manifestKey.toString('hex'), wrapped_secret_hex: wrapped.toString('hex'), envelope_hex: envelope.toString('hex') } };
}
export function recoveryKeyReference(secret) {
  const checksum = hash(label('recovery-check/v1', secret)).subarray(0, 4);
  const bits = BigInt('0x' + join(secret, checksum).toString('hex')) << 2n;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let encoded = '';
  for (let i = 57; i >= 0; i--) encoded += alphabet[Number((bits >> BigInt(i * 5)) & 31n)];
  return { human_key: 'AEGIS-R1-' + encoded.match(/.{1,4}/g).join('-'), checksum_hex: checksum.toString('hex') };
}
export function referenceVectors() {
  const identity = { master_hex: master.toString('hex'), vault_id_hex: vault.toString('hex'), epoch_id_hex: epoch.toString('hex') };
  const inputs = { secret_hex: secret.toString('hex'), wrap_iv_hex: wrapIv.toString('hex'), manifest_iv_hex: manifestIv.toString('hex'), created_at_ms: createdAt };
  const texts = ['Hello, AEGIS — ảnh\n', ''].map((value, index) => {
    const bytes = text(value), manifest = join(number(1, 1), number(1, 1), number(createdAt, 8), number(bytes.length, 4), bytes);
    return { text: value, ...item(index + 1, manifest, 0).vector };
  });
  const files = [0, 37, chunkSize, chunkSize + 1, 2 * chunkSize + 37].map((size, index) => {
    const name = text('ảnh.bin'), mime = text('application/octet-stream'), count = Math.ceil(size / chunkSize);
    const manifest = join(number(1, 1), number(2, 1), number(createdAt, 8), number(size, 8), number(chunkSize, 4), number(count, 4), number(name.length, 2), name, number(mime.length, 2), mime);
    const record = item(10 + index, manifest, 1), digest = hash(record.envelope), prefix = join(text('AGF1'), record.header, digest);
    const wholeHash = createHash('sha256').update(prefix), plainHash = createHash('sha256'), records = [];
    for (let i = 0; i < count; i++) {
      const bytes = pattern(Math.min(chunkSize, size - i * chunkSize), i * chunkSize), nonce = join(Buffer.alloc(8), number(i, 4));
      const aad = label('file-chunk/v1', record.header, digest, number(i, 4), number(bytes.length, 4), number(size, 8), number(count, 4), number(i === count - 1 ? 1 : 0, 1));
      const encrypted = aes(record.fileKey, nonce, aad, bytes); wholeHash.update(number(encrypted.length, 4)).update(encrypted); plainHash.update(bytes);
      records.push({ index: i, ciphertext_length: encrypted.length, sha256: hash(encrypted).toString('hex'), tag_hex: encrypted.subarray(-16).toString('hex'), aad_hex: aad.toString('hex') });
    }
    return { size, name: name.toString(), mime_type: mime.toString(), ...record.vector,
      file_key_hex: record.fileKey.toString('hex'), prefix_hex: prefix.toString('hex'), records,
      object_size: 92 + size + count * 20, object_sha256: wholeHash.digest('hex'), plaintext_sha256: plainHash.digest('hex') };
  });
  const descHeader = join(text('AGV1'), number(1, 2), Buffer.alloc(2), vault, epoch), aad = label('vault-check/v1', descHeader);
  const checkKey = kdf(master, vault, vaultInfo('vault-check', vault, epoch));
  const descriptor = join(descHeader, iv, aes(checkKey, iv, aad, hash(aad)));
  const salt = seq(16, 160), recoveryIv = seq(12, 176), recoveryKey = seq(32, 192), descHash = hash(descriptor), bundle = join(master, descriptor);
  const recoveryHeader = join(text('AGR1'), number(1, 2), Buffer.alloc(2), vault, epoch, salt, descHash);
  const recoveryDerived = kdf(recoveryKey, salt, tlv(text('AEGIS-Drop'), number(1, 2), text('recovery/v1'), vault, epoch));
  const recovery = join(recoveryHeader, recoveryIv, aes(recoveryDerived, recoveryIv, label('recovery/v1', recoveryHeader), bundle));
  const newD = Buffer.alloc(32), trustedD = Buffer.alloc(32); newD[31] = 1; trustedD[31] = 2;
  const newEcdh = createECDH('prime256v1'), trustedEcdh = createECDH('prime256v1'); newEcdh.setPrivateKey(newD); trustedEcdh.setPrivateKey(trustedD);
  const pn = newEcdh.getPublicKey(), pt = trustedEcdh.getPublicKey(), pairId = seq(32, 16), nn = seq(32, 48), nt = seq(32, 80), origin = 'https://aegis.example', start = 1700000000;
  const transcript = join(text('AGP1'), number(1, 2), number(1, 1), Buffer.alloc(1), number(text(origin).length, 2), text(origin), vault, epoch, descHash, pairId, number(1, 1), pn, nn, number(2, 1), pt, nt, number(start, 8), number(start + 300, 8));
  const shared = newEcdh.computeSecret(pt), transcriptHash = hash(transcript), pairInfo = name => tlv(text('AEGIS-pair'), number(1, 2), text(name), transcriptHash);
  const provisionKey = kdf(shared, transcriptHash, pairInfo('provision')), confirmKey = kdf(shared, transcriptHash, pairInfo('confirm')), sasBytes = kdf(shared, transcriptHash, pairInfo('sas'), 8);
  const bits = BigInt('0x' + sasBytes.toString('hex')) >> 4n, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let sas = ''; for (let i = 11; i >= 0; i--) sas += alphabet[Number((bits >> BigInt(i * 5)) & 31n)];
  sas = `${sas.slice(0, 4)} ${sas.slice(4, 8)} ${sas.slice(8)}`;
  const ready = createHmac('sha256', confirmKey).update(label('new-ready', transcriptHash)).digest();
  const sealed = join(text('AGS1'), number(1, 2), Buffer.alloc(2), iv, aes(provisionKey, iv, label('provision/v1', transcriptHash), bundle));
  const consumed = createHmac('sha256', confirmKey).update(label('new-consumed', transcriptHash, hash(sealed))).digest();
  return { warning: 'TEST ONLY. Fixed entropy/scalars are public, unsafe for real data.', format_version: 1, identity, entropy: inputs,
    pattern: 'plaintext byte at offset i = (17*i + 3) mod 256; large ciphertext represented by digests plus tags and AAD', texts, files,
    vault: { iv_hex: iv.toString('hex'), descriptor_hex: descriptor.toString('hex'), key_hex: checkKey.toString('hex'), aad_hex: aad.toString('hex') },
    recovery: { salt_hex: salt.toString('hex'), iv_hex: recoveryIv.toString('hex'), key_hex: recoveryKey.toString('hex'), derived_key_hex: recoveryDerived.toString('hex'), package_hex: recovery.toString('hex'), ...recoveryKeyReference(recoveryKey) },
    pairing: { origin, created: start, expires: start + 300, new_scalar_hex: newD.toString('hex'), trusted_scalar_hex: trustedD.toString('hex'), new_public_hex: pn.toString('hex'), trusted_public_hex: pt.toString('hex'), pair_id_hex: pairId.toString('hex'), new_nonce_hex: nn.toString('hex'), trusted_nonce_hex: nt.toString('hex'), transcript_hex: transcript.toString('hex'), transcript_hash_hex: transcriptHash.toString('hex'), provision_info_hex: pairInfo('provision').toString('hex'), confirm_info_hex: pairInfo('confirm').toString('hex'), sas_info_hex: pairInfo('sas').toString('hex'), provision_aad_hex: label('provision/v1', transcriptHash).toString('hex'), ready_mac_input_hex: label('new-ready', transcriptHash).toString('hex'), consumed_mac_input_hex: label('new-consumed', transcriptHash, hash(sealed)).toString('hex'), shared_secret_hex: shared.toString('hex'), provision_key_hex: provisionKey.toString('hex'), confirm_key_hex: confirmKey.toString('hex'), sas_bytes_hex: sasBytes.toString('hex'), sas, ready_mac_hex: ready.toString('hex'), sealed_hex: sealed.toString('hex'), consumed_mac_hex: consumed.toString('hex'), provision_iv_hex: iv.toString('hex') } };
}
