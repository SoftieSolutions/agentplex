import type { CSSProperties, JSX } from 'react';
import { needsYouWords } from '../sessions/attention-floor.js';
import { Box, UnstyledButton } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';

/**
 * The bell in the chrome: the attention floor, said in the one place that is
 * on screen at every address and in both forms of the shell.
 *
 * It is the same count the browser tab says (`attention-floor.ts`), and it is
 * deliberately not narrowed to the machine the selector picked. Both surfaces
 * are ambient -- neither is a screen, neither carries a selector -- and a bell
 * that quietly spoke for one machine would sit beside a title claiming a
 * different number, which is how an attention surface stops being believed.
 *
 * An anchor and not a button. The panel that lists what is asking is AGX-259;
 * until it lands the bell goes to the session list, whose first rows are
 * exactly what it is counting -- `partitionNeedsYou` puts them there. A bell
 * that swallowed the tap in the meantime would be worse than no bell, and a
 * disabled one worse still.
 *
 * The mark is a bare dot rather than a number, as the mockups draw it. The
 * number has two places already -- the tab title, and the panel when it exists
 * -- and neither is a 32px square where a two-digit count is a smudge. The
 * count is not lost: it is the bell's accessible name, and the live region
 * beside it is what reads a change out.
 */

/** The bell's box, matching the mockup's square control in the header. */
const SIDE = 32;

/**
 * Off screen, and still read out. `display: none` and `visibility: hidden` are
 * both dropped from the accessibility tree, which for a live region means it
 * announces nothing at all.
 */
const OFF_SCREEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface AttentionBellProps {
  /**
   * How many sessions are asking for a human, across the whole fleet:
   * `fleetAttentionCount`. Zero is drawn -- as a bell with no mark on it --
   * because a control that disappears when it is quiet is one nobody learns
   * the position of.
   */
  readonly count: number;
  readonly scheme: Scheme;
}

export function AttentionBell({ count, scheme }: AttentionBellProps): JSX.Element {
  return (
    <Box style={{ display: 'flex', position: 'relative' }}>
      <UnstyledButton
        component="a"
        data-attention-bell
        href={destinationHash('sessions')}
        aria-label={needsYouWords(count)}
        style={{
          position: 'relative',
          width: SIDE,
          height: SIDE,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 7,
          border: `1px solid ${colorForRole('border', scheme)}`,
          color: colorForRole('textSecondary', scheme),
        }}
      >
        <BellGlyph />
        {count === 0 ? null : <AttentionMark count={count} scheme={scheme} />}
      </UnstyledButton>
      {/* Mounted at every count, empty at zero: see the dot above for why the
          words are here rather than on the mark. */}
      <Box role="status" style={OFF_SCREEN}>
        {count === 0 ? '' : needsYouWords(count)}
      </Box>
    </Box>
  );
}

/**
 * The bell itself, drawn rather than imported.
 *
 * The app ships no icon set -- the action button is a `+` and the selector's
 * disclosure is one character -- and this is the one place that costs
 * something, because there is no character that reads as a notification bell
 * the way a drawn one does. Two strokes inline is cheaper than a dependency
 * that would then have to be used everywhere else for consistency, and it
 * inherits the colour of the control it sits in.
 */
function BellGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

interface AttentionMarkProps {
  readonly count: number;
  readonly scheme: Scheme;
}

/**
 * The dot on the bell's shoulder: the needs-you tone, ringed in the page's own
 * background so it stays a dot where it overlaps the glyph's stroke.
 *
 * `data-needs-you` carries the count it stands for. Nothing draws that number
 * -- the dot is bare -- but a test asking "the mark for two" should not have
 * to settle for "a mark".
 */
function AttentionMark({ count, scheme }: AttentionMarkProps): JSX.Element {
  return (
    <Box
      aria-hidden
      data-needs-you={count}
      style={{
        position: 'absolute',
        top: 4,
        right: 5,
        display: 'grid',
        padding: 2,
        borderRadius: '50%',
        pointerEvents: 'none',
        background: colorForRole('background', scheme),
      }}
    >
      <ToneDot tone="needs-you" scheme={scheme} />
    </Box>
  );
}
