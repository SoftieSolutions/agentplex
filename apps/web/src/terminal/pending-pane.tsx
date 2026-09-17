import { useCallback, useMemo, type JSX } from 'react';
import type { ClientTerminalTarget, FrameId, TerminalSize } from '@agentplex/protocol';

import { terminalKey, type HubStore, type TerminalWatchView } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Group, Stack, Text, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme, type Tone } from '../ui/tokens.js';
import type { EmulatorFactory } from './emulator.js';
import { pendingWords, type PendingWords } from './pending-pane-model.js';
import { terminalInputNotice, terminalScopeNotice } from './presentation.js';
import { chunkTerminalInput } from './terminal-input.js';
import { TerminalView } from './terminal-view.js';
import { useTerminalWatch } from './use-terminal-watch.js';

/**
 * The pane a session gets before it has a name.
 *
 * A start is submitted and this opens immediately, in the tree, on the handle
 * the asking already has -- the id of the `session-start` frame that carried
 * it. What it is for is the gap: the provider mints its own session id and
 * writes it moments after the fork, and until then there is a live process
 * with output to show and no `{ storeId, sessionId }` to address it by. A pane
 * that waited for the id would be blank for exactly the seconds a person is
 * watching hardest, and the thing it was waiting for is a scan.
 *
 * So it says what it knows in words and shows the terminal it is allowed to
 * watch, and it stops being this pane the moment the hub says which session
 * the start became -- `rebindPending` in the layout store, off a fact rather
 * than a timer. This component never rebinds itself: the tree is the layout
 * store's, and a pane that rewrote it would be doing it from an effect.
 *
 * It is deliberately less than the session pane. No steer bar, no find, no
 * stop: every one of those addresses a session, this has none yet, and a
 * control that could only be pressed once the pane had already become
 * something else is a control for nobody. Keystrokes do go down -- the
 * protocol addresses input by start handle for the same reason it addresses
 * output that way -- so an agent that asks a question in its first second can
 * be answered.
 */

export interface PendingPaneProps {
  /** The `session-start` frame this pane is waiting on. */
  readonly startId: FrameId;
  /** The page's one hub store, handed down through the layout. */
  readonly store: HubStore;
  /** Injected by tests and by nothing else; the real default is the xterm factory. */
  readonly emulators?: EmulatorFactory | undefined;
}

function toneFor(words: PendingWords): Tone {
  switch (words.kind) {
    case 'refused':
      return 'blocked';
    case 'starting':
      return 'running';
    case 'asking':
      return 'idle';
  }
}

export function PendingPane({ startId, store: hub, emulators }: PendingPaneProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  const snapshot = useHubSnapshot(hub);
  // The one target a spawn can be named by. Memoized on the handle so the
  // watch is not given back and retaken on every render.
  const target = useMemo<ClientTerminalTarget>(() => ({ by: 'start', startId }), [startId]);
  useTerminalWatch(hub, target);
  const terminal: TerminalWatchView | null = snapshot.terminals.get(terminalKey(target)) ?? null;

  const sendInput = useCallback(
    (data: string): boolean => {
      for (const piece of chunkTerminalInput(data)) {
        if (!hub.sendTerminalInput(target, piece).delivered) return false;
      }
      return true;
    },
    [hub, target],
  );

  const sendResize = useCallback(
    (size: TerminalSize): void => {
      hub.sendTerminalResize(target, size);
    },
    [hub, target],
  );

  const words = pendingWords(
    startId,
    snapshot.lastStarted,
    snapshot.lastRefusal,
    snapshot.machineState,
  );
  const tone = toneFor(words);
  const scope = terminalScopeNotice(terminal);
  const notice = terminalInputNotice(snapshot, terminal);
  const border = `1px solid ${colorForRole('border', scheme)}`;

  return (
    <Stack gap={0} style={{ height: '100%' }}>
      <Group gap={10} px={18} py={10} style={{ borderBottom: border }} wrap="nowrap">
        <Box w={6} h={6} style={{ borderRadius: '50%', background: colorForTone(tone, scheme) }} />
        <Text fz={13} role="status" style={{ color: colorForTone(tone, scheme) }}>
          {words.words}
        </Text>
      </Group>

      {words.kind === 'refused' ? (
        // The pane is the refusal now. No terminal under it: the hub said this
        // start did not happen, and a rectangle that went on looking like a
        // terminal would be a pane waiting for output that is never coming.
        <Stack align="center" justify="center" gap={4} style={{ flex: 1 }}>
          <Text fz={12} style={{ color: colorForRole('textMuted', scheme) }}>
            Nothing was started here
          </Text>
        </Stack>
      ) : terminal === null ? (
        // The watch is declared in a subscription, which React runs after the
        // first commit, so there is one frame in which this pane has no feed
        // to hand an emulator. The same well, painted.
        <Box style={{ flex: 1, background: colorForRole('terminalBackground', scheme) }} />
      ) : (
        <TerminalView
          feed={terminal.feed}
          scheme={scheme}
          onData={sendInput}
          onResize={sendResize}
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
    </Stack>
  );
}
