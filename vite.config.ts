import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomUUID } from 'node:crypto';

export default defineConfig(({ command }) => {
  const version = command === 'build' ? randomUUID() : 'development';
  return {
    plugins: [react(), {
      name: 'aegis-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
      },
    }],
    define: { __APP_VERSION__: JSON.stringify(version) },
    base: '/aegis-drop/',
  };
});
