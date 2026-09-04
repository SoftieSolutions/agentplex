import { hues } from '../ui/tokens.js';

/** Where the manifest is served from, relative to the site root. */
export const MANIFEST_PATH = 'manifest.webmanifest';

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable';
}

export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  id: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
}

/**
 * Built here rather than committed as a static file so the manifest's colors
 * come from the tokens module instead of being repeated as literals. The vite
 * config serves this in dev and emits it into the build.
 */
export function buildWebManifest(): WebManifest {
  return {
    name: 'agentplex',
    short_name: 'agentplex',
    description: 'Watch and drive coding-agent sessions across machines',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: hues.char,
    theme_color: hues.char,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
