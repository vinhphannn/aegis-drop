// Frozen v1 codecs. These modules are deliberately not imported by the app.
export const VERSION = 1;
export const CHUNK_SIZE = 1024 * 1024;
export const MAX_FILE_BYTES = 100 * CHUNK_SIZE;
export const MAX_TEXT_BYTES = 65536;
export const HEADER_BYTES = 56;
export const MAX_ENVELOPE_BYTES = 65698;
export const DESCRIPTOR_BYTES = 100;
export const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function requireValue(ok: unknown, message = 'Invalid encrypted format.'): asserts ok {
  if (!ok) throw new Error(message);
}
export function sized(bytes: Uint8Array, size: number) {
  requireValue(bytes instanceof Uint8Array && bytes.length === size);
  return new Uint8Array(bytes);
}
export function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function uint(value: number, bytes: 1 | 2 | 4 | 8) {
  requireValue(Number.isSafeInteger(value) && value >= 0 && (bytes === 8 || value < 2 ** (bytes * 8)));
  const data = new Uint8Array(bytes), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (bytes === 8) view.setBigUint64(0, BigInt(value));
  else if (bytes === 4) view.setUint32(0, value);
  else if (bytes === 2) view.setUint16(0, value);
  else view.setUint8(0, value);
  return data;
}
// Tuple: u16 field count, then u32 length + raw bytes for each field.
export function tuple(...fields: Uint8Array[]) {
  return concat(uint(fields.length, 2), ...fields.flatMap(field => [uint(field.length, 4), field]));
}
export const domain = (label: string, ...fields: Uint8Array[]) => tuple(encoder.encode(label), ...fields);
export class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}
  take(length: number) {
    requireValue(Number.isSafeInteger(length) && length >= 0 && length <= this.data.length - this.offset);
    const value = new Uint8Array(this.data.subarray(this.offset, this.offset + length)); this.offset += length; return value;
  }
  number(bytes: 1 | 2 | 4 | 8) {
    const data = this.take(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const value = bytes === 8 ? Number(view.getBigUint64(0)) : bytes === 4 ? view.getUint32(0) : bytes === 2 ? view.getUint16(0) : view.getUint8(0);
    requireValue(Number.isSafeInteger(value)); return value;
  }
  magic(value: string) { requireValue(equal(this.take(value.length), encoder.encode(value))); }
  end() { requireValue(this.offset === this.data.length); }
}
export interface ItemContext { vaultId: Uint8Array; epochId: Uint8Array; itemId: Uint8Array }
export interface Header extends ItemContext { storageKind: 0 | 1 }
export function encodeHeader(context: ItemContext, storageKind: 0 | 1) {
  const itemId = sized(context.itemId, 16);
  requireValue((itemId[6] & 0xf0) === 0x40 && (itemId[8] & 0xc0) === 0x80);
  requireValue(storageKind === 0 || storageKind === 1);
  return concat(encoder.encode('AGD1'), uint(VERSION, 2), uint(storageKind, 1), uint(0, 1),
    sized(context.vaultId, 16), sized(context.epochId, 16), itemId);
}
export function decodeHeader(data: Uint8Array): Header {
  const reader = new Reader(sized(data, HEADER_BYTES));
  reader.magic('AGD1'); requireValue(reader.number(2) === VERSION);
  const storageKind = reader.number(1); requireValue(storageKind === 0 || storageKind === 1);
  requireValue(reader.number(1) === 0);
  const result: Header = { storageKind, vaultId: reader.take(16), epochId: reader.take(16), itemId: reader.take(16) };
  reader.end(); encodeHeader(result, storageKind); return result;
}
export function assertContext(header: Header, expected: ItemContext, kind: 0 | 1) {
  requireValue(equal(encodeHeader(header, header.storageKind), encodeHeader(expected, kind)), 'Encrypted item context mismatch.');
}
export interface Envelope { header: Uint8Array; wrapIv: Uint8Array; wrappedSecret: Uint8Array; manifestIv: Uint8Array; manifestCipher: Uint8Array }
export function encodeEnvelope(value: Envelope) {
  const h = decodeHeader(value.header);
  requireValue(value.manifestCipher.length >= (h.storageKind === 0 ? 30 : 50) && value.manifestCipher.length <= (h.storageKind === 0 ? MAX_TEXT_BYTES + 30 : 4397));
  return concat(sized(value.header, 56), sized(value.wrapIv, 12), sized(value.wrappedSecret, 48),
    sized(value.manifestIv, 12), uint(value.manifestCipher.length, 4), value.manifestCipher);
}
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  requireValue(bytes.length <= MAX_ENVELOPE_BYTES);
  const r = new Reader(bytes), header = r.take(56), h = decodeHeader(header);
  const wrapIv = r.take(12), wrappedSecret = r.take(48), manifestIv = r.take(12), length = r.number(4);
  requireValue(length >= (h.storageKind === 0 ? 30 : 50) && length <= (h.storageKind === 0 ? MAX_TEXT_BYTES + 30 : 4397));
  const manifestCipher = r.take(length); r.end();
  return { header, wrapIv, wrappedSecret, manifestIv, manifestCipher };
}
export interface TextManifest { kind: 'text'; createdAt: number; text: string }
export interface FileManifest { kind: 'file'; createdAt: number; size: number; name: string; mimeType: string }
export type Manifest = TextManifest | FileManifest;
function validText(value: string) {
  const bytes = encoder.encode(value); requireValue(decoder.decode(bytes) === value, 'Noncanonical Unicode.'); return bytes;
}
export function chunkCount(size: number) {
  requireValue(Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_BYTES); return Math.ceil(size / CHUNK_SIZE);
}
export function encodeManifest(value: Manifest) {
  const prefix = concat(uint(VERSION, 1), uint(value.kind === 'text' ? 1 : 2, 1), uint(value.createdAt, 8));
  if (value.kind === 'text') {
    const text = validText(value.text); requireValue(text.length <= MAX_TEXT_BYTES);
    return concat(prefix, uint(text.length, 4), text);
  }
  requireValue(value.kind === 'file');
  const name = validText(value.name), mime = validText(value.mimeType);
  requireValue(name.length > 0 && name.length <= 4096 && !/[\x00-\x1f\x7f/\\]/.test(value.name));
  requireValue(mime.length > 0 && mime.length <= 255 && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(value.mimeType) && /^[\x20-\x7e]+$/.test(value.mimeType));
  return concat(prefix, uint(value.size, 8), uint(CHUNK_SIZE, 4), uint(chunkCount(value.size), 4),
    uint(name.length, 2), name, uint(mime.length, 2), mime);
}
export function decodeManifest(bytes: Uint8Array, storageKind: 0 | 1): Manifest {
  const r = new Reader(bytes); requireValue(r.number(1) === VERSION);
  const kind = r.number(1), createdAt = r.number(8);
  let result: Manifest;
  if (kind === 1 && storageKind === 0) {
    const length = r.number(4); requireValue(length <= MAX_TEXT_BYTES);
    result = { kind: 'text', createdAt, text: decoder.decode(r.take(length)) };
  } else {
    requireValue(kind === 2 && storageKind === 1);
    const size = r.number(8); requireValue(r.number(4) === CHUNK_SIZE);
    requireValue(r.number(4) === chunkCount(size));
    const nameLength = r.number(2); requireValue(nameLength > 0 && nameLength <= 4096);
    const name = decoder.decode(r.take(nameLength));
    const mimeLength = r.number(2); requireValue(mimeLength > 0 && mimeLength <= 255);
    result = { kind: 'file', createdAt, size, name, mimeType: decoder.decode(r.take(mimeLength)) };
  }
  r.end(); requireValue(equal(encodeManifest(result), bytes)); return result;
}
export function descriptorHeader(vaultId: Uint8Array, epochId: Uint8Array) {
  return concat(encoder.encode('AGV1'), uint(VERSION, 2), uint(0, 2), sized(vaultId, 16), sized(epochId, 16));
}
export function decodeDescriptor(bytes: Uint8Array) {
  const r = new Reader(sized(bytes, DESCRIPTOR_BYTES));
  r.magic('AGV1'); requireValue(r.number(2) === VERSION && r.number(2) === 0);
  const vaultId = r.take(16), epochId = r.take(16), iv = r.take(12), cipher = r.take(48); r.end();
  return { vaultId, epochId, iv, cipher, header: descriptorHeader(vaultId, epochId) };
}
export const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
