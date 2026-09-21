import type { JSX } from 'react';
import { ageLabel } from '../sessions/session-list-model.js';
import { SessionSummaryLine } from '../sessions/session-summary-line.js';
import { sessionHash } from '../terminal/session-route.js';
import { Box, Button, Group, Stack, Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { AdoptedSession } from './adopted-sessions-model.js';

/**
 * What the machine somebody just paired was already holding, under the card
 * that says it answered.
 *
 * A report and not a form. The approved mockup (turn 7f) drew these rows with
 * a checkbox each and an "Adopt N sessions" button under them, and neither is
 * here: the server watches its store on disk and reports what is in it, so by
 * the time the hub has published a state naming these sessions they are
 * already the hub's. A pre-checked list would be asking permission for
 * something that has happened, and an unchecked one would promise an opt-out
 * the protocol does not offer. What is left of the mockup is the part that was
 * always true -- the bordered row, the name in bold, the muted monospace
 * detail line, the activity at the right edge.
 *
 * Each row is an anchor to the session's own address rather than a click
 * handler, for the reason the session card is one: an anchor is what the
 * browser already makes keyboard reachable, middle-clickable into a second
 * tab, and hoverable to see where it goes. Nothing in a row is interactive
 * besides the link, so the link is the row itself rather than a stretched
 * overlay.
 *
 * Nothing is held here. The sessions are a prop read per render from the
 * state the hub last published, so a session that stops while this screen is
 * open changes what the screen says -- the alternative is a snapshot taken at
 * pairing time that keeps describing the moment it was taken.
 */

export interface AdoptedSessionsProps {
  readonly sessions: readonly AdoptedSession[];
  /** The machine's label, so the empty state can name it rather than say "this machine". */
  readonly label: string;
  readonly scheme: Scheme;
  /** The moment the ages on this render are measured against. */
  readonly now: number;
  /**
   * The way out of the wizard, which is where somebody with no sessions has
   * to go to make one. The same exit the step's own Done button takes, handed
   * down rather than performed here: dismissing the wizard is the screen's
   * business and this component only knows there is nothing on this machine
   * to show yet.
   */
  readonly onGoToSessions: () => void;
}

export function AdoptedSessions({
  sessions,
  label,
  scheme,
  now,
  onGoToSessions,
}: AdoptedSessionsProps): JSX.Element {
  if (sessions.length === 0) {
    return (
      <Stack gap={8} align="flex-start">
        <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          No agent sessions were found on {label} yet.
        </Text>
        {/* Where to go, rather than what went wrong. An empty store on a
            machine that has just been installed is the ordinary case, and a
            first-run screen that reads like a failure here sends somebody
            hunting for a fault that is not there. */}
        <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Start one from the session list and it appears here on its own: that machine reports what
          turns up in the stores it watches.
        </Text>
        <Button size="xs" onClick={onGoToSessions}>
          Go to the session list
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap={8}>
      <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
        {foundWords(sessions.length, label)} Nothing to confirm; this hub already has them.
      </Text>
      <Stack gap={6}>
        {sessions.map((session) => (
          <AdoptedSessionRow
            key={`${session.ref.storeId}/${session.ref.sessionId}`}
            session={session}
            scheme={scheme}
            now={now}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/** How many were found, on which machine, in the plural the count earns. */
function foundWords(count: number, label: string): string {
  const noun = count === 1 ? 'agent session' : 'agent sessions';
  return `${String(count)} ${noun} on ${label}.`;
}

interface AdoptedSessionRowProps {
  readonly session: AdoptedSession;
  readonly scheme: Scheme;
  readonly now: number;
}

function AdoptedSessionRow({ session, scheme, now }: AdoptedSessionRowProps): JSX.Element {
  return (
    <Box
      component="a"
      href={sessionHash(session.ref)}
      aria-label={`open ${session.name}`}
      style={{
        display: 'block',
        textDecoration: 'none',
        border: `1px solid ${colorForRole('border', scheme)}`,
        borderRadius: 8,
        padding: '8px 10px',
        minWidth: 0,
      }}
    >
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fw={600} fz={13} truncate="end" style={{ flex: 1 }} c={colorForRole('text', scheme)}>
          {session.name}
        </Text>
        <Text ff="monospace" fz={10} c={colorForRole('textMuted', scheme)}>
          {session.provider}
        </Text>
        {/* The activity at the right edge, as the mockup has it, with the age
            beside it: a word on its own says what a session is doing and
            nothing about whether anyone is still doing it. */}
        <Text fz={11} style={{ whiteSpace: 'nowrap' }} c={colorForRole('textMuted', scheme)}>
          {`${session.activity} · ${ageLabel(now, session.updatedAt)}`}
        </Text>
      </Group>
      {/* The same monospace line the session card draws, because it is the
          same claim: this is the session quoting itself, not the UI talking.
          No activity, and said rather than left off: this report's model
          carries the status words in the column above and never the parsed
          activity, so the line here is the directory or nothing. */}
      <SessionSummaryLine
        activity={null}
        text={session.cwd ?? 'working directory not recorded'}
        scheme={scheme}
      />
    </Box>
  );
}
