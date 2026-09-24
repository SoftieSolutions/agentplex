import type { JSX } from 'react';
import type { GraphRunState } from '@agentplex/protocol';
import { Button, Group, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { isRunOpen, runStripText, runTone } from './run-model.js';

/**
 * The strip mockup 6d draws under the header while a run is on: the run's
 * number, the word for where it is, the step count, and a way to stop it.
 *
 * It draws one run -- the graph's newest -- and reads everything off the
 * state the hub last sent, whole. A failed run keeps the strip and puts the
 * hub's sentence beside the count, because "run 38 failed" is not something
 * to act on and "no route on classify matched" is. A stale run -- held across
 * a connection that went, with the hub yet to say where it stands -- is
 * drawn at rest and offers no Cancel: the word is `reconnecting`, because
 * `live` would be a claim nothing on this screen can make.
 */

export interface RunStripProps {
  readonly run: GraphRunState;
  readonly scheme: Scheme;
  /** Whether a cancel is out and unanswered. */
  readonly cancelling: boolean;
  /** Whether the state is from a connection that is gone, with the hub yet to confirm it. */
  readonly stale: boolean;
  readonly onCancel: () => void;
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export function RunStrip({ run, scheme, cancelling, stale, onCancel }: RunStripProps): JSX.Element {
  const toneName = runTone(run.status, stale);
  const tone = colorForTone(toneName, scheme);
  return (
    <Group
      data-run-strip={run.runId}
      data-run-status={run.status}
      data-run-tone={toneName}
      data-run-stale={stale ? 'true' : undefined}
      gap={10}
      px={18}
      py={6}
      wrap="nowrap"
      style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}` }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: tone,
          flexShrink: 0,
        }}
      />
      <Text fz={11} fw={500} style={{ ...MONO, whiteSpace: 'nowrap' }}>
        {runStripText(run, stale)}
      </Text>
      {run.reason === null ? null : (
        <Text fz={12} style={{ color: tone, minWidth: 0 }} truncate>
          {run.reason}
        </Text>
      )}
      {isRunOpen(run.status) && !stale ? (
        <Button
          variant="default"
          size="compact-xs"
          ml="auto"
          disabled={cancelling}
          onClick={onCancel}
        >
          Cancel
        </Button>
      ) : null}
    </Group>
  );
}
