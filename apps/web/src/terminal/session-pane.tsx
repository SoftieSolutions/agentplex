import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type {
  ClientTerminalTarget,
  PendingApproval,
  SessionRef,
  TerminalSize,
} from '@agentplex/protocol';

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
import {
  browserClipboard,
  clipboardProblem,
  CLIPBOARD_EMPTY,
  NOTHING_SELECTED,
  type Clipboard,
} from './clipboard.js';
import { ApprovalsBlock } from './approvals-block.js';
import { ApprovalsTab } from './approvals-tab.js';
import { ContextPanel, type ContextBlock } from './context-panel.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { FindBar } from './find-bar.js';
import {
  breadcrumb,
  findSessionRow,
  metadataSegments,
  paneAttachment,
  statusWord,
  terminalInputNotice,
  terminalIsPartial,
  machineFor,
  terminalFeedNotice,
  terminalScopeNotice,
  toneForStatus,
  type CrumbRole,
} from './presentation.js';
import { projectForSession, type SessionProject } from '../sessions/approval-policy-model.js';
import { approvalsOldestFirst } from '../sessions/session-list-model.js';
import { StopButton } from '../sessions/stop-button.js';
import { ToneDot } from '../ui/tone-dot.js';
import { useShellForm } from '../shell/shell-form.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';
import { TabStrip } from './tab-strip.js';
import { activeTab, type SessionTab } from './tab-strip-model.js';
import { TaskBlock } from './task-block.js';
import { chunkTerminalInput } from './terminal-input.js';
import { TerminalView } from './terminal-view.js';
import { useTerminalWatch } from './use-terminal-watch.js';

/**
 * The open-session screen (mockup 7c): header row, tab strip, terminal, steer
 * bar.
 *
 * The strip is drawn with the tabs that are built, which is now two: the
 * Terminal, and Approvals while this session is holding a request. That is the
 * arrangement the strip was given a list for -- Transcript (AGX-82) and Diff
 * (AGX-105) append a tab each when they land, and until they do, nothing
 * disabled and nothing placeholder stands in for them. Approvals goes further
 * than appending, because it is the first tab whose existence is a fact about
 * the session rather than about what has been built: it is offered while
 * something is asking and not otherwise. What the mockup shows and this still
 * does not draw: the Pause / Hand off / Replay buttons.
 *
 * The context panel is the second mount point, and it works the same way. The
 * pane's body is a row -- the terminal and everything said about it on the
 * left, the panel on the right -- and the panel takes a list of blocks the way
 * the strip takes a list of tabs. One block is built: TASK, drawn for a session
 * the hub knows a task for and for no other, so a pane on an adopted session is
 * still the screen it was.
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
 * The tabs this pane has: the Terminal, and Approvals while something is
 * asking.
 *
 * It stopped being a module constant when the second tab landed, which is what
 * the strip taking a list was for. Approvals is drawn only while the session is
 * holding a request, with the count as its badge -- the mockup's `3` -- and it
 * disappears when the last one settles. A tab that stayed with `0` on it would
 * be a control that opens an empty screen, and the strip's own rule is that
 * nothing disabled and nothing placeholder stands in for a screen.
 *
 * The one-tab answer is a module constant rather than a fresh array so that a
 * pane on a session that never asks for anything -- every codex session -- hands
 * the strip the same list on every keystroke that re-renders the pane.
 *
 * Outside the component body because it needs nothing from it.
 */
const TERMINAL_TAB = 'terminal';
const APPROVALS_TAB = 'approvals';
const TERMINAL_ONLY: readonly SessionTab[] = [{ id: TERMINAL_TAB, label: 'Terminal', badge: null }];

function sessionTabs(pending: number): readonly SessionTab[] {
  if (pending === 0) return TERMINAL_ONLY;
  return [...TERMINAL_ONLY, { id: APPROVALS_TAB, label: 'Approvals', badge: String(pending) }];
}

/** A session asking for nothing, as one array rather than a new one per render. */
const NO_APPROVALS: readonly PendingApproval[] = [];

