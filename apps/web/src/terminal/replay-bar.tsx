import type { JSX } from 'react';

import { Button, Group, Slider, Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { stepBack, stepForward } from './replay-model.js';

/**
 * The scrubber above a transcript in replay: a slider over the steps, a
 * button either side of it, an Exit, and a sentence about where it stands.
 *
 * It draws props and holds nothing. The position is the pane's -- it is what
 * a refresh has to re-clamp, and the pane is where the count lives -- so every
 * control here reports a new position or a leave and lets the pane decide.
 * Given the resolved position rather than the request, the buttons can say
 * which end they are at without clamping a second time.
 *
 * The sentence is `role="status"` and always mounted while the bar is, for the
 * reason the transcript's own status line is: a region that exists when the
 * words land is one a screen reader announces.
 */

export interface ReplayBarProps {
  /** The resolved step, already inside `[0, count - 1]`. */
  readonly position: number;
  /** How many steps there are; at least one, or the pane draws no bar. */
  readonly count: number;
  /** Which step of how many, in the model's words. */
  readonly status: string;
  /** Asks the pane to stand on another step. */
  readonly onSeek: (position: number) => void;
  /** Asks the pane to leave replay and show the live list. */
  readonly onExit: () => void;
  readonly scheme: Scheme;
}

export function ReplayBar({
  position,
  count,
  status,
  onSeek,
  onExit,
  scheme,
}: ReplayBarProps): JSX.Element {
  const back = stepBack(position, count);
  const forward = stepForward(position, count);
  return (
    <Group
      gap={8}
      px={18}
      py={8}
      wrap="nowrap"
      data-replay-bar
      style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}` }}
    >
      <Button
        size="compact-xs"
        variant="default"
        aria-label="back one step"
        disabled={back === null || back === position}
        onClick={() => {
          if (back !== null) onSeek(back);
        }}
        style={{ flex: 'none' }}
      >
        Back
      </Button>
      {/* The steps are zero-based positions here and one-based in the sentence:
          the slider's numbers are for a program and the sentence is for a
          person. No floating label, since the sentence beside it already says
          the same thing in words. */}
      <Slider
        min={0}
        max={count - 1}
        step={1}
        value={position}
        onChange={onSeek}
        label={null}
        thumbProps={{ 'aria-label': 'replay position' }}
        style={{ flex: 1, minWidth: 0 }}
      />
      <Button
        size="compact-xs"
        variant="default"
        aria-label="forward one step"
        disabled={forward === null || forward === position}
        onClick={() => {
          if (forward !== null) onSeek(forward);
        }}
        style={{ flex: 'none' }}
      >
        Forward
      </Button>
      <Text
        data-replay-status
        role="status"
        fz={11}
        style={{ flex: 'none', whiteSpace: 'nowrap', color: colorForRole('textFaint', scheme) }}
      >
        {status}
      </Text>
      <Button
        size="compact-xs"
        variant="default"
        aria-label="leave replay and show the live transcript"
        onClick={onExit}
        style={{ flex: 'none' }}
      >
        Exit
      </Button>
    </Group>
  );
}
