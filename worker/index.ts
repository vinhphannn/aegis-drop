import { MAX_FILE_SIZE } from '../src/model';
import { cleanup, insertItem, listItems, markDeleted, parsePage, UUID } from './storage';
import type { Env, ItemRow } from './storage';

const MAX_TEXT_BYTES = 64 * 1024;
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
  // Bound even chunked JSON bodies before parsing. Text stays opaque to storage.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Missing text body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TEXT_BYTES + 4096) {
      await reader.cancel();
      throw new ApiError(413, 'Text request is too large.');
    }
    chunks.push(value);
  }
  let payload: unknown;
  try { payload = JSON.parse(await new Blob(chunks).text()); }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
  if (!payload || typeof payload !== 'object' || !('text' in payload) || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new ApiError(400, 'A non-empty text string is required.');
  }
  if ('type' in payload && payload.type !== 'text') throw new ApiError(400, 'Invalid item type.');
  const bytes = new TextEncoder().encode(payload.text).byteLength;
  if (bytes > MAX_TEXT_BYTES) throw new ApiError(413, 'Text is limited to 64 KiB.');
  await insertItem(env, { id: crypto.randomUUID(), type: 'text', text_content: payload.text,
    file_key: null, file_name: null, mime_type: null, size: bytes });
}

async function createFile(request: Request, env: Env) {
  const sizeHeader = request.headers.get('x-file-size');
  if (!sizeHeader || !/^\d+$/.test(sizeHeader)) throw new ApiError(400, 'X-File-Size must be a byte count.');
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size > MAX_FILE_SIZE) throw new ApiError(413, 'Files are limited to 100 MiB.');
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== size) throw new ApiError(400, 'File size does not match Content-Length.');
  let name: string;
  try { name = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new ApiError(400, 'Invalid encoded filename.'); }
  if (!name || name.length > 1024 || /[\x00-\x1f\x7f]/.test(name)) throw new ApiError(400, 'A valid filename is required (maximum 1024 characters).');
  const mimeType = request.headers.get('content-type') || 'application/octet-stream';
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(mimeType) || mimeType.length > 255) {
    throw new ApiError(400, 'Invalid MIME type.');
  }
  const id = crypto.randomUUID();
  const key = `items/${id}`;
  try {
    if (size === 0 && !request.body) await env.FILES.put(key, new Uint8Array());
    else {
      if (!request.body) throw new ApiError(400, 'Missing file body.');
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
        request.body.pipeThrough(checkSize).pipeTo(stream.writable, { signal: abort.signal }),
        Promise.resolve().then(() => env.FILES.put(key, stream.readable)).catch(error => {
          // A put can fail before it consumes the stream. Unblock the producer
          // and cancel its source instead of waiting forever on backpressure.
          abort.abort(error);
          throw error;
        }),
      ]);
      if (invalidSize) throw new ApiError(400, 'Actual bytes did not match the declared size.');
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
    await insertItem(env, { id, type: 'file', text_content: null,
      file_key: key, file_name: name, mime_type: mimeType, size });
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

function attachment(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
async function download(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND pending_delete = 0').bind(id).first<ItemRow>();
  if (!row || row.type !== 'file') throw new ApiError(404, 'File not found.');
  const object = await env.FILES.get(row.file_key!);
  if (!object) throw new ApiError(404, 'File not found.');
  return new Response(object.body, { headers: {
    'Content-Type': row.mime_type!, 'Content-Length': String(object.size),
    'Content-Disposition': attachment(row.file_name!), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store',
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
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
      if (error instanceof ApiError) return json({ error: error.message }, error.status, error.allow ? { Allow: error.allow } : {});
      console.error('API operation failed');
      return json({ error: 'Storage operation failed. Please retry.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
