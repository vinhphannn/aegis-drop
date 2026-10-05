import { useEffect, useRef, useState } from 'react';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import QRCode from 'qrcode';
import { DirectPeer } from './peer';
import type { ReceivedItem } from './peer';

const ROOT_URL = 'https://vinhphannn.github.io/aegis-drop/';
const HOST_ID = 'aegis-drop-vinhphannn-personal-v1';

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
    const livePeers = new Map<string, { connection: DataConnection; store: DirectPeer }>();
    const connectTo = (id: string) => {
      if (!alive || id === peer.id || livePeers.has(id)) return;
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
      livePeers.set(connection.peer, { connection, store });
      stores.set(connection.connectionId, store);
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
        }
      }));
      connection.on('close', () => {
        if (livePeers.get(connection.peer)?.connection === connection) {
          livePeers.delete(connection.peer);
          if (alive) broadcastPeers();
        }
      });
      connection.on('open', () => {
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
    setLink(ROOT_URL);
    QRCode.toDataURL(ROOT_URL, { width: 240, margin: 2 }).then(value => { if (alive) setQr(value); }).catch(() => { if (alive) setMessage('Share unavailable.'); });
    return () => {
      alive = false; unsubscribers.forEach(off => off());
      for (const store of stores.values()) {
        const items = store.getSnapshot().items;
        store.disconnect();
        for (const item of items) if (item.type === 'file') { URL.revokeObjectURL(item.url); if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }
      }
      stores.clear(); peer.destroy();
    };
  }, []);
  useEffect(() => {
    if (!panel) return;
    function close(event: PointerEvent) { if (!panelRoot.current?.contains(event.target as Node)) setPanel(null); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setPanel(null); }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [panel]);
  const stores = [...connections.current.entries()];
  const connected = stores.filter(([, store]) => store.getSnapshot().status === 'connected');
  const items = [...new Map(stores.flatMap(([, store]) => store.getSnapshot().items).map(item => [item.id, item])).values()].sort((a, b) => b.createdAt - a.createdAt);
  function recipients() {
    if (!connected.length) { setMessage('No connected devices.'); return []; }
    setMessage(''); return connected.map(([, store]) => store);
  }
  async function files(list: File[]) {
    if (sending || !list.length) return;
    const peers = recipients(); if (!peers.length) return;
    setSending(true);
    try { for (const file of list) { const id = crypto.randomUUID(); await Promise.all(peers.map(store => store.sendFile(file, id))); } }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Transfer failed.'); }
    finally { setSending(false); }
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
      {panel === 'devices' && <div className="popover devices" role="dialog" aria-label="Connected devices"><h2>Connected devices</h2><div className="device"><span>● {local.current.label} <small>(This device)</small></span></div>{connected.map(([id, store]) => <div className="device" key={id}><span>● {store.getSnapshot().device?.label ?? 'Browser'}</span><button onClick={() => store.disconnect()}>Disconnect</button></div>)}</div>}
    </div></header>
    <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void files(Array.from(event.dataTransfer.files)); }}>
      <textarea aria-label="Message" placeholder="Paste text, image or drop a file..." value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} onPaste={event => { const list = Array.from(event.clipboardData.files); if (list.length) { event.preventDefault(); void files(list); } }} />
      <button className="attach" aria-label="Choose files" disabled={sending} onClick={() => picker.current?.click()}>+</button>
      <input hidden ref={picker} type="file" multiple onChange={event => { void files(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div>
    {stores.flatMap(([id, store]) => [store.getSnapshot().sending, store.getSnapshot().receiving].map((progress, index) => progress && <p className="progress" key={`${id}-${index}`}>{progress.name} · {progress.total ? Math.round(progress.bytes / progress.total * 100) : 100}%</p>))}
    <section className="items">{items.map(item => <article key={item.id}>{item.type === 'text' ? <><pre>{item.text}</pre><button onClick={() => { void navigator.clipboard.writeText(item.text).catch(() => setMessage('Copy failed.')); }}>Copy</button></> : <>
      {item.previewUrl && <img className="preview" src={item.previewUrl} alt={item.name} />}
      <p>{item.name} <small>{size(item.size)}</small></p><div className="item-actions">{item.previewUrl && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function' && <button onClick={() => { void copyImage(item); }}>Copy image</button>}<a href={item.url} download={item.name}>Save</a></div>
    </>}</article>)}</section>
    {message && <p role="status" className="error">{message}</p>}
  </main>;
}
