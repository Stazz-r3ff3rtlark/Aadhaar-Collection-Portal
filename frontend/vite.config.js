import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, Vite forwards /api to the local backend, mirroring nginx in production,
// so the frontend always calls the relative path /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // API_PROXY_TARGET lets a second copy run beside your usual one (e.g. for testing).
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:17101',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
  },
});
