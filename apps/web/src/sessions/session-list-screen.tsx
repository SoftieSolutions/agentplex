import { useState, type JSX } from 'react';
import type { ServerRegistrationId } from '@agentplex/protocol';
import {
  Box,
  Button,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
  useComputedColorScheme,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import {
  chipCounts,
  connectionNotice,
  listSessions,
  providerOptions,
  storeOptions,
  visibleSessions,
  type ChipCount,
  type StatusChip,
} from './session-list-model.js';
import { CataloguePanel } from '../catalogue/catalogue-panel.js';
import { createCatalogueStore, type CatalogueStore } from '../catalogue/catalogue-store.js';
import { ProjectDocuments } from '../docs/project-docs.js';
import { MachineSelector } from '../machines/machine-selector.js';
import { narrowedToMachine } from '../machines/machine-selector-model.js';
import { NewProjectForm } from '../projects/new-project-form.js';
import { NodeMenu } from '../tree/node-menu.js';
import { nodeForSession } from '../tree/tree-model.js';
import { NewSessionForm } from './new-session-form.js';
import { SessionCard } from './session-card.js';
import { stoppedNotice } from './stop-model.js';

/**
 * The session list: flat, activity-ordered, needs-you first as a stable
 * partition. Store and provider narrowings sit before the table and exist
 * only when the data offers a choice; the chips exist only for states that
 * exist; the table's one filter is search. Layout is the approved mockup's
 * card grid (turn 7, 7a/7b), which collapses to the mobile card feed (7e) by
 * dropping to one column rather than by being a second view.
 *
 * The catalogue sits beside it: a sidebar at desk widths and a tab at phone
 * widths, which is the one decision this file makes about it. The two are
 * different answers to different questions -- "what am I working on" against
 * "where did I put things" -- and the cards are the fleet's own reading while
 * the panel is a page of the hub's catalogue query.
 *
 * Which of the two is on screen is decided without a media query: each column
 * is rendered exactly once and carries `visibleFrom="md"` only while the other
 * tab is the chosen one, so above the breakpoint both are drawn and below it
 * the tab decides. A media query hook would be a second source of truth about
 * the same breakpoint, and two panels rendered so one can be hidden would be
 * two catalogue queries for one screen.
 *
 * The machine selector sits above both, and it is a narrowing rather than a
 * place: a session is `{ storeId, sessionId }` and never a machine, so picking
 * one sets the catalogue query's `filter.server` and the same constraint over
 * the cards, and does nothing else. That is why the selection is held here and
 * not in either column -- it is one fact about this screen, written by one
 * function, and the panel carries no machine control of its own for the same
 * reason. The catalogue store is built here for the same reason: the selection
 * has to reach the query the panel is drawing, and a store the panel made
 * privately could only be reached through an effect.
 *
 * All UI state here is what the user did to this screen; everything derived
 * from the machine state comes from session-list-model.ts, and the snapshot
 * arrives through `useSyncExternalStore` -- no effects anywhere.
 */
export interface SessionListScreenProps {
  readonly store: HubStore;
  /** The clock, injected so a test can render fixed ages. */
  readonly now?: () => number;
}

export function SessionListScreen({ store, now = Date.now }: SessionListScreenProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  // Declaring interest, which is what sends the layout request and what has it
  // re-sent after every reconnection and every `catalogue-changed`. The tree is
  // what the menus on this screen edit, so this screen is what is looking at it.
  const layout = useHubLayout(store);
  const scheme = useComputedColorScheme('dark');
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<StatusChip | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [machine, setMachine] = useState<ServerRegistrationId | null>(null);
  // Built once and inert until something subscribes: creating a catalogue
  // store dials nothing, and the panel's first subscriber is what asks.
  const [catalogue] = useState<CatalogueStore>(() => createCatalogueStore({ hub: store }));
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [tab, setTab] = useState<Tab>('sessions');

  const state = snapshot.machineState;
  const notice = connectionNotice(snapshot.phase, snapshot.problem, state !== null);

  if (state === null) {
    return (
      <Stack component="main" p="md" gap="xs">
        <Title order={1} fz={16}>
          Sessions
        </Title>
        <Text c="dimmed">{notice ?? 'waiting for the hub'}</Text>
      </Stack>
    );
  }

  const everySession = listSessions(state);
  const stores = storeOptions(state);
  const providers = providerOptions(everySession);

  // A narrowing whose option vanished from the state narrows nothing: the
  // stored choice is kept in case the option returns, but the pipeline only
  // ever sees choices the current state actually offers.
  const activeStore = storeId !== null && stores.some((id) => id === storeId) ? storeId : null;
  const activeProvider =
    provider !== null && providers.some((name) => name === provider) ? provider : null;

  const narrowed = everySession.filter(
    (item) =>
      (activeStore === null || item.storeId === activeStore) &&
      (activeProvider === null || item.provider === activeProvider) &&
      (machine === null || item.server === machine),
  );
  const chips = chipCounts(narrowed);
  const activeChip = chip !== null && chips.some((entry) => entry.chip === chip) ? chip : null;

  const visible = visibleSessions(state, {
    search,
    chip: activeChip,
    storeId: activeStore,
    provider: activeProvider,
    server: machine,
  });
  const moment = now();
  // What the last stop landed on, from the reply's own payload. Kept brief and
  // kept at all because the answer reaches the client that asked: without it a
  // session stopped in another tab is a row that quietly stops being held.
  const stopped = stoppedNotice(state, snapshot.lastStopped);

  /**
   * The one place the selection moves from.
   *
   * Two things read it -- the cards above and the catalogue query the panel
   * draws -- and they are written together here rather than kept in step
   * afterwards. The query's copy is the filter field itself, because that is
   * what goes on the wire, and nothing else in this screen sets it. It is in
   * the body because it writes this screen's state and the store this screen
   * holds; everything it decides is in the model it calls.
   */
  function pickMachine(next: ServerRegistrationId | null): void {
    setMachine(next);
    catalogue.reshape(narrowedToMachine(catalogue.getSnapshot().shape, next));
  }

  return (
    <Stack component="main" p="md" gap="sm">
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
            drawn, so New is a direct button. On small screens the same action
            is the mockup's floating button, bottom-right (7e). */}
        {/* Two buttons and not a menu, for the reason the one above is a
            button: a popover over two options is a click in front of every
            click. A project is where sessions get started from, so it sits
            beside the thing that starts them. */}
        <Group gap={8} visibleFrom="sm">
          <Button size="xs" variant="default" onClick={() => setCreatingProject(true)}>
            New project
          </Button>
          <Button size="xs" onClick={() => setCreating(true)}>
            New session
          </Button>
        </Group>
        <Button
          hiddenFrom="sm"
          size="md"
          radius="xl"
          onClick={() => setCreating(true)}
          style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 20 }}
        >
          New session
        </Button>
      </Group>
      <NewSessionForm
        store={store}
        opened={creating}
        onClose={() => setCreating(false)}
        scheme={scheme}
      />
      <NewProjectForm
        store={store}
        opened={creatingProject}
        onClose={() => setCreatingProject(false)}
        scheme={scheme}
      />

      <ProjectDocuments store={store} scheme={scheme} />

      {stores.length === 0 && providers.length === 0 ? null : (
        <Group gap={8}>
          {stores.length === 0 ? null : (
            <Select
              size="xs"
              aria-label="Store"
              placeholder="All stores"
              data={[...stores]}
              value={activeStore}
              onChange={setStoreId}
              clearable
            />
          )}
          {providers.length === 0 ? null : (
            <Select
              size="xs"
              aria-label="Provider"
              placeholder="All providers"
              data={[...providers]}
              value={activeProvider}
              onChange={setProvider}
              clearable
            />
          )}
        </Group>
      )}

      <MachineSelector state={state} chosen={machine} onPick={pickMachine} scheme={scheme} />

      {/* Below the breakpoint the two columns are one at a time, and this is
          what chooses. Above it the control is not drawn and both are. */}
      <SegmentedControl
        hiddenFrom="md"
        size="xs"
        fullWidth
        aria-label="What to show"
        value={tab}
        onChange={(value) => setTab(value === 'projects' ? 'projects' : 'sessions')}
        data={[
          { value: 'sessions', label: 'Sessions' },
          { value: 'projects', label: 'Projects' },
        ]}
      />

      <Group align="flex-start" wrap="nowrap" gap="md">
        <Box
          w={{ base: '100%', md: 300 }}
          style={{ flexShrink: 0, minWidth: 0 }}
          {...(tab === 'projects' ? {} : { visibleFrom: 'md' as const })}
        >
          <CataloguePanel
            store={store}
            state={state}
            layout={layout}
            scheme={scheme}
            catalogue={catalogue}
          />
        </Box>

        <Stack
          gap="sm"
          style={{ flex: 1, minWidth: 0 }}
          {...(tab === 'sessions' ? {} : { visibleFrom: 'md' as const })}
        >
          <Group gap={10}>
            {chips.length === 0 ? null : (
              <StatusChips
                chips={chips}
                total={narrowed.length}
                active={activeChip}
                onPick={setChip}
                scheme={scheme}
              />
            )}
            <TextInput
              size="xs"
              aria-label="Search sessions"
              placeholder="Search sessions"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{ flex: 1, maxWidth: 380 }}
            />
          </Group>

          {visible.length === 0 ? (
            <Text c="dimmed" fz={13}>
              {everySession.length === 0
                ? 'no sessions in any store yet'
                : 'no session matches the current narrowing'}
            </Text>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing={10}>
              {visible.map((item) => {
                // A session the tree holds no node for gets no menu: there is
                // nothing to rename, move or remove, and a menu that opened onto
                // three refusals would be worse than no menu.
                const node = nodeForSession(layout, item.ref);
                return (
                  <SessionCard
                    key={item.key}
                    item={item}
                    scheme={scheme}
                    now={moment}
                    store={store}
                    actions={
                      node === null ? null : (
                        <NodeMenu
                          store={store}
                          nodeId={node.id}
                          name={node.name ?? item.name}
                          layout={layout}
                          anchor={item.ref}
                          scheme={scheme}
                        />
                      )
                    }
                  />
                );
              })}
            </SimpleGrid>
          )}
        </Stack>
      </Group>
    </Stack>
  );
}

/** Which of the two columns a narrow screen is showing. */
type Tab = 'sessions' | 'projects';

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
