import { decodeEnvelope, decodeHeader, MAX_ENVELOPE_BYTES, requireValue } from './crypto/format';

export const MAX_TEXT_REQUEST_BYTES = 90000;
export function itemIdString(bytes: Uint8Array) {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function encodeTextEnvelope(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function parseTextEnvelope(id: string, encoded: unknown) {
  requireValue(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_ENVELOPE_BYTES * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(encoded));
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  requireValue(encodeTextEnvelope(bytes) === encoded);
  const header = decodeHeader(decodeEnvelope(bytes).header);
  requireValue(header.storageKind === 0 && itemIdString(header.itemId) === id);
  return { bytes, header };
}
