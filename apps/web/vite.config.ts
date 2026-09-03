import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { MANIFEST_PATH, buildWebManifest } from './src/pwa/manifest.js';
import { hues } from './src/ui/tokens.js';

/**
 * Serves the web manifest in dev and emits it into the build, and injects the
 * head tags that reference it. The manifest and the theme-color meta are
 * produced from src/pwa/manifest.ts and src/ui/tokens.ts rather than written
 * into index.html, so the hues exist in the tokens file and nowhere else.
 */
function webManifest(): Plugin {
  const body = (): string => JSON.stringify(buildWebManifest(), null, 2);
  return {
    name: 'agentplex:web-manifest',
    configureServer(server) {
      server.middlewares.use(`/${MANIFEST_PATH}`, (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(body());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_PATH, source: body() });
    },
    transformIndexHtml() {
      return [
        { tag: 'meta', attrs: { name: 'theme-color', content: hues.midnight }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'manifest', href: `/${MANIFEST_PATH}` }, injectTo: 'head' },
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
          injectTo: 'head',
        },
      ];
    },
  };
}

/**
 * The PWA is served by the hub, so the build output is static and the dev
 * server proxies the hub rather than the other way round.
 */
export default defineConfig({
  plugins: [react(), webManifest()],
  build: { outDir: 'dist', sourcemap: true },
  server: { port: 5173 },
});
