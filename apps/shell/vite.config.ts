import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = 'http://localhost:4310';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
