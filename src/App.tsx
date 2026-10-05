import { useEffect, useRef, useState } from 'react';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import QRCode from 'qrcode';
import { checkVersion } from './version';
import { DirectPeer, validateSendFile } from './peer';
import type { ReceivedItem, FileTransfer } from './peer';

const ROOT_URL = 'https://vinhphannn.github.io/aegis-drop/';
const HOST_ID = 'aegis-drop-vinhphannn-personal-protocol-2';

function deviceLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${device} ${browser}`;
}
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export default function App() {
  const [qr, setQr] = useState(''), [link, setLink] = useState(''), [text, setText] = useState(''), [message, setMessage] = useState('');
  const [panel, setPanel] = useState<'share' | 'devices' | null>(null);
  const [dragging, setDragging] = useState(false), [sending, setSending] = useState(false);
  const [, refresh] = useState(0);
  const [localFailures, setLocalFailures] = useState<FileTransfer[]>([]);
  const fileBusy = useRef(false);
  const disconnectActions = useRef(new Map<string, () => void>());
  const connections = useRef(new Map<string, DirectPeer>());
  const picker = useRef<HTMLInputElement>(null), panelRoot = useRef<HTMLDivElement>(null);
  const local = useRef({ id: crypto.randomUUID(), label: deviceLabel() });
  useEffect(() => {
    let alive = true;
    const stores = connections.current;
    const unsubscribers: (() => void)[] = [];
    const options = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } };
    let peer: Peer;
    let isHost = true;
    const blocked = new Set<string>();
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const livePeers = new Map<string, { connection: DataConnection; store: DirectPeer }>();
    const connectTo = (id: string) => {
      if (!alive || blocked.has(id) || id === peer.id || livePeers.has(id)) return;
      accept(peer.connect(id, { label: 'aegis-drop-v1', reliable: true, serialization: 'raw', metadata: { session: crypto.randomUUID() } }));
    };
    const broadcastPeers = () => {
      if (!isHost) return;
      const connected = [...livePeers.entries()].filter(([, entry]) => entry.store.getSnapshot().status === 'connected');
      for (const [, entry] of connected) entry.store.sendPeers(connected.map(([id]) => id));
    };
    const accept = (connection: DataConnection) => {
      if (livePeers.has(connection.peer)) { connection.close(); return; }
      const store = new DirectPeer(local.current);
      store.onVersionMismatch = () => { void checkVersion(fileBusy.current).then(message => { if (alive && message) setMessage(message); }); };
      livePeers.set(connection.peer, { connection, store });
      stores.set(connection.connectionId, store);
      disconnectActions.current.set(connection.connectionId, () => { blocked.add(connection.peer); store.disconnect(); });
      const timeout = setTimeout(() => {
        pendingTimers.delete(timeout);
        if (store.getSnapshot().status !== 'connected') connection.close();
      }, 12000);
      pendingTimers.add(timeout);
      if (connection.peer === HOST_ID) store.onPeers = ids => {
        for (const id of ids) if (peer.id < id) connectTo(id);
      };
      let previous = store.getSnapshot().status;
      unsubscribers.push(store.subscribe(() => {
        if (!alive) return;
        refresh(value => value + 1);
        const status = store.getSnapshot().status;
        if (previous !== status) {
          previous = status;
          if (status === 'connected') { setMessage(''); broadcastPeers(); }
          else if (store.getSnapshot().error) setMessage(store.getSnapshot().error!);
        }
      }));
      connection.on('close', () => {
        clearTimeout(timeout); pendingTimers.delete(timeout);
        if (livePeers.get(connection.peer)?.connection === connection) {
          livePeers.delete(connection.peer);
          if (alive) broadcastPeers();
        }
      });
      connection.on('open', () => {
        clearTimeout(timeout); pendingTimers.delete(timeout);
        if (!alive) return;
        if (typeof connection.metadata?.session !== 'string') { connection.close(); return; }
        store.connect(connection, connection.metadata.session);
      });
      connection.on('error', () => { store.disconnect(); });
    };
    const setup = (current: Peer) => {
      current.on('open', () => { if (alive && !isHost) connectTo(HOST_ID); });
      current.on('connection', accept);
      current.on('error', error => {
        if (!alive || current !== peer) return;
        if (isHost && error.type === 'unavailable-id') {
          current.destroy(); isHost = false;
          peer = new Peer(options); setup(peer);
        } else setMessage('Connection unavailable.');
      });
    };
    peer = new Peer(HOST_ID, options); setup(peer);
    const retry = setInterval(() => {
      if (!alive || peer.destroyed) return;
      if (peer.disconnected) { peer.reconnect(); return; }
      if (!isHost && peer.open) connectTo(HOST_ID);
    }, 3000);
    setLink(ROOT_URL);
    QRCode.toDataURL(ROOT_URL, { width: 240, margin: 2 }).then(value => { if (alive) setQr(value); }).catch(() => { if (alive) setMessage('Share unavailable.'); });
    return () => {
      alive = false; clearInterval(retry); pendingTimers.forEach(clearTimeout); disconnectActions.current.clear(); unsubscribers.forEach(off => off());
      for (const store of stores.values()) {
        const items = store.getSnapshot().items;
        store.disconnect();
        for (const item of items) if (item.type === 'file') { URL.revokeObjectURL(item.url); if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }
      }
      stores.clear(); peer.destroy();
    };
  }, []);
  useEffect(() => {
    let alive = true, checking = false;
    const check = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      const busy = fileBusy.current || [...connections.current.values()].some(store => !!store.getSnapshot().sending || !!store.getSnapshot().receiving);
      const result = await checkVersion(busy);
      checking = false;
      if (alive && result) setMessage(result);
    };
    const timer = setInterval(() => { void check(); }, 30000);
    const resume = () => { void check(); };
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, []);
  useEffect(() => {
    if (!panel) return;
    function close(event: PointerEvent) { if (!panelRoot.current?.contains(event.target as Node)) setPanel(null); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setPanel(null); }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [panel]);
  useEffect(() => {
    const input = picker.current;
    const cancelled = () => setMessage('No file selected.');
    input?.addEventListener('cancel', cancelled);
    return () => input?.removeEventListener('cancel', cancelled);
  }, []);
  const stores = [...connections.current.entries()];
  const connected = stores.filter(([, store]) => store.getSnapshot().status === 'connected');
  const items = [...new Map(stores.flatMap(([, store]) => store.getSnapshot().items).map(item => [item.id, item])).values()].sort((a, b) => b.createdAt - a.createdAt);
  const grouped = new Map<string, FileTransfer>();
  for (const transfer of [...localFailures, ...stores.flatMap(([, store]) => store.getSnapshot().transfers)]) {
    const previous = grouped.get(transfer.id);
    if (!previous || (previous.phase !== 'failed' && (transfer.phase === 'failed' || !['sent', 'received'].includes(transfer.phase)))) grouped.set(transfer.id, transfer);
  }
  const recent = [...items.filter(item => item.type === 'text'), ...[...grouped.values()].filter(transfer => !['sent', 'received'].includes(transfer.phase) || items.some(item => item.id === transfer.id))].sort((a, b) => b.createdAt - a.createdAt);
  function recipients() {
    if (!connected.length) { setMessage('No connected devices.'); return []; }
    setMessage(''); return connected.map(([, store]) => store);
  }
  function fileFailure(file: File, reason: string) {
    setMessage(reason);
    setLocalFailures(items => [{ id: crypto.randomUUID(), name: file.name || 'screenshot.png', size: file.size, createdAt: Date.now(), direction: 'send', phase: 'failed', bytes: 0, error: reason }, ...items]);
  }
  async function files(list: File[]) {
    if (!list.length) { setMessage('No file selected.'); return; }
    const valid: File[] = [];
    for (const file of list) {
      try { validateSendFile(file); valid.push(file); }
      catch (error) { fileFailure(file, error instanceof Error ? error.message : 'Invalid file.'); }
    }
    if (!valid.length) return; // Every rejected file already has a visible failed card.
    if (fileBusy.current) { valid.forEach(file => fileFailure(file, 'Another file is sending.')); return; }
    const peers = [...connections.current.values()].filter(store => store.getSnapshot().status === 'connected');
    if (!peers.length) { valid.forEach(file => fileFailure(file, 'No connected devices.')); return; }
    fileBusy.current = true; setSending(true);
    try { for (const file of valid) {
      const id = crypto.randomUUID();
      const results = await Promise.allSettled(peers.map(store => store.sendFile(file, id)));
      for (const result of results) if (result.status === 'rejected') setMessage(result.reason instanceof Error ? result.reason.message : 'Transfer failed.');
    }
    } catch (error) { valid.forEach(file => fileFailure(file, error instanceof Error ? error.message : 'Transfer failed.')); }
    finally { fileBusy.current = false; setSending(false); }
  }
  function send() {
    if (sending || !text.trim()) return;
    const peers = recipients(); if (!peers.length) return;
    try { const id = crypto.randomUUID(); peers.forEach(store => store.sendText(text, id)); setText(''); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Transfer failed.'); }
  }
  async function copyImage(item: ReceivedItem) {
    if (item.type !== 'file' || !item.previewUrl) return;
    try {
      const source = item.previewUrl;
      const png = (async () => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error()), 'image/png'));
      return blob;
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch { setMessage('Copy image unavailable.'); }
  }
  return <main className="shell">
    <header><span className="brand">AEGIS DROP</span><div className="header-actions" ref={panelRoot}>
      <button aria-expanded={panel === 'devices'} onClick={() => setPanel(panel === 'devices' ? null : 'devices')}>Devices</button>
      <button aria-expanded={panel === 'share'} onClick={() => setPanel(panel === 'share' ? null : 'share')}>Share</button>
      {panel === 'share' && <div className="popover share" role="dialog" aria-label="Share">{qr && <img src={qr} alt="Connection QR code" />}<button disabled={!link} onClick={() => { void navigator.clipboard.writeText(link).catch(() => setMessage('Copy failed.')); }}>Copy link</button></div>}
      {panel === 'devices' && <div className="popover devices" role="dialog" aria-label="Connected devices"><h2>Connected devices</h2><div className="device"><span>● {local.current.label} <small>(This device)</small></span></div>{connected.map(([id, store]) => <div className="device" key={id}><span>● {store.getSnapshot().device?.label ?? 'Browser'}</span><button onClick={() => disconnectActions.current.get(id)?.()}>Disconnect</button></div>)}</div>}
    </div></header>
    <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void files(Array.from(event.dataTransfer.files)); }}>
      <textarea aria-label="Message" placeholder="Paste text, image or drop a file..." value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} onPaste={event => { const list = Array.from(event.clipboardData.files); if (list.length) { event.preventDefault(); void files(list); } }} />
      <button className="attach" aria-label="Choose files" onClick={() => {
        try { if (!picker.current) throw new Error(); picker.current.click(); }
        catch { setMessage('Could not open file picker.'); }
      }}>+</button>
      <input hidden ref={picker} type="file" multiple onChange={event => {
        try { void files(Array.from(event.target.files ?? [])); }
        catch { setMessage('Could not read file selection.'); }
        finally { event.target.value = ''; }
      }} />
    </div>
    <section className="items">{recent.map(entry => {
      if ('text' in entry) return <article key={entry.id}><pre>{entry.text}</pre><button onClick={() => { void navigator.clipboard.writeText(entry.text).catch(() => setMessage('Copy failed.')); }}>Copy</button></article>;
      const item = items.find(item => item.id === entry.id && item.type === 'file');
      const completed = entry.phase === 'sent' || entry.phase === 'received';
      const percent = entry.size ? Math.floor(entry.bytes / entry.size * 100) : completed || entry.phase === 'verifying' ? 100 : 0;
      const label = entry.phase === 'failed' ? `Failed — ${entry.error}` : completed ? `${entry.phase === 'sent' ? 'Sent' : 'Received'} ✓ · Verified ✓` : entry.phase === 'sending' || entry.phase === 'receiving' ? `${entry.phase === 'sending' ? 'Sending' : 'Receiving'} ${percent}%` : `${entry.phase === 'hashing' ? 'Hashing' : entry.phase === 'verifying' ? 'Verifying' : 'Preparing'}…`;
      return <article key={entry.id}>
        {completed && item?.type === 'file' && item.previewUrl && <img className="preview" src={item.previewUrl} alt={entry.name} />}
        <p>{entry.name} <small>{size(entry.size)}</small></p>
        <p className={entry.phase === 'failed' ? 'error' : 'progress'} role="status">{label}</p>
        {(entry.phase === 'sending' || entry.phase === 'receiving') && <progress aria-label={`${entry.name} transfer progress`} value={entry.bytes} max={entry.size || 1} />}
        {completed && item?.type === 'file' && <div className="item-actions">{item.previewUrl && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function' && <button onClick={() => { void copyImage(item); }}>Copy image</button>}<a href={item.url} download={item.name}>Save</a></div>}
      </article>;
    })}</section>
    {message && <p role="status" className="error">{message}</p>}
  </main>;
}
