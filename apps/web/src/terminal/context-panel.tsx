import type { CSSProperties, JSX, ReactNode } from 'react';

import type { ShellForm } from '../shell/shell-form.js';
import { Box, Stack, Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The right column of the open-session screen (mockups 7c and 7d): a fixed
 * column beside the terminal, holding a stack of titled blocks.
 *
 * It takes a list and draws it, the way `TabStrip` takes a list of tabs and
 * draws it, and for the same reason. The blocks belong to four different
 * tickets across three epics -- TASK here (AGX-130), APPROVALS from AGX-104,
 * COST from AGX-107, and the machine and diff blocks after them -- and none of
 * them should have to edit this file to appear. So nothing here knows a block
 * by name: a block is `{ key, title, body }`, the frame owns the heading style
 * and the separator, and a ticket that adds one appends to an array.
 *
 * Which also means the frame has to be honest about a subset. Epics land in
 * whatever order they land, so the ordinary state of this panel for months is
 * some of its blocks built and the rest not, and the frame draws exactly the
 * ones it was handed. The blocks it was not handed leave no gap and no
 * placeholder: a bordered empty section under a heading nobody can fill is a
 * promise the screen cannot keep.
 *
 * Two cases draw no panel at all rather than an empty one, and both are
 * decided here rather than at the call site, so there is one answer to "is
 * there a panel" and the pane beside it cannot hold a different one:
 *
 *   - No blocks. The column exists to hold them; with none there is nothing
 *     for 300 fixed pixels and a border to be for, and the space is the
 *     terminal's.
 *   - The phone form. 7e draws no phone form for this panel -- whether it
 *     collapses, moves or becomes a tab is undesigned -- and a 300px column on
 *     a 390px screen is not a guess worth shipping. The form arrives as a prop
 *     from the shell's one breakpoint rather than as a media query written
 *     again here, which is the rule `shell-form.ts` exists to keep: two
 *     spellings of one breakpoint open a band of widths where neither agrees.
 */

/**
 * The column's width in CSS pixels, from the mockup's grid:
 * `grid-template-columns: 232px 1fr 300px`.
 *
 * Fixed in both directions, which is the load-bearing half. The terminal is
 * the `1fr`, and it refits itself whenever its own box changes size; a panel
 * that grew or shrank with the pane would therefore move the terminal's grid
 * every time anything else on screen moved. Exported so a test can assert the
 * mockup's number rather than transcribe it a second time.
 */
export const CONTEXT_PANEL_WIDTH = 300;

/**
 * One section of the panel.
 *
 * `body` is a node and not a string because every block after the first is a
 * small layout of its own -- a list of files with their line counts, a row of
 * approvals with a marker each, a cost with a sparkline under it. The frame
 * gives it a titled box with the panel's padding and nothing else.
 *
 * `key` is React's, and it is separate from `title` on purpose: a title is
 * copy and copy gets edited, and a block that was re-keyed by a word change
 * would be torn down and rebuilt rather than updated.
 */
export interface ContextBlock {
  readonly key: string;
  readonly title: string;
  readonly body: ReactNode;
}

export interface ContextPanelProps {
  readonly blocks: readonly ContextBlock[];
  /** The shell's form, which decides whether this panel exists at all. */
  readonly form: ShellForm;
  readonly scheme: Scheme;
}

/**
 * The heading of a block: the mockup's 9px letterspaced monospace label.
 *
 * Uppercased by the frame rather than by the words a block passes in, so the
 * style is in one place and a block supplies ordinary copy. Outside the
 * component body because it needs nothing from it.
 */
function headingStyle(scheme: Scheme): CSSProperties {
  return {
    fontFamily: 'var(--mantine-font-family-monospace)',
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: colorForRole('textMuted', scheme),
  };
}

export function ContextPanel({ blocks, form, scheme }: ContextPanelProps): JSX.Element | null {
  if (form === 'phone' || blocks.length === 0) return null;

  const border = `1px solid ${colorForRole('border', scheme)}`;

  return (
    <Box
      component="aside"
      aria-label="session context"
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Never grows, never shrinks: see CONTEXT_PANEL_WIDTH.
        flexGrow: 0,
        flexShrink: 0,
        width: CONTEXT_PANEL_WIDTH,
        minHeight: 0,
        // The blocks are the scrolling part. The terminal beside it is fitted
        // to its own box and must not be pushed out of the pane by a long
        // task description.
        overflowY: 'auto',
        borderLeft: border,
        background: colorForRole('surface', scheme),
        fontSize: 12,
      }}
    >
      {blocks.map((block, index) => (
        <Stack
          key={block.key}
          component="section"
          // Named for a screen reader with the same words that are drawn: a
          // section with an accessible name is a region, which is how someone
          // reaches one block of this panel without reading the ones above it.
          aria-label={block.title}
          gap={6}
          px={16}
          py={12}
          style={{
            flex: 'none',
            // Between the blocks and not under the last one: a hairline under
            // the bottom block would draw an edge across a column that has
            // nothing below it.
            borderBottom: index === blocks.length - 1 ? undefined : border,
          }}
        >
          <Text component="h2" style={headingStyle(scheme)}>
            {block.title}
          </Text>
          {block.body}
        </Stack>
      ))}
    </Box>
  );
}
