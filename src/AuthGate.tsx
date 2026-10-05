import { useEffect, useState } from 'react';
import VaultGate from './VaultGate';
import { authStore, useAuth } from './auth';
import { itemStore } from './store';

export default function AuthGate() {
  const { status, busy, error } = useAuth();
  const [accessKey, setAccessKey] = useState('');
  useEffect(() => { void authStore.check(); }, []);
  useEffect(() => {
    if (status !== 'ready') itemStore.reset();
    setAccessKey('');
  }, [status]);
  if (status === 'ready') return <VaultGate />;
  return <main className="shell unlock-shell">
    <header><span className="brand"><span className="brand-mark" aria-hidden="true">↘</span> AEGIS <span>DROP</span></span></header>
    <section className="intro"><p className="eyebrow">YOUR PRIVATE DROP SPACE</p><h1>Keep it close.</h1><p>Unlock this device with your access key.</p></section>
    {status === 'checking' ? <p className="loading" role="status">Checking session…</p> : <form className="composer unlock-form" onSubmit={async event => {
      event.preventDefault();
      try { await authStore.login(accessKey); setAccessKey(''); } catch { /* Show the auth error; allow correction. */ }
    }}>
      <label htmlFor="access-key">Access key</label>
      <input id="access-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1024} value={accessKey} disabled={busy} onChange={event => setAccessKey(event.target.value)} />
      <button className="send" disabled={busy || !accessKey}>{busy ? 'Unlocking…' : 'Unlock'}</button>
    </form>}
    <p className="status" role="status">{error}</p>
  </main>;
}
