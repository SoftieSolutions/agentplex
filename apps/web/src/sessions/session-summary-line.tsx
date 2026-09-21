import { type JSX } from 'react';
import type { Activity } from '@agentplex/protocol';
import { ActivityWidget } from '../activity/activity-widget.js';
import { Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The one-line monospace body of a session card: what the session is doing
 * when its provider recorded an activity, and where it is running when it
 * recorded none.
 *
 * The fallback is the whole shape of this component. An activity is a claim
 * about what an agent is up to, and a session whose transcript said nothing
 * this app can parse has no such claim to make -- so the line goes back to
 * exactly what it drew before the vocabulary existed, the working directory or
 * the status in words, rather than to a blank or to a sentence invented out of
 * the status. Degrading toward the coarser true thing is the rule the rest of
 * this screen follows, and the caller's `text` is where the coarser true thing
 * is already worked out.
 *
 * Both forms of the list draw this and the onboarding report draws it too, so
 * it stays one component: the ink is the mockup's terminal foreground on dark
 * and faint ink on paper -- the line is quoting the session, not the UI -- and
 * three copies of that judgement would be three chances for one surface to
 * quote a session in the app's own voice.
 */
export interface SessionSummaryLineProps {
  /**
   * What the session is doing, or `null` when its provider recorded nothing.
   *
   * Required and never defaulted, because a caller that has no activity to
   * pass is making a claim -- that there is none to show -- and an optional
   * prop would let a surface that simply forgot make the same silent one.
   */
  readonly activity: Activity | null;
  /** What to draw instead: the working directory, or the status in words. */
  readonly text: string;
  readonly scheme: Scheme;
}

export function SessionSummaryLine({
  activity,
  text,
  scheme,
}: SessionSummaryLineProps): JSX.Element {
  if (activity !== null) {
    return <ActivityWidget activity={activity} form="collapsed" scheme={scheme} />;
  }
  const color =
    scheme === 'dark' ? colorForRole('terminalText', 'dark') : colorForRole('textFaint', 'light');
  return (
    <Text
      ff="monospace"
      fz={11}
      lh={1.45}
      c={color}
      // Cut the way the collapsed widget is cut, and the way this line was cut
      // before there was a widget: one card must not truncate two of its own
      // lines two different ways.
      truncate="end"
    >
      {text}
    </Text>
  );
}
