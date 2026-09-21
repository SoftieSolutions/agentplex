import type { JSX } from 'react';

import { ActivityWidget } from '../activity/activity-widget.js';
import { Box, Button, Group, Stack, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import type { TranscriptState } from './transcript-model.js';

/**
 * What is under the Transcript tab (mockup 7c): the session's own work, drawn
 * in the widget vocabulary, oldest first.
 *
 * It renders a value and asks for nothing. The read is the pane's -- sent when
 * the tab is chosen and again when the button here is pressed -- so this file
 * has no store, no effect and no idea that a socket exists; what it is handed
 * is `transcriptState`, which is a pure function of what the store holds and
 * what the pane asked for. That is what keeps the whole of "when do we ask"
 * in one place and out of a render.
 *
 * The widgets are the full form of the same component a card draws collapsed.
 * Two components would be two vocabularies, and the thing they must never do
 * is disagree about what an activity says.
 *
 * The status line is always mounted, even while it has nothing to say. A
 * `role="status"` region that appears at the moment it first has words is a
 * region a screen reader was not watching when the words arrived; one that is
 * there from the first render announces every sentence that lands in it.
 */

export interface TranscriptPanelProps {
  readonly state: TranscriptState;
  /** Sends the read again. The pane owns the frame; this owns the button. */
  readonly onRefresh: () => void;
  readonly scheme: Scheme;
  /** The id the tab strip's `aria-controls` points at. */
  readonly panelId: string;
  /** The tab that controls this panel, for a screen reader reading backwards. */
  readonly labelledBy: string;
}

export function TranscriptPanel({
  state,
  onRefresh,
  scheme,
  panelId,
  labelledBy,
}: TranscriptPanelProps): JSX.Element {
  return (
    <Stack
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      gap={0}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
    >
      <Group
        gap={8}
        px={18}
        py={8}
        wrap="nowrap"
        style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}` }}
      >
        {/* Mounted whether or not it has words, so that a sentence arriving
            later is announced rather than appearing beside a region nothing
            was watching. Empty is empty: no placeholder stands in for an
            answer that has not come. */}
        <Text
          data-transcript-status
          role="status"
          fz={11}
          style={{
            flex: 1,
            minWidth: 0,
            color:
              state.tone === 'blocked'
                ? colorForTone('blocked', scheme)
                : colorForRole('textFaint', scheme),
          }}
        >
          {state.status ?? ''}
        </Text>
        {/* A read and not a subscription: a transcript is a file another
            process is appending to, so the honest offer is asking again rather
            than a feed that claims to be live. */}
        <Button
          size="compact-xs"
          variant="default"
          onClick={onRefresh}
          aria-label="read this session’s transcript again"
          style={{ flex: 'none' }}
        >
          Refresh
        </Button>
      </Group>

      <Stack gap={10} px={18} py={12} data-transcript-feed>
        {state.activities.map((activity, index) => (
          <Box
            // Keyed by position, deliberately. An activity carries no id --
            // it is a reading of a line in somebody else's file, not a row --
            // and the list is replaced whole on every read, so there is no
            // reordering for a positional key to get wrong.
            key={index}
            data-activity={activity.kind}
          >
            <ActivityWidget activity={activity} form="full" scheme={scheme} />
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
