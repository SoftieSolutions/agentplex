import { useState, type JSX } from 'react';
import type { GraphDocument, GraphSimulatedStep, RouteInput } from '@agentplex/protocol';
import { Box, Button, CloseButton, Group, Stack, Text, Textarea } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import {
  parseSimulateInput,
  sampleInputText,
  simulatedRows,
  simulationSummary,
} from './simulate-model.js';

/**
 * The simulate panel: the input a run would be started with, and the path
 * the hub says a run of the draft would take with it.
 *
 * Drawn under the run strip, across the screen, because what it shows is a
 * sequence of steps with a sentence each and the inspector's column is too
 * narrow for sentences; the canvas stays above it, so a step's label can be
 * found on a card by eye.
 *
 * The box is the one thing held here: what a person is typing is theirs and
 * no store's, and it starts as the sample the graph's routes read. It is
 * parsed on every render by `simulate-model.ts`, so the refusal under it is
 * always about what is in it now, and Simulate is offered only for a box the
 * run's own input schema accepts. Everything else -- the path, whether one
 * is out, why sending is blocked -- is handed in, and the rows are derived
 * from the path each render.
 */

export interface SimulatePanelProps {
  /** The draft on screen: what the sample is read off and what names a step. */
  readonly document: GraphDocument;
  readonly simulation: {
    readonly path: readonly GraphSimulatedStep[];
    readonly reason: string | null;
  } | null;
  readonly simulating: boolean;
  /** Why nothing can be sent right now, said beside the button, or `null`. */
  readonly blocked: string | null;
  readonly scheme: Scheme;
  readonly onSimulate: (input: RouteInput) => void;
  readonly onClose: () => void;
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export function SimulatePanel({
  document,
  simulation,
  simulating,
  blocked,
  scheme,
  onSimulate,
  onClose,
}: SimulatePanelProps): JSX.Element {
  // The person's typing, seeded once from the draft: a later edit to the
  // graph does not overwrite what somebody typed into the box.
  const [text, setText] = useState(() => sampleInputText(document));
  const parsed = parseSimulateInput(text);
  const muted = colorForRole('textMuted', scheme);
  const border = `1px solid ${colorForRole('border', scheme)}`;
  const rows = simulation === null ? [] : simulatedRows(simulation.path, document);

  return (
    <Box
      component="section"
      aria-label="Simulate"
      data-simulate-panel
      px={18}
      py={12}
      style={{
        borderBottom: border,
        background: colorForRole('surface', scheme),
        display: 'flex',
        gap: 18,
        maxHeight: 280,
        minHeight: 0,
      }}
    >
      <Stack gap={6} w={280} style={{ flexShrink: 0 }}>
        <Group gap={8} wrap="nowrap">
          <Text
            style={{ ...MONO, fontSize: 9, fontWeight: 600, letterSpacing: '.08em', color: muted }}
          >
            SIMULATE
          </Text>
          <Text fz={11} c={muted}>
            nothing runs
          </Text>
          <CloseButton
            ml="auto"
            size="sm"
            aria-label="Close the simulation"
            data-simulate-close
            onClick={onClose}
          />
        </Group>
        <Textarea
          aria-label="Input"
          minRows={4}
          maxRows={8}
          styles={{ input: MONO }}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        {parsed.ok ? null : (
          <Text data-simulate-refusal fz={11} style={{ color: colorForTone('blocked', scheme) }}>
            {parsed.problem}
          </Text>
        )}
        <Group gap={8} wrap="nowrap">
          <Button
            size="xs"
            variant="default"
            data-simulate-send
            disabled={!parsed.ok || simulating || blocked !== null}
            onClick={() => {
              if (parsed.ok) onSimulate(parsed.input);
            }}
          >
            {simulating ? 'Simulating' : 'Simulate with this input'}
          </Button>
          {blocked === null ? null : (
            <Text fz={11} c={muted}>
              {blocked}
            </Text>
          )}
        </Group>
      </Stack>
      <Stack gap={4} style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {simulation === null ? (
          <Text fz={12} c={muted}>
            {simulating
              ? 'Walking the draft'
              : 'The path a run of the saved draft would take appears here, with why at every step.'}
          </Text>
        ) : (
          <Text
            data-simulate-summary
            fz={12}
            fw={600}
            style={{
              color:
                simulation.reason === null
                  ? colorForRole('text', scheme)
                  : colorForTone('blocked', scheme),
            }}
          >
            {simulationSummary(simulation.path, simulation.reason)}
          </Text>
        )}
        {rows.map((row) => (
          <Box
            key={row.key}
            data-simulated-step={row.nodeId}
            data-simulated-tone={row.tone}
            data-simulated-depth={String(row.depth)}
            style={{ paddingLeft: row.depth * 16, display: 'flex', gap: 8 }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                marginTop: 6,
                background: colorForTone(row.tone, scheme),
                flexShrink: 0,
              }}
            />
            <Box style={{ minWidth: 0 }}>
              <Text fz={12} fw={600} style={{ whiteSpace: 'nowrap' }}>
                {row.label}{' '}
                <Text component="span" fz={10} c={muted} style={MONO}>
                  {row.kind} · {row.outcome}
                </Text>
              </Text>
              <Text fz={11} c={muted}>
                {row.why}
              </Text>
            </Box>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
