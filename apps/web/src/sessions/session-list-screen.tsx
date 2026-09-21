import { useState, useSyncExternalStore, type JSX } from 'react';
import type { Layout, ServerRegistrationId } from '@agentplex/protocol';
import {
  Button,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
  useComputedColorScheme,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { ShellForm } from '../shell/shell-form.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { NextActionLink } from '../shell/next-action.js';
import { SidebarFilter } from '../shell/sidebar-filter.js';
import {
  chipOptions,
  connectionNotice,
  effectiveFilters,
  emptyListing,
  listSessions,
  visibleSessions,
  type ChipCount,
  type EmptyListing as EmptyListingView,
  type SessionListItem,
  type StatusChip,
} from './session-list-model.js';
import { appSessionFiltersStore, type SessionListView } from './session-filters-store.js';
import { appLayoutStore } from '../layout/app-layout.js';
import { ProjectDocuments } from '../docs/project-docs.js';
import { NewProjectForm } from '../projects/new-project-form.js';
import { NodeMenu } from '../tree/node-menu.js';
import { nodeForSession } from '../tree/tree-model.js';
import { NewSessionForm } from './new-session-form.js';
import { SessionCard } from './session-card.js';
import { SessionRow } from './session-row.js';
import { stoppedNotice } from './stop-model.js';

/**
 * The session list: flat, activity-ordered, needs-you first as a stable
 * partition. The chips exist only for states that exist. Layout is the
 * approved mockup's card grid (turn 7, 7a/7b), which collapses to the mobile
 * card feed (7e) by dropping to one column rather than by being a second view.
 *
 * The toggle beside the chips (mockup 7a, at the right of that row) is the
 * third thing and not a replacement for that collapse: it chooses between the
 * grid and a one-row-per-session list, at the widths that have a choice. Both
 * forms are drawn by `SessionListing` off one `visible` array and one `actions`
 * slot per session, which is what makes "the same sessions, in the same order,
 * under the same narrowing" true by construction rather than by two call sites
 * agreeing. Below the breakpoint the toggle is not drawn and the cards are
 * what is drawn, however the choice was left at a wider width: the phone feed
 * is the grid at one column, and a list arriving there would be a form nobody
 * on that screen could get out of.
 *
 * The store and provider selects that used to stand above the cards are gone:
 * they are sections of the sidebar's filter popover now (mockup 6b), which is
 * where the machine, project and last-updated narrowings arrive beside them.
 * The narrowings themselves live in `session-filters-store.ts` because two
 * surfaces write them, and that file argues why one holder rather than two
 * copies. What the screen does with them is read them -- through
 * `effectiveFilters`, so that a choice whose option has left the fleet narrows
 * nothing, and through `visibleSessions` and `chipOptions` against the clock
 * it was handed.
 *
 * The filter row is drawn in the two places the two forms have room for it:
 * the sidebar has it in the wide form, and in the phone form, which has no
 * sidebar at all, this screen draws it (mockup 6c). It is the same component
 * either way (`shell/sidebar-filter.tsx`), which is why it takes what it
 * narrows as props rather than reading a tab: a bare box here would have moved
 * Store and Provider off the phone when it moved them into the popover, and
 * left five narrowings reachable only at a width the phone does not have. The
 * chips stay on the screen at both widths, where mockup 7a keeps them, and the
 * row here is the phone form's only -- at the wider one it would be the second
 * of two boxes typing into one field, under the second of two badges counting
 * one set of choices.
 *
 * The mockup's floating action button used to be drawn here, fixed to the
 * corner at narrow widths. It belongs to the phone chrome (AGX-125): it floats
 * over every destination and its badge counts the whole narrowed fleet, so a
 * copy owned by this screen would be one of two. New project stays, at every
 * width: it is this screen's own, the chrome starts sessions and not projects,
 * and a phone that could start neither would be a phone that can only watch.
 *
 * The catalogue tree and the machine selector used to stand beside the cards
 * here, because until AGX-122 this screen was the only place with room for
 * them. They are the shell's now (`shell/sidebar.tsx`): they belong to every
 * screen rather than to this one, and a session route no longer replaces the
 * page, so a tree drawn here would be a second tree the moment a session is
 * open. What arrives in their place is one prop -- the machine the chrome is
 * narrowed to -- because the cards narrow by the same fact the hub narrows the
 * catalogue by, and `machine-selector-model.ts` argues why that is one fact
 * with one writer.
 *
 * What `useState` is left holding is what the user did to this screen alone --
 * which form is open. The narrowings are the page's and the fleet is the hub's,
 * and both arrive through `useSyncExternalStore`; everything derived from the
 * machine state comes from session-list-model.ts. No effects anywhere.
 */
export interface SessionListScreenProps {
  readonly store: HubStore;
  /**
   * The machine the shell is narrowed to, or `null` for all of them. Read and
   * never written: the selector that writes it is in the chrome.
   */
  readonly machine?: ServerRegistrationId | null;
  /**
   * The form the shell is in, because two things here depend on it: below the
   * breakpoint the chrome's action button is what starts a session, and an
   * empty list names whichever of the two is actually drawn. Read from the
   * shell rather than measured again, so the two cannot disagree about which
   * of them is drawing that button -- or about which one the sentence should
   * send somebody to.
   */
  readonly form?: ShellForm;
  /** The clock, injected so a test can render fixed ages. */
  readonly now?: () => number;
}

export function SessionListScreen({
  store,
  machine = null,
  form = 'wide',
  now = Date.now,
}: SessionListScreenProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  // Declaring interest, which is what sends the layout request and what has it
  // re-sent after every reconnection and every `catalogue-changed`. The tree is
  // what the menus on this screen edit, so this screen is what is looking at it.
  const layout = useHubLayout(store);
  const scheme = useComputedColorScheme('dark');
  // The page's narrowings, which the sidebar's popover writes as well. Through
  // `useSyncExternalStore` and not an effect, like everything else here.
  const filtersStore = appSessionFiltersStore(store);
  const held = useSyncExternalStore(filtersStore.subscribe, filtersStore.getSnapshot);
  // The view, off the same subscription and its own string snapshot, so that
  // typing in the search box does not re-render through this reader as well.
  const chosen = useSyncExternalStore(filtersStore.subscribe, filtersStore.getView);
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  const state = snapshot.machineState;
  const notice = connectionNotice(snapshot.phase, snapshot.problem, state !== null);

  if (state === null) {
    return (
      <Stack p="md" gap="xs">
        <Title order={1} fz={16}>
          Sessions
        </Title>
        <Text c="dimmed">{notice ?? 'waiting for the hub'}</Text>
      </Stack>
    );
  }

  const everySession = listSessions(state);
  const moment = now();
  // The selector's machine is composed in rather than read out of the store:
  // the chrome owns that fact and `onPickMachine` is its one writer, and the
  // cards narrow by the same fact the catalogue beside them narrows by. The
  // popover's own Machine section is a different field on these filters, and
  // `SessionListFilters` argues why the two are not one.
  const filters = effectiveFilters(state, { ...held, server: machine }, moment);
  const chips = chipOptions(state, filters, moment);
  // The All chip's number: the sessions the chips are counted over, which is
  // the sum of what they carry -- every session falls under exactly one chip.
  const total = chips.reduce((count, entry) => count + entry.count, 0);
  const visible = visibleSessions(state, filters, moment);
  // The phone has no toggle, so it has no list: the feed is the grid at one
  // column. The choice is left standing in the store rather than written back
  // to `grid` here -- a window narrowed and widened again should come back to
  // the form it was reading in, not to the one the phone had to draw.
  const view: SessionListView = form === 'phone' ? 'grid' : chosen;
  // What the last stop landed on, from the reply's own payload. Kept brief and
  // kept at all because the answer reaches the client that asked: without it a
  // session stopped in another tab is a row that quietly stops being held.
  const stopped = stoppedNotice(state, snapshot.lastStopped);

  return (
    <Stack p="md" gap="sm">
      <Group justify="space-between" align="center">
        <Group gap={14} align="baseline">
          <Title order={1} fz={16}>
            Sessions
          </Title>
          {notice === null ? null : (
            <Text fz={12} c="dimmed">
              {notice}
            </Text>
          )}
          {stopped === null ? null : (
            <Text fz={12} c="dimmed" role="status">
              {stopped}
            </Text>
          )}
        </Group>
        {/* The mockup's New popover lists five node kinds; Session is the one
            live in this milestone, and a menu with one live option is not
            drawn, so New is a direct button. */}
        {/* Two buttons and not a menu, for the reason the one beside it is a
            button: a popover over two options is a click in front of every
            click. A project is where sessions get started from, so it sits
            beside the thing that starts them. */}
        <Group gap={8}>
          <Button size="xs" variant="default" onClick={() => setCreatingProject(true)}>
            New project
          </Button>
          {/* In the phone form the chrome's action button is what starts a
              session -- floating over every destination rather than only over
              this one -- so this would be the second of two. Not a media query:
              the shell's form is one rule in one place, and a `visibleFrom`
              here would be a second spelling of it that disagrees at any font
              size but the default. */}
          {form === 'wide' ? (
            <Button size="xs" onClick={() => setCreating(true)}>
              New session
            </Button>
          ) : null}
        </Group>
      </Group>
      <NewSessionForm
        store={store}
        opened={creating}
        onClose={() => setCreating(false)}
        scheme={scheme}
        // The start opens a pane in the layout the moment it goes out, on the
        // handle the start frame already has. The page's one layout store, for
        // the reason `app-layout.ts` gives -- a second one would adopt a
        // stored arrangement that predates what the first one saved.
        onPending={(startId) => appLayoutStore(store).showPendingSession(startId)}
      />
      <NewProjectForm
        store={store}
        opened={creatingProject}
        onClose={() => setCreatingProject(false)}
        scheme={scheme}
      />

      <ProjectDocuments store={store} scheme={scheme} />

      {/* The wide form's row is in the sidebar, above whichever tab is
          showing, so this one is the phone form's. Not a media query, for the
          reason the New session button above it is not one: the shell's form
          is one rule in one place, and a second spelling of it disagrees at
          any font size but the default.

          The moment is the one the cards are drawn against rather than a
          second reading of the clock, so the age window cannot mean one thing
          in the popover and another in the list under it. */}
      {form === 'phone' ? (
        <SidebarFilter
          state={state}
          filters={filtersStore}
          machine={machine}
          label="Filter sessions"
          text={filters.search}
          onText={(text) => filtersStore.set({ search: text })}
          popover
          scheme={scheme}
          now={() => moment}
        />
      ) : null}

      <Group gap={10} align="center" wrap="nowrap">
        {chips.length === 0 ? null : (
          <StatusChips
            chips={chips}
            total={total}
            active={filters.chip}
            onPick={(chip) => filtersStore.set({ chip })}
            scheme={scheme}
          />
        )}
        {/* Mockup 7a puts it at the far right of this row, past the chips. Not
            drawn in the phone form, for the reason the New session button is
            not: the shell's form is one rule in one place. */}
        {form === 'phone' ? null : (
          <ViewToggle view={view} onPick={(next) => filtersStore.setView(next)} scheme={scheme} />
        )}
      </Group>

      {visible.length === 0 ? (
        <EmptyListing
          listing={emptyListing(state, everySession.length > 0, form)}
          scheme={scheme}
        />
      ) : (
        <SessionListing
          view={view}
          items={visible}
          layout={layout}
          store={store}
          scheme={scheme}
          now={moment}
        />
      )}
    </Stack>
  );
}

interface SessionListingProps {
  readonly view: SessionListView;
  readonly items: readonly SessionListItem[];
  readonly layout: Layout | null;
  readonly store: HubStore;
  readonly scheme: Scheme;
  /** The moment every age in the listing is measured against. */
  readonly now: number;
}

/**
 * The visible sessions in whichever form the toggle is on.
 *
 * One array in, and the same `actions` slot built for each session whichever
 * component ends up drawing it: the two forms differ in how a session is laid
 * out and in nothing else. That is the ticket's whole claim -- a list is a
 * re-layout of a known set, not a second listing -- and putting the choice
 * here rather than around two copies of the loop is what keeps a narrowing,
 * an ordering or a menu from being applied to one form and forgotten on the
 * other.
 */
function SessionListing({
  view,
  items,
  layout,
  store,
  scheme,
  now,
}: SessionListingProps): JSX.Element {
  const drawn = items.map((item) => {
    // A session the tree holds no node for gets no menu: there is nothing to
    // rename, move or remove, and a menu that opened onto three refusals would
    // be worse than no menu.
    const node = nodeForSession(layout, item.ref);
    return {
      item,
      actions:
        node === null ? null : (
          <NodeMenu
            store={store}
            nodeId={node.id}
            name={node.name ?? item.name}
            layout={layout}
            anchor={item.ref}
            scheme={scheme}
          />
        ),
    };
  });

  if (view === 'list') {
    return (
      <Stack gap={6}>
        {drawn.map(({ item, actions }) => (
          <SessionRow
            key={item.key}
            item={item}
            scheme={scheme}
            now={now}
            store={store}
            actions={actions}
          />
        ))}
      </Stack>
    );
  }
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing={10}>
      {drawn.map(({ item, actions }) => (
        <SessionCard
          key={item.key}
          item={item}
          scheme={scheme}
          now={now}
          store={store}
          actions={actions}
        />
      ))}
    </SimpleGrid>
  );
}

