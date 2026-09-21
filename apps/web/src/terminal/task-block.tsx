import type { JSX } from 'react';

import { Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { markTaskProse } from './task-block-model.js';

/**
 * The TASK block of the context panel (mockup 7c): what this session was
 * started to do, in the words it was started with.
 *
 * The words are the hub's `row.task` and nothing else. That is the decision
 * this ticket turned on and it is worth having written down where the text is
 * drawn: a task line that meant "the first thing anyone typed into this
 * terminal" would be right for a session somebody started from the start form
 * and wrong for every session the hub adopted off a machine, and it would be
 * wrong quietly -- a plausible sentence under a heading that says TASK, which
 * is worse than no block. So a session the hub has no task for draws no block
 * at all, and `session-pane.tsx` is where that is decided.
 *
 * Everything else here is about the text being a person's, typed into a form:
 * it is drawn as text, it wraps rather than widening the column, and it is
 * bounded in height so that an essay costs its own block and not the blocks
 * below it.
 */

/**
 * How tall the prose may get before it scrolls, in CSS pixels: eight lines at
 * the block's own line height.
 *
 * A number and not a line count because the browser has no `max-lines`, and a
 * `-webkit-line-clamp` would hide the rest of the sentence behind an ellipsis
 * with no way to read it. Eight lines is roughly the longest prompt that still
 * reads as a glance rather than as a document; past that the block keeps its
 * size and the reader scrolls it, which is the behaviour the panel's own
 * scroll would otherwise take from every block under this one.
 */
export const TASK_PROSE_MAX_HEIGHT = 144;

const MONOSPACE = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export interface TaskBlockProps {
  /** The prompt this session was started with. Never empty: no task, no block. */
  readonly task: string;
  readonly scheme: Scheme;
}

export function TaskBlock({ task, scheme }: TaskBlockProps): JSX.Element {
  return (
    <Text
      component="p"
      data-task-prose
      style={{
        margin: 0,
        lineHeight: 1.5,
        color: colorForRole('textSecondary', scheme),
        // A prompt can carry a URL or a path with no break in it for longer
        // than this column is wide, and the column cannot grow: it is fixed so
        // that the terminal beside it is not re-fitted every time the panel
        // changes. `anywhere` breaks such a token rather than letting it
        // overflow the panel's edge.
        overflowWrap: 'anywhere',
        maxHeight: TASK_PROSE_MAX_HEIGHT,
        overflowY: 'auto',
      }}
    >
      {markTaskProse(task).map((segment, index) =>
        segment.branch ? (
          // Keyed by position because that is what these are: runs of one
          // string, rebuilt whenever the string changes and never reordered.
          // There is no identity here to preserve -- two occurrences of the
          // same branch name in one prompt are two segments, not one moved.
          <Text key={`${index}:${segment.text}`} span inherit style={MONOSPACE}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}
