import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The server serves the built console and the API on the same origin. In dev, Vite proxies the
// API to a server on port 8787 (npm run server).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
