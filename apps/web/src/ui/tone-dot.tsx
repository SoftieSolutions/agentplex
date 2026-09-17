import type { JSX } from 'react';
import { colorForTone, type Scheme, type Tone } from './tokens.js';

/**
 * The mockup's status dot: 7px, round, colored by tone and nothing else.
 *
 * It sits here rather than in either screen that draws it. The settings screen
 * and the pairing panel had a copy each, and the panel could not import the
 * screen's: the wizard draws the panel too, so that import would drag the whole
 * settings screen behind a first-run step for ten lines of markup. Beside
 * `colorForTone` is the one place both can reach, and it is where the dot
 * belongs anyway — it is that function plus a circle.
 */
export function ToneDot({ tone, scheme }: ToneDotProps): JSX.Element {
  return (
    <span
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

export interface ToneDotProps {
  readonly tone: Tone;
  readonly scheme: Scheme;
}
