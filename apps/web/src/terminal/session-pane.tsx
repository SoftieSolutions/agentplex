import {
  Fragment,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  assertNever,
  type ClientTerminalTarget,
  type PendingApproval,
  type SessionRef,
  type TerminalSize,
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
  terminalInputNotice,
  terminalIsPartial,
  machineFor,
  terminalFeedNotice,
  terminalScopeNotice,
  type CrumbRole,
} from './presentation.js';
import { projectForSession, type SessionProject } from '../sessions/approval-policy-model.js';
import {
  approvalsOldestFirst,
  toneForSession,
  wordsForSession,
} from '../sessions/session-list-model.js';
import { PauseButton } from '../sessions/pause-button.js';
import { StopButton } from '../sessions/stop-button.js';
import { ToneDot } from '../ui/tone-dot.js';
import { useShellForm } from '../shell/shell-form.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';
import { TabStrip } from './tab-strip.js';
import { activeTab, type SessionTab } from './tab-strip-model.js';
import { TaskBlock } from './task-block.js';
import { LAST_STEP, replayOffered, replayState } from './replay-model.js';
import { ReplayBar } from './replay-bar.js';
import { transcriptState, TRANSCRIPT_COUNT, type TranscriptAsks } from './transcript-model.js';
import { TranscriptPanel } from './transcript-panel.js';
import { chunkTerminalInput } from './terminal-input.js';
import { TerminalView } from './terminal-view.js';
import { useTerminalWatch } from './use-terminal-watch.js';

/**
 * The open-session screen (mockup 7c): header row, tab strip, terminal, steer
 * bar.
 *
 * The strip is drawn with the tabs that are built, which is now three:
 * Terminal, Transcript beside it, and Approvals while this session is holding
 * a request. That is the arrangement the strip was given a list for -- Diff
 * (AGX-105) appends one more when it lands, and until it does, nothing
 * disabled and nothing placeholder stands in for it. Approvals goes further
 * than appending, because it is the one tab whose existence is a fact about
 * the session rather than about what has been built: it is offered while
 * something is asking and not otherwise. What the mockup shows and this still
 * does not draw: the Pause / Hand off / Replay buttons.
 *
 * Choosing another tab *unmounts* the terminal rather than hiding it, which is
 * the one thing about the switch below that is not a style. A hidden terminal
 * measures zero rows and zero columns, and the emulator would report that
 * across two machines as a resize -- so the program at the far end would
 * redraw itself for a screen nobody is looking at, and would still be that
 * shape when the tab came back. The bytes are not lost by unmounting: the feed
 * belongs to the target and lives in the store, so returning to the tab
 * replays what arrived while it was away.
 *
 * The context panel is the second mount point, and it works the same way. The
 * pane's body is a row -- the tab that is open and everything said about it on
 * the left, the panel on the right -- and the panel takes a list of blocks the
 * way the strip takes a list of tabs. One block is built: TASK, drawn for a
 * session the hub knows a task for and for no other, so a pane on an adopted
 * session is still the screen it was.
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
 * The tabs this pane has: Terminal, Transcript, and Approvals while something
 * is asking.
 *
 * This is the one list, and it is a function of the pane for two separate
 * reasons that arrived on two branches and want the same shape. A tab needs
 * something only a mounted pane knows -- the id of the element it shows, for
 * `aria-controls` -- because two panes can be open on one session and two
 * elements cannot share an id, so the pane mints a prefix and each tab is
 * handed the id of its own panel. And a tab can be a fact about the session
 * rather than about what has been built: Approvals is drawn only while the
 * session is holding a request, with the count as its badge -- the mockup's
 * `3` -- and it disappears when the last one settles. A tab that stayed with
 * `0` on it would be a control that opens an empty screen, and the strip's own
 * rule is that nothing disabled and nothing placeholder stands in for a
 * screen.
 *
 * Terminal stays first, which is what makes it the default: `activeTab` falls
 * back to `tabs[0]`, so the ordering is the rule rather than a flag somewhere.
 * Transcript is second and carries no badge -- there is no count of a
 * transcript that means anything before it has been read -- and Approvals is
 * last because it is the one that comes and goes, and a tab that inserted
 * itself between two standing ones would move them under the pointer.
 *
 * Outside the component body because it needs nothing from it but the two
 * facts it is handed.
 */
const TERMINAL_TAB = 'terminal';
const TRANSCRIPT_TAB = 'transcript';
const APPROVALS_TAB = 'approvals';

/**
 * Which tab is being shown, as a closed set.
 *
 * A union and not the strip's `string`, so the body below ends in an
 * `assertNever`: the day a fourth panel is added, a pane that has not grown a
 * case fails to compile rather than drawing nothing under a tab somebody can
 * press.
 */
type ShownTab = typeof TERMINAL_TAB | typeof TRANSCRIPT_TAB | typeof APPROVALS_TAB;

