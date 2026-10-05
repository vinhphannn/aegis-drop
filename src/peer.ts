import { APP_VERSION } from './version';
export const CHUNK_BYTES = 16 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_BYTES = 12 * 1024;
const MAX_CONTROL_BYTES = 16 * 1024;
const HIGH_WATER = 256 * 1024, LOW_WATER = 64 * 1024;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function check(ok: unknown, message = 'Invalid peer message.'): asserts ok { if (!ok) throw new Error(message); }
export type ReceivedItem = { id: string; createdAt: number } & (
  { type: 'text'; text: string } | { type: 'file'; name: string; mimeType: string; size: number; url: string; previewUrl?: string }
);
export interface FileTransfer {
  id: string; name: string; size: number; createdAt: number; direction: 'send' | 'receive';
  phase: 'preparing' | 'hashing' | 'sending' | 'receiving' | 'verifying' | 'sent' | 'received' | 'failed';
  bytes: number; error?: string;
}
export function validateSendFile(file: File) {
  if (file.size > MAX_FILE_BYTES) {
    console.warn('File too large', { filename: file.name, size: file.size, limit: MAX_FILE_BYTES });
    throw new Error('File too large. Maximum 32 MB.');
  }
  validFile(file.name || 'screenshot.png', file.type || 'application/octet-stream', file.size);
}
async function checksum(blob: Blob) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { throw new Error('Could not read or hash file.'); }
}
interface Progress { name: string; bytes: number; total: number }
export interface PeerState {
  status: 'disconnected' | 'preparing' | 'waiting' | 'connecting' | 'connected' | 'failed';
  error: string | null; device?: { id: string; label: string };
  transfers: readonly FileTransfer[];
  items: readonly ReceivedItem[]; sending: Progress | null; receiving: Progress | null;
}
interface Incoming { id: string; name: string; mime: string; size: number; hash: string; received: number; chunks: Uint8Array[] }
export function validFile(name: unknown, mime: unknown, size: unknown) {
  check(typeof name === 'string' && name.length > 0 && encoder.encode(name).length <= 4096 && !/[\x00-\x1f\x7f/\\]/.test(name), 'Invalid filename.');
  check(typeof mime === 'string' && mime.length <= 255 && /^[\x20-\x7e]+$/.test(mime), 'Invalid file type.');
  check(typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_BYTES, 'Files are limited to 32 MiB each.');
}
async function preview(blob: Blob, mime: string) {
  if (blob.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(mime)) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return undefined;
    width = view.getUint32(16); height = view.getUint32(20);
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = view.getUint32(i); if (length > bytes.length - i - 12 || view.getUint32(i + 4) === 0x6163544c) return undefined;
      i += length + 12;
    }
  } else if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 4 < bytes.length;) {
      if (bytes[i++] !== 255) return undefined;
      while (i < bytes.length && bytes[i] === 255) i++;
      const marker = bytes[i++]; if (marker === 217 || marker === 218 || i + 2 > bytes.length) break;
      const length = view.getUint16(i); if (length < 2 || length > bytes.length - i) return undefined;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        height = view.getUint16(i + 3); width = view.getUint16(i + 5); break;
      }
      i += length;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 4000000 ? URL.createObjectURL(blob) : undefined;
}
function dispose(item: ReceivedItem) {
  if (item.type === 'file') { URL.revokeObjectURL(item.url); if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }
}
export class DirectPeer {
  private state: PeerState = { status: 'disconnected', error: null, transfers: [], items: [], sending: null, receiving: null };
  private listeners = new Set<() => void>();
  private connection?: import('peerjs').DataConnection;
  private channel?: RTCDataChannel;
  private session = '';
  private epoch = 0;
  private hello = false;
  private incoming?: Incoming;
  private finishing = false;
  private receiveTimer?: ReturnType<typeof setTimeout>;
  private progressTimes = new Map<string, number>();
  private seen = new Set<string>();
  private ack?: { id: string; hash: string; resolve: () => void; reject: (error: Error) => void };

