import type { JSX } from 'react';
import { Text } from './components.js';
import { colorForRole, type Scheme } from './tokens.js';

/**
 * A chord drawn beside the control it belongs to, as text and nothing more.
 *
 * It sits here rather than in either chrome that draws one. The New menu's rows
 * had the first copy and the palette's trigger would have been the second, and
 * the two have to agree about more than a font: what a hint claims is an
 * accessibility decision, and a second copy is where the two drift apart.
 *
 * `aria-hidden` and never `aria-keyshortcuts`. Nothing in the app listens for
 * these chords yet -- there is no chrome-level registry, and AGX-260 is where
 * one is decided -- so the one attribute that would make a screen reader offer
 * a hint as a way to work the app is the one attribute this must not have.
 * Announcing a shortcut that answers nothing is the over-claim the degrade rule
 * is about, and the visual hint costs a sighted person nothing when it turns
 * out to be decoration, because the control beside it is what works.
 *
 * `bound` is carried as an attribute rather than assumed: the day a chord is
 * really bound, every hint drawn through here has to be looked at again, and a
 * hard-coded "false" in the markup is a fact nobody would be made to revisit.
 */
export function ShortcutHint({ text, bound, scheme }: ShortcutHintProps): JSX.Element {
  return (
    <Text
      component="span"
      aria-hidden
      data-shortcut-hint
      data-bound={String(bound)}
      ff="monospace"
      fz={10}
      fw={500}
      c={colorForRole('textMuted', scheme)}
    >
      {text}
    </Text>
  );
}

export interface ShortcutHintProps {
  /** The chord as a person reads it, in the mockup's own glyphs. */
  readonly text: string;
  /** Whether anything listens for it. False today, everywhere this is drawn. */
  readonly bound: boolean;
  readonly scheme: Scheme;
}