interface ViewToggleProps {
  readonly view: SessionListView;
  readonly onPick: (view: SessionListView) => void;
  readonly scheme: Scheme;
}

/**
 * The mockup's two-button bordered pill, the shape the status chips beside it
 * already are, because it is the same kind of control: a small set of
 * exclusive options, one of them pressed.
 *
 * The mockup draws an icon in each half. These are words instead. The icons
 * would need labels anyway -- a toggle whose options a screen reader cannot
 * tell apart is a toggle with one option -- and two four-letter words at this
 * size cost no more room than the glyphs and the `aria-label`s they would have
 * needed. It follows the catalogue panel's tree-or-list toggle in being a view
 * choice held beside the narrowings and drawn above what it re-lays-out; it
 * does not follow it into `SegmentedControl`, whose radio group would be a
 * second spelling of the pressed state this screen already has in its chips.
 */
function ViewToggle({ view, onPick, scheme }: ViewToggleProps): JSX.Element {
  return (
    <Group
      gap={2}
      wrap="nowrap"
      ml="auto"
      p={2}
      style={{ border: `1px solid ${colorForRole('border', scheme)}`, borderRadius: 7 }}
    >
      <ViewButton
        label="Grid"
        selected={view === 'grid'}
        onPick={() => onPick('grid')}
        scheme={scheme}
      />
      <ViewButton
        label="List"
        selected={view === 'list'}
        onPick={() => onPick('list')}
        scheme={scheme}
      />
    </Group>
  );
}