  constructor(private readonly localDevice?: { id: string; label: string }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(patch: Partial<PeerState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  private transfer(value: FileTransfer) {
    const transfers = [value, ...this.state.transfers.filter(item => item.id !== value.id)];
    this.update({ transfers });
  }
  private progress(id: string, phase: FileTransfer['phase'], bytes: number, error?: string) {
    const item = this.state.transfers.find(item => item.id === id); if (!item) return;
    const now = performance.now();
    if (!error && phase === item.phase && bytes !== item.size && now - (this.progressTimes.get(id) ?? 0) < 80) return;
    this.progressTimes.set(id, now);
    this.update({ transfers: this.state.transfers.map(item => item.id === id ? { ...item, phase, bytes, error } : item) });
  }
  recordFileFailure(file: File, error: string, id = crypto.randomUUID()) {
    this.transfer({ id, name: file.name || 'screenshot.png', size: file.size, createdAt: Date.now(), direction: 'send', phase: 'failed', bytes: 0, error });
  }
  private receivingTimeout() {
    clearTimeout(this.receiveTimer);
    this.receiveTimer = setTimeout(() => this.fail(new Error('Transfer timed out.')), 30000);
  }
  disconnect = () => {
    clearTimeout(this.receiveTimer);
    this.update({ transfers: this.state.transfers.map(item => ['sent', 'received', 'failed'].includes(item.phase) ? item : { ...item, phase: 'failed', error: 'Peer disconnected.' }) });
    this.epoch++; this.ack?.reject(new Error('Connection closed.')); this.ack = undefined;
    this.connection?.close(); this.connection = undefined; this.channel?.close(); this.channel = undefined; this.hello = false;
    if (this.incoming) for (const chunk of this.incoming.chunks) chunk.fill(0);
    this.incoming = undefined; this.finishing = false; this.seen.clear(); if (!this.localDevice) this.state.items.forEach(dispose);
    this.update({ status: 'disconnected', error: null, items: this.localDevice ? this.state.items : [], sending: null, receiving: null });
  };
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : 'Transfer failed.';
    if (this.incoming && this.channel?.readyState === 'open') {
      try { this.control({ type: 'file-error', id: this.incoming.id, reason: message }); }
      catch { console.warn('Could not notify receiver rejection', { transferId: this.incoming.id }); }
    }
    this.update({ transfers: this.state.transfers.map(item => ['sent', 'received', 'failed'].includes(item.phase) ? item : { ...item, phase: 'failed', error: message }) });
    this.disconnect(); this.update({ status: 'failed', error: message });
  }
  onVersionMismatch?: () => void;
  onPeers?: (peers: string[]) => void;
  sendPeers(peers: string[]) { this.ready(); this.control({ type: 'peers', peers }); }
  setStatus(status: PeerState['status'], error: string | null = null) { this.update({ status, error }); }
  connect(connection: import('peerjs').DataConnection, session: string) {
    if (this.channel) { connection.close(); return; }
    this.connection = connection; this.session = session;
    this.attach(connection.dataChannel, this.epoch);
  }
  private attach(channel: RTCDataChannel, epoch: number) {
    if (this.channel && this.channel !== channel) { channel.close(); return; }
    check(channel.ordered);
    this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = LOW_WATER;
    const opened = () => { if (epoch === this.epoch) this.control({ type: 'hello', device: this.localDevice, protocol: 2, appVersion: APP_VERSION }); };
    channel.addEventListener('open', opened);
    channel.addEventListener('close', () => { if (epoch === this.epoch) this.fail(new Error('Connection closed. Reload to reconnect.')); });
    channel.addEventListener('error', () => { if (epoch === this.epoch) this.fail(new Error('Data transfer failed.')); });
    channel.addEventListener('message', event => { if (epoch === this.epoch) { try { this.receive(event.data, epoch); } catch (error) { this.fail(error); } } });
    if (channel.readyState === 'open') opened();
  }
  private control(value: Record<string, unknown>) {
    check(this.channel?.readyState === 'open', 'Connect to the other device first.');
    const encoded = JSON.stringify({ ...value, v: 1, session: this.session });
    check(encoder.encode(encoded).length <= MAX_CONTROL_BYTES, 'Message is too large.'); this.send(encoded);
  }
  private send(data: string | ArrayBuffer) { if (this.connection) this.connection.send(data); else this.channel!.send(data as string); }
  private ready() { check(this.hello && this.channel?.readyState === 'open' && this.state.status === 'connected', 'Connect to the other device first.'); }
  private add(item: ReceivedItem) {
    const items = [item, ...this.state.items];
    let bytes = items.reduce((n, item) => n + (item.type === 'file' ? item.size : encoder.encode(item.text).length), 0);
    while (items.length > 5 || bytes > MAX_HISTORY_BYTES) { const old = items.pop()!; bytes -= old.type === 'file' ? old.size : encoder.encode(old.text).length; dispose(old); }
    this.seen.add(item.id); if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!); this.update({ items });
  }
  private receive(data: unknown, epoch: number) {
    if (typeof data !== 'string') {
      check(this.hello && this.incoming && !this.finishing && data instanceof ArrayBuffer && data.byteLength > 0 && data.byteLength <= CHUNK_BYTES, 'Unexpected file chunk.');
      check(data.byteLength === Math.min(CHUNK_BYTES, this.incoming.size - this.incoming.received), 'Wrong file chunk size.');
      check(this.incoming.received + data.byteLength <= this.incoming.size, 'Wrong file byte count.');
      this.incoming.chunks.push(new Uint8Array(data)); this.incoming.received += data.byteLength;
      this.receivingTimeout();
      this.progress(this.incoming.id, 'receiving', this.incoming.received);
      if (this.state.transfers.find(item => item.id === this.incoming!.id)?.bytes === this.incoming.received)
        this.update({ receiving: { name: this.incoming.name, bytes: this.incoming.received, total: this.incoming.size } });
      return;
    }
    check(data.length <= MAX_CONTROL_BYTES && encoder.encode(data).length <= MAX_CONTROL_BYTES);
    const value = JSON.parse(data); check(value && value.v === 1 && value.session === this.session);
    if (value.type === 'hello') {
      if (value.protocol !== 2) {
        this.onVersionMismatch?.();
        throw new Error('Other device uses an older version. Reload both devices.');
      }
      if (value.appVersion !== APP_VERSION) this.onVersionMismatch?.();
      if (value.device) check(typeof value.device.id === 'string' && uuid.test(value.device.id) && typeof value.device.label === 'string' && value.device.label.length <= 80);
      this.hello = true; this.update({ status: 'connected', error: null, device: value.device }); return;
    }
    check(this.hello);
    if (value.type === 'peers') {
      check(Array.isArray(value.peers) && value.peers.length <= 64 && value.peers.every((id: unknown) => typeof id === 'string' && id.length <= 128));
      this.onPeers?.(value.peers); return;
    }
    if (value.type === 'text') {
      check(typeof value.id === 'string' && uuid.test(value.id) && typeof value.text === 'string' && encoder.encode(value.text).length <= MAX_TEXT_BYTES);
      if (!this.seen.has(value.id)) this.add({ id: value.id, createdAt: Date.now(), type: 'text', text: value.text }); return;
    }
    if (value.type === 'file-start') {
      check(!this.incoming && !this.finishing, 'Another file is receiving.');
      if (typeof value.id !== 'string' || !uuid.test(value.id) || this.seen.has(value.id)) {
        this.transfer({ id: crypto.randomUUID(), name: 'File', size: 0, createdAt: Date.now(), direction: 'receive', phase: 'failed', bytes: 0, error: 'Malformed file metadata.' });
        throw new Error('Malformed file metadata.');
      }
      this.transfer({ id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 1024) : 'File', size: typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0, createdAt: Date.now(), direction: 'receive', phase: 'receiving', bytes: 0 });
      // Retain the transfer ID so malformed metadata can be rejected explicitly.
      this.incoming = { id: value.id, name: value.name, mime: value.mime, size: value.size, hash: value.hash, received: 0, chunks: [] };
      validFile(value.name, value.mime, value.size);
      check(typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash), 'Malformed file checksum.');
      this.update({ receiving: { name: value.name, bytes: 0, total: value.size } }); this.receivingTimeout(); return;
    }
    if (value.type === 'file-end') {
      const incoming = this.incoming;
      check(incoming && !this.finishing && value.id === incoming.id, 'Unexpected file completion.');
      check(incoming.received === incoming.size, 'Wrong final byte count.');
      this.finishing = true; this.progress(incoming.id, 'verifying', incoming.received);
      void this.finishFile(incoming, epoch).catch(error => { if (epoch === this.epoch) this.fail(error); }); return;
    }
    if (value.type === 'file-error') {
      check(this.ack && value.id === this.ack.id, 'Unexpected file rejection.');
      const reason = typeof value.reason === 'string' ? value.reason.slice(0, 120) : 'Receiver rejected file.';
      this.ack.reject(new Error(reason)); this.ack = undefined; return;
    }
    if (value.type === 'file-received') {
      check(this.ack && value.id === this.ack.id, 'Unexpected file receipt.');
      check(value.hash === this.ack.hash, 'Receiver verification failed.');
      this.ack.resolve(); this.ack = undefined; return;
    }
    throw new Error('Unsupported peer message.');
  }
  private async finishFile(incoming: Incoming, epoch: number) {
    const blob = new Blob(incoming.chunks, { type: incoming.mime }); incoming.chunks.forEach(chunk => chunk.fill(0));
    check(blob.size === incoming.size, 'Wrong final byte count.');
    const hash = await checksum(blob);
    if (epoch !== this.epoch) return;
    if (hash !== incoming.hash) {
      console.error('Transfer checksum mismatch', { transferId: incoming.id });
      throw new Error('Transfer failed — checksum mismatch');
    }
    let previewUrl: string | undefined;
    try { previewUrl = await preview(blob, incoming.mime); }
    catch { console.warn('File preview unavailable', { transferId: incoming.id }); }
    if (epoch !== this.epoch) { if (previewUrl) URL.revokeObjectURL(previewUrl); return; }
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'));
    this.control({ type: 'file-received', id: incoming.id, hash });
    this.add({ id: incoming.id, createdAt: Date.now(), type: 'file', name: incoming.name, mimeType: incoming.mime, size: incoming.size, url, previewUrl });
    this.progress(incoming.id, 'received', incoming.size);
    clearTimeout(this.receiveTimer); this.incoming = undefined;
    this.finishing = false; this.update({ receiving: null });
  }

  sendText(text: string, id = crypto.randomUUID()) {
    this.ready(); check(!this.state.sending, 'Please wait for the current file transfer.');
    check(encoder.encode(text).length <= MAX_TEXT_BYTES, 'Text is limited to 12 KiB.'); this.control({ type: 'text', id, text }); this.add({ id, createdAt: Date.now(), type: 'text', text });
  }
  private async drain(epoch: number) {
    check(epoch === this.epoch && this.channel?.readyState === 'open', 'Peer disconnected.');
    const channel = this.channel; if (channel.bufferedAmount <= HIGH_WATER - CHUNK_BYTES) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', closed); channel.removeEventListener('error', closed); error ? reject(error) : resolve(); };
      const low = () => { if (channel.bufferedAmount <= LOW_WATER) finish(); };
      const closed = () => finish(new Error('Connection closed during transfer.'));
      const timer = setTimeout(() => finish(new Error('Transfer stalled. Reconnect and try again.')), 30000);
      channel.addEventListener('bufferedamountlow', low); channel.addEventListener('close', closed); channel.addEventListener('error', closed); low();
    });
    check(epoch === this.epoch, 'Connection closed during transfer.');
  }
  async sendFile(file: File, id = crypto.randomUUID()) {
    this.transfer({ id, name: file.name || 'screenshot.png', size: file.size, createdAt: Date.now(), direction: 'send', phase: 'preparing', bytes: 0 });
    const epoch = this.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    try {
      validateSendFile(file);
      check(this.channel?.readyState === 'open', 'DataChannel not open.');
      this.ready(); check(!this.state.sending, 'Another file is sending.');
      const name = file.name || 'screenshot.png', mime = file.type || 'application/octet-stream';
      this.update({ sending: { name, bytes: 0, total: file.size } }); started = true;
      this.progress(id, 'hashing', 0);
      const hash = await checksum(file);
      check(epoch === this.epoch && this.channel?.readyState === 'open', 'Peer disconnected.');
      const receipt = new Promise<void>((resolve, reject) => { this.ack = { id, hash, resolve, reject }; });
      void receipt.catch(() => console.warn('File receipt failed', { transferId: id }));
      this.control({ type: 'file-start', id, name, mime, size: file.size, hash });
      this.progress(id, 'sending', 0);
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        await this.drain(epoch);
        let bytes: ArrayBuffer;
        try { bytes = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer(); }
        catch { throw new Error('Could not read file.'); }
        check(epoch === this.epoch && this.channel?.readyState === 'open', 'Peer disconnected.');
        check(bytes.byteLength === Math.min(CHUNK_BYTES, file.size - offset), 'Could not read complete file.');
        this.send(bytes);
        const transferred = offset + bytes.byteLength;
        this.progress(id, 'sending', transferred);
        if (this.state.transfers.find(item => item.id === id)?.bytes === transferred)
          this.update({ sending: { name, bytes: transferred, total: file.size } });
      }
      await this.drain(epoch); this.control({ type: 'file-end', id });
      this.progress(id, 'verifying', file.size);
      timer = setTimeout(() => this.ack?.reject(new Error('Receiver verification timed out.')), 30000); await receipt;
      check(epoch === this.epoch, 'Peer disconnected.');
      let previewUrl: string | undefined;
      try { previewUrl = await preview(file, mime); }
      catch { console.warn('File preview unavailable', { transferId: id }); }
      if (epoch !== this.epoch) { if (previewUrl) URL.revokeObjectURL(previewUrl); throw new Error('Peer disconnected.'); }
      this.add({ id, createdAt: Date.now(), type: 'file', name, mimeType: mime, size: file.size, url: URL.createObjectURL(file.slice(0, file.size, 'application/octet-stream')), previewUrl });
      this.progress(id, 'sent', file.size);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Transfer failed.';
      this.progress(id, 'failed', this.state.transfers.find(item => item.id === id)?.bytes ?? 0, reason);
      this.update({ error: reason });
      if (started && epoch === this.epoch) this.fail(error);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
      if (started && epoch === this.epoch) { this.ack = undefined; this.update({ sending: null }); }
    }
  }
  remove = (id: string) => { const item = this.state.items.find(item => item.id === id); if (item) dispose(item); this.update({ items: this.state.items.filter(item => item.id !== id) }); };
}
