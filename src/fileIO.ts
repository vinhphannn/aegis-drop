import { CHUNK_SIZE, uint } from './crypto/format';
import { BROWSER_FILE_LIMIT } from './model';
import type { DropItem, FileItem } from './model';
import { openVaultFile, prepareVaultFile } from './localVault';

let uploading = false, inFlightBytes = 0, inFlightCount = 0;
const previews = new Map<string, { envelope: string; url: string; bytes: number }>();
let previewBytes = 0, previewReserved = 0, previewPending = 0, generation = 0, downloadUrl: string | undefined;
export async function encryptedUpload(file: File) {
  if (file.size > BROWSER_FILE_LIMIT) throw new Error('This browser file path is limited to 8 MiB. Larger disk-backed transfers are not enabled yet.');
  if (uploading) throw new Error('Please wait for the current file upload.');
  uploading = true;
  try {
    const operation = await prepareVaultFile({ size: file.size, name: file.name || 'clipboard-image.png',
      mimeType: file.type || 'application/octet-stream', createdAt: Date.now() });
    async function* source() {
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) yield new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    }
    // Deliberate, hard-capped fallback: never collect an unbounded file.
    const records: BlobPart[] = [];
    for await (const bytes of operation.encrypt(source())) records.push(bytes);
    const object = new Blob(records), body = new Blob([uint(operation.envelope.length, 4), operation.envelope, object]);
    return { id: operation.id, body, ciphertextSize: object.size };
  } finally { uploading = false; }
}
export async function decryptedDownload(item: FileItem, fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>, signal?: AbortSignal) {
  const opened = await openVaultFile(item.id, item.envelope), size = opened.manifest.size;
  if (size > BROWSER_FILE_LIMIT) throw new Error('Downloads are limited to 8 MiB on the current browser path.');
  if (inFlightBytes + size > BROWSER_FILE_LIMIT || inFlightCount >= 4) throw new Error('Please wait for the current file download.');
  inFlightBytes += size; inFlightCount++;
  const records: Uint8Array[] = [];
  try {
    signal?.throwIfAborted();
    const response = await fetchCiphertext(item.url, signal);
    if (!response.body) throw new Error('Missing encrypted file response.');
    const expectedBytes = 92 + size + 20 * Math.ceil(size / CHUNK_SIZE);
    const length = response.headers.get('content-length');
    if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/octet-stream' ||
      (length !== null && Number(length) !== expectedBytes)) {
      void response.body.cancel().catch(() => {}); throw new Error('Invalid encrypted file response.');
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    async function* source() {
      let received = 0;
      try {
        while (true) {
          signal?.throwIfAborted(); const result = await reader.read(); if (result.done) break;
          received += result.value.length;
          if (received > expectedBytes) throw new Error('Unexpected encrypted file length.');
          for (let i = 0; i < result.value.length; i += CHUNK_SIZE) yield result.value.subarray(i, i + CHUNK_SIZE);
        }
      } finally { signal?.removeEventListener('abort', cancel); try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    for await (const plain of opened.decrypt(source())) { signal?.throwIfAborted(); records.push(plain); }
    signal?.throwIfAborted(); opened.assertLive();
    // Only exact EOF + all tags can create a user-visible Blob.
    return new Blob(records, { type: opened.manifest.mimeType });
  } finally { for (const bytes of records) bytes.fill(0); inFlightBytes -= size; inFlightCount--; }
}
function safeRaster(bytes: Uint8Array, mime: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
    width = view.getUint32(16); height = view.getUint32(20);
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = view.getUint32(i); if (length > bytes.length - i - 12) return false;
      if (view.getUint32(i + 4) === 0x6163544c) return false; // APNG: no animation memory claim.
      i += length + 12;
    }
  } else if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 4 < bytes.length;) {
      if (bytes[i++] !== 255) return false;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++]; if (marker === 217 || marker === 218) break;
      const length = view.getUint16(i); if (length < 2 || length > bytes.length - i) return false;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        height = view.getUint16(i + 3); width = view.getUint16(i + 5); break;
      }
      i += length;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 4000000;
}
export async function localPreview(item: FileItem, fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>) {
  const existing = previews.get(item.id);
  if (existing?.envelope === item.envelope) return existing.url;
  if (!['image/png', 'image/jpeg'].includes(item.mimeType) || item.size > 2 * 1024 * 1024 ||
    previews.size + previewPending >= 4 || previewBytes + previewReserved + item.size > BROWSER_FILE_LIMIT) return undefined;
  const epoch = generation; previewReserved += item.size; previewPending++;
  try {
    const blob = await decryptedDownload(item, fetchCiphertext);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      if (epoch !== generation || !safeRaster(bytes, item.mimeType)) return undefined;
      const url = URL.createObjectURL(blob);
      if (existing) { URL.revokeObjectURL(existing.url); previewBytes -= existing.bytes; }
      previews.set(item.id, { envelope: item.envelope, url, bytes: blob.size }); previewBytes += blob.size;
      return url;
    } finally { bytes.fill(0); }
  } catch { return undefined; }
  finally { previewReserved -= item.size; previewPending--; }
}
export function disposePreviews(items: readonly DropItem[], retained: readonly DropItem[] = []) {
  const keep = new Set(retained.filter(item => item.type === 'file').map(item => item.previewUrl));
  for (const item of items) if (item.type === 'file' && item.previewUrl && !keep.has(item.previewUrl)) {
    URL.revokeObjectURL(item.previewUrl);
    const stored = previews.get(item.id);
    if (stored?.url === item.previewUrl) { previewBytes -= stored.bytes; previews.delete(item.id); }
  }
}
export function clearFileOutput() {
  generation++;
  for (const preview of previews.values()) URL.revokeObjectURL(preview.url);
  previews.clear(); previewBytes = 0;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = undefined;
}
export function exposeDownload(blob: Blob, name: string) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  // The save URL stays non-executable even for an authenticated HTML/SVG file.
  downloadUrl = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'));
  const link = document.createElement('a'); link.href = downloadUrl; link.download = name;
  link.click(); // Retain until the next download or lock, never revoke immediately after click.
}
