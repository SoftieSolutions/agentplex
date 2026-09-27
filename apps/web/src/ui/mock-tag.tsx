import type { JSX } from 'react';
import { colorForRole, type Scheme } from './tokens.js';

/**
 * The chip worn by anything drawn from sample data rather than from the hub:
 * the word "Mock", in the mockups' small-caps label face (Fira Code 600 at
 * 9px, tracked .08em, as the graph node kinds are set in mock 6d) on a filled
 * chip of its own.
 *
 * Its hues are the mock tag's own roles, never a status tone, so a sample row
 * wearing it cannot be read as running, blocked or paused. And it is not
 * `aria-hidden`, unlike the tone dot: the dot repeats words that sit beside
 * it, while this tag is the only thing on the screen saying the value next to
 * it was invented. A screen reader has to hear that as much as an eye has to
 * see it, so it is a labelled note.
 *
 * It sits here beside the tone dot rather than in the mock folder because
 * every feature that draws sample data draws this, and `ui/` is the one place
 * all of them already import from.
 */
export function MockTag({ scheme }: MockTagProps): JSX.Element {
  return (
    <span
      role="note"
      aria-label="mock data"
      // Presence is the fact: a test or a screenshot check asks for the
      // attribute rather than matching on the word.
      data-mock-tag=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        marginLeft: 6,
        padding: '1px 5px',
        borderRadius: 4,
        background: colorForRole('mockTag', scheme),
        color: colorForRole('onMockTag', scheme),
        fontFamily: 'var(--mantine-font-family-monospace)',
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 'normal',
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      Mock
    </span>
  );
}

export interface MockTagProps {
  readonly scheme: Scheme;
}
