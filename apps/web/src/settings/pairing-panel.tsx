import { useState, type JSX } from 'react';
import type { ServerRegistrationId } from '@agentplex/protocol';
import {
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import {
  parsePairingForm,
  prefillFromCandidate,
  type DiscoveredCandidate,
  type PairingFormProblems,
} from './pairing-form.js';
import type { PairingOperations } from './pairing-operations.js';

/**
 * Pairing a server: the one form, wherever it is drawn.
 *
 * It lives in its own file because there are now two places somebody pairs a
 * machine -- the settings screen and the first-run wizard -- and two copies of
 * a form carrying a credential is two places for the rules to drift apart. The
 * panel owns everything about pairing: the candidate list, the fields, the
 * parser it runs before anything is sent, and the words it says back. What the
 * screen around it owns is where it sits and what happens next, which is the
 * whole of `onPaired`.
 *
 * It draws no surface of its own for the same reason: settings puts it in a
 * bordered section beside two others, the wizard puts it inside a step, and a
 * component that brought its own frame would be fighting one of them.
 */

export interface PairingPanelProps {
  readonly pairing: PairingOperations;
  readonly candidates: readonly DiscoveredCandidate[];
  readonly scheme: Scheme;
  /**
   * Told which registration the hub recorded, for a caller that has somewhere
   * to go next. Optional because settings has nowhere to go: the row simply
   * appears in the list below, and the hub's next machine state is what puts
   * it there.
   */
  readonly onPaired?: (registrationId: ServerRegistrationId) => void;
}

const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

export function PairingPanel({
  pairing,
  candidates,
  scheme,
  onPaired,
}: PairingPanelProps): JSX.Element {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [problems, setProblems] = useState<PairingFormProblems>({});
  const [outcome, setOutcome] = useState<{ ok: boolean; words: string } | null>(null);
  const [sending, setSending] = useState(false);

  function submit(): void {
    const parsed = parsePairingForm({ name, address, token });
    if (!parsed.ok) {
      setProblems(parsed.problems);
      setOutcome(null);
      return;
    }
    setProblems({});
    setSending(true);
    void pairing.pairServer(parsed.request).then((answer) => {
      setSending(false);
      if (!answer.ok) {
        setOutcome({ ok: false, words: answer.reason });
        return;
      }
      setName('');
      setAddress('');
      setToken('');
      // "Its row appears below" is true where this panel sits above the paired
      // list and false in the wizard, which is the whole route and has no list
      // under it. A caller that asked to be told has somewhere to send the
      // reader and says so itself, so the panel says nothing rather than
      // guessing at a layout it cannot see.
      setOutcome(
        onPaired === undefined
          ? {
              ok: true,
              words: 'Pairing recorded. The hub dials it from here; its row appears below.',
            }
          : null,
      );
      onPaired?.(answer.registrationId);
    });
  }

  return (
    <Stack gap="sm">
      <Title order={4}>Pair a server</Title>
      <Text size="sm" c="dimmed">
        The address is where this hub dials out to; the token is in the server&apos;s identity file
        (~/.agentplex/server.json by default) and is never printed. Each server has its own token,
        so revoking one later touches nothing else.
      </Text>
      {candidates.length > 0 && (
        <Stack gap={6}>
          <Text size="sm" c="dimmed">
            Heard on the network — selecting one fills in the address and stops. You still type that
            server&apos;s token: being heard on the network is not being trusted.
          </Text>
          <Stack gap={4}>
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.serverId}
                candidate={candidate}
                scheme={scheme}
                onSelect={setAddress}
              />
            ))}
          </Stack>
        </Stack>
      )}
      <TextInput
        label="Name"
        placeholder="gpu-box-01"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={problems.name}
      />
      <TextInput
        label="Address"
        placeholder="wss://gpu-box-01.example:8443"
        value={address}
        onChange={(event) => setAddress(event.currentTarget.value)}
        error={problems.address}
        styles={MONO_INPUT}
      />
      <PasswordInput
        label="Server token"
        placeholder="the token in that server's identity file"
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        error={problems.token}
        styles={MONO_INPUT}
      />
      <Group>
        <Button onClick={submit} loading={sending}>
          Pair server
        </Button>
      </Group>
      {outcome !== null &&
        (outcome.ok ? (
          <Text size="sm" c="dimmed">
            {outcome.words}
          </Text>
        ) : (
          <Text size="sm" style={{ color: colorForTone('blocked', scheme) }}>
            {outcome.words}
          </Text>
        ))}
    </Stack>
  );
}

/**
 * One machine heard on the network.
 *
 * Everything the beacon claimed is shown — what it calls itself, where it says
 * it is, the port, and the protocol it speaks — because every one of those is a
 * claim and the row is how the user judges it. A machine this build cannot
 * speak to is drawn all the same, marked and with its selection refused: the
 * honest report is "it is there and these two cannot talk", and leaving it out
 * would report an empty network instead.
 */
function CandidateRow({
  candidate,
  scheme,
  onSelect,
}: {
  readonly candidate: DiscoveredCandidate;
  readonly scheme: Scheme;
  readonly onSelect: (address: string) => void;
}): JSX.Element {
  const prefill = prefillFromCandidate(candidate);
  return (
    <Paper
      withBorder
      radius="md"
      p="xs"
      data-candidate={candidate.serverId}
      style={{
        background: colorForRole('surfaceAlt', scheme),
        borderColor: colorForRole('border', scheme),
      }}
    >
      <Group gap={10} align="center" wrap="nowrap">
        {/* Idle, not running: this machine is offering itself, and nothing
            about hearing it says anything is working. */}
        <ToneDot tone={candidate.unusable === null ? 'idle' : 'blocked'} scheme={scheme} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" ff="monospace">
            {candidate.serverId}
          </Text>
          <Text size="xs" ff="monospace" c="dimmed">
            {candidate.host}:{candidate.port} · server protocol {candidate.protocolVersion}
          </Text>
          {candidate.unusable !== null && (
            <Text size="xs" style={{ color: colorForTone('blocked', scheme) }}>
              {candidate.unusable}
            </Text>
          )}
        </Stack>
        <Button
          variant="default"
          size="xs"
          disabled={prefill === null}
          onClick={() => {
            if (prefill !== null) onSelect(prefill.address);
          }}
        >
          Use address
        </Button>
      </Group>
    </Paper>
  );
}
