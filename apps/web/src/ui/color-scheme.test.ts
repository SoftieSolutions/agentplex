import { describe, expect, it } from 'vitest';
import {
  COLOR_SCHEME_STORAGE_KEY,
  colorSchemeChoices,
  colorSchemeLabels,
  parseColorSchemeChoice,
  type ColorSchemeChoice,
} from './color-scheme.js';

/**
 * The choice as a value: what the word coming back from a control is allowed
 * to be, and what it is refused for. The hook and the storage are pinned
 * where they can be observed -- against a mounted provider, in
 * settings/color-scheme-control.test.tsx.
 */

describe('parseColorSchemeChoice', () => {
  it('accepts each of the three states the control carries', () => {
    for (const choice of colorSchemeChoices) {
      expect(parseColorSchemeChoice(choice)).toBe(choice);
    }
  });

  it('refuses a word that is not one of them rather than guessing', () => {
    for (const word of ['', 'auto', 'Dark', 'sepia', 'undefined']) {
      expect(parseColorSchemeChoice(word), word).toBeNull();
    }
  });
});

describe('the choices the control offers', () => {
  it('are the whole union, so a state cannot be added and left unreachable', () => {
    const offered: readonly ColorSchemeChoice[] = colorSchemeChoices;
    expect([...offered].sort()).toEqual(['dark', 'light', 'system']);
  });

  it('lead with dark, the scheme the app falls back to', () => {
    expect(colorSchemeChoices[0]).toBe('dark');
  });

  it('each have words to show', () => {
    for (const choice of colorSchemeChoices) {
      expect(colorSchemeLabels[choice], choice).not.toBe('');
    }
  });
});

describe('the storage key', () => {
  it('names this app rather than the component library behind the seam', () => {
    expect(COLOR_SCHEME_STORAGE_KEY).toBe('agentplex.colorScheme');
  });
});
