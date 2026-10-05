import { authenticated, authRoute, AuthError, checkOrigin } from './auth';
import { MAX_CIPHERTEXT_SIZE } from '../src/model';
import { cleanup, insertItem, listItems, markDeleted, parsePage, UUID } from './storage';
import type { Env, ItemRow } from './storage';

import { encodeTextEnvelope, MAX_TEXT_REQUEST_BYTES, parseTextEnvelope } from '../src/textEnvelope';
import { decodeEnvelope, equal, sha256 } from '../src/crypto/format';
class ApiError extends Error {
  constructor(public status: number, message: string, public allow?: string) { super(message); }
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function createText(request: Request, env: Env) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Send text as application/json.');
  }
  // Bound even chunked JSON before parsing; only public encrypted framing is validated.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Missing text body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TEXT_REQUEST_BYTES) {
      await reader.cancel();
      throw new ApiError(413, 'Text request is too large.');
    }
    chunks.push(value);
  }
  let payload: unknown;
  try { payload = JSON.parse(await new Blob(chunks).text()); }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !== 'envelope,id' ||
    !('id' in payload) || typeof payload.id !== 'string' || !UUID.test(payload.id) ||
    !('envelope' in payload)) throw new ApiError(400, 'An encrypted text envelope and client item ID are required.');
  let bytes: Uint8Array;
  try { bytes = parseTextEnvelope(payload.id, payload.envelope).bytes; }
  catch { throw new ApiError(400, 'Invalid encrypted text envelope.'); }
  const existing = await env.DB.prepare('SELECT id FROM items WHERE id = ?').bind(payload.id).first();
  if (existing) throw new ApiError(409, 'Item ID already exists.');
  await insertItem(env, { id: payload.id, type: 'text', envelope: payload.envelope as string,
    file_key: null, ciphertext_size: bytes.length });
}

async function createFile(request: Request, env: Env) {
  if (request.headers.get('x-file-name') || request.headers.get('x-file-size')) throw new ApiError(400, 'Plaintext file headers are not accepted.');
  if (request.headers.get('content-type') !== 'application/octet-stream') throw new ApiError(415, 'Send encrypted binary data.');
  const id = request.headers.get('x-item-id') || '', sizeHeader = request.headers.get('x-ciphertext-size');
  if (!UUID.test(id) || !sizeHeader || !/^\d+$/.test(sizeHeader)) throw new ApiError(400, 'Encrypted item ID and ciphertext size are required.');
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size < 92 || size > MAX_CIPHERTEXT_SIZE) throw new ApiError(413, 'Encrypted file size exceeds the 100 MiB plaintext-equivalent limit.');
  if (!request.body) throw new ApiError(400, 'Missing encrypted file body.');
  const reader = request.body.getReader(); let released = false;
  const releaseReader = () => { if (!released) { released = true; reader.releaseLock(); } };
  const cancelReader = (reason?: unknown) => { if (!released) { void reader.cancel(reason).catch(() => {}); releaseReader(); } };
  let current = new Uint8Array(), offset = 0;
  async function take(count: number) {
    const out = new Uint8Array(count); let filled = 0;
    while (filled < count) {
      if (offset === current.length) { const next = await reader.read(); if (next.done) throw new ApiError(400, 'Truncated file prefix.'); current = next.value; offset = 0; }
      const n = Math.min(count - filled, current.length - offset); out.set(current.subarray(offset, offset + n), filled); filled += n; offset += n;
    }
    return out;
  }
  let envelope: string, prefix: Uint8Array;
  try {
    const length = new DataView((await take(4)).buffer).getUint32(0);
    if (length < 182 || length > 4529) throw new ApiError(400, 'Invalid file envelope length.');
    const raw = await take(length); envelope = encodeTextEnvelope(raw); parseTextEnvelope(id, envelope, 1);
    const total = request.headers.get('content-length');
    if (total !== null && Number(total) !== 4 + length + size) throw new ApiError(400, 'Encrypted request length mismatch.');
    prefix = await take(92);
    if (!equal(prefix.subarray(0, 4), new TextEncoder().encode('AGF1')) ||
      !equal(prefix.subarray(4, 60), decodeEnvelope(raw).header) || !equal(prefix.subarray(60), await sha256(raw))) throw new ApiError(400, 'Encrypted file binding mismatch.');
    if (await env.DB.prepare('SELECT id FROM items WHERE id = ?').bind(id).first()) throw new ApiError(409, 'Item ID already exists.');
  } catch (error) { cancelReader(error); if (error instanceof ApiError) throw error; throw new ApiError(400, 'Invalid encrypted file prefix.'); }
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (first) { first = false; controller.enqueue(prefix); return; }
        if (offset < current.length) { controller.enqueue(current.subarray(offset)); offset = current.length; return; }
        const next = await reader.read(); if (next.done) { controller.close(); releaseReader(); } else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { cancelReader(reason); },
  });
  const key = `items/${crypto.randomUUID()}`;
  try {
    {
      // FixedLengthStream verifies actual byte count and supplies R2 a known
      // length. No multipart buffering, arrayBuffer(), or base64 conversion.
      const stream = new FixedLengthStream(size);
      const abort = new AbortController();
      let received = 0;
      let invalidSize = false;
      const checkSize = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > size) { invalidSize = true; throw new Error('Too many upload bytes.'); }
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== size) { invalidSize = true; throw new Error('Too few upload bytes.'); }
        },
      });
      const results = await Promise.allSettled([
        body.pipeThrough(checkSize).pipeTo(stream.writable, { signal: abort.signal }),
        Promise.resolve().then(() => env.FILES.put(key, stream.readable)).catch(error => {
          // A put can fail before it consumes the stream. Unblock the producer
          // and cancel its source instead of waiting forever on backpressure.
          abort.abort(error);
          // R2 may fail without ever locking/reading FixedLengthStream. Cancel
          // its unused readable side too, so a pending small prefix write settles.
          void stream.readable.cancel(error).catch(() => {});
          cancelReader(error);
          throw error;
        }),
      ]);
      if (invalidSize) throw new ApiError(400, 'Actual bytes did not match the declared size.');
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
    await insertItem(env, { id, type: 'file', envelope, file_key: key, ciphertext_size: size });
  } catch (error) {
    // A transport error is not proof of rollback: D1 may have committed before
    // its acknowledgement was lost. Never delete bytes still owned by any row,
    // including a pending-delete row. If D1 is unavailable, preserve the object.
    try {
      const owner = await env.DB.prepare('SELECT id FROM items WHERE file_key = ?').bind(key).first();
      if (!owner) await env.FILES.delete(key);
    } catch { console.error('Upload rollback deferred; ownership or deletion could not be confirmed', key); }
    throw error;
  }
}

