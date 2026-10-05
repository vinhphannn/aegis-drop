import { useEffect, useRef, useState } from 'react';
import { preview } from './peer';
import type { FileTransfer } from './peer';
import type { HistoryItem } from './history';
import { HistoryStore } from './history';
import ItemTime from './ItemTime';

export function formatSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
export default function FileCard({ item, transfer, history, error }: { item?: Extract<HistoryItem, { type: 'file' }>; transfer?: FileTransfer; history: HistoryStore; error: (message: string) => void }) {
  const root = useRef<HTMLElement>(null), urls = useRef(new Set<string>());
  const [imageUrl, setImageUrl] = useState('');
  useEffect(() => {
    let alive = true, previewUrl = '';
    const currentUrls = urls.current;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || !item || !['image/png', 'image/jpeg'].includes(item.mimeType) || item.size > 2 * 1024 * 1024) return;
      observer.disconnect();
      void history.blob(item.id).then(blob => preview(blob, item.mimeType)).then(url => {
        if (!url) return;
        if (!alive) { URL.revokeObjectURL(url); return; }
        previewUrl = url; setImageUrl(url);
      }).catch(() => error('Image preview unavailable.'));
    });
    if (root.current) observer.observe(root.current);
    return () => { alive = false; observer.disconnect(); if (previewUrl) URL.revokeObjectURL(previewUrl); currentUrls.forEach(URL.revokeObjectURL); currentUrls.clear(); };
  }, [item?.id, history]);
  const name = item?.name ?? transfer!.name, size = item?.size ?? transfer!.size;
  const phase = transfer?.phase;
  const percent = size ? Math.floor((transfer?.bytes ?? size) / size * 100) : phase === 'verifying' ? 100 : 0;
  const label = phase === 'failed' ? `Failed — ${transfer?.error}` : phase === 'sending' || phase === 'receiving' ? `${phase === 'sending' ? 'Sending' : 'Receiving'} ${percent}%` : phase === 'preparing' || phase === 'hashing' || phase === 'verifying' ? `${phase === 'hashing' ? 'Hashing' : phase === 'verifying' ? 'Verifying' : 'Preparing'}…` : item ? 'Verified ✓' : 'Saved locally';
  async function save() {
    if (!item) return;
    try {
      const blob = await history.blob(item.id);
      const url = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream')); urls.current.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 60000);
    } catch { error('Stored file unavailable.'); }
  }
  async function copyImage() {
    try {
      const png = (async () => {
        const image = new Image(); image.src = imageUrl; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error()), 'image/png'));
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch { error('Copy image unavailable.'); }
  }
  return <article ref={root}>
    <ItemTime createdAt={item?.createdAt ?? transfer!.createdAt} />
    {imageUrl && <img className="preview" src={imageUrl} alt={name} />}
    <p>{name} <small>{formatSize(size)}</small></p><p className={phase === 'failed' ? 'error' : 'progress'} role="status">{label}</p>
    {(phase === 'sending' || phase === 'receiving') && <progress aria-label={`${name} transfer progress`} value={transfer!.bytes} max={size || 1} />}
    {item && <div className="item-actions">{imageUrl && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function' && <button onClick={() => { void copyImage(); }}>Copy image</button>}<button onClick={() => { void save(); }}>Save</button></div>}
  </article>;
}
