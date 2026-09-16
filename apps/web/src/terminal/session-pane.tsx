import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { ClientTerminalTarget, SessionRef, TerminalSize } from '@agentplex/protocol';

import { terminalKey, type HubStore, type TerminalWatchView } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import {
  Box,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  useComputedColorScheme,
} from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { FindBar } from './find-bar.js';
import {
  findSessionRow,
  machineLabel,
  terminalInputNotice,
  terminalIsPartial,
  terminalScopeNotice,
  toneForStatus,
} from './presentation.js';
import { StopButton } from '../sessions/stop-button.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';
import { TerminalView } from './terminal-view.js';

/**
 * The open-session screen (mockup 7c): header row, terminal, steer bar.
 *
 * What the mockup shows and this deliberately does not draw yet: the tab
 * strip (Transcript, Diff and Approvals are their own tickets, and a control
 * with one option is not drawn), the context panel, and the Pause / Hand off
 * / Replay buttons — all later tickets.
 *
 * The terminal itself is fed by the store: the pane declares standing
 * interest in a target, and the bytes that come back go to the feed the store
 * holds for that target and from there to the emulator. They never touch
 * React, and neither does the size going the other way. What React holds is
 * the handful of facts a pane has to be able to say out loud — whether it is
 * attached, and how much of the session it is not being shown.
 */

const MONO_META = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

/**
 * Standing interest in one terminal, declared the way looking at anything is
 * declared here: a subscription whose lifetime is the component's, through
 * `useSyncExternalStore` rather than an effect. The hook never re-renders —
 * the snapshot is a constant — it exists purely so the store subscribes while
 * this pane is mounted, replays that subscription on every reconnection, and
 * gives the watch back when the pane goes.
 *
 * The bytes and the facts are not returned here. They live in the store's own
 * snapshot, which the pane already reads through `useHubSnapshot`, so a pane
 * gets the current version of them on every render rather than the version
 * that was true at mount.
 */
const NOTHING = (): null => null;
function useTerminalWatch(store: HubStore, target: ClientTerminalTarget): void {
  const subscribe = useCallback(() => store.watchTerminal(target), [store, target]);
  useSyncExternalStore(subscribe, NOTHING);
}

export interface SessionPaneProps {
  readonly sessionRef: SessionRef;
  /** The page's one hub store, handed down through the layout. */
  readonly store: HubStore;
  /**
   * Injected by tests and by nothing else; the real default is the xterm
   * factory `TerminalView` reaches for. The same seam that view already
   * declares, forwarded one level up, because the chords and the find bar are
   * the pane's and a test of them wants an emulator it can read.
   */
  readonly emulators?: EmulatorFactory | undefined;
}

