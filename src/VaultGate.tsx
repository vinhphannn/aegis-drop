import App from './App';
import { authStore, useAuth } from './auth';
import { useVault, vaultStore } from './vaultStore';

export default function VaultGate() {
  const vault = useVault(), auth = useAuth();
  if (vault.status === 'unlocked') return <>
    <div className="shell vault-toolbar">
      <div><strong>Local vault unlocked</strong><p>Cloud drops still use the existing unencrypted storage.</p></div>
      <button className="refresh" onClick={() => vaultStore.lock()}>Lock vault</button>
    </div>
    <App />
  </>;
  const waiting = vault.status === 'checking' || vault.status === 'unauthenticated';
  const empty = vault.status === 'empty', damaged = vault.status === 'damaged';
  return <main className="shell unlock-shell">
    <header><span className="brand"><span className="brand-mark" aria-hidden="true">↘</span> AEGIS <span>DROP</span></span>
      <button className="logout" disabled={auth.busy} onClick={() => { void authStore.logout(); }}>Sign out</button></header>
    <section className="intro"><p className="eyebrow">LOCAL VAULT</p>
      <h1>{waiting ? 'Checking this browser…' : empty ? 'Create your local vault.' : damaged ? 'Device enrollment damaged.' : vault.status === 'unavailable' ? 'Local storage unavailable.' : 'Your vault is locked.'}</h1>
      <p>{empty ? 'Create vault keys for this browser. Pairing and recovery setup are not available here yet.' : damaged ? 'The saved enrollment cannot be validated. It has not been replaced.' : 'Your session is authenticated. Vault keys are kept separately on this browser.'}</p>
    </section>
    {waiting ? <p className="loading" role="status">Checking enrollment…</p> : <section className="composer unlock-form">
      {empty ? <button className="send" disabled={vault.busy} onClick={() => { void vaultStore.bootstrap(); }}>{vault.busy ? 'Creating…' : 'Create local vault'}</button>
        : vault.status === 'locked' ? <button className="send" disabled={vault.busy} onClick={() => { void vaultStore.unlock(); }}>{vault.busy ? 'Unlocking…' : 'Unlock local vault'}</button>
        : <button className="refresh" disabled={vault.busy} onClick={() => { void vaultStore.check(); }}>Check again</button>}
      <p className="vault-note">This step does not encrypt existing cloud text or files.</p>
    </section>}
    <p className="status" role="status">{vault.error || auth.error}</p>
  </main>;
}
