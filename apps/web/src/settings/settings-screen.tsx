import { useState, type JSX, type ReactNode } from 'react';
import type { ServerRegistrationId } from '@agentplex/protocol';
import type { HubSnapshot } from '../store/hub-store.js';
import type { TokenStore } from '../auth/token.js';
import {
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
  useComputedColorScheme,
} from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme, type Tone } from '../ui/tokens.js';
import {
  parsePairingForm,
  prefillFromCandidate,
  type DiscoveredCandidate,
  type PairingFormProblems,
} from './pairing-form.js';
import type { PairingOperations } from './pairing-operations.js';
import { serverRows, type ServerRowView } from './server-rows.js';

/**
 * The settings screen: hub access, server pairing, and the paired-server
 * list. Everything drawn here is either typed by the user or read out of the
 * snapshot; every failure is shown in words, because a settings screen is
 * exactly the place a person goes to find out why something is not working.
 *
 * The visual language is the approved mockup direction (design mockups, turn
 * 7): bordered surfaces on the app background, 7-10px radii, Fira Code for
 * addresses and ids, and connectivity as a tone dot beside words.
 */

export interface SettingsScreenProps {
  readonly snapshot: HubSnapshot;
  readonly tokens: TokenStore;
  readonly pairing: PairingOperations;
  readonly candidates: readonly DiscoveredCandidate[];
}

/** The connection phase as the tone dot beside the hub line. */
function toneForPhase(phase: HubSnapshot['phase']): Tone {
  switch (phase) {
    case 'connected':
      return 'running';
    case 'connecting':
    case 'idle':
      return 'idle';
    case 'reconnecting':
      return 'needs-you';
    case 'failed':
      return 'blocked';
  }
}

function phaseWords(snapshot: HubSnapshot): string {
  switch (snapshot.phase) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return snapshot.hubId === null ? 'connected' : `connected · hub ${snapshot.hubId}`;
    case 'reconnecting':
      return 'reconnecting';
    case 'failed':
      return 'failed';
  }
}

/** The mockup's status dot: 7px, round, colored by tone and nothing else. */
function ToneDot({ tone, scheme }: { readonly tone: Tone; readonly scheme: Scheme }): JSX.Element {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: colorForTone(tone, scheme),
        flex: 'none',
      }}
    />
  );
}

/** One bordered surface, the way every t7 panel sits on the background. */
function Section({
  scheme,
  children,
}: {
  readonly scheme: Scheme;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Paper
      withBorder
      radius="lg"
      p="md"
      style={{
        background: colorForRole('surface', scheme),
        borderColor: colorForRole('border', scheme),
      }}
    >
      {children}
    </Paper>
  );
}

const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

export function SettingsScreen({
  snapshot,
  tokens,
  pairing,
  candidates,
}: SettingsScreenProps): JSX.Element {
  const scheme = useComputedColorScheme('dark');
  return (
    <Stack gap="md" maw={720}>
      <Title order={2}>Settings</Title>
      <Section scheme={scheme}>
        <HubAccessSection snapshot={snapshot} tokens={tokens} scheme={scheme} />
      </Section>
      <Section scheme={scheme}>
        <PairingFormSection pairing={pairing} candidates={candidates} scheme={scheme} />
      </Section>
      <Section scheme={scheme}>
        <PairedServersSection snapshot={snapshot} pairing={pairing} scheme={scheme} />
      </Section>
    </Stack>
  );
}

