import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import QRCode from 'qrcode';
import { checkVersion } from './version';
import { DirectPeer, validateSendFile } from './peer';
import type { FileTransfer } from './peer';
import { HistoryStore } from './history';
import { HistorySync } from './sync';
import FileCard from './FileCard';

const history = new HistoryStore();

const ROOT_URL = 'https://vinhphannn.github.io/aegis-drop/';
const HOST_ID = 'aegis-drop-vinhphannn-personal-protocol-3';

function deviceLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${device} ${browser}`;
}


export default function App() {
  const [qr, setQr] = useState(''), [link, setLink] = useState(''), [text, setText] = useState(''), [message, setMessage] = useState('');
  const items = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const [syncStatus, setSyncStatus] = useState('');
  const [panel, setPanel] = useState<'share' | 'devices' | null>(null);
  const [dragging, setDragging] = useState(false), [sending, setSending] = useState(false);
  const [, refresh] = useState(0);
  const [localFailures, setLocalFailures] = useState<FileTransfer[]>([]);
  const fileBusy = useRef(false);
  const disconnectActions = useRef(new Map<string, () => void>());
  const connections = useRef(new Map<string, DirectPeer>());
  const picker = useRef<HTMLInputElement>(null), panelRoot = useRef<HTMLDivElement>(null);
  const local = useRef<{ id: string; label: string }>({ id: crypto.randomUUID(), label: deviceLabel() });
  useEffect(() => {
    let alive = true;
    const stores = connections.current;
    const sync = new HistorySync(history, value => { if (alive) setSyncStatus(value); }, value => { if (alive) setMessage(value); });
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
      sync.attach(store);
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
        sync.detach(store);
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
    void history.ready.then(() => {
      if (!alive) return;
      local.current.id = history.deviceId;
      peer = new Peer(HOST_ID, options); setup(peer);
    }).catch(() => { if (alive) setMessage('Local history unavailable. Check browser storage.'); });
    const retry = setInterval(() => {
      if (!alive || !peer || peer.destroyed) return;
      if (peer.disconnected) { peer.reconnect(); return; }
      if (!isHost && peer.open) connectTo(HOST_ID);
    }, 3000);
    setLink(ROOT_URL);
    QRCode.toDataURL(ROOT_URL, { width: 240, margin: 2 }).then(value => { if (alive) setQr(value); }).catch(() => { if (alive) setMessage('Share unavailable.'); });
    return () => {
      alive = false; sync.dispose(); clearInterval(retry); pendingTimers.forEach(clearTimeout); disconnectActions.current.clear(); unsubscribers.forEach(off => off());
      for (const store of stores.values()) {
        const items = store.getSnapshot().items;
        store.disconnect();
        for (const item of items) if (item.type === 'file') { URL.revokeObjectURL(item.url); if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }
      }
      stores.clear(); peer?.destroy();
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
    const resume = () => { void check(); void history.ready.then(() => history.refresh()).catch(() => { if (alive) setMessage('Could not load local history.'); }); };
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

  const grouped = new Map<string, FileTransfer>();
  for (const transfer of [...localFailures, ...stores.flatMap(([, store]) => store.getSnapshot().transfers)]) {
    const previous = grouped.get(transfer.id);
    if (!previous || (previous.phase !== 'failed' && (transfer.phase === 'failed' || !['sent', 'received'].includes(transfer.phase)))) grouped.set(transfer.id, transfer);
  }
  const visibleIds = new Set(items.map(item => item.id));
  const recent = [...items, ...[...grouped.values()].filter(transfer => !visibleIds.has(transfer.id) && !['sent', 'received'].includes(transfer.phase))].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  useEffect(() => {
    if (!syncStatus) return;
    if (syncStatus === 'Synced') { const timer = setTimeout(() => setSyncStatus(''), 2000); return () => clearTimeout(timer); }
  }, [syncStatus]);
  function fileFailure(file: File, reason: string) {
    setMessage(reason);
    setLocalFailures(items => [{ id: crypto.randomUUID(), name: file.name || 'screenshot.png', size: file.size, createdAt: Date.now(), direction: 'send', phase: 'failed', bytes: 0, error: reason }, ...items.slice(0, 49)]);
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
    fileBusy.current = true; setSending(true); setMessage('');
    try { for (const file of valid) {
      const id = crypto.randomUUID();
      setLocalFailures(items => [{ id, name: file.name || 'screenshot.png', size: file.size, createdAt: Date.now(), direction: 'send', phase: 'hashing', bytes: 0 }, ...items.slice(0, 49)]);
      try { await history.createFile(file); setLocalFailures(items => items.filter(item => item.id !== id)); }
      catch (error) { setLocalFailures(items => items.filter(item => item.id !== id)); fileFailure(file, error instanceof Error ? error.message : 'Could not save file.'); }
    } } finally { fileBusy.current = false; setSending(false); }
  }
  async function send() {
    if (sending || !text.trim()) return;
    try { await history.createText(text); setText(''); setMessage(''); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save text.'); }
  }
  return <main className="shell">
    <header><span className="brand">AEGIS DROP</span><div className="header-actions" ref={panelRoot}>
      <button aria-expanded={panel === 'devices'} onClick={() => setPanel(panel === 'devices' ? null : 'devices')}>Devices</button>
      <button aria-expanded={panel === 'share'} onClick={() => setPanel(panel === 'share' ? null : 'share')}>Share</button>
      {panel === 'share' && <div className="popover share" role="dialog" aria-label="Share">{qr && <img src={qr} alt="Connection QR code" />}<button disabled={!link} onClick={() => { void navigator.clipboard.writeText(link).catch(() => setMessage('Copy failed.')); }}>Copy link</button></div>}
      {panel === 'devices' && <div className="popover devices" role="dialog" aria-label="Connected devices"><h2>Connected devices</h2><div className="device"><span>● {local.current.label} <small>(This device)</small></span></div>{connected.map(([id, store]) => <div className="device" key={id}><span>● {store.getSnapshot().device?.label ?? 'Browser'}</span><button onClick={() => disconnectActions.current.get(id)?.()}>Disconnect</button></div>)}</div>}
    </div></header>
    <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void files(Array.from(event.dataTransfer.files)); }}>
      <textarea aria-label="Message" placeholder="Paste text, image or drop a file..." value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} onPaste={event => { const list = Array.from(event.clipboardData.files); if (list.length) { event.preventDefault(); void files(list); } }} />
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
    {syncStatus && <p className="progress" role="status">{syncStatus}</p>}
    <section className="items">{recent.map(entry => {
      if ('type' in entry && entry.type === 'text') return <article key={entry.id}><pre>{entry.text}</pre><button onClick={() => { void navigator.clipboard.writeText(entry.text).catch(() => setMessage('Copy failed.')); }}>Copy</button></article>;
      const item = 'type' in entry && entry.type === 'file' ? entry : undefined;
      const transfer = grouped.get(entry.id);
      return <FileCard key={entry.id} item={item} transfer={transfer ?? (!('type' in entry) ? entry : undefined)} history={history} error={setMessage} />;
    })}</section>
    {message && <p role="status" className="error">{message}</p>}
  </main>;
}
