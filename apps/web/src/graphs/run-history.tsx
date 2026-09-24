import type { JSX } from 'react';
import type { GraphRunId, GraphRunSummary } from '@agentplex/protocol';
import { Box, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { historyRows } from './run-history-model.js';

/**
 * The graph's runs, newest first, as the hub listed them: one row per run in
 * the strip's words, with the tone dot the strip draws and a failed run's
 * sentence under it.
 *
 * A row is a button. Picking one hands its run up, and the screen puts that
 * run on the strip and in LAST OUTPUT; picking the marked row again hands up
 * `null`, which is "follow the newest" -- the one way back that does not need
 * a second control. Everything drawn is derived by `run-history-model.ts`
 * from the list on each render; nothing is kept here.
 *
 * `null` is the hub not having answered yet, and draws nothing: saying "no
 * runs" before the hub has said so would be a claim about a graph this
 * screen has not heard about.
 */

export interface RunHistoryProps {
  readonly runs: readonly GraphRunSummary[] | null;
  /** The run on the strip because a person picked it, or `null` when the strip follows the newest. */
  readonly selected: GraphRunId | null;
  readonly scheme: Scheme;
  readonly onSelect: (runId: GraphRunId | null) => void;
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export function RunHistory({ runs, selected, scheme, onSelect }: RunHistoryProps): JSX.Element {
  const muted = colorForRole('textMuted', scheme);
  const rows = runs === null ? [] : historyRows(runs, selected);
  return (
    <Stack gap={0} data-run-history>
      <Text
        px={16}
        pt={12}
        pb={6}
        style={{ ...MONO, fontSize: 9, fontWeight: 600, letterSpacing: '.08em', color: muted }}
      >
        RUNS
      </Text>
      {runs !== null && rows.length === 0 ? (
        <Text px={16} pb={12} fz={12} c={muted}>
          No runs yet
        </Text>
      ) : null}
      {rows.map((row) => (
        <UnstyledButton
          key={row.runId}
          data-history-run={row.runId}
          data-run-tone={row.tone}
          aria-current={row.selected ? 'true' : undefined}
          onClick={() => onSelect(row.selected ? null : row.runId)}
          px={16}
          py={4}
          style={{
            display: 'block',
            width: '100%',
            background: row.selected ? colorForRole('raised', scheme) : undefined,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: colorForTone(row.tone, scheme),
                flexShrink: 0,
              }}
            />
            <Text fz={11} fw={row.selected ? 700 : 500} style={{ ...MONO, whiteSpace: 'nowrap' }}>
              {row.text}
            </Text>
          </Box>
          {row.reason === null ? null : (
            <Text fz={11} pl={14} style={{ color: colorForTone(row.tone, scheme) }} truncate>
              {row.reason}
            </Text>
          )}
        </UnstyledButton>
      ))}
    </Stack>
  );
}
