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
  Anchor,
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
} from '../ui/components.js';
import { ProviderLine } from '../ui/provider-line.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { ColorSchemeControl } from './color-scheme-control.js';
import type { DiscoveredCandidate } from './pairing-form.js';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { PairingPanel } from './pairing-panel.js';
import type { PairingOperations } from './pairing-operations.js';
import { serverRows, type ServerRowView } from './server-rows.js';

/**
 * The settings screen: hub access, server pairing, and the paired-server
 * list. Everything drawn here is either typed by the user or read out of the
 * snapshot; every failure is shown in words, because a settings screen is
 * exactly the place a person goes to find out why something is not working.
 *
 * The pairing form is not drawn here: it is `PairingPanel`, which the
 * first-run wizard draws too. What this screen keeps is the section it sits
 * in, because a screen decides where a panel goes and a panel decides what
 * pairing is.
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
        <PairingPanel pairing={pairing} candidates={candidates} scheme={scheme} />
      </Section>
      <Section scheme={scheme}>
        <PairedServersSection snapshot={snapshot} pairing={pairing} scheme={scheme} />
      </Section>
      <Section scheme={scheme}>
        <ColorSchemeControl />
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
      {/* The way back to the wizard, which opens by itself only while no
          server is paired -- so from the second machine onwards this link is
          the only way to it. It lives here because Settings is where somebody
          adding a machine already is, and it is an anchor to the address
          rather than a button toggling state: the wizard has one address, and
          a link to it can be bookmarked, opened in a tab, and read aloud. */}
      <Anchor href={ONBOARDING_HASH} size="sm">
        Open the first-run guide
      </Anchor>
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
 * Where the token comes from is stated the way the two programs actually
 * behave, because the obvious guess is wrong in both halves. `install.sh`
 * writes no token -- it says so itself, and for a reason: "it never writes a
 * database path, a store path or a token, because it has no way to know one
 * and a guessed value is worse than an absent one". And `agentplex setup`,
 * which it hands over to, deliberately never prints one: `describe-outcome.ts`
 * reports the identity file and says "the pairing token is in that file",
 * which `setup-command.test.ts` pins. So the sentence here names the file and
 * not a program that hands you a secret, and the operator is sent to read it.
 *
 * Neither command carries a host. Where the bootstrap is fetched from is a
 * fact about a deployment, and the identity file's path is whatever that
 * machine was configured with -- which is exactly why setup reports it rather
 * than this screen naming one.
 */
function NoServersPaired({ scheme }: { readonly scheme: Scheme }): JSX.Element {
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        No servers are paired with this hub, so it has nothing to run a session on and no store to
        read.
      </Text>
      <Text size="sm" c="dimmed">
        Pair one above. A server is the machine that holds the sessions:{' '}
        <Mono scheme={scheme}>install.sh --role=server</Mono> puts one there and hands over to{' '}
        <Mono scheme={scheme}>agentplex setup</Mono>, which reports an identity file on that machine
        and says the pairing token is in it. The token is never printed, so it is read out of that
        file and typed above.
      </Text>
    </Stack>
  );
}

/** A command or a path, in the face addresses and ids are set in everywhere here. */
function Mono({
  scheme,
  children,
}: {
  readonly scheme: Scheme;
  readonly children: string;
}): JSX.Element {
  return (
    <Text component="span" size="sm" ff="monospace" c={colorForRole('text', scheme)}>
      {children}
    </Text>
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
