import { type JSX, type ReactNode } from 'react';
import type { CatalogueItem, NodeId } from '@agentplex/protocol';
import { toneForStatus } from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { Box, Group, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { nameStyleOf, rowNotes, type CatalogueRow } from './catalogue-model.js';

/**
 * One row of the catalogue, in either view.
 *
 * Thin on purpose: every rule it draws by -- how deep it sits, whether it has
 * a disclosure, what the second line says, which of the three kinds of name
 * this is -- was decided in `catalogue-model.ts`, where a test can reach it
 * without a DOM. This stack renders under no jsdom (AGX-238 and AGX-243 set
 * the pattern), so a rule that lived here would be a rule nothing tests.
 *
 * A leaf that addresses a session is an anchor and not a button. The session
 * route is an address -- `#/session/<store>/<session>` -- and a link is what a
 * person can middle-click into a second tab, which is exactly the thing
 * somebody watching two agents wants to do.
 */
export interface CatalogueRowViewProps {
  readonly row: Extract<CatalogueRow, { kind: 'item' }>;
  readonly scheme: Scheme;
  /** Registration id to the short machine label, computed over the whole fleet. */
  readonly machines: ReadonlyMap<string, string>;
  /** How many sessions each container holds, when that can be said at all. */
  readonly sessions: ReadonlyMap<NodeId, number>;
  readonly onToggle: (nodeId: NodeId) => void;
  /** The row's menu, or nothing while the tree cannot answer for this node. */
  readonly actions: ReactNode;
}

/** Indentation per level. One step, so a deep tree still fits a sidebar. */
const INDENT_PER_DEPTH = 12;

export function CatalogueRowView({
  row,
  scheme,
  machines,
  sessions,
  onToggle,
  actions,
}: CatalogueRowViewProps): JSX.Element {
  const { item } = row;
  const notes = rowNotes(item);
  const count = sessions.get(item.id) ?? null;
  const machine = machineFor(item, machines);

  return (
    <Box style={{ paddingLeft: row.depth * INDENT_PER_DEPTH, minWidth: 0 }}>
      <Group gap={6} wrap="nowrap" align="center">
        {row.expandable ? (
          <UnstyledButton
            onClick={() => onToggle(item.id)}
            aria-expanded={!row.collapsed}
            aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${item.displayName}`}
            fz={10}
            c={colorForRole('textMuted', scheme)}
            style={{ width: 14, flexShrink: 0, textAlign: 'center' }}
          >
            {/* Two characters and no icon set: the disclosure is the one glyph
                this app would otherwise take a dependency for. */}
            {row.collapsed ? '>' : 'v'}
          </UnstyledButton>
        ) : (
          <Box style={{ width: 14, flexShrink: 0 }} />
        )}

        {item.session === null ? null : (
          <Box
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              flexShrink: 0,
              background: colorForTone(toneForStatus(item.session.descriptor.status), scheme),
            }}
          />
        )}

        <RowName item={item} scheme={scheme} />

        {count === null ? null : (
          <Text fz={11} c={colorForRole('textFaint', scheme)} style={{ flexShrink: 0 }}>
            {count}
          </Text>
        )}
        {machine === null ? null : (
          <Text ff="monospace" fz={10} fw={500} c={colorForRole('textMuted', scheme)}>
            {machine}
          </Text>
        )}
        {actions}
      </Group>
      {notes.map((note) => (
        <Text key={note} fz={11} c={colorForRole('textFaint', scheme)} style={{ paddingLeft: 20 }}>
          {note}
        </Text>
      ))}
    </Box>
  );
}

interface RowNameProps {
  readonly item: CatalogueItem;
  readonly scheme: Scheme;
}

/**
 * The name, drawn as what it is.
 *
 * A name the user chose reads as text; one that followed a provider's
 * transcript title is quieter, because it will move when the provider
 * retitles; a session id is quieter still and in the monospace face, because
 * it is an identifier and not a name at all. The accent is a search hit on the
 * name itself, which is the one case where the reason a row is here is the row.
 */
function RowName({ item, scheme }: RowNameProps): JSX.Element {
  const style = nameStyleOf(item);
  const hit = item.matched === 'name';
  const color = hit
    ? colorForRole('accent', scheme)
    : style === 'given'
      ? colorForRole('text', scheme)
      : style === 'derived'
        ? colorForRole('textSecondary', scheme)
        : colorForRole('textMuted', scheme);

  const text = (
    <Text
      fz={13}
      truncate="end"
      c={color}
      ff={style === 'identifier' ? 'monospace' : 'text'}
      fs={style === 'identifier' ? 'italic' : 'normal'}
      style={{ flex: 1, minWidth: 0 }}
    >
      {item.displayName}
    </Text>
  );

  if (item.anchor === null) return text;
  return (
    <UnstyledButton
      component="a"
      href={sessionHash(item.anchor)}
      style={{ flex: 1, minWidth: 0, display: 'block' }}
    >
      {text}
    </UnstyledButton>
  );
}

/**
 * Which machine to put on a session row, short.
 *
 * The holder where there is one and the reading's source otherwise, the same
 * pair the session card uses: what is running it, or whose reading this is
 * when nobody is. A label the fleet does not describe is left off rather than
 * drawn as a registration id -- the row has four characters, and an opaque id
 * in them says less than nothing.
 */
function machineFor(item: CatalogueItem, machines: ReadonlyMap<string, string>): string | null {
  if (item.session === null) return null;
  const id = item.session.holder?.server ?? item.session.source;
  return machines.get(id) ?? null;
}
