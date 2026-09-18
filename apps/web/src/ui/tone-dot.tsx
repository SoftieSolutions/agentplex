import type { JSX } from 'react';
import { colorForTone, type Scheme, type Tone } from './tokens.js';

/**
 * The mockup's status dot: 7px, round, colored by tone and nothing else.
 *
 * Here rather than beside one of its callers because there are three now --
 * the settings screen's hub line, its server and provider rows, and the
 * connection line in the chrome -- and a dot drawn a pixel larger on one screen
 * than another is the kind of drift a shared atom exists to prevent. It lives
 * in `src/ui/` for the reason the tokens do: it is the visual vocabulary, not a
 * feature.
 *
 * Marked `aria-hidden`: the tone is a second rendering of words that are always
 * beside it, and a screen reader announcing an unlabelled dot before them adds
 * nothing. Every caller says in words what the dot says in colour, which is the
 * rule that makes hiding it safe.
 */
export interface ToneDotProps {
  readonly tone: Tone;
  readonly scheme: Scheme;
}

export function ToneDot({ tone, scheme }: ToneDotProps): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: colorForTone(tone, scheme),
        flex: 'none',
      }}
    />
  );
}
