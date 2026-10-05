import type {
  FrameId,
  Layout,
  MachineState,
  Provider,
  ServerRegistrationId,
  StoreId,
} from '@agentplex/protocol';
import { terminalKey } from '../store/terminals.js';
import type { StartView } from '../store/views.js';
import {
  pendingSession,
  startAwaited,
  type NamedTerminal,
  type StartMoment,
} from '../terminal/pending-pane-model.js';
import { serverLabel, type SessionListItem } from './session-list-model.js';

/**
 * The sidebar's rows for starts that are not sessions yet, as pure functions.
 *
 * A fresh spawn has no session id until the provider writes one, and the list
 * is built from scans that find sessions by that id -- so for the seconds
 * between the hub's yes and the provider's first write, the one thing a person
 * just did was nowhere in the index. These rows are that interval, and nothing
 * either side of it:
 *
 *   * Not before the yes. A start the hub has not answered may still be
 *     refused, and a row for it would be a session the screen promised and then
 *     took back.
 *   * Never after a no. A refused start is not a slow one; the form that asked
 *     says so in the hub's words.
 *   * Not once the name can no longer come. The hub names a start only down
 *     the socket that made it and forgets that socket's starts when it closes,
 *     and a provider that exits before writing an id is never named at all.
 *     So a start whose connection has closed -- redialled or not -- or one
 *     unnamed `NAMING_BOUND_MS` after its yes, is not drawn -- dropped rather than drawn as failed,
 *     because "did not start" is a guess about a process this client cannot
 *     see, and if it did write an id after all the scan lists it in its own
 *     row. `startAwaited` decides it, the same reading the start's address
 *     uses, so a row and the pane it opens agree.
 *   * Not after the naming. From then on the session has an id, so the scan
 *     will list it under its own row, and two rows would be one agent drawn
 *     twice. "Named" is decided by `pendingSession`, the same function that
 *     turns a pending pane into a session pane, so a row and a pane cannot
 *     disagree about whether the start has become something.
 *
 * Everything a row says comes from the client's own records: the ask the
 * store filed when the start was accepted, the machine the hub answered with,
 * and the tree for the project's name. Nothing is matched against the fleet,
 * because matching a new row in the state to a start by time or machine is
 * the guess `pending-pane-model.ts` refuses to make.
 */

/** One start the sidebar lists while the provider has not named its session. */
export interface PendingRow {
  /** The frame that asked for it, which is what a pending pane is opened on. */
  readonly startId: FrameId;
  readonly provider: Provider;
  readonly storeId: StoreId;
  /** The project's name in the tree, or `null` for none or one the tree no longer has. */
  readonly project: string | null;
  /** The machine the hub placed it on, spelled as every other row spells it. */
  readonly machine: string;
  readonly words: string;
}

/** One line of the sidebar's index: a session the scans found, or a start. */
export type SidebarEntry =
  | { readonly kind: 'session'; readonly item: SessionListItem }
  | { readonly kind: 'pending'; readonly row: PendingRow };

/**
 * Every start this client made that the hub accepted and has not yet named,
 * most recently asked first.
 *
 * Newest first because frame ids only grow, and it is the order the rest of
 * the index is in: by activity, and a start's activity is the asking.
 *
 * Narrowed by the chrome's machine and by nothing else. The machine is a fact
 * the row carries, from the hub's own answer; the list's other narrowings --
 * a status chip, a search over titles and directories, an age window -- are
 * about fields a session has and a start does not, and a row that vanished
 * under a narrowing it cannot be judged by would be the start going missing
 * again for a reason nobody could see.
 */
export function pendingRows(
  starts: ReadonlyMap<FrameId, StartView>,
  terminals: ReadonlyMap<string, NamedTerminal>,
  state: MachineState | null,
  layout: Layout | null,
  machine: ServerRegistrationId | null,
  moment: StartMoment,
): readonly PendingRow[] {
  const rows: PendingRow[] = [];
  for (const [startId, start] of starts) {
    const { started, refusal } = start;
    if (started === null || refusal !== null) continue;
    if (!startAwaited(start, moment)) continue;
    const terminal = terminals.get(terminalKey({ by: 'start', startId })) ?? null;
    if (pendingSession(start, terminal) !== null) continue;
    if (machine !== null && started.server !== machine) continue;
    rows.push({
      startId,
      provider: start.asked.provider,
      storeId: start.asked.storeId,
      project: projectName(layout, start),
      machine: state === null ? started.server : serverLabel(state, started.server),
      words: 'starting',
    });
  }
  return rows.sort((left, right) => right.startId - left.startId);
}

function projectName(layout: Layout | null, start: StartView): string | null {
  const { project } = start.asked;
  if (project === null || layout === null) return null;
  return layout.find((node) => node.id === project)?.name ?? null;
}

/**
 * The index in the order it is drawn: needs-you sessions, then starts, then
 * the rest.
 *
 * Below needs-you because a session waiting on a person outranks one that has
 * not begun, and above the rest because a start is the newest thing in the
 * fleet by definition -- and the row a person just caused, so the one they are
 * looking for. The sessions keep the order they arrived in on both sides of
 * the split, which is what lets this run after the list's own ordering.
 */
export function withPendingRows(
  items: readonly SessionListItem[],
  pending: readonly PendingRow[],
): readonly SidebarEntry[] {
  const session = (item: SessionListItem): SidebarEntry => ({ kind: 'session', item });
  return [
    ...items.filter((item) => item.needsYou).map(session),
    ...pending.map((row): SidebarEntry => ({ kind: 'pending', row })),
    ...items.filter((item) => !item.needsYou).map(session),
  ];
}
