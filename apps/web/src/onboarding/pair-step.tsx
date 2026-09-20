import { useState, type JSX } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
import type { DiscoveredCandidate } from '../settings/pairing-form.js';
import type { PairingOperations } from '../settings/pairing-operations.js';
import { PairingPanel } from '../settings/pairing-panel.js';
import type { ServerRowView } from '../settings/server-rows.js';
import { Button, Group, Stack, Text, Title } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { sessionsOnServer } from './adopted-sessions-model.js';
import { EnrollPanel } from './enroll-panel.js';
import { MachineCard } from './machine-card.js';
import { pairProgress } from './pair-progress-model.js';

/**
 * The wizard's live step: pairing the first machine.
 *
 * It asks a question before it draws anything, because a first-run reader is
 * one of two people and the form only suits one of them. Somebody who already
 * runs a server has an address and a token and wants the form; somebody who
 * has never installed one has neither, and a form is then a demand for two
 * values that do not exist yet -- the point where a wizard starts looking
 * broken rather than helpful. So nothing is drawn until the reader says which
 * they are, and the answer is theirs rather than guessed from the network:
 * hearing a beacon says a machine is there, not that it is the one they meant
 * or that they have its token.
 *
 * Neither answer is drawn here. The form is `PairingPanel`, the same component
 * the settings screen mounts, over the same `PairingOperations` the page
 * already holds; the other is `EnrollPanel`, which is the install command and
 * nothing this step has to know about. What this file owns is the question,
 * the routing between the two, and what follows a pairing -- which is the
 * difference between this mount of the form and settings': settings has a list
 * under it and nowhere to go, and this step has a next thing to say.
 *
 * The direction is load-bearing in every sentence here. The hub dials the
 * server; the server listens and dials nothing. Copy that read the other way
 * would send somebody to open a port on the machine that needs none.
 */

/** Which reader this is, once they have said. */
type Answer = 'already-running' | 'needs-one';

export interface PairStepProps {
  readonly pairing: PairingOperations;
  readonly candidates: readonly DiscoveredCandidate[];
  /**
   * Every paired server the hub has published, as the settings list projects
   * them. Handed down rather than read here, because the screen above already
   * holds the store's snapshot: two `useHubSnapshot` calls would be two
   * readings of one fact, and this step would then need the store to draw a
   * card. The rows are re-read on every render of that snapshot, so the card
   * follows the hub's broadcasts with no timer and no effect -- a poll would
   * only ask a store that already knows.
   */
  readonly rows: readonly ServerRowView[];
  /**
   * The same broadcast the rows were projected from, for the sessions the
   * paired machine was already holding.
   *
   * Handed down beside the rows rather than instead of them: `serverRows` is
   * the settings screen's projection of the machines and says nothing about
   * sessions, and re-deriving the sessions from it is not possible. Reading
   * both off one state is what keeps the card and the list under it describing
   * the same moment -- two snapshots taken a broadcast apart would let the
   * wizard name sessions on a machine whose row already reads unreachable.
   *
   * Nullable for the same reason the rows are derived from a nullable state:
   * the hub has broadcast nothing until it has.
   */
  readonly machineState: MachineState | null;
  readonly scheme: Scheme;
  /** Closes the wizard: the same way out the hero's skip takes. */
  readonly onDone: () => void;
  /** The clock the card measures a connection's age against; see `MachineCard`. */
  readonly now?: number | undefined;
}

export function PairStep({
  pairing,
  candidates,
  rows,
  machineState,
  scheme,
  onDone,
  now,
}: PairStepProps): JSX.Element {
  const [answer, setAnswer] = useState<Answer | null>(null);
  /**
   * The registration the hub recorded for this step, or `null` before it has
   * recorded one.
   *
   * It was a boolean while nothing on this screen named a row. It is the id
   * now because the card does name one: the wizard's last screen is a reading
   * of what the hub published about this one registration, and the id is the
   * only thing that picks it out. The machine's label cannot -- two machines
   * somebody called `gpu-box` are one row twice -- and the newest row cannot
   * either, because the hub publishes them sorted by label.
   *
   * What is *not* held here is anything the rows already say. The card's state
   * is derived per render, so a machine that answers, drains and goes stale
   * walks through all three without this step storing a word of it.
   */
  const [paired, setPaired] = useState<ServerRegistrationId | null>(null);

  if (paired !== null) {
    return (
      <Stack gap={16} maw={520} align="flex-start">
        <StepTitle scheme={scheme} />
        <MachineCard
          progress={pairProgress(rows, paired)}
          scheme={scheme}
          now={now}
          sessions={sessionsOnServer(machineState, paired)}
          /* The session list is out of the wizard, which is where `onDone`
             already goes: dismissing it and landing on the app are one act,
             and a second exit that did half of it would leave the wizard
             offering itself again on the next load. */
          onGoToSessions={onDone}
        />
        {/* The way out, in every state the card can reach. A wizard that only
            let somebody leave once the dial had landed would trap the reader
            whose machine is the one that never answers -- which is the reader
            this screen was drawn for. */}
        <Button onClick={onDone}>Done</Button>
      </Stack>
    );
  }

  return (
    <Stack gap={16} maw={520}>
      <StepTitle scheme={scheme} />
      <Text fz={14} lh={1.6} c={colorForRole('textSecondary', scheme)}>
        A server is the agentplex process on a machine your agents run on. This hub dials out to it
        and merges what it reports, so what pairing needs is an address this hub can reach and that
        machine&apos;s token, which setup wrote into its identity file and showed nowhere.
      </Text>
      <Group gap="sm">
        <Button
          variant={answer === 'already-running' ? 'filled' : 'default'}
          aria-pressed={answer === 'already-running'}
          onClick={() => setAnswer('already-running')}
        >
          I already run a server
        </Button>
        <Button
          variant={answer === 'needs-one' ? 'filled' : 'default'}
          aria-pressed={answer === 'needs-one'}
          onClick={() => setAnswer('needs-one')}
        >
          I need to run one
        </Button>
      </Group>
      {answer === 'already-running' && (
        <PairingPanel
          pairing={pairing}
          candidates={candidates}
          scheme={scheme}
          onPaired={(registrationId) => setPaired(registrationId)}
        />
      )}
      {answer === 'needs-one' && (
        /* The other branch, and the reason this step asks its question at all:
           a reader with no server needs a command, not a form. The panel hands
           them back here once they have been to that machine, so the two
           answers are a round trip rather than two dead ends. */
        <EnrollPanel scheme={scheme} onHaveToken={() => setAnswer('already-running')} />
      )}
    </Stack>
  );
}

/**
 * The step's heading, in one place because both of this step's states draw it.
 *
 * It names the direction rather than repeating the panel's own "Pair a
 * server": the stepper beside it already carries that label, and a heading
 * that said it a third time would be the loudest words on the screen saying
 * nothing new.
 */
function StepTitle({ scheme }: { readonly scheme: Scheme }): JSX.Element {
  return (
    <Title order={2} fz={20} c={colorForRole('text', scheme)}>
      Point this hub at a machine
    </Title>
  );
}