function HubAccessSection({
  snapshot,
  tokens,
  scheme,
}: {
  readonly snapshot: HubSnapshot;
  readonly tokens: TokenStore;
  readonly scheme: Scheme;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stored = tokens.read();

  function saveToken(): void {
    const token = draft.trim();
    if (token.length === 0) {
      setProblem('expected the token the hub was configured with');
      setNotice(null);
      return;
    }
    setProblem(null);
    if (tokens.write(token)) {
      setDraft('');
      setNotice(
        'Token saved on this device. Saving it proves nothing about it — the connection line below is what does.',
      );
    } else {
      setNotice(
        'This browser refused to store the token; it will be used for this page but asked for again next time.',
      );
    }
  }

  function clearToken(): void {
    setProblem(null);
    setNotice(
      tokens.clear()
        ? 'Token cleared from this device.'
        : 'This browser refused to touch its storage; the token may still be there.',
    );
  }

  return (
    <Stack gap="sm">
      <Title order={4}>Hub access</Title>
      <Text size="sm" c="dimmed">
        The hub token is typed once per device and kept in this browser only. It is exchanged with
        this hub for a connection ticket and sent nowhere else.
      </Text>
      <Group align="flex-end" gap="sm">
        <PasswordInput
          label="Hub token"
          placeholder={stored === null ? 'paste the hub token' : 'a token is stored on this device'}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          error={problem}
          style={{ flex: 1 }}
          styles={MONO_INPUT}
        />
        <Button onClick={saveToken}>Save</Button>
        {stored !== null && (
          <Button variant="default" onClick={clearToken}>
            Clear
          </Button>
        )}
      </Group>
      {notice !== null && (
        <Text size="sm" c="dimmed">
          {notice}
        </Text>
      )}
      <Group gap={8} align="center">
        <ToneDot tone={toneForPhase(snapshot.phase)} scheme={scheme} />
        <Text size="sm" ff="monospace">
          {phaseWords(snapshot)}
        </Text>
      </Group>
      {snapshot.problem !== null && (
        <Text size="sm" style={{ color: colorForTone('blocked', scheme) }}>
          {snapshot.problem}
        </Text>
      )}
      {snapshot.lastRefusal !== null && (
        <Text size="sm" style={{ color: colorForTone('blocked', scheme) }}>
          The hub refused the last request: {snapshot.lastRefusal.message}
        </Text>
      )}
    </Stack>
  );
}

function PairingFormSection({
  pairing,
  candidates,
  scheme,
}: {
  readonly pairing: PairingOperations;
  readonly candidates: readonly DiscoveredCandidate[];
  readonly scheme: Scheme;
}): JSX.Element {
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
      if (answer.ok) {
        setName('');
        setAddress('');
        setToken('');
        setOutcome({
          ok: true,
          words: 'Pairing recorded. The hub dials it from here; its row appears below.',
        });
      } else {
        setOutcome({ ok: false, words: answer.reason });
      }
    });
  }

  return (
    <Stack gap="sm">
      <Title order={4}>Pair a server</Title>
      <Text size="sm" c="dimmed">
        The address is where this hub dials out to; the token is the one that server printed. Each
        server has its own token, so revoking one later touches nothing else.
      </Text>
      {candidates.length > 0 && (
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            Heard on the network — selecting one fills in the address and nothing else:
          </Text>
          <Group gap="xs">
            {candidates.map((candidate) => (
              <Button
                key={candidate.address}
                variant="default"
                size="xs"
                ff="monospace"
                onClick={() => setAddress(prefillFromCandidate(candidate).address)}
              >
                {candidate.label === null
                  ? candidate.address
                  : `${candidate.label} · ${candidate.address}`}
              </Button>
            ))}
          </Group>
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
        placeholder="the token that server printed"
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

function PairedServersSection({
  snapshot,
  pairing,
  scheme,
}: {
  readonly snapshot: HubSnapshot;
  readonly pairing: PairingOperations;
  readonly scheme: Scheme;
}): JSX.Element {
  const rows = serverRows(snapshot.machineState);
  return (
    <Stack gap="sm">
      <Title order={4}>Paired servers</Title>
      {snapshot.machineState === null ? (
        <Text size="sm" c="dimmed">
          Nothing to list yet — the hub&apos;s first state has not arrived.
        </Text>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No servers are paired with this hub.
        </Text>
      ) : (
        <Stack gap="xs">
          {rows.map((row) => (
            <ServerRow key={row.registrationId} row={row} pairing={pairing} scheme={scheme} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function ServerRow({
  row,
  pairing,
  scheme,
}: {
  readonly row: ServerRowView;
  readonly pairing: PairingOperations;
  readonly scheme: Scheme;
}): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function unpair(registrationId: ServerRegistrationId): void {
    setSending(true);
    void pairing.unpairServer(registrationId).then((answer) => {
      setSending(false);
      // A pairing that was revoked disappears from the broadcast state; the
      // row leaving the list is the success signal, so only a refusal draws.
      setRefusal(answer.ok ? null : answer.reason);
    });
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      style={{
        background: colorForRole('surfaceAlt', scheme),
        borderColor: colorForRole('border', scheme),
      }}
    >
      <Group gap={10} align="center" wrap="nowrap">
        <ToneDot tone={row.tone} scheme={scheme} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8}>
            <Text size="sm" fw={600}>
              {row.label}
            </Text>
            <Text size="xs" ff="monospace" c="dimmed">
              {row.serverId === null ? 'identity not yet confirmed' : row.serverId}
            </Text>
          </Group>
          <Text size="xs" ff="monospace" c="dimmed">
            {row.phase}
            {row.stores.length > 0 &&
              ` · ${String(row.stores.length)} store${row.stores.length === 1 ? '' : 's'}`}
          </Text>
          {row.problem !== null && (
            <Text size="xs" style={{ color: colorForTone('blocked', scheme) }}>
              {row.problem}
            </Text>
          )}
          {refusal !== null && (
            <Text size="xs" style={{ color: colorForTone('blocked', scheme) }}>
              {refusal}
            </Text>
          )}
        </Stack>
        <Button
          variant="default"
          size="xs"
          loading={sending}
          onClick={() => unpair(row.registrationId)}
        >
          Unpair
        </Button>
      </Group>
    </Paper>
  );
}
