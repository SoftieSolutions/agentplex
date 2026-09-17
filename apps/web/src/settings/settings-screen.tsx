import { useState, type JSX, type ReactNode } from 'react';
import type { ServerRegistrationId } from '@agentplex/protocol';
import type { HubSnapshot } from '../store/hub-store.js';
import type { TokenStore } from '../auth/token.js';
// The chrome's connection line owns this mapping now (AGX-119). Imported
// rather than kept here as a second copy: this screen and the top bar draw
// the same phase, and two switches over it are two chances to disagree about
// what "reconnecting" looks like.
import { toneForPhase } from '../shell/connection-model.js';
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
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import {
  parsePairingForm,
  prefillFromCandidate,
  type DiscoveredCandidate,
  type PairingFormProblems,
} from './pairing-form.js';
import type { PairingOperations } from './pairing-operations.js';
import { serverRows, type ProviderRowView, type ServerRowView } from './server-rows.js';

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
        <Stack gap={6}>
          <Text size="sm" c="dimmed">
            Heard on the network — selecting one fills in the address and stops. You still type that
            server&apos;s token: being heard is not being trusted.
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
            {candidate.host}:{candidate.port} · protocol {candidate.protocolVersion}
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

/**
 * One agent this machine can, or cannot, run.
 *
 * Drawn on every row rather than only on the unhappy ones: which version of
 * `claude` a box will actually start is the thing an operator comes here to
 * check, and a line that only appears when something is broken teaches nobody
 * where to look. The tone carries the verdict, the words carry the version, and
 * the machine's own sentence sits underneath when there is one.
 */
function ProviderLine({
  provider,
  scheme,
}: {
  readonly provider: ProviderRowView;
  readonly scheme: Scheme;
}): JSX.Element {
  return (
    <Stack gap={0}>
      <Group gap={6} align="center">
        <ToneDot tone={provider.tone} scheme={scheme} />
        <Text size="xs" ff="monospace" c="dimmed">
          {provider.words}
        </Text>
      </Group>
      {provider.problem !== null && (
        <Text size="xs" style={{ color: colorForTone(provider.tone, scheme) }}>
          {provider.problem}
        </Text>
      )}
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
        <NoServersPaired scheme={scheme} />
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

/**
 * No servers, and what to do about it.
 *
 * Both halves of the answer are named because a person reaching this line is
 * stuck at one of two different places. If a server is already running, the
 * thing that resolves this is the form directly above -- so it is named by its
 * own heading rather than linked, since a link to the screen you are reading
 * is a route to nowhere. If no server is running anywhere, no form helps, and
 * what resolves it is the installer on the machine that will hold the
 * sessions.
 *
 * The command is the README's, exactly, and carries no host: where the
 * bootstrap is fetched from is a fact about a deployment and not something a
 * screen may invent. What it is here to say is the flag.
 */
function NoServersPaired({ scheme }: { readonly scheme: Scheme }): JSX.Element {
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        No servers are paired with this hub, so it has nothing to run a session on and no store to
        read.
      </Text>
      <Text size="sm" c="dimmed">
        Pair one above. A server is the machine that holds the sessions; it prints the token that
        form asks for when{' '}
        <Text component="span" size="sm" ff="monospace" c={colorForRole('text', scheme)}>
          install.sh --role=server
        </Text>{' '}
        sets it up.
      </Text>
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
            {row.address}
          </Text>
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
          {row.providers.map((provider) => (
            <ProviderLine key={provider.name} provider={provider} scheme={scheme} />
          ))}
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
