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
        { tag: 'meta', attrs: { name: 'theme-color', content: hues.char }, injectTo: 'head' },
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
 * Where a `pnpm dev` server sends the requests it does not serve itself.
 *
 * The hub's default port on the loopback, because the ordinary way to develop
 * against one is to run `--role=both` beside this. It is a constant rather than
 * a setting: what this reproduces is the deployed arrangement, where the app
 * and the hub are one origin, and a knob here would be a way to develop against
 * an arrangement that does not exist in production.
 */
const DEV_HUB = 'http://127.0.0.1:8080';

/**
 * The PWA is served by the hub, so the build output is static and the dev
 * server proxies the hub rather than the other way round.
 *
 * The proxy is what makes that sentence true in dev. The app reads its own
 * `window.location` to reach the hub — one origin for the shell, the ticket
 * exchange, the client socket and, later, MCP — so a dev server that served
 * only the app would leave those three routes pointing at itself.
 */
export default defineConfig({
  plugins: [react(), webManifest()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      // `/client` and `/client/ticket` both, since a proxy key is a prefix.
      // `ws` is not optional: the client socket is the application, and a
      // proxy that answers an upgrade with a 200 looks exactly like a hub that
      // accepts connections and then says nothing.
      '/client': { target: DEV_HUB, ws: true },
      '/health': { target: DEV_HUB },
    },
  },
});
