import { authStore, useAuth } from './auth';
import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent } from 'react';
import { itemStore, MAX_FILE_SIZE, useItems } from './store';
import type { DropItem } from './store';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 'KB' : bytes < 1024 ** 3 ? 'MB' : 'GB';
  const divisor = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

function ItemCard({ item, announce, busy }: { item: DropItem; announce: (message: string) => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (item.type !== 'text') return;
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      announce('Text copied to clipboard.');
    } catch {
      announce('Copy failed. Select the text and copy it manually. Clipboard access requires HTTPS or localhost.');
    }
  }
  const image = item.type === 'file' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(item.mimeType);
  return (
    <article className="item-card">
      <div className="item-heading">
        <span className="item-kind">{item.type === 'text' ? 'TEXT' : image ? 'IMAGE' : 'FILE'}</span>
        <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      {item.type === 'text' ? <pre className="text-preview">{item.text}</pre> : <>
        {image && <a className="image-preview" href={item.url} download={item.name} aria-label={`Download ${item.name}`}><img src={item.url} alt={item.name} /></a>}
        <div className="file-info"><span className="file-symbol" aria-hidden="true">{image ? '▧' : '↧'}</span><div><p className="filename">{item.name}</p><p className="file-size">{formatSize(item.size)}</p></div></div>
      </>}
      <div className="item-actions">
        {item.type === 'text' ? <button onClick={copy}>{copied ? 'Copy again' : 'Copy text'} <span aria-hidden="true">⧉</span></button> : <a href={item.url} download={item.name}>Download <span aria-hidden="true">↓</span></a>}
        <button className="delete" disabled={busy} aria-label={`Delete ${item.type === 'text' ? 'text item' : item.name}`} onClick={async () => { try { await itemStore.remove(item.id); announce('Item deleted.'); } catch { /* Store displays request errors. */ } }}>Delete</button>
      </div>
    </article>
  );
}

export default function App() {
  const { items, nextCursor, loading, loadingOlder, busy, error } = useItems();
  const auth = useAuth();
  const unavailable = loading || loadingOlder || busy || auth.busy;
  useEffect(() => { void itemStore.load(); }, []);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  async function addFiles(files: File[]) {
    if (!files.length) return;
    if (unavailable) return;
    if (files.some(file => file.size > MAX_FILE_SIZE)) { setMessage('Files are limited to 100 MiB each.'); return; }
    try { await itemStore.addFiles(files); } catch { return; }
    setMessage(`${files.length === 1 ? 'File' : `${files.length} files`} added.`);
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); addFiles(files); }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (unavailable) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) addFiles(files);
    else {
      const droppedText = event.dataTransfer.getData('text/plain');
      if (droppedText) setText(current => current + droppedText);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    if (unavailable) return;
    try { await itemStore.addText(text); setText(''); setMessage('Text added.'); } catch { /* Keep unsent text. */ }
  }
  return (
    <main className="shell">
      <header><a className="brand" href="./" aria-label="AEGIS Drop home"><span className="brand-mark" aria-hidden="true">↘</span> AEGIS <span>DROP</span></a><span className="local-badge"><i /> Cloud storage</span></header>
      <section className="intro"><p className="eyebrow">YOUR EVERYDAY DROP SPACE</p><h1>A little less friction.</h1><p>Text, images, files. Drop it here, keep it handy.</p></section>
      <form className={`composer ${dragging ? 'dragging' : ''}`} onSubmit={send} onDragEnter={event => { event.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }} onDrop={drop}>
        <label className="sr-only" htmlFor="drop-text">Text to share</label>
        <textarea disabled={unavailable} id="drop-text" placeholder="Type or paste something…" value={text} onChange={event => setText(event.target.value)} onPaste={paste} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-bottom"><div><button type="button" className="attach" disabled={unavailable} onClick={() => picker.current?.click()}><span aria-hidden="true">＋</span> Add files</button><span className="drop-hint">or drop them anywhere in this box</span></div><button className="send" type="submit" disabled={unavailable || !text.trim()}>Send text <span aria-hidden="true">↗</span></button></div>
        <input className="sr-only" ref={picker} tabIndex={-1} type="file" multiple disabled={unavailable} aria-label="Choose files" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        {dragging && <div className="drop-overlay">Drop to add <span>Images and files welcome</span></div>}
      </form>
      <div className="composer-note"><span>Paste screenshots directly into the text box.</span><span className="keyboard-hint">⌘ / Ctrl + Enter to send</span></div>
      <section className="recent" aria-labelledby="recent-title"><div className="section-heading"><h2 id="recent-title">Recent drops <span>{items.length} loaded</span></h2><button className="refresh" disabled={unavailable} onClick={() => { setMessage(''); void itemStore.load(); }}>Refresh ↻</button></div>
        {loading ? <p className="loading">Loading drops…</p> : items.length ? <div className="items">{items.map(item => <ItemCard key={item.id} item={item} announce={setMessage} busy={unavailable} />)}</div> : <div className="empty"><span aria-hidden="true">↘</span><h3>Room for your next thought.</h3><p>Send some text or add a file to get started.</p></div>}
        {nextCursor && <button className="load-older" disabled={unavailable} onClick={() => { void itemStore.loadOlder(); }}>{loadingOlder ? 'Loading older…' : 'Load older'}</button>}
      </section>
      <p className="status" role="status" aria-live="polite">{auth.error || error || (busy ? 'Saving…' : message)}</p>
      <footer><span>Kept until you delete it.</span><span>Stored in the cloud · <button className="logout" disabled={unavailable} onClick={() => { void authStore.logout(); }}>Sign out</button></span></footer>
    </main>
  );
}