export function SessionPane({ sessionRef, store: hub, emulators }: SessionPaneProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  const snapshot = useHubSnapshot(hub);
  // A pane addresses a session; the start handle the target union also allows
  // belongs to a spawn the provider has not named, which no address can name
  // either. Memoized on the ref so the watch is not given back and retaken on
  // every render.
  const target = useMemo<ClientTerminalTarget>(
    () => ({ by: 'session', storeId: sessionRef.storeId, sessionId: sessionRef.sessionId }),
    [sessionRef],
  );
  useTerminalWatch(hub, target);
  const terminal: TerminalWatchView | null = snapshot.terminals.get(terminalKey(target)) ?? null;

  // Pane-lifetime collaborators, not render data: the registry holds the
  // chord bindings. One per mounted pane; the route keys the pane so another
  // session gets a fresh one. The feed is not among them — it belongs to the
  // target and not to the pane, so that a second pane on one session replays
  // what the first one has rather than opening blank.
  const emulatorRef = useRef<TerminalEmulator | null>(null);
  const steerRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  // Whether the find bar is drawn. State and not a ref: it is the one thing
  // about the terminal that the pane renders differently.
  const [finding, setFinding] = useState(false);
  const [registry] = useState<ShortcutRegistry>(() => {
    const bindings = createShortcutRegistry();
    // The minimal real bindings; the layout ticket (AGX-34) registers its
    // pane and region navigation into this same registry.
    bindings.register({
      key: 't',
      description: 'focus the terminal',
      run: () => emulatorRef.current?.focus(),
    });
    bindings.register({
      key: 's',
      description: 'focus the steer input',
      run: () => steerRef.current?.focus(),
    });
    bindings.register({
      key: 'f',
      description: 'find in the terminal output',
      run: () => {
        setFinding(true);
        // Opening focuses through the bar's own ref callback; this is the
        // second press, on a bar that is already open, which should put the
        // caret back in it rather than do nothing.
        findRef.current?.focus();
      },
    });
    return bindings;
  });

  const sendInput = useCallback(
    (data: string): boolean => hub.sendTerminalInput(target, data).delivered,
    [hub, target],
  );

  // The one thing about the viewer the process on the other machine has to be
  // told. Stable, so a keystroke-rate re-render never rebuilds the emulator
  // that produces these.
  const sendResize = useCallback(
    (size: TerminalSize): void => {
      hub.sendTerminalResize(target, size);
    },
    [hub, target],
  );

  const emulatorReady = useCallback((emulator: TerminalEmulator | null) => {
    emulatorRef.current = emulator;
    // A find bar outlives no emulator. The emulator is rebuilt whenever a
    // constructor-time fact changes -- the colour scheme, today -- and the
    // rebuilt one starts on an empty buffer, so a bar still listening to the
    // disposed one would go on showing a count of matches that are no longer
    // anywhere. Teardown always precedes the rebuild, so this is the moment.
    if (emulator === null) setFinding(false);
  }, []);

  // The find bar's three seams onto the pane, stable so the bar's own ref
  // callback is not torn down and rebuilt on every keystroke.
  const paneSearch = useCallback(() => emulatorRef.current?.search ?? null, []);
  const closeFind = useCallback(() => {
    // The find is over: the highlights and the selection go, and so does the
    // caret -- back to the terminal, which is where it was before the chord.
    emulatorRef.current?.search.clear();
    setFinding(false);
    emulatorRef.current?.focus();
  }, []);

  // Steer, honestly: there is no steer frame in the protocol, so the words
  // are sent through the same terminal-input path as typing them, with Enter.
  // The caption beside the input says exactly that, and it is now a claim the
  // pane can make — there is a frame to put a keystroke on, so these bytes
  // reach the pty, and the input clears only when they went out.
  function sendSteer(): void {
    const input = steerRef.current;
    const text = input?.value ?? '';
    if (text.length === 0) return;
    if (sendInput(`${text}\r`) && input !== null) input.value = '';
  }

  function steerKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      sendSteer();
      return;
    }
    // The mockup's contract: Tab leaves the steer input for raw keystrokes.
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      emulatorRef.current?.focus();
    }
  }

  const state = snapshot.machineState;
  const row = findSessionRow(state, sessionRef);
  const tone = row === null ? 'idle' : toneForStatus(row.descriptor.status);
  const statusWord = row === null ? 'not reported' : row.descriptor.status;
  const name = row?.descriptor.title ?? sessionRef.sessionId;
  const metadata =
    row === null || state === null
      ? null
      : [row.descriptor.provider, machineLabel(state, row), row.descriptor.cwd]
          .filter((part): part is string => part !== null)
          .join(' · ');
  const notice = terminalInputNotice(snapshot, terminal);
  const scope = terminalScopeNotice(terminal);
  const border = `1px solid ${colorForRole('border', scheme)}`;

  return (
    <Stack
      gap={0}
      // The pane fills whatever cell the layout gives it; before AGX-34 this
      // was the whole viewport, and now the viewport is the layout screen's.
      style={{ height: '100%' }}
      // Capture phase, on the pane's root: a chord is decided here, before
      // the emulator's own keydown listener can turn it into bytes for the
      // pty. React's onKeyDownCapture is the capture-phase listener.
      onKeyDownCapture={(event) => registry.handleKeyDown(event)}
    >
      <Group gap={10} px={18} py={10} style={{ borderBottom: border }} wrap="nowrap">
        <Text c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {sessionRef.storeId} /
        </Text>
        <Text fw={700} fz={15} style={{ whiteSpace: 'nowrap' }}>
          {name}
        </Text>
        <Group gap={5} wrap="nowrap">
          <Box
            w={6}
            h={6}
            style={{ borderRadius: '50%', background: colorForTone(tone, scheme) }}
          />
          <Text fz={10} fw={500} style={{ ...MONO_META, color: colorForTone(tone, scheme) }}>
            {statusWord}
          </Text>
        </Group>
        {metadata !== null && (
          <Text
            c="dimmed"
            fz={10}
            fw={500}
            style={{
              ...MONO_META,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {metadata}
          </Text>
        )}
        {/* The same button the card carries, off the same published fact.
            Nothing is drawn for a session nobody is running, or for a holder
            mid-turn. */}
        <StopButton
          store={hub}
          sessionRef={sessionRef}
          holder={row?.holder ?? null}
          scheme={scheme}
          size="xs"
        />
      </Group>

      {finding && (
        <FindBar
          search={paneSearch}
          truncated={() => terminalIsPartial(terminal)}
          scheme={scheme}
          onClose={closeFind}
          inputRef={findRef}
        />
      )}

      {terminal === null ? (
        // The watch is declared in a subscription, which React runs after the
        // first commit, so there is one frame in which this pane has no feed
        // to hand an emulator. The same well, painted, rather than an
        // emulator built against a buffer that is about to be replaced.
        <Box style={{ flex: 1, background: colorForRole('terminalBackground', scheme) }} />
      ) : (
        <TerminalView
          feed={terminal.feed}
          scheme={scheme}
          onData={sendInput}
          onResize={sendResize}
          emulatorReady={emulatorReady}
          emulators={emulators}
        />
      )}

      {scope !== null && (
        <Text
          fz={11}
          px={18}
          py={6}
          style={{ color: colorForRole('textFaint', scheme), borderTop: border }}
        >
          {scope}
        </Text>
      )}

      {notice !== null && (
        <Text fz={11} px={18} py={6} style={{ color: colorForTone('blocked', scheme) }}>
          {notice}
        </Text>
      )}

      <Group gap={8} px={18} py={10} style={{ borderTop: border }} wrap="nowrap">
        <Text fz={11} fw={500} style={{ ...MONO_META, color: colorForRole('accent', scheme) }}>
          steer
        </Text>
        <TextInput
          ref={steerRef}
          style={{ flex: 1 }}
          placeholder="Tell the agent something, or Tab to type raw keystrokes"
          onKeyDown={steerKeyDown}
          aria-label="steer the agent"
        />
        <Text c="dimmed" fz={10} fw={500} style={{ ...MONO_META, whiteSpace: 'nowrap' }}>
          sent as typed input
        </Text>
        <Button onClick={sendSteer}>Send</Button>
      </Group>
    </Stack>
  );
}
