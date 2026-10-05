import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:8787';
export default defineConfig({ plugins: [react()], server: { proxy: { '/api': {
  target: backend,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      // The dev reverse proxy translates only its own same-origin requests.
      // Keep foreign Origin values intact so Worker origin checks still reject them.
      if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader('Origin', backend);
    });
  },
} } } });
