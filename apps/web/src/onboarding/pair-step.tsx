import { useState, type JSX } from 'react';
import type { DiscoveredCandidate } from '../settings/pairing-form.js';
import type { PairingOperations } from '../settings/pairing-operations.js';
import { PairingPanel } from '../settings/pairing-panel.js';
import { Button, Group, Stack, Text, Title } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

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
 * The form itself is `PairingPanel`, the same component the settings screen
 * mounts, over the same `PairingOperations` the page already holds. What this
 * file owns is the question, the two answers, and what follows a pairing --
 * which is the difference between the two mounts: settings has a list under it
 * and nowhere to go, and this step has a next thing to say.
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
  readonly scheme: Scheme;
  /** Closes the wizard: the same way out the hero's skip takes. */
  readonly onDone: () => void;
}

export function PairStep({ pairing, candidates, scheme, onDone }: PairStepProps): JSX.Element {
  const [answer, setAnswer] = useState<Answer | null>(null);
  /**
   * Whether the hub has recorded a pairing from this step. A boolean and not
   * the registration id the panel hands over: nothing on this screen names one
   * row yet, and state nothing reads is state that goes stale unnoticed. The
   * id is in the panel's `onPaired` argument for whoever wants to point at
   * that row.
   */
  const [recorded, setRecorded] = useState(false);

  if (recorded) {
    return (
      <Stack gap={16} maw={520} align="flex-start">
        <StepTitle scheme={scheme} />
        <Text fz={14} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Pairing recorded; the hub dials it from here.
        </Text>
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
          onPaired={() => setRecorded(true)}
        />
      )}
      {answer === 'needs-one' && (
        <Text fz={14} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Install one on that machine first. A later change puts the install command here; until
          then the server&apos;s README on the machine you install on carries it, and the install.sh
          it points at does the whole of it — the runtime, the toolchain where one is needed, and
          the unit that keeps it up. Setup leaves that server&apos;s token in its identity file
          (~/.agentplex/server.json by default) and shows it nowhere, so read it there; come back
          with it and the address, and pick &quot;I already run a server&quot;.
        </Text>
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
