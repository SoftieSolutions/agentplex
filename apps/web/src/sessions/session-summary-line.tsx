import { type JSX } from 'react';
import { Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The one-line monospace body of a session card: today the working directory
 * or the status in words, later whatever a provider widget wants to say about
 * a live session. AGX-81 generalizes this into the widget seam; until then it
 * is deliberately one component in one file so that ticket replaces a file,
 * not a search.
 *
 * The mockup renders this line in the terminal's foreground on dark and in
 * faint ink on light -- it is quoting the session, not the UI -- which is why
 * the color is not simply secondary text.
 */
export interface SessionSummaryLineProps {
  readonly text: string;
  readonly scheme: Scheme;
}

export function SessionSummaryLine({ text, scheme }: SessionSummaryLineProps): JSX.Element {
  const color =
    scheme === 'dark' ? colorForRole('terminalText', 'dark') : colorForRole('textFaint', 'light');
  return (
    <Text ff="monospace" fz={11} lh={1.45} truncate="end" c={color}>
      {text}
    </Text>
  );
}
