import { useSyncExternalStore, type JSX } from 'react';
import type { FrameId, MachineState, ServerRegistrationId } from '@agentplex/protocol';
import {
  withPendingRows,
  type PendingRow,
  type SidebarEntry,
} from '../sessions/pending-rows-model.js';
import type { SessionFiltersStore } from '../sessions/session-filters-store.js';
import {
  activeFilterCount,
  ageLabel,
  effectiveFilters,
  placeLabel,
  visibleSessions,
  type SessionListFilters,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { Box, Group, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';

/**
 * The sidebar's other reading of the fleet: every session, one line each, in
 * the order the list screen puts them in -- needs-you first, then by activity.
 *
 * It is a way to get somewhere, not a screen: the cards in the content region
 * are where a session is read, and this is the standing index beside them, so
 * a row carries a name, a tone, an age and where the session is, and no
 * controls at all. Everything it decides comes from `session-list-model.ts`,
 * including the order, the narrowing and the second line, so the two readings
 * cannot disagree about which sessions exist, which project one is in or which
 * machine one is on.
 *
 * The mockup's filter row and its applied-filter summary are drawn above this
 * list rather than in it (`sidebar-filter.tsx`), and these rows answer them.
 * There is one set of narrowings for the fleet, held in one place, read here
 * and by the cards on the list screen at the same moment: a badge counting
 * three filters over an index still listing what they took away would be
 * counting rows a person can see. So this file has no controls of its own
 * still -- it is an index, and what narrows it is the row above it.
 *
 * Starts the hub accepted and the provider has not named are rows here too
 * (`pending-rows-model.ts` decides which), drawn between the sessions waiting
 * on somebody and the rest. They are buttons rather than links: a start has no
 * address another tab could open, so what a press does is open the pending
 * pane in this one, through the shell's `onOpenPending`.
 */
export interface SidebarSessionsProps {
  readonly state: MachineState;
  /** Accepted starts with no session yet, already narrowed to the machine. */
  readonly pending: readonly PendingRow[];
  /** Opens the pane waiting on a start, by the frame that asked for it. */
  readonly onOpenPending: (startId: FrameId) => void;
  /** The page's narrowings, the same ones the filter row above writes. */
  readonly filters: SessionFiltersStore;
  /** The machine the chrome is narrowed to, or `null` for all of them. */
  readonly machine: ServerRegistrationId | null;
  readonly scheme: Scheme;
  /** The clock, injected so a test can render fixed ages. */
  readonly now?: () => number;
}

export function SidebarSessions({
  state,
  pending,
  onOpenPending,
  filters,
  machine,
  scheme,
  now = Date.now,
}: SidebarSessionsProps): JSX.Element {
  const held = useSyncExternalStore(filters.subscribe, filters.getSnapshot);
  const moment = now();
  // The selector's machine composed in rather than read out, as the list
  // screen composes it: the chrome owns that fact and the popover's own
  // Machine section is a different field. Through `effectiveFilters` for the
  // reason the row above reads it that way -- a choice whose option has left
  // the fleet narrows nothing, so it cannot empty this index invisibly.
  const narrowings = effectiveFilters(state, { ...held, server: machine }, moment);
  const rows = visibleSessions(state, narrowings, moment);
  // Empty only when there is nothing at all to list: a start is a row, and a
  // sentence saying no store holds a session over the one just started would
  // be the sidebar contradicting what the form beside it said a moment ago.
  if (rows.length === 0 && pending.length === 0) {
    return (
      <Text fz={12} c={colorForRole('textMuted', scheme)}>
        {emptyWords(narrowings, machine)}
      </Text>
    );
  }
  return (
    <Stack gap={1}>
      {withPendingRows(rows, pending).map((entry) => (
        <SidebarEntryRow
          key={entryKey(entry)}
          entry={entry}
          moment={moment}
          scheme={scheme}
          onOpenPending={onOpenPending}
        />
      ))}
    </Stack>
  );
}

/**
 * Why the index is empty, which is never "there are no sessions" while a
 * narrowing is on.
 *
 * The row above is already counting what the narrowings hid, and a sentence
 * under it saying no store holds a session would have the sidebar telling
 * somebody their fleet is gone when it is one Clear away. The list screen's
 * `emptyListing` answers the same question at length and with somewhere to go;
 * this is a column at least 240px wide whose undo is the line directly above
 * it, so it says the one thing that column can act on.
 *
 * The typed search counts here although `activeFilterCount` leaves it out: the
 * count is for the badge, where a person can see the box for themselves, and
 * this is a sentence about why there is nothing under it.
 */
function emptyWords(filters: SessionListFilters, machine: ServerRegistrationId | null): string {
  if (activeFilterCount(filters) > 0 || filters.search.trim() !== '') {
    return 'no session here matches the narrowing';
  }
  return machine === null ? 'no sessions in any store yet' : 'no sessions on this machine';
}

/** A React key no session's can collide with, since a session key is a ref's. */
function entryKey(entry: SidebarEntry): string {
  return entry.kind === 'session' ? entry.item.key : `start:${String(entry.row.startId)}`;
}

interface SidebarEntryRowProps {
  readonly entry: SidebarEntry;
  readonly moment: number;
  readonly scheme: Scheme;
  readonly onOpenPending: (startId: FrameId) => void;
}

function SidebarEntryRow({
  entry,
  moment,
  scheme,
  onOpenPending,
}: SidebarEntryRowProps): JSX.Element {
  switch (entry.kind) {
    case 'session':
      return <SidebarSessionRow item={entry.item} moment={moment} scheme={scheme} />;
    case 'pending':
      return <SidebarPendingRow row={entry.row} scheme={scheme} onOpen={onOpenPending} />;
  }
}

interface SidebarPendingRowProps {
  readonly row: PendingRow;
  readonly scheme: Scheme;
  readonly onOpen: (startId: FrameId) => void;
}

/**
 * A start with no session yet: the provider where a session's name goes,
 * because the provider is the one thing it is called so far, and its words
 * where a session's age goes, because it has no activity to be aged by.
 *
 * Idle-toned rather than running: the hub placed it, and nothing has said the
 * agent is doing anything yet.
 */
function SidebarPendingRow({ row, scheme, onOpen }: SidebarPendingRowProps): JSX.Element {
  return (
    <UnstyledButton
      component="button"
      type="button"
      // The place line in the name as it is drawn, so two starts of one
      // provider on one machine in two projects are two names, and the words
      // a person reads off the row are words they can say to reach it.
      aria-label={`open the ${row.provider} session ${row.words} in ${placeLabel(row)}`}
      onClick={() => onOpen(row.startId)}
      style={{ display: 'block', width: '100%', padding: '6px 8px', borderRadius: 6, minWidth: 0 }}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <Box
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: colorForTone('idle', scheme),
          }}
        />
        <Text
          component="span"
          fz={12.5}
          truncate="end"
          c={colorForRole('textSecondary', scheme)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {row.provider}
        </Text>
        <Text
          component="span"
          ff="monospace"
          fz={10}
          c={colorForRole('textMuted', scheme)}
          style={{ flexShrink: 0 }}
        >
          {row.words}
        </Text>
      </Group>
      <Text
        component="span"
        ff="monospace"
        fz={10}
        truncate="end"
        c={colorForRole('textMuted', scheme)}
        style={{ display: 'block', paddingLeft: 14 }}
      >
        {placeLabel(row)}
      </Text>
    </UnstyledButton>
  );
}

interface SidebarSessionRowProps {
  readonly item: SessionListItem;
  readonly moment: number;
  readonly scheme: Scheme;
}

function SidebarSessionRow({ item, moment, scheme }: SidebarSessionRowProps): JSX.Element {
  return (
    <UnstyledButton
      component="a"
      href={sessionHash(item.ref)}
      aria-label={`open ${item.name}`}
      style={{ display: 'block', padding: '6px 8px', borderRadius: 6, minWidth: 0 }}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <Box
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: colorForTone(item.tone, scheme),
          }}
        />
        <Text
          component="span"
          fz={12.5}
          fw={item.needsYou ? 600 : 400}
          truncate="end"
          c={colorForRole(item.needsYou ? 'text' : 'textSecondary', scheme)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {item.name}
        </Text>
        <Text
          component="span"
          ff="monospace"
          fz={10}
          c={colorForRole('textMuted', scheme)}
          style={{ flexShrink: 0 }}
        >
          {ageLabel(moment, item.updatedAt)}
        </Text>
      </Group>
      <Text
        component="span"
        ff="monospace"
        fz={10}
        truncate="end"
        c={colorForRole('textMuted', scheme)}
        style={{ display: 'block', paddingLeft: 14 }}
      >
        {placeLabel(item)}
      </Text>
    </UnstyledButton>
  );
}
