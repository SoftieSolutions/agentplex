import { describe, expect, it } from 'vitest';
import { hues } from '../ui/tokens.js';
import { buildWebManifest } from './manifest.js';

describe('buildWebManifest', () => {
  const manifest = buildWebManifest();

  it('declares a standalone app rooted at /, which is what makes it installable', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/');
  });

  it('takes its colors from the tokens module, never from a literal of its own', () => {
    expect(manifest.theme_color).toBe(hues.char);
    expect(manifest.background_color).toBe(hues.char);
  });

  it('ships the icon set installability requires: 192, 512, and a maskable variant', () => {
    const sizes = manifest.icons.map((icon) => `${icon.purpose}:${icon.sizes}`);
    expect(sizes).toContain('any:192x192');
    expect(sizes).toContain('any:512x512');
    expect(sizes).toContain('maskable:512x512');
  });
});