interface ViewButtonProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly scheme: Scheme;
}

function ViewButton({ label, selected, onPick, scheme }: ViewButtonProps): JSX.Element {
  return (
    <UnstyledButton
      onClick={onPick}
      aria-pressed={selected}
      fz={12}
      fw={selected ? 600 : 400}
      c={colorForRole(selected ? 'text' : 'textMuted', scheme)}
      bg={selected ? colorForRole('raised', scheme) : 'transparent'}
      style={{ padding: '3px 8px', borderRadius: 5, whiteSpace: 'nowrap' }}
    >
      {label}
    </UnstyledButton>
  );
}

/**
 * The list with nothing in it, worded by `emptyListing` and drawn here.
 *
 * The words and the link are one sentence and one line: a person reads why the
 * list is empty and, where there is one, where to go about it, without the
 * screen shouting. An empty list is not an error.
 */
function EmptyListing({
  listing,
  scheme,
}: {
  readonly listing: EmptyListingView;
  readonly scheme: Scheme;
}): JSX.Element {
  return (
    <Text c="dimmed" fz={13}>
      {listing.words}
      {listing.action === null ? null : (
        <>
          {' '}
          <NextActionLink action={listing.action} scheme={scheme} />
        </>
      )}
    </Text>
  );
}

interface StatusChipsProps {
  readonly chips: readonly ChipCount[];
  readonly total: number;
  readonly active: StatusChip | null;
  readonly onPick: (chip: StatusChip | null) => void;
  readonly scheme: Scheme;
}