/**
 * How loudly each crumb is drawn, as the two roles `breadcrumb` hands back.
 *
 * A record keyed by the role rather than a conditional at the call site, so
 * that a third role would be a type error here instead of quietly rendering
 * in the muted one. The weights are the mockup's: where the session is, said
 * quietly, and what it is called, said at the size a person picks a window out
 * by.
 */
const CRUMB_ROLES: Record<
  CrumbRole,
  { readonly c?: string; readonly fw?: number; readonly fz?: number }
> = {
  muted: { c: 'dimmed' },
  emphatic: { fw: 700, fz: 15 },
};

/**
 * The blocks in the context panel, built from the row the hub published and
 * from where the tree has this session filed.
 *
 * It stopped being a module constant the moment the first block landed, which
 * is what the frame was built to allow: a block is `{ key, title, body }` and a
 * ticket that adds one appends to this list and writes the component its body
 * renders. COST (AGX-107) and the machine and diff blocks each arrive as
 * another entry here, and none of them touches `ContextPanel`.
 *
 * TASK is here on one condition, and it is AGX-130's whole decision: the task
 * is `row.task`, the prompt the session was started with, and a session the hub
 * has no task for -- every session it adopted off a machine rather than started
 * -- gets no block. Not an empty one: a TASK heading with nothing under it
 * reads as a fact that failed to load.
 *
 * APPROVALS is here on no condition at all, and that is the difference between
 * the two. The policy is a standing fact about what this session will and will
 * not be asked about, and the answer for a session filed under no project is
 * not "nothing to say" -- it is that there is nowhere for a rule to live, which
 * is exactly what somebody looking for the policy needs to be told. So the
 * block draws for every session, and the panel is now drawn for every session
 * that has a pane, which is the first time that has been true.
 *
 * Outside the component body because it needs nothing from it.
 */
function contextBlocks(
  task: string | null,
  project: SessionProject,
  store: HubStore,
  scheme: Scheme,
): readonly ContextBlock[] {
  const blocks: ContextBlock[] = [];
  if (task !== null) {
    blocks.push({ key: 'task', title: 'Task', body: <TaskBlock task={task} scheme={scheme} /> });
  }
  blocks.push({
    key: 'approvals',
    title: 'Approvals',
    body: <ApprovalsBlock project={project} store={store} scheme={scheme} />,
  });
  return blocks;
}

/**
 * Whether this device's main pointer is a finger, which is the whole of what
 * decides whether the header draws a paste control.
 *
 * A media query and not the user agent string. The question is not which OS
 * or which browser; it is whether the person looking at this pane has a way to
 * press Ctrl+Shift+V, and the only honest source for that is the pointer they
 * are using. An iPad with a keyboard attached reports a fine pointer and gets
 * the chord; the same iPad held in two hands reports a coarse one and gets the
 * button. No list of devices has to be kept up to date for that to keep being
 * true.
 *
 * `(pointer: coarse)` rather than `(any-pointer: coarse)`: a laptop with a
 * touchscreen has both, and drawing a control for the pointer somebody is not
 * using is how a header fills up with things nobody needs.
 *
 * Read at render, not subscribed to. A pointer changes when a keyboard case is
 * clipped on, which is rare and which re-renders this pane for other reasons
 * within moments anyway; a subscription in the pane's hot path would be
 * machinery bought for that. The guard is for jsdom, which has no `matchMedia`
 * unless a test installs one.
 */
function hasCoarsePointer(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
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
  /**
   * The system clipboard, injected for the same reason the emulator is: no
   * suite can grant a clipboard permission or answer a browser's prompt, and
   * the case worth testing hardest is the one where the browser says no.
   *
   * Constructor-time for a pane, like the store and the session it is pointed
   * at: the chords are registered once, on the first render, and hold the
   * clipboard they were given. Nothing in the app hands a pane a second one.
   */
  readonly clipboard?: Clipboard | undefined;
}

