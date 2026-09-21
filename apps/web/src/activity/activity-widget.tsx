import { type JSX } from 'react';
import type { Activity } from '@agentplex/protocol';
import { Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { activityWords } from './activity-words.js';

/**
 * What a session is doing, drawn: one line on a card or a row, and the same
 * sentence at reading size on the session screen.
 *
 * Two forms of one widget rather than two components, because the thing they
 * must never do is disagree. The words come from `activityWords`, which holds
 * the one switch over the vocabulary; what this file decides is layout --
 * whether the line truncates or wraps -- and face: the provider's own string
 * in the monospace terminal ink, this app's words in prose around it.
 *
 * Nothing here interprets the strings it draws. They are React children, so
 * they are text nodes and never markup, and the two that came out of somebody
 * else's transcript -- a command line and a file path -- are drawn `dir="ltr"`
 * so that neither the surrounding text's direction nor a character left in the
 * string can reorder what a person reads into a different command or a
 * different path. The protocol already strips the bidi overrides; this is the
 * second half of the same promise, for the characters it is right to keep.
 *
 * An activity is never a tone. The dot, the border and the needs-you partition
 * read the session's status, and a card whose colour moved because an agent
 * ran a failing test would be claiming somebody is wanted when nobody is. The
 * failure is said in words instead.
 *
 * Four of the six kinds -- `edit`, `tests`, `narration`, `approval` -- are
 * emitted by no adapter today and are not dead code: the wire vocabulary is
 * what this renders, the captured transcripts redact the tool input the first
 * three would come from, and no provider writes an approval to disk at all.
 * AGX-263 re-captures fixtures with tool inputs, and nothing here changes when
 * it does.
 */

/** One line that truncates, or a paragraph that wraps. */
export type ActivityForm = 'collapsed' | 'full';

export interface ActivityWidgetProps {
  readonly activity: Activity;
  readonly form: ActivityForm;
  readonly scheme: Scheme;
}

export function ActivityWidget({ activity, form, scheme }: ActivityWidgetProps): JSX.Element {
  const words = activityWords(activity);
  const collapsed = form === 'collapsed';
  // The card's line quotes the session, which is why it is the terminal's
  // foreground on dark and faint ink on paper rather than ordinary secondary
  // text. The full form is being read rather than scanned, so it takes the
  // page's own text colour and leaves the terminal ink to the quoted run.
  const color = collapsed
    ? scheme === 'dark'
      ? colorForRole('terminalText', 'dark')
      : colorForRole('textFaint', 'light')
    : colorForRole('text', scheme);
  // The library's own truncation, which is what every other fact on a card and
  // a row already uses: one list whose facts were cut two different ways would
  // be a list where one of them stopped being cut the day somebody changed the
  // other. Spread rather than passed as `undefined`, because the prop is
  // optional in the sense of absent and the app compiles with
  // `exactOptionalPropertyTypes`.
  const truncation = collapsed ? ({ truncate: 'end' } as const) : {};
  return (
    <Text
      fz={collapsed ? 11 : 12}
      lh={collapsed ? 1.45 : 1.55}
      c={color}
      {...truncation}
      style={
        collapsed
          ? { minWidth: 0 }
          : // A command line has no spaces to break at, so an unbroken one
            // would push the session screen sideways; it breaks anywhere rather
            // than being cut, since the full form's whole job is showing all of
            // it.
            { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
      }
    >
      {words.lead}
      {words.lead !== null && words.quoted !== null ? ' ' : null}
      {words.quoted === null ? null : (
        <Text
          component="span"
          dir="ltr"
          ff="monospace"
          fz="inherit"
          c={collapsed ? color : colorForRole('terminalText', scheme)}
        >
          {words.quoted}
        </Text>
      )}
      {words.detail === null ? null : ` ${words.detail}`}
    </Text>
  );
}