async function download(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND pending_delete = 0').bind(id).first<ItemRow>();
  if (!row || row.type !== 'file') throw new ApiError(404, 'File not found.');
  const object = await env.FILES.get(row.file_key!);
  if (!object) throw new ApiError(404, 'File not found.');
  return new Response(object.body, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${id}.agd"`, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store',
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      checkOrigin(request);
      const authResponse = await authRoute(request, env);
      if (authResponse) return authResponse;
      if (!await authenticated(request, env)) throw new ApiError(401, 'Authentication required.');
      if (path === '/api/items' && request.method === 'GET') {
        const page = parsePage(new URL(request.url).searchParams);
        if (!page) throw new ApiError(400, 'Invalid pagination limit or cursor.');
        await cleanup(env);
        return json(await listItems(env, page));
      }
      if (path === '/api/items/text' && request.method === 'POST') {
        await createText(request, env); await cleanup(env); return json({ ok: true }, 201);
      }
      if (path === '/api/items/file' && request.method === 'POST') {
        await createFile(request, env); await cleanup(env); return json({ ok: true }, 201);
      }
      if (['/api/items', '/api/items/text', '/api/items/file'].includes(path)) {
        throw new ApiError(405, 'Method not allowed.', path === '/api/items' ? 'GET' : 'POST');
      }
      const match = path.match(/^\/api\/items\/([^/]+)(\/file)?$/);
      if (match) {
        if (!UUID.test(match[1])) throw new ApiError(400, 'Invalid item ID.');
        if (match[2] && request.method === 'GET') return await download(env, match[1]);
        if (!match[2] && request.method === 'DELETE') {
          if (!await markDeleted(env, match[1])) throw new ApiError(404, 'Item not found.');
          await cleanup(env); return json({ ok: true });
        }
        throw new ApiError(405, 'Method not allowed.', match[2] ? 'GET' : 'DELETE');
      }
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof ApiError || error instanceof AuthError) return json({ error: error.message }, error.status, error.allow ? { Allow: error.allow } : {});
      console.error('API operation failed');
      return json({ error: 'Storage operation failed. Please retry.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