/**
 * The mockup's chip row: an All chip and one chip per state that exists, each
 * carrying its count. Only rendered when there are at least two states -- the
 * caller holds the rule -- because an All chip beside one state chip is one
 * effective option wearing two buttons.
 */
function StatusChips({ chips, total, active, onPick, scheme }: StatusChipsProps): JSX.Element {
  return (
    <Group
      gap={4}
      wrap="nowrap"
      p={3}
      bg={colorForRole('surfaceAlt', scheme)}
      style={{
        border: `1px solid ${colorForRole('border', scheme)}`,
        borderRadius: 7,
        overflowX: 'auto',
      }}
    >
      <StatusChipButton
        label={`All · ${String(total)}`}
        selected={active === null}
        onPick={() => onPick(null)}
        scheme={scheme}
      />
      {chips.map((entry) => (
        <StatusChipButton
          key={entry.chip}
          label={`${entry.label} · ${String(entry.count)}`}
          selected={active === entry.chip}
          onPick={() => onPick(entry.chip)}
          scheme={scheme}
        />
      ))}
    </Group>
  );
}

interface StatusChipButtonProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly scheme: Scheme;
}

function StatusChipButton({ label, selected, onPick, scheme }: StatusChipButtonProps): JSX.Element {
  return (
    <UnstyledButton
      onClick={onPick}
      aria-pressed={selected}
      fz={12}
      fw={selected ? 600 : 400}
      c={colorForRole(selected ? 'text' : 'textMuted', scheme)}
      bg={selected ? colorForRole('raised', scheme) : 'transparent'}
      style={{ padding: '4px 10px', borderRadius: 5, whiteSpace: 'nowrap' }}
    >
      {label}
    </UnstyledButton>
  );
}
