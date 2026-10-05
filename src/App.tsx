import { useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent } from 'react';
import { MAX_FILE_BYTES } from './peer';
import type { ReceivedItem } from './peer';
import { peerStore, usePeer } from './store';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
function ItemCard({ item, announce }: { item: ReceivedItem; announce: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  return <article className="item-card">
    <div className="item-heading"><span className="item-kind">{item.type === 'text' ? 'TEXT' : item.previewUrl ? 'IMAGE' : 'FILE'}</span><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
    {item.type === 'text' ? <pre className="text-preview">{item.text}</pre> : <>
      {item.previewUrl && <a className="image-preview" href={item.url} download={item.name}><img src={item.previewUrl} alt={item.name} /></a>}
      <div className="file-info"><span className="file-symbol" aria-hidden="true">↧</span><div><p className="filename">{item.name}</p><p className="file-size">{formatSize(item.size)}</p></div></div>
    </>}
    <div className="item-actions">{item.type === 'text' ? <button onClick={async () => {
      try { await navigator.clipboard.writeText(item.text); setCopied(true); announce('Text copied.'); }
      catch { announce('Copy failed. Select the text and copy it manually.'); }
    }}>{copied ? 'Copy again' : 'Copy text'} ⧉</button> : <a href={item.url} download={item.name}>Download ↓</a>}
      <button className="delete" onClick={() => peerStore.remove(item.id)}>Remove</button>
    </div>
  </article>;
}
export default function App() {
  const peer = usePeer();
  const [joining, setJoining] = useState(false), [remote, setRemote] = useState('');
  const [text, setText] = useState(''), [message, setMessage] = useState(''), [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), picker = useRef<HTMLInputElement>(null);
  const connected = peer.status === 'connected', unavailable = !connected || !!peer.sending;
  const busy = peer.status === 'preparing';
  async function operation(action: () => Promise<void>) {
    setMessage(''); try { await action(); setRemote(''); } catch (error) { setMessage(error instanceof Error ? error.message : 'Connection failed.'); }
  }
  async function addFiles(files: File[]) {
    if (unavailable || !files.length) return;
    if (files.some(file => file.size > MAX_FILE_BYTES)) { setMessage('Files are limited to 32 MiB each.'); return; }
    try { for (const file of files) await peerStore.sendFile(file); setMessage('File transfer confirmed by the other device.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'File transfer failed.'); }
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (unavailable) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void addFiles(files); else setText(current => current + event.dataTransfer.getData('text/plain'));
  }
  function send(event: FormEvent) {
    event.preventDefault(); if (unavailable || !text.trim()) return;
    try { peerStore.sendText(text); setText(''); setMessage('Text sent directly.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Transfer failed.'); }
  }
  async function copySignal() {
    try { await navigator.clipboard.writeText(peer.signal); setMessage('Connection code copied.'); }
    catch { setMessage('Select the complete connection code and copy it manually.'); }
  }
  return <main className="shell">
    <header><a className="brand" href="./" aria-label="AEGIS Drop home"><span className="brand-mark" aria-hidden="true">↘</span> AEGIS <span>DROP</span></a><span className="local-badge">{connected && <i />}{connected ? 'Connected to device' : 'Direct transfer'}</span></header>
    <section className="intro"><p className="eyebrow">BROWSER TO BROWSER</p><h1>A little less friction.</h1><p>Text, screenshots, files. Send directly to your other device.</p></section>
    {!connected ? <section className="composer pairing" aria-label="Connect devices">
      {(peer.status === 'disconnected' || peer.status === 'failed') && <>
        <div className="connection-actions"><button className="send" disabled={busy} onClick={() => { setJoining(false); void operation(() => peerStore.create()); }}>Create connection</button><button className="attach" onClick={() => { setJoining(true); setRemote(''); setMessage(''); }}>Join connection</button></div>
        {joining && <form className="signal-form" onSubmit={event => { event.preventDefault(); void operation(() => peerStore.join(remote)); }}><label htmlFor="remote-offer">Paste the offer from the first device</label><textarea id="remote-offer" maxLength={131072} value={remote} onChange={event => setRemote(event.target.value)} /><button className="send" disabled={!remote.trim()}>Generate answer</button></form>}
      </>}
      {busy && <p className="loading" role="status">Preparing connection code…</p>}
      {peer.signal && <div className="signal-form">
        <label htmlFor="local-signal">{peer.role === 'create' ? '1. Copy this offer to the other device' : '2. Copy this answer back to the first device'}</label>
        <textarea id="local-signal" readOnly value={peer.signal} onFocus={event => event.currentTarget.select()} />
        <button className="refresh" onClick={() => { void copySignal(); }}>Copy {peer.role === 'create' ? 'offer' : 'answer'}</button>
      </div>}
      {peer.status === 'waiting-answer' && <form className="signal-form" onSubmit={event => { event.preventDefault(); void operation(() => peerStore.acceptAnswer(remote)); }}>
        <label htmlFor="remote-answer">3. Paste the answer from the other device</label><textarea id="remote-answer" maxLength={131072} value={remote} onChange={event => setRemote(event.target.value)} /><button className="send" disabled={!remote.trim()}>Connect</button>
      </form>}
      {peer.status === 'connecting' && <p className="loading" role="status">Connecting… After exchanging both codes, restrictive networks may still need TURN.</p>}
      {peer.role && <button className="logout" onClick={() => { peerStore.disconnect(); setJoining(false); setRemote(''); setMessage(''); }}>Cancel connection</button>}
      <p className="pairing-note">No sign-in or upload server. Exchange codes only with your other device. No TURN relay is configured.</p>
    </section> : <>
      <form className={`composer ${dragging ? 'dragging' : ''}`} onSubmit={send} onDragEnter={event => { event.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }} onDrop={drop}>
        <label className="sr-only" htmlFor="drop-text">Text to send</label><textarea disabled={unavailable} id="drop-text" placeholder="Type or paste something…" value={text} onChange={event => setText(event.target.value)} onPaste={paste} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-bottom"><div><button type="button" className="attach" disabled={unavailable} onClick={() => picker.current?.click()}>＋ Add files</button><span className="drop-hint">or drop them here</span></div><button className="send" type="submit" disabled={unavailable || !text.trim()}>Send text ↗</button></div>
        <input className="sr-only" ref={picker} tabIndex={-1} type="file" multiple disabled={unavailable} aria-label="Choose files" onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        {dragging && <div className="drop-overlay">Drop to send <span>Images and files welcome</span></div>}
      </form>
      <div className="composer-note"><span>Paste screenshots directly · Files up to 32 MiB</span><span className="keyboard-hint">⌘ / Ctrl + Enter to send</span></div>
      {[['Sending', peer.sending], ['Receiving', peer.receiving]].map(([label, progress]) => typeof progress === 'object' && progress && <p className="transfer-progress" key={String(label)} role="status">{String(label)} {progress.name}: {formatSize(progress.bytes)} / {formatSize(progress.total)}</p>)}
      <section className="recent" aria-labelledby="recent-title"><div className="section-heading"><h2 id="recent-title">Received <span>{peer.items.length} items</span></h2></div>
        {peer.items.length ? <div className="items">{peer.items.map(item => <ItemCard key={item.id} item={item} announce={setMessage} />)}</div> : <div className="empty"><span aria-hidden="true">↘</span><h3>Ready for your next thought.</h3><p>Send from the connected device to receive it here.</p></div>}
      </section>
    </>}
    <p className="status" role="status" aria-live="polite">{peer.error || message}</p>
    <footer><span>Received items stay only in this page session.</span>{connected && <button className="logout" onClick={() => { peerStore.disconnect(); setText(''); setMessage(''); }}>Disconnect</button>}</footer>
  </main>;
}
