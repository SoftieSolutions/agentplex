import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { pinTestEnvironment } from '../../scripts/test-env.js';
import { MANIFEST_PATH, buildWebManifest } from './src/pwa/manifest.js';
import { shellStyles } from './src/pwa/shell-styles.js';
import { hues } from './src/ui/tokens.js';

/**
 * The timezone and locale every test run gets, pinned here because this file is
 * the only config a suite in this package loads.
 *
 * This package is excepted from `scripts/vitest.config.ts` -- it owns the React
 * plugin its component suites are transformed by -- and the argument for that
 * exception is about `$HOME`: a browser bundle starts no child process, so it
 * has no home to leak. Nothing in that carries over to here. A browser bundle
 * is where timestamps are actually rendered for a person to read, and a
 * component test asserting on a formatted time would pass in one timezone and
 * fail in the next. So the two halves of the shared config land differently:
 * the home redirect stays where it is needed, and the pins are called from
 * both. `scripts/test-env.ts` holds the values, so there is still one place
 * they are decided, and this is a second call site rather than a second answer.
 *
 * At module scope, because `TZ` is read by the engine when a worker starts
 * rather than looked up per `Date` -- `scripts/vitest.config.ts` carries what
 * was measured. Guarded, because this config is also what `vite build` and
 * `vite dev` load: a developer's dev server should render the times their
 * machine would, and only the test run wants them pinned. `VITEST` is set by
 * the vitest CLI in the process that loads this file, which is the same process
 * the pin has to happen in.
 */
if (process.env.VITEST) {
  pinTestEnvironment(process.env);
}

/**
 * Serves the web manifest in dev and emits it into the build, and composes the
 * head tags that go with it. The manifest, the theme-color meta and the one
 * rule the document itself carries are produced from src/pwa/ and
 * src/ui/tokens.ts rather than written into index.html, so each value exists
 * in a module beside its reason and nowhere else.
 *
 * The stylesheet is in the head rather than in the bundle because it is true
 * of the viewport before the bundle has parsed, and the first gesture at an
 * app that is still starting is exactly the one it is there for.
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
        { tag: 'style', children: shellStyles(), injectTo: 'head' },
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
  // `sourcemap: true` and not `'hidden'`: the map is emitted with its
  // `sourceMappingURL` comment so that a developer running the hub against this
  // build gets it associated automatically. It is 3437 KB against an 834 KB
  // bundle, so it is left out of the published package instead of out of the
  // build -- see `isClientSourceMap` in `scripts/assemble-package.ts`. Turning this
  // off, or to `'hidden'`, would take the map away from the one place it is
  // used to save nothing the packaging does not already save.
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
