import { concat, decodeDescriptor, domain, encoder, equal, Reader, requireValue, sha256, sized, tuple, uint, VERSION } from './format';
import { decrypt, encrypt, hkdf, randomBytes, verifyDescriptor } from './keys';
import { decodeRootBundle, encodeRootBundle } from './recovery';

export interface Ephemeral { readonly publicKey: Uint8Array }
interface LocalKey { privateKey?: CryptoKey; publicKey: Uint8Array; peer?: Uint8Array; bound: boolean }
const locals = new WeakMap<Ephemeral, LocalKey>();
export interface PairTranscript {
  origin: string; vaultId: Uint8Array; epochId: Uint8Array; descriptorHash: Uint8Array; pairId: Uint8Array;
  newPublic: Uint8Array; trustedPublic: Uint8Array; newNonce: Uint8Array; trustedNonce: Uint8Array;
  created: number; expires: number;
}
function publicPoint(bytes: Uint8Array) { const point = sized(bytes, 65); requireValue(point[0] === 4); return point; }
export function encodeTranscript(t: PairTranscript) {
  requireValue(typeof t.origin === 'string' && t.origin.length >= 9 && t.origin.length <= 512);
  const origin = encoder.encode(t.origin), url = new URL(t.origin);
  requireValue(!equal(publicPoint(t.newPublic), publicPoint(t.trustedPublic)) && !equal(sized(t.newNonce, 32), sized(t.trustedNonce, 32)), 'Reflected pairing material.');
  requireValue(url.protocol === 'https:' && url.origin === t.origin && origin.length <= 512);
  requireValue(Number.isSafeInteger(t.created) && t.expires - t.created === 300);
  return concat(encoder.encode('AGP1'), uint(VERSION, 2), uint(1, 1), uint(0, 1), uint(origin.length, 2), origin,
    sized(t.vaultId, 16), sized(t.epochId, 16), sized(t.descriptorHash, 32), sized(t.pairId, 32),
    uint(1, 1), publicPoint(t.newPublic), sized(t.newNonce, 32),
    uint(2, 1), publicPoint(t.trustedPublic), sized(t.trustedNonce, 32), uint(t.created, 8), uint(t.expires, 8));
}
export function decodeTranscript(bytes: Uint8Array): PairTranscript {
  requireValue(bytes instanceof Uint8Array && bytes.length >= 327 && bytes.length <= 830);
  const r = new Reader(bytes); r.magic('AGP1'); requireValue(r.number(2) === VERSION && r.number(1) === 1 && r.number(1) === 0);
  const length = r.number(2); requireValue(length > 0 && length <= 512);
  const origin = new TextDecoder('utf-8', { fatal: true }).decode(r.take(length));
  const vaultId = r.take(16), epochId = r.take(16), descriptorHash = r.take(32), pairId = r.take(32);
  requireValue(r.number(1) === 1); const newPublic = r.take(65), newNonce = r.take(32);
  requireValue(r.number(1) === 2); const trustedPublic = r.take(65), trustedNonce = r.take(32);
  const created = r.number(8), expires = r.number(8); r.end();
  const result = { origin, vaultId, epochId, descriptorHash, pairId, newPublic, trustedPublic, newNonce, trustedNonce, created, expires };
  requireValue(equal(encodeTranscript(result), bytes)); return result;
}
export function assertLivePairing(t: PairTranscript, now: number) {
  encodeTranscript(t); requireValue(Number.isSafeInteger(now) && t.created <= now && now < t.expires, 'Pairing expired or not yet valid.');
}
export async function generateEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const handle = Object.freeze({ get publicKey() { return publicKey.slice(); } });
  locals.set(handle, { privateKey: pair.privateKey, publicKey, bound: false }); return handle;
}
function localKey(local: Ephemeral) {
  const key = locals.get(local); requireValue(key, 'Unknown pairing key handle.'); return key;
}
async function shared(key: LocalKey, remote: Uint8Array) {
  const privateKey = key.privateKey; requireValue(privateKey, 'Ephemeral key has been released.');
  const peer = publicPoint(remote);
  requireValue(!key.peer || equal(key.peer, peer), 'Ephemeral key cannot be reused with a different peer.');
  key.peer = peer;
  // Native import rejects off-curve points, infinity and noncanonical coordinates.
  const point = await crypto.subtle.importKey('raw', peer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: point }, privateKey, 256));
}
export async function deriveSharedSecret(local: Ephemeral, remote: Uint8Array) {
  const key = localKey(local); requireValue(!key.bound, 'Ephemeral key is already bound to a pairing.');
  return shared(key, remote);
}
export interface PairKeys { readonly sas: string; readonly transcript: Uint8Array; readonly hash: Uint8Array }
type Phase = 'active' | 'sealing' | 'sealed' | 'opening' | 'opened' | 'completed' | 'failed';
interface State {
  role: 'new' | 'trusted'; t: PairTranscript; transcript: Uint8Array; hash: Uint8Array; sas: string;
  provision: CryptoKey; confirm: CryptoKey; deadline: number; approved: boolean; ready: boolean; readySent: boolean;
  phase: Phase; sealedHash?: Uint8Array;
}
const states = new WeakMap<PairKeys, State>();
function stateOf(keys: PairKeys) {
  const state = states.get(keys); requireValue(state, 'Unknown pairing context.');
  requireValue(state.phase !== 'failed', 'Pairing expired or failed.');
  try {
    assertLivePairing(state.t, Math.floor(Date.now() / 1000));
    requireValue(performance.now() < state.deadline, 'Pairing expired or failed.');
  } catch {
    // Expiry/clock invalidation is terminal, even if a later clock correction
    // returns wall time to this transcript's formerly valid interval.
    state.phase = 'failed'; throw new Error('Pairing expired or failed.');
  }
  return state;
}
function sasString(bytes: Uint8Array) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let result = '';
  for (let i = 0; i < 12; i++) {
    let value = 0;
    for (let bit = 0; bit < 5; bit++) { const offset = i * 5 + bit; value = (value << 1) | ((bytes[offset >> 3] >> (7 - (offset & 7))) & 1); }
    result += alphabet[value];
  }
  return `${result.slice(0, 4)} ${result.slice(4, 8)} ${result.slice(8)}`;
}
export function assertSasMatch(actual: string, observed: string) {
  requireValue(/^[A-Z2-7]{4} [A-Z2-7]{4} [A-Z2-7]{4}$/.test(observed) && actual === observed, 'Pairing code mismatch.');
}
export async function derivePairKeys(local: Ephemeral, role: 'new' | 'trusted', transcript: Uint8Array): Promise<PairKeys> {
  requireValue(role === 'new' || role === 'trusted');
  requireValue(transcript instanceof Uint8Array && transcript.length >= 327 && transcript.length <= 830);
  const snapshot = new Uint8Array(transcript), t = decodeTranscript(snapshot), localState = localKey(local);
  requireValue(equal(localState.publicKey, role === 'new' ? t.newPublic : t.trustedPublic), 'Pairing public key/role mismatch.');
  assertLivePairing(t, Math.floor(Date.now() / 1000));
  requireValue(!localState.bound, 'Ephemeral key is already bound to a pairing.'); localState.bound = true;
  const deadline = performance.now() + Math.min(300000, t.expires * 1000 - Date.now());
  let secret: Uint8Array | undefined, provision: Uint8Array | undefined, confirm: Uint8Array | undefined, sasBytes: Uint8Array | undefined;
  try {
    secret = await shared(localState, role === 'new' ? t.trustedPublic : t.newPublic);
    const hash = await sha256(snapshot);
    const info = (label: string) => tuple(encoder.encode('AEGIS-pair'), uint(VERSION, 2), encoder.encode(label), hash);
    provision = await hkdf(secret, hash, info('provision'), 32); confirm = await hkdf(secret, hash, info('confirm'), 32);
    sasBytes = await hkdf(secret, hash, info('sas'), 8);
    const provisionKey = await crypto.subtle.importKey('raw', provision, 'AES-GCM', false, [role === 'trusted' ? 'encrypt' : 'decrypt']);
    const confirmKey = await crypto.subtle.importKey('raw', confirm, { name: 'HMAC', hash: 'SHA-256' }, false, [role === 'new' ? 'sign' : 'verify']);
    const sas = sasString(sasBytes);
    const handle = Object.freeze({ sas, get transcript() { return snapshot.slice(); }, get hash() { return hash.slice(); } });
    states.set(handle, { role, t, transcript: snapshot, hash, sas, provision: provisionKey, confirm: confirmKey, deadline, approved: false, ready: false, readySent: false, phase: 'active' });
    stateOf(handle); return handle;
  } finally { localState.privateKey = undefined; secret?.fill(0); provision?.fill(0); confirm?.fill(0); sasBytes?.fill(0); }
}
// Explicit local caller declaration that the two physical codes were compared and
// the user approved. Crypto cannot itself attest that a human performed this action.
export function approvePairing(keys: PairKeys, observedSas: string) {
  const state = stateOf(keys); requireValue(state.phase === 'active', 'Pairing is no longer awaiting approval.');
  assertSasMatch(state.sas, observedSas); state.approved = true;
}
async function macData(state: State, purpose: 'new-ready' | 'new-consumed', sealed?: Uint8Array) {
  requireValue(purpose === 'new-ready' || purpose === 'new-consumed');
  requireValue((purpose === 'new-consumed') === (sealed !== undefined));
  if (!sealed) return domain(purpose, state.hash);
  const hash = await sha256(sized(sealed, 168));
  requireValue(state.sealedHash && equal(state.sealedHash, hash), 'Sealed-response acknowledgement mismatch.');
  return domain(purpose, state.hash, hash);
}
function confirmationPhase(state: State, purpose: 'new-ready' | 'new-consumed', verifying: boolean) {
  requireValue(purpose === 'new-ready' ? state.phase === 'active' :
    (verifying ? ['sealed', 'completed'] : ['opened', 'completed']).includes(state.phase), 'Invalid pairing confirmation state.');
}
export async function confirmMac(keys: PairKeys, purpose: 'new-ready' | 'new-consumed', sealed?: Uint8Array) {
  const state = stateOf(keys); requireValue(state.role === 'new' && state.approved, 'New-device approval required.');
  confirmationPhase(state, purpose, false);
  const data = await macData(state, purpose, sealed);
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', state.confirm, data));
  stateOf(keys); confirmationPhase(state, purpose, false);
  if (purpose === 'new-consumed') state.phase = 'completed'; else state.readySent = true; return result;
}
export async function verifyConfirm(keys: PairKeys, purpose: 'new-ready' | 'new-consumed', mac: Uint8Array, sealed?: Uint8Array) {
  const state = stateOf(keys); requireValue(state.role === 'trusted', 'Trusted-device verification required.');
  confirmationPhase(state, purpose, true);
  const signature = sized(mac, 32), data = await macData(state, purpose, sealed);
  requireValue(await crypto.subtle.verify('HMAC', state.confirm, signature, data), 'Pairing confirmation failed.');
  stateOf(keys); confirmationPhase(state, purpose, true);
  if (purpose === 'new-ready') state.ready = true; else state.phase = 'completed';
}
export async function sealProvision(keys: PairKeys, master: Uint8Array, descriptor: Uint8Array) {
  const state = stateOf(keys);
  requireValue(state.role === 'trusted' && state.approved && state.ready && state.phase === 'active', 'Approved trusted pairing with verified ready MAC required.');
  state.phase = 'sealing'; // Reserve synchronously before any await, including validation.
  let root: Uint8Array | undefined, bundle: Uint8Array | undefined;
  try {
    root = sized(master, 32); const desc = sized(descriptor, 100), d = decodeDescriptor(desc);
    requireValue(equal(d.vaultId, state.t.vaultId) && equal(d.epochId, state.t.epochId) && equal(await sha256(desc), state.t.descriptorHash));
    await verifyDescriptor(root, desc);
    bundle = encodeRootBundle(root, desc);
    const iv = randomBytes(12), result = concat(encoder.encode('AGS1'), uint(VERSION, 2), uint(0, 2), iv, await encrypt(state.provision, iv, domain('provision/v1', state.hash), bundle));
    const sealedHash = await sha256(result); stateOf(keys);
    state.sealedHash = sealedHash; state.phase = 'sealed'; return result;
  } catch { state.phase = 'failed'; throw new Error('Pairing provisioning failed.'); }
  finally { root?.fill(0); bundle?.fill(0); }
}
export async function openProvision(keys: PairKeys, bytes: Uint8Array) {
  const state = stateOf(keys);
  requireValue(state.role === 'new' && state.approved && state.readySent && state.phase === 'active', 'Approved new-device pairing required.');
  state.phase = 'opening';
  let plain: Uint8Array | undefined, root: Awaited<ReturnType<typeof decodeRootBundle>> | undefined, success = false;
  try {
    const snapshot = sized(bytes, 168), r = new Reader(snapshot); r.magic('AGS1'); requireValue(r.number(2) === VERSION && r.number(2) === 0);
    const iv = r.take(12), cipher = r.take(148); r.end();
    plain = await decrypt(state.provision, iv, domain('provision/v1', state.hash), cipher);
    root = await decodeRootBundle(plain); const d = decodeDescriptor(root.descriptor);
    requireValue(equal(d.vaultId, state.t.vaultId) && equal(d.epochId, state.t.epochId) && equal(await sha256(root.descriptor), state.t.descriptorHash));
    const sealedHash = await sha256(snapshot); stateOf(keys);
    state.sealedHash = sealedHash; state.phase = 'opened'; success = true; return root;
  } catch { state.phase = 'failed'; throw new Error('Pairing provisioning failed.'); }
  finally { plain?.fill(0); if (!success) root?.master.fill(0); }
}
