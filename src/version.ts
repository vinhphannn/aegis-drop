declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development';

export function needsUpdate(current: string, deployed: unknown): deployed is string {
  return typeof deployed === 'string' && deployed.length > 0 && deployed.length < 128 && deployed !== current;
}

export async function checkVersion(busy = false): Promise<string | null> {
  if (APP_VERSION === 'development') return null;
  try {
    const url = new URL('version.json', new URL('/aegis-drop/', location.origin));
    url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Version check unavailable');
    const { version } = await response.json();
    if (!needsUpdate(APP_VERSION, version)) return null;
    if (busy) return 'Update available. Waiting for file transfer to finish.';
    const key = 'aegis-update-attempt';
    if (sessionStorage.getItem(key) === version) return 'Update not loaded yet. Reload this page.';
    sessionStorage.setItem(key, version);
    const next = new URL(location.href);
    next.searchParams.set('_aegis_version', version);
    location.replace(next.href);
    return 'Updating…';
  } catch (error) {
    console.warn('App version check unavailable', error instanceof Error ? error.message : 'Network error');
    return null;
  }
}

export function clearUpdateMarker() {
  const url = new URL(location.href);
  if (url.searchParams.has('_aegis_version')) {
    url.searchParams.delete('_aegis_version');
    history.replaceState(null, '', url.href);
  }
  if (sessionStorage.getItem('aegis-update-attempt') === APP_VERSION) sessionStorage.removeItem('aegis-update-attempt');
}