function sessionTabs(paneId: string, pending: number): readonly SessionTab[] {
  const standing: readonly SessionTab[] = [
    { id: TERMINAL_TAB, label: 'Terminal', badge: null, panelId: `${paneId}-terminal` },
    { id: TRANSCRIPT_TAB, label: 'Transcript', badge: null, panelId: `${paneId}-transcript` },
  ];
  if (pending === 0) return standing;
  return [
    ...standing,
    {
      id: APPROVALS_TAB,
      label: 'Approvals',
      badge: String(pending),
      panelId: `${paneId}-approvals`,
    },
  ];
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
   * The reads this pane has made, or `null` before it has made one.
   *
   * The pane's and not the store's, because the store files every client's
   * answers together and two panes can be open on one session. These ids are
   * what say which of those answers are this pane's, and they are why a second
   * pane opening its own tab cannot repaint this one.
   *
   * Two of them, because a refresh is a second question about the same session:
   * `latest` is what the tab's sentence is about, and `answered` is the list it
   * goes on drawing until the new answer lands.
   */
  const [transcriptAsks, setTranscriptAsks] = useState<TranscriptAsks | null>(null);
  /**
   * The step replay stands on, as a request, or `null` while the tab is live.
   *
   * A request and not a resolved index, which is what lets it be plain state
   * with nothing watching it: Replay presses it before the transcript has
   * necessarily been read, and a refresh can answer with fewer steps than the
   * one somebody is standing on. Both are settled at render by `replayState`,
   * which clamps against the list as it stands now -- see `replay-model.ts`
   * for why the clamp lives there and not in an effect here.
   */
  const [replayPosition, setReplayPosition] = useState<number | null>(null);
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

  /**
   * Reads the transcript, and remembers the frame the read went out under.
   *
   * A command, which is how every other once-only intent leaves this app: a
   * connection that blinks queues it rather than dropping it, and the id is
   * minted at acceptance so the pane's record of what it asked matches the id
   * the answer will carry. A read that was not accepted leaves the pane on
   * whatever it asked before, which is what makes the Refresh button's failure
   * mode "nothing changed" rather than "the history vanished".
   *
   * The id it keeps beside the new one is whichever of its own reads it has an
   * answer to, decided here rather than watched for: the store is asked once,
   * at the moment of asking again, which is the one moment the question has an
   * answer that cannot change under it. That is what a `useEffect` on the
   * snapshot would have been for, and there is nothing for one to do.
   */
  const readTranscript = useCallback((): void => {
    const outcome = hub.sendCommand({
      type: 'session-transcript',
      storeId: sessionRef.storeId,
      sessionId: sessionRef.sessionId,
      count: TRANSCRIPT_COUNT,
    });
    if (!outcome.accepted) return;
    const id = outcome.id;
    setTranscriptAsks((asks) => {
      if (asks === null) return { latest: id, answered: null };
      const answers = hub.getSnapshot().transcripts;
      const drawn = answers.has(asks.latest) ? asks.latest : asks.answered;
      return { latest: id, answered: drawn };
    });
  }, [hub, sessionRef]);

  /**
   * The tab the user asked for, and the read that choosing Transcript implies.
   *
   * The ask is here rather than in an effect, which is the rule this app
   * follows and also the simpler thing: choosing a tab is an event, a read is
   * something that happens because somebody did that, and an effect would be
   * the same call reached by watching a variable change. It fires on the first
   * showing only -- a pane that has asked keeps its answer, and the Refresh
   * button is how somebody asks again.
   */
  const selectTab = useCallback(
    (id: string): void => {
      setRequestedTab(id);
      if (id === TRANSCRIPT_TAB && transcriptAsks === null) readTranscript();
    },
    [readTranscript, transcriptAsks],
  );

  /**
   * Replay, from the header: the Transcript tab, and the last step of it.
   *
   * Through `selectTab` rather than beside it, so the read that showing the
   * tab implies is issued the one way it ever is. The position asked for is
   * "the last step" and not a number, because at this moment the list may
   * not have arrived -- the clamp in `replayState` lands it on the end once it
   * has, and leaves the tab live until then.
   */
  const startReplay = useCallback((): void => {
    selectTab(TRANSCRIPT_TAB);
    setReplayPosition(LAST_STEP);
  }, [selectTab]);

  const exitReplay = useCallback((): void => {
    setReplayPosition(null);
  }, []);

  const state = snapshot.machineState;
  const row = findSessionRow(state, sessionRef);
  // The whole row and not the status alone: a session set down at a boundary
  // is drawn paused whatever its transcript last said, and the word beside the
  // dot says pausing for the interval before the boundary is reached.
  const tone = toneForSession(row);
  const word = wordsForSession(row);
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
  // One prefix per mounted pane, so two panes on one session do not put two
  // elements under one id -- which is what `aria-controls` would otherwise
  // point a screen reader at.
  const paneId = useId();
  const tabs = useMemo(() => sessionTabs(paneId, approvals.length), [paneId, approvals.length]);
  const shownTab = activeTab(tabs, requestedTab);
  // Narrowed to the closed set before the body switches on it. `activeTab`
  // answers in the strip's vocabulary, which is a string, and the pane is the
  // place that knows which strings it drew. The fallback is the Terminal
  // rather than a throw for the same reason `activeTab` has one: a request can
  // name a tab this session is not offering.
  const shown: ShownTab =
    shownTab === TRANSCRIPT_TAB || shownTab === APPROVALS_TAB ? shownTab : TERMINAL_TAB;
  const transcript = transcriptState(transcriptAsks, snapshot.transcripts, snapshot.lastRefusal);
  /**
   * The replay window over that list, resolved at render against the count
   * as it stands now. `null` for the position means live, which it also is on
   * an empty list whatever was asked for -- so the bar only ever stands on a
   * step that exists.
   */
  const replay = replayState(transcript.activities, replayPosition);
  const replayBar =
    replayOffered(transcript) && replay.position !== null && replay.status !== null ? (
      <ReplayBar
        position={replay.position}
        count={transcript.activities.length}
        status={replay.status}
        onSeek={setReplayPosition}
        onExit={exitReplay}
        scheme={scheme}
      />
    ) : null;
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

  /**
   * The one panel that is mounted, chosen by an exhaustive switch.
   *
   * Inside the component body because every arm needs something from it -- the
   * feed, the emulator seams, the transcript state, the requests this session
   * is blocked on -- and marked as such rather than lifted out with a dozen
   * arguments, which is the shape the rule about functions outside a component
   * exists to avoid reaching for.
   *
   * The find bar and the sentences about how much of the session this pane is
   * not showing are inside the terminal's arm, because that is what they are
   * about: there is nothing to find in a transcript that was fetched whole and
   * nothing partial about a list of requests. The header, the strip and the
   * steer bar are the pane's and stay whichever tab is open -- steering goes
   * down the same terminal-input path whether or not an emulator is mounted to
   * echo it.
   */
  function paneBody(tab: ShownTab): JSX.Element {
    switch (tab) {
      case TERMINAL_TAB:
        return (
          <Box
            id={`${paneId}-terminal`}
            role="tabpanel"
            aria-labelledby={`${paneId}-terminal-tab`}
            // `minWidth: 0` for the reason the column outside it carries one:
            // the panel is now between the terminal and that column, and a
            // flex child that will not shrink puts the terminal's fitted width
            // back past the pane's edge.
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
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
          </Box>
        );
      case TRANSCRIPT_TAB:
        return (
          <TranscriptPanel
            // The transcript's own sentence stays; only the list is windowed.
            // The bar carries the replay sentence, so the two cannot be read
            // as one status contradicting itself.
            state={{ ...transcript, activities: replay.activities }}
            bar={replayBar}
            onRefresh={readTranscript}
            scheme={scheme}
            panelId={`${paneId}-transcript`}
            labelledBy={`${paneId}-transcript-tab`}
          />
        );
      case APPROVALS_TAB:
        // Wrapped rather than given the two ids itself: the tab's panel is a
        // region, and what `ApprovalsTab` draws is a list -- putting
        // `role="tabpanel"` on the `ul` would cost a screen reader the count
        // of what is waiting, which is the one thing that list is for.
        return (
          <Box
            id={`${paneId}-approvals`}
            role="tabpanel"
            aria-labelledby={`${paneId}-approvals-tab`}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <ApprovalsTab
              sessionRef={sessionRef}
              approvals={approvals}
              project={project}
              store={hub}
              scheme={scheme}
            />
          </Box>
        );
      default:
        return assertNever(tab, 'session tab');
    }
  }

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
          {/* Drawn whether or not the transcript has been read, because the
              press is what reads it: gating it on an answer would make it
              unreachable from the Terminal tab, which is where somebody is
              when they want to see how the session got here. Labelled for the
              reason the paste control is: the word on it is one word. */}
          <Button
            size="compact-xs"
            variant="default"
            onClick={startReplay}
            aria-label="replay this session’s transcript"
          >
            Replay
          </Button>
          {/* The same button the card carries, off the same published fact.
              Nothing is drawn for a session nobody is running, or for a holder
              mid-turn. */}
          {/* Pause is the header action the mockup draws first. Offered to any
              held session, mid-turn included -- that is what a pause is for --
              and it reads Resume once the holder says the session is paused. */}
          <PauseButton
            store={hub}
            sessionRef={sessionRef}
            holder={row?.holder ?? null}
            scheme={scheme}
            size="xs"
          />
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
        onSelect={selectTab}
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

          {/* What is under the tab that is showing, as one switch that ends
              in `assertNever`. Exactly one panel is mounted at a time and the
              others are gone rather than hidden -- see the note at the top of
              this file for why a hidden terminal is not a free thing to leave
              lying about. */}
          {paneBody(shown)}

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
