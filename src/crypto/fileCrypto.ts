import { CHUNK_SIZE, Reader, chunkCount, concat, decodeEnvelope, decodeHeader, domain, encoder, equal, requireValue, sha256, uint } from './format';
import type { FileManifest, ItemContext } from './format';
import { decrypt, encrypt } from './keys';
import { openManifest, sealManifest } from './itemCrypto';

export type ByteSource = AsyncIterable<Uint8Array>;
const usedKeys = new WeakMap<CryptoKey, { next: number; binding: Uint8Array }>();
function expectedLength(manifest: FileManifest, index: number) {
  const count = chunkCount(manifest.size);
  requireValue(Number.isInteger(index) && index >= 0 && index < count);
  return Math.min(CHUNK_SIZE, manifest.size - index * CHUNK_SIZE);
}
function chunkAad(header: Uint8Array, digest: Uint8Array, manifest: FileManifest, index: number) {
  return domain('file-chunk/v1', header, digest, uint(index, 4), uint(expectedLength(manifest, index), 4),
    uint(manifest.size, 8), uint(chunkCount(manifest.size), 4), uint(index === chunkCount(manifest.size) - 1 ? 1 : 0, 1));
}
const nonce = (index: number) => concat(new Uint8Array(8), uint(index, 4));
export async function encryptChunk(key: CryptoKey, header: Uint8Array, digest: Uint8Array, manifest: FileManifest, index: number, plain: Uint8Array) {
  requireValue(plain.length === expectedLength(manifest, index));
  const binding = domain('chunk-key-binding/v1', header, digest, uint(manifest.size, 8));
  const state = usedKeys.get(key) ?? { next: 0, binding };
  requireValue(state.next === index && equal(state.binding, binding), 'Chunk key/index already used or out of order.');
  // Reserve before awaiting: even cancellation/failure cannot authorize nonce reuse.
  state.next++; usedKeys.set(key, state);
  return encrypt(key, nonce(index), chunkAad(header, digest, manifest, index), plain);
}
export async function decryptChunk(key: CryptoKey, header: Uint8Array, digest: Uint8Array, manifest: FileManifest, index: number, cipher: Uint8Array) {
  requireValue(cipher.length === expectedLength(manifest, index) + 16);
  return decrypt(key, nonce(index), chunkAad(header, digest, manifest, index), cipher);
}
// One input block plus one output record; caller supplies bounded source blocks.
class SourceReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = new Uint8Array();
  private offset = 0;
  constructor(source: ByteSource) { this.iterator = source[Symbol.asyncIterator](); }
  private async pull() {
    const result = await this.iterator.next();
    if (result.done) return false;
    requireValue(result.value instanceof Uint8Array && result.value.length <= CHUNK_SIZE + 128, 'Source block exceeds bounded-memory contract.');
    this.current = result.value; this.offset = 0; return true;
  }
  async take(length: number) {
    requireValue(length >= 0 && length <= CHUNK_SIZE + 16);
    const result = new Uint8Array(length); let filled = 0;
    while (filled < length) {
      if (this.offset === this.current.length && !await this.pull()) throw new Error('Truncated encrypted file or source.');
      const count = Math.min(length - filled, this.current.length - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + count), filled);
      this.offset += count; filled += count;
    }
    return result;
  }
  async end() {
    requireValue(this.offset === this.current.length, 'Trailing file bytes.');
    while (await this.pull()) requireValue(this.current.length === 0, 'Trailing file bytes.');
  }
  async close() { await this.iterator.return?.(); }
}
export async function sealFileManifest(master: Uint8Array, context: ItemContext, metadata: Omit<FileManifest, 'kind'>) {
  const manifest: FileManifest = Object.freeze({ ...metadata, kind: 'file' });
  const sealed = await sealManifest(master, context, manifest);
  const header = decodeEnvelope(sealed.envelope).header, digest = await sha256(sealed.envelope);
  const key = sealed.fileKey!;
  let used = false;
  return {
    envelope: sealed.envelope.slice(),
    async *encrypt(source: ByteSource) {
      requireValue(!used, 'File encryption is single-use; retry frozen ciphertext or create a new item.'); used = true;
      const reader = new SourceReader(source);
      try {
        yield concat(encoder.encode('AGF1'), header, digest);
        for (let i = 0; i < chunkCount(manifest.size); i++) {
          const plain = await reader.take(expectedLength(manifest, i));
          try {
            const cipher = await encryptChunk(key, header, digest, manifest, i, plain);
            yield concat(uint(cipher.length, 4), cipher);
          } finally { plain.fill(0); }
        }
        await reader.end();
      } finally { await reader.close(); }
    },
  };
}
export async function openFileManifest(master: Uint8Array, envelope: Uint8Array, expected: ItemContext) {
  const snapshot = new Uint8Array(envelope), opened = await openManifest(master, snapshot, expected, 1);
  const manifest = Object.freeze(opened.manifest as FileManifest);
  const header = decodeEnvelope(snapshot).header, digest = await sha256(snapshot), key = opened.fileKey!;
  return {
    manifest,
    // Each yielded block is authenticated; completion is required for whole-file validity.
    async *decrypt(source: ByteSource) {
      const reader = new SourceReader(source);
      try {
        const prefix = new Reader(await reader.take(92)); prefix.magic('AGF1');
        const receivedHeader = prefix.take(56); decodeHeader(receivedHeader);
        requireValue(equal(receivedHeader, header) && equal(prefix.take(32), digest)); prefix.end();
        for (let i = 0; i < chunkCount(manifest.size); i++) {
          const length = new Reader(await reader.take(4)).number(4);
          requireValue(length === expectedLength(manifest, i) + 16, 'Incorrect ciphertext record length.');
          yield await decryptChunk(key, header, digest, manifest, i, await reader.take(length));
        }
        await reader.end();
      } finally { await reader.close(); }
    },
  };
}
