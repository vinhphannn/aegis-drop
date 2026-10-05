import type { Env } from './storage';

const COOKIE = '__Host-aegis-session';
const TTL = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => new Uint8Array(value.match(/../g)!.map(byte => parseInt(byte, 16)));
export class AuthError extends Error {
  constructor(public status: number, message: string, public allow?: string) { super(message); }
}
function configured(env: Env) {
  if (!/^[a-f0-9]{64}$/.test(env.ACCESS_KEY_SHA256 ?? '') || !/^[a-f0-9]{64}$/.test(env.SESSION_SECRET ?? '')) {
    throw new AuthError(503, 'Authentication is not configured.');
  }
}
async function signingKey(env: Env) {
  configured(env);
  return crypto.subtle.importKey('raw', unhex(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function signedBytes(env: Env, payload: string) {
  // Binding the verifier invalidates existing sessions when either secret rotates.
  return encoder.encode(`aegis-session:${env.ACCESS_KEY_SHA256}:${payload}`);
}
export async function authenticated(request: Request, env: Env) {
  configured(env);
  const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE}=`)).map(part => part.slice(COOKIE.length + 1));
  if (values.length !== 1 || values[0].length > 256) return false;
  const match = values[0].match(/^v1\.([0-9]{1,12})\.([0-9]{1,12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match) return false;
  const [, issued, expires, , signature] = match;
  const now = Math.floor(Date.now() / 1000);
  if (Number(issued) > now || Number(expires) <= now || Number(expires) - Number(issued) !== TTL) return false;
  const payload = values[0].slice(0, -(signature.length + 1));
  return crypto.subtle.verify('HMAC', await signingKey(env), unhex(signature), signedBytes(env, payload));
}
export function checkOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && !['same-origin', 'none'].includes(site))) {
    throw new AuthError(403, 'Cross-origin requests are not allowed.');
  }
}
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function cookie(token: string, age: number) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}${age === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`;
}
async function login(request: Request, env: Env) {
  configured(env);
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(415, 'Send login as application/json.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'Missing login body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new AuthError(413, 'Login request is too large.'); }
    chunks.push(value);
  }
  let data: unknown;
  try { data = JSON.parse(await new Blob(chunks).text()); }
  catch { throw new AuthError(400, 'Invalid login request.'); }
  if (!data || typeof data !== 'object' || !('accessKey' in data) || typeof data.accessKey !== 'string' || !data.accessKey || data.accessKey.length > 1024) {
    throw new AuthError(400, 'An access key is required.');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data.accessKey));
  if (!crypto.subtle.timingSafeEqual(digest, unhex(env.ACCESS_KEY_SHA256))) throw new AuthError(401, 'Invalid access key.');
  const issued = Math.floor(Date.now() / 1000);
  const payload = `v1.${issued}.${issued + TTL}.${hex(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(env), signedBytes(env, payload)));
  return response({ authenticated: true }, 200, { 'Set-Cookie': cookie(`${payload}.${signature}`, TTL) });
}
export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/login') {
    if (request.method !== 'POST') throw new AuthError(405, 'Method not allowed.', 'POST');
    return login(request, env);
  }
  if (path === '/api/auth/session') {
    if (request.method !== 'GET') throw new AuthError(405, 'Method not allowed.', 'GET');
    return response({ authenticated: await authenticated(request, env) });
  }
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') throw new AuthError(405, 'Method not allowed.', 'POST');
    return response({ authenticated: false }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  return null;
}