export function SessionPane({
  sessionRef,
  store: hub,
  emulators,
  clipboard = browserClipboard,
}: SessionPaneProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  /**
   * The shape the shell is in, which decides whether this pane has a context
   * panel at all.
   *
   * Read from the shell's own breakpoint rather than from a media query here.
   * `shell-form.ts` argues it: a query string and a JS pixel width are two
   * spellings of one rule, and a reader whose default font size is not 16px
   * opens a band where they disagree. It is an external store read through
   * `useSyncExternalStore`, so a resize that crosses the breakpoint re-renders
   * this pane once and a resize that does not re-renders nothing.
   */
  const form = useShellForm();
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
  /**
   * The tree, for the one question the panel asks of it: which project this
   * session is filed under, and therefore whose standing policy decides what it
   * is asked about.
   *
   * Read out of the snapshot rather than subscribed to here. The tree is
   * page-wide standing interest -- the shell declares it for every screen it
   * mounts, once, and the store re-asks for it on every reconnection -- so a
   * pane taking a second watch would be declaring interest in something that is
   * already being kept current for it. What makes reading safe is that the
   * answer has a third value: a pane handed no tree says it does not know where
   * this session is filed, which is a different sentence from "no project" and
   * the only one it is entitled to.
   */
  const project = useMemo(
    () => projectForSession(snapshot.layout, sessionRef),
    [snapshot.layout, sessionRef],
  );

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
  /**
   * The tab the user last asked for, which is a request and not the answer.
   * `activeTab` resolves it against the strip as it stands now, because the
   * strip grows a tab at a time and a pane can outlive the one it was on.
   */
  const [requestedTab, setRequestedTab] = useState<string>(TERMINAL_TAB);
  /**
   * The last thing the clipboard would not do, or `null` while it has done
   * everything asked of it.
   *
   * State, because it is a sentence the pane draws, and a sentence is the
   * whole point: a copy chord that silently does nothing and a copy chord on a
   * browser that refused the permission are the same non-event to look at, and
   * on the device where paste is a button they are the same non-event to
   * press. It clears on the next clipboard action that works, so it says what
   * happened last rather than accumulating.
   */
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);

  /**
   * Copy and paste, as the pane does them.
   *
   * Both are asynchronous because the browser's clipboard is, and both end in
   * either clearing the notice or setting one -- there is no path through
   * either that ends in nothing having visibly happened. A rejected promise
   * here is the ordinary case, not the exceptional one: an insecure origin has
   * no clipboard at all, and a permission is the user's to refuse.
   *
   * The copy reads the selection through the emulator seam rather than the
   * DOM's own `getSelection`. What a user means by selecting part of a
   * terminal is rows rejoined without the padding each one is drawn with, and
   * that is the emulator's answer; the DOM's would carry the layout.
   *
   * The paste hands the text back to the emulator instead of sending it. That
   * is the load-bearing choice on this path: the emulator normalises the line
   * endings and, when the program at the far end has asked for bracketed
   * paste, wraps the text in the markers that tell it a paste is a paste. What
   * comes out of that goes down the same `onData` the keyboard goes down, so
   * there is one route from this pane to a pty and a paste is on it.
   */
  const copySelection = useCallback(async (): Promise<void> => {
    const selection = emulatorRef.current?.selection() ?? '';
    if (selection.length === 0) {
      setClipboardNotice(NOTHING_SELECTED);
      return;
    }
    try {
      await clipboard.writeText(selection);
      setClipboardNotice(null);
    } catch (error) {
      setClipboardNotice(clipboardProblem('copy', error));
    }
  }, [clipboard]);

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const emulator = emulatorRef.current;
    if (emulator === null) return;
    let text: string;
    try {
      text = await clipboard.readText();
    } catch (error) {
      setClipboardNotice(clipboardProblem('paste', error));
      return;
    }
    if (text.length === 0) {
      setClipboardNotice(CLIPBOARD_EMPTY);
      return;
    }
    setClipboardNotice(null);
    emulator.paste(text);
  }, [clipboard]);

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
    /**
     * Copy and paste, in the corner of the keyboard reserved for exactly this.
     *
     * Ctrl+Shift+C and Ctrl+Shift+V are the terminal convention and they are
     * the convention for a reason this pane inherits whole: plain Ctrl+C is
     * the interrupt a user sends a runaway agent, and a pane that spent it on
     * copying would have taken away the one key that stops things. Cmd+Shift
     * is the same chord on a Mac, which the registry already treats as one
     * space.
     *
     * What no page can promise is that the browser lets a chord through at
     * all: Ctrl+Shift+C is the devtools inspector shortcut on some browsers
     * and platforms, and a shortcut the browser keeps is one this handler
     * never sees. Observed reaching the page on Chrome on macOS and checked
     * nowhere else, so it is written down as the risk it is rather than as a
     * fact about every browser. It is survivable where it bites: a selection
     * is still copyable with the platform's own Cmd/Ctrl+C, which xterm's
     * textarea answers. Paste is the half with no fallback on a touch device,
     * and it is on V, which is nobody's inspector.
     *
     * The run closures are async and their promises are deliberately dropped:
     * a chord has nobody to report to, and both functions already end in a
     * sentence on the pane, which is the reporting.
     */
    bindings.register({
      key: 'c',
      description: 'copy the selection',
      run: () => void copySelection(),
    });
    bindings.register({
      key: 'v',
      description: 'paste into the terminal',
      run: () => void pasteFromClipboard(),
    });
    return bindings;
  });

  /**
   * Everything the emulator produces, on its way to the pty: keystrokes, and
   * pastes, which arrive here as one very long keystroke.
   *
   * Cut into frames the protocol will accept, in order, and abandoned at the
   * first one that does not go. Abandoning is the honest half: the store
   * discards input rather than queueing it while the connection is down, so
   * pressing on would hand it the rest of a paste to discard one frame at a
   * time and would leave the user told that forty keystrokes went nowhere when
   * what went nowhere was one paste. One refusal, counted once, said once.
   */
  const sendInput = useCallback(
    (data: string): boolean => {
      for (const piece of chunkTerminalInput(data)) {
        if (!hub.sendTerminalInput(target, piece).delivered) return false;
      }
      return true;
    },
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
  const word = statusWord(row);
  const crumbs = breadcrumb(row, sessionRef);
  // The one tone that means something is happening as you look at it, which is
  // the whole of what the mockup animates. Read off the tone rather than off
  // the status a second time, so the two cannot come to disagree about which
  // status is the live one.
  const live = tone === 'running';
  const parts = metadataSegments(state, row);
  const metadata = parts.length === 0 ? null : parts.join(' · ');
  const notice = terminalInputNotice(snapshot, terminal);
  const scope = terminalScopeNotice(terminal);
  // The machine's own reading, so a pane whose hub cannot connect at all says
  // that rather than telling somebody to wait for a dial that will be refused.
  const feed = terminalFeedNotice(terminal, machineFor(state, row));
  /**
   * Every request this session is blocked on, oldest first, and the tabs that
   * follow from how many there are.
   *
   * Memoized on the row's own array: a row is a fresh object on every state
   * frame the hub sends, and this pane re-renders on every keystroke that
   * changes anything else about it, so a list rebuilt each time would hand the
   * tab a new array of new objects for requests that have not changed.
   *
   * `shownTab` resolves the request against the strip as it stands now, which
   * is the whole of what happens when the last request settles under somebody
   * looking at the Approvals tab: the tab stops being in the list and the pane
   * shows the first one that is, which is the Terminal.
   */
  const approvals = useMemo(() => approvalsOldestFirst(row?.approvals ?? NO_APPROVALS), [row]);
  const tabs = useMemo(() => sessionTabs(approvals.length), [approvals.length]);
  const shownTab = activeTab(tabs, requestedTab);
  /**
   * What the panel has to say about this session.
   *
   * Memoized on the task text, the project and the scheme rather than on the
   * row: a row is a fresh object on every state frame the hub sends, and this
   * pane re-renders on every keystroke that changes anything else about it, so
   * a list rebuilt each time would hand the panel a new array and a new block
   * element for facts that have not changed since the session started.
   */
  const blocks = useMemo(
    () => contextBlocks(row?.task ?? null, project, hub, scheme),
    [row?.task, project, hub, scheme],
  );
  // Attachment is a claim about a socket and the subscription on it, which is
  // why it is read off the store and never off the route: an address says
  // where a user pointed, not what a hub answered.
  const attachment = paneAttachment(snapshot.phase, terminal);
  const border = `1px solid ${colorForRole('border', scheme)}`;
  /**
   * Whether to draw the paste control, asked at render.
   *
   * The device with no chord is the device this whole control exists for: a
   * PWA on an iOS home screen has no Ctrl and no Cmd, so without a button
   * there is no way at all to get text into a session from that device --
   * which is the primary one. On anything with a keyboard the chord is better
   * than a button and the header stays as it was.
   */
  const pasteControl = hasCoarsePointer();

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
        {/* The three readings of one row, each from a function in
            presentation.ts, each marked with a `data-` attribute the suite
            beside this file reads. Nothing draws off those attributes: they
            are here because the alternative is asserting on Mantine's
            generated class names or on the whole bar's text run together, and
            both fail for reasons that have nothing to do with this header. */}
        <Box
          component="span"
          data-crumbs
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {crumbs.map((crumb, index) => (
            // Keyed by the role: there are two of them, they are distinct, and
            // the text is the thing that changes as a session is renamed.
            <Fragment key={crumb.role}>
              {/* Between the crumbs and nowhere else. A separator drawn after
                  each one leaves a trailing slash promising a crumb that is
                  not coming, which is what a bar built by concatenation does
                  the first time a field is absent. */}
              {index > 0 && (
                <Text component="span" c="dimmed">
                  {' / '}
                </Text>
              )}
              <Text component="span" data-crumb={crumb.role} {...CRUMB_ROLES[crumb.role]}>
                {crumb.text}
              </Text>
            </Fragment>
          ))}
        </Box>
        <Group gap={5} wrap="nowrap" data-status style={{ flex: 'none' }}>
          <ToneDot tone={tone} scheme={scheme} live={live} />
          <Text fz={10} fw={500} style={{ ...MONO_META, color: colorForTone(tone, scheme) }}>
            {word}
          </Text>
        </Group>
        {metadata !== null && (
          <Text
            data-metadata
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
        {/* The trailing controls as one group with the `ml="auto"` on it,
            rather than on whichever of them happens to come first. Two items
            each asking for the free space would have the flexbox share it
            between them and leave a gap in the middle of the controls; and
            the attachment has to be last whether or not a paste button or a
            stop is drawn beside it, which is the mockup's order and also the
            one place a person looks for it. */}
        <Group gap={8} ml="auto" wrap="nowrap" style={{ flex: 'none' }}>
          {pasteControl && (
            // Labelled for the same reason the find bar's controls are: the
            // word on it is one word, and what it acts on is the terminal.
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => void pasteFromClipboard()}
              aria-label="paste into the terminal"
            >
              Paste
            </Button>
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
          {/**
           * Whether this pane is attached, where the mockup puts it.
           *
           * The mockup draws a keyboard glyph before the word. This draws a
           * tone marker instead -- the same dot the status beside the session
           * name uses, in the same four tones -- because the app has no icon
           * set and the pictograph the mockup's HTML uses renders as a colour
           * emoji on the platform this is primarily read on. A marker whose
           * colour is the state says more than a glyph that is the same
           * picture whatever the state, and status here is a tone by rule.
           */}
          <Group
            gap={6}
            wrap="nowrap"
            px={10}
            py={4}
            style={{ borderRadius: 6, background: colorForRole('raised', scheme) }}
          >
            <Box
              w={6}
              h={6}
              style={{ borderRadius: '50%', background: colorForTone(attachment.tone, scheme) }}
            />
            <Text fz={12} fw={600} role="status" style={{ whiteSpace: 'nowrap' }}>
              {attachment.words}
            </Text>
          </Group>
        </Group>
      </Group>

      <TabStrip
        tabs={tabs}
        activeId={shownTab}
        onSelect={setRequestedTab}
        scheme={scheme}
        label="session views"
      />

      {/**
       * The body: the session on the left, what is known about it on the
       * right.
       *
       * The row starts below the strip rather than below the header, which is
       * the mockup's own arrangement turned into the one this pane can keep.
       * 7c puts its aside beside a whole main column because there the header
       * is the window's; here the header and the strip are this pane's, there
       * can be two panes side by side, and a name and an attachment chip
       * squeezed into whatever is left of a split pane after 300 fixed pixels
       * is the first thing that stops being readable.
       *
       * `minHeight: 0` is what makes the row the flexible child of the pane
       * rather than one sized by its contents: without it a long task
       * description in the panel would grow the row and push the steer bar off
       * the bottom of a pane that has a fixed height. `minWidth: 0` on the left
       * column is the same rule the other way round, and it is the one the
       * terminal depends on -- it is what lets the panel's fixed column
       * actually take its pixels from the terminal instead of overflowing the
       * pane while the terminal goes on fitting to a width it no longer has.
       *
       * Nothing here is padded, and that is a decision rather than an
       * omission. The fit addon measures the element `TerminalView` renders
       * and subtracts the terminal element's own padding and no ancestor's
       * (AGX-248, `padTerminalElement`), so padding anywhere on the way in
       * would be grid drawn past the pane's edge and clipped. The insets in
       * this body are on the rows and the blocks themselves.
       */}
      <Group gap={0} align="stretch" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          {clipboardNotice !== null && (
            // Under the header rather than inside it, and its own row rather
            // than a word beside the button: this is a whole sentence, the
            // header is a no-wrap row whose metadata is already ellipsized, and
            // a truncated explanation of why a paste did not happen is worse
            // than none. It is also where the chord's failures have to appear,
            // since on a keyboard there is no button for them to appear beside.
            <Text
              fz={11}
              px={18}
              py={6}
              role="alert"
              style={{ color: colorForTone('blocked', scheme), borderBottom: border }}
            >
              {clipboardNotice}
            </Text>
          )}

          {/**
           * What is under the tab that is open.
           *
           * The Approvals tab replaces the terminal rather than sitting beside
           * it, and the terminal is unmounted rather than hidden. Hiding it
           * would leave the fit addon measuring a box with no size and telling
           * a pty on another machine it is zero columns wide; unmounting is the
           * lifetime `terminal-view.tsx` is built for -- the emulator goes with
           * its element, and the feed does not go with either. The feed belongs
           * to the watched target and is held by the store, so coming back
           * builds an emulator and replays into it, the same path a second pane
           * opened on one session already takes.
           *
           * The find bar and the sentences about how much of the session this
           * pane is not showing go with the terminal, because that is what they
           * are about. The header, the strip and the steer bar are the pane's
           * and stay whichever tab is open: steering goes down the same
           * terminal-input path whether or not an emulator is mounted to echo
           * it.
           *
           * The strip still carries no `aria-controls`: the element a tab would
           * point at here is the emulator's own box, which belongs to
           * `terminal-view.tsx`, and naming one of the two panels and not the
           * other would be worse than naming neither.
           */}
          {shownTab === APPROVALS_TAB ? (
            <ApprovalsTab
              sessionRef={sessionRef}
              approvals={approvals}
              store={hub}
              scheme={scheme}
            />
          ) : (
            <>
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
                // The watch is declared in a subscription, which React runs
                // after the first commit, so there is one frame in which this
                // pane has no feed to hand an emulator. The same well, painted,
                // rather than an emulator built against a buffer that is about
                // to be replaced.
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

              {feed !== null && (
                <Text
                  fz={11}
                  px={18}
                  py={6}
                  style={{ color: colorForTone('blocked', scheme), borderTop: border }}
                >
                  {feed}
                </Text>
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
            </>
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

        <ContextPanel blocks={blocks} form={form} scheme={scheme} />
      </Group>
    </Stack>
  );
}
