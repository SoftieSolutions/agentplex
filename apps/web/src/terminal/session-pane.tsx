import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { SessionRef } from '@agentplex/protocol';

import type { HubStore } from '../store/hub-store.js';
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
import { createTerminalFeed, DEFAULT_FEED_BYTES, type TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { FindBar } from './find-bar.js';
import {
  findSessionRow,
  machineLabel,
  terminalInputNotice,
  toneForStatus,
} from './presentation.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';
import { TerminalView } from './terminal-view.js';

/**
 * The open-session screen (mockup 7c): header row, terminal, steer bar.
 *
 * What the mockup shows and this deliberately does not draw yet: the tab
 * strip (Transcript, Diff and Approvals are their own tickets, and a control
 * with one option is not drawn), the context panel, and the Pause / Hand off
 * / Replay buttons — all later tickets. The terminal itself renders whatever
 * the chunk feed carries; no protocol frame delivers terminal output yet, so
 * until the terminal-frames ticket lands the feed stays empty and the input
 * notice under the pane says, in words, that typing goes nowhere.
 */

const MONO_META = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

/**
 * Standing interest in one session, declared the way looking at anything is
 * declared here: a subscription whose lifetime is the component's, through
 * `useSyncExternalStore` rather than an effect. The hook never re-renders —
 * the snapshot is a constant — it exists purely so the store replays this
 * interest on every reconnection while the pane is mounted.
 */
const NOTHING = (): null => null;
function useSessionInterest(store: HubStore, sessionRef: SessionRef): void {
  const subscribe = useCallback(() => store.subscribeSession(sessionRef), [store, sessionRef]);
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
  useSessionInterest(hub, sessionRef);

  // Pane-lifetime collaborators, not render data: the feed buffers terminal
  // bytes outside React, the registry holds the chord bindings. One of each
  // per mounted pane; the route keys the pane so another session gets fresh
  // ones.
  const emulatorRef = useRef<TerminalEmulator | null>(null);
  const steerRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const [feed] = useState<TerminalFeed>(() => createTerminalFeed({ maxBytes: DEFAULT_FEED_BYTES }));
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

  // Words about undelivered keystrokes — never the keystrokes themselves.
  const [undelivered, setUndelivered] = useState<string | null>(null);

  const sendInput = useCallback(
    (data: string): boolean => {
      const outcome = hub.sendTerminalInput(sessionRef, data);
      setUndelivered(outcome.delivered ? null : outcome.reason);
      return outcome.delivered;
    },
    [hub, sessionRef],
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
  const feedTruncated = useCallback(() => feed.truncated, [feed]);
  const closeFind = useCallback(() => {
    // The find is over: the highlights and the selection go, and so does the
    // caret -- back to the terminal, which is where it was before the chord.
    emulatorRef.current?.search.clear();
    setFinding(false);
    emulatorRef.current?.focus();
  }, []);

  // Steer, honestly: there is no steer frame in the protocol, so the words
  // are sent through the same terminal-input path as typing them, with Enter.
  // The caption beside the input says exactly that.
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
  const notice = terminalInputNotice(snapshot, undelivered);
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
      </Group>

      {finding && (
        <FindBar
          search={paneSearch}
          truncated={feedTruncated}
          scheme={scheme}
          onClose={closeFind}
          inputRef={findRef}
        />
      )}

      <TerminalView
        feed={feed}
        scheme={scheme}
        onData={sendInput}
        emulatorReady={emulatorReady}
        emulators={emulators}
      />

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
