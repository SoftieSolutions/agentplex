import { useState, type JSX } from 'react';
import {
  Group,
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
import { useHubSnapshot } from '../store/use-hub-store.js';
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
import { SessionCard } from './session-card.js';

/**
 * The session list: flat, activity-ordered, needs-you first as a stable
 * partition. Store and provider narrowings sit before the table and exist
 * only when the data offers a choice; the chips exist only for states that
 * exist; the table's one filter is search. Layout is the approved mockup's
 * card grid (turn 7, 7a/7b), which collapses to the mobile card feed (7e) by
 * dropping to one column rather than by being a second view.
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
  const scheme = useComputedColorScheme('dark');
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<StatusChip | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

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
      (activeProvider === null || item.provider === activeProvider),
  );
  const chips = chipCounts(narrowed);
  const activeChip = chip !== null && chips.some((entry) => entry.chip === chip) ? chip : null;

  const visible = visibleSessions(state, {
    search,
    chip: activeChip,
    storeId: activeStore,
    provider: activeProvider,
  });
  const moment = now();

  return (
    <Stack component="main" p="md" gap="sm">
      <Group gap={14} align="baseline">
        <Title order={1} fz={16}>
          Sessions
        </Title>
        {notice === null ? null : (
          <Text fz={12} c="dimmed">
            {notice}
          </Text>
        )}
      </Group>

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
          {visible.map((item) => (
            <SessionCard key={item.key} item={item} scheme={scheme} now={moment} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
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
