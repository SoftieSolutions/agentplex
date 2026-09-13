import type { JSX } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
import { Box, Group, Menu, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import {
  ALL_MACHINES,
  machineHeader,
  machineSelector,
  type MachineRow,
} from './machine-selector-model.js';

/**
 * The header above the sidebar tabs: what the app is narrowed to, how much of
 * the fleet is up, and a menu to change it.
 *
 * Thin on purpose, like every other component in this stack: the counts, the
 * words at both widths, the rows and what a selection does to the query are
 * all in `machine-selector-model.ts`, where a test reaches them without a DOM.
 * What is here is a menu, a dot and two pieces of text.
 *
 * Both widths are rendered and CSS chooses, which is the same decision the
 * session list makes about its two columns: a media-query hook would be a
 * second source of truth about one breakpoint, and a header that measured
 * itself would be a layout effect for a line of text.
 */
export interface MachineSelectorProps {
  readonly state: MachineState | null;
  /** What the app is narrowed to now, as the one place that holds it says. */
  readonly chosen: string | null;
  /** `null` is All machines: the selection taken away, not a machine named. */
  readonly onPick: (machine: ServerRegistrationId | null) => void;
  readonly scheme: Scheme;
}

export function MachineSelector({
  state,
  chosen,
  onPick,
  scheme,
}: MachineSelectorProps): JSX.Element {
  const view = machineSelector(state, chosen);
  const wide = machineHeader(view, 'wide');
  const narrow = machineHeader(view, 'narrow');
  const muted = colorForRole('textMuted', scheme);

  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={260}>
      <Menu.Target>
        {/* Every piece of text in the target is a span: a button's content is
            phrasing, and Mantine's Text is a paragraph unless told otherwise. */}
        <UnstyledButton style={{ minWidth: 0 }}>
          <Group gap={8} align="baseline" wrap="nowrap">
            <Text
              component="span"
              fz={13}
              fw={600}
              c={colorForRole('text', scheme)}
              visibleFrom="md"
            >
              {wide.title}
            </Text>
            {wide.detail === null ? null : (
              <Text component="span" fz={11} c={muted} visibleFrom="md">
                {wide.detail}
              </Text>
            )}
            <Text component="span" fz={12} c={colorForRole('text', scheme)} hiddenFrom="md">
              {narrow.title}
            </Text>
            {/* One character and no icon set, the same disclosure the
                catalogue rows draw. */}
            <Text component="span" aria-hidden fz={10} c={muted}>
              v
            </Text>
          </Group>
        </UnstyledButton>
      </Menu.Target>

      <Menu.Dropdown>
        {/* `aria-current` and not a radio role: Mantine sets `role` on the item
            itself, so a role passed in here is dropped on the floor and a
            `menuitem` carrying `aria-checked` would be a claim no AT reads. */}
        <Menu.Item aria-current={view.selected === null} onClick={() => onPick(null)}>
          <Text component="span" fz={13} fw={view.selected === null ? 600 : 400}>
            {ALL_MACHINES}
          </Text>
        </Menu.Item>
        {view.rows.map((row) => (
          <Menu.Item
            key={row.registrationId}
            aria-current={row.selected}
            onClick={() => onPick(row.registrationId)}
          >
            <MachineRowLine row={row} scheme={scheme} />
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

interface MachineRowLineProps {
  readonly row: MachineRow;
  readonly scheme: Scheme;
}

/**
 * One machine: its short name, its full one, and what it is doing.
 *
 * The short label leads because it is the name the tree rows carry, so the
 * menu is where a person learns what `gpu` on a row means; the full label sits
 * beside it because the short one is an abbreviation and an abbreviation alone
 * is not a machine's name.
 */
function MachineRowLine({ row, scheme }: MachineRowLineProps): JSX.Element {
  return (
    <Group gap={7} wrap="nowrap" align="center">
      <Box
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          background: colorForTone(row.tone, scheme),
        }}
      />
      <Text component="span" ff="monospace" fz={11} fw={500} c={colorForRole('textMuted', scheme)}>
        {row.short}
      </Text>
      <Text component="span" fz={13} fw={row.selected ? 600 : 400} style={{ flex: 1, minWidth: 0 }}>
        {row.label}
      </Text>
      <Text
        component="span"
        fz={11}
        c={colorForRole('textFaint', scheme)}
        style={{ flexShrink: 0 }}
      >
        {row.words}
      </Text>
    </Group>
  );
}
