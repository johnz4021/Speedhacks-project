import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// HARNESS_SERVER_PORT points the dev proxy at another server (e.g. a sandbox on 4371); VITE_PORT moves the dev server.
const server = `http://localhost:${process.env.HARNESS_SERVER_PORT ?? 4310}`;
const port = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port,
    strictPort: true,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
