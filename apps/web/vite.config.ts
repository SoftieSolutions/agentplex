import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The PWA is served by the hub, so the build output is static and the dev
 * server proxies the hub rather than the other way round. The manifest, the
 * service worker and the real application arrive in milestone 4.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: { port: 5173 },
});
