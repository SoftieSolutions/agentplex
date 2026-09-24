import {
  parseRouteCondition,
  routeInputSchema,
  type GraphDocument,
  type GraphSimulatedStep,
  type RouteInput,
  type SimulatedOutcome,
} from '@agentplex/protocol';
import type { Tone } from '../ui/tokens.js';
import { KIND_WORDS } from './graph-model.js';

/**
 * What the simulate panel reads: the input box parsed, the sample it starts
 * from, and the hub's path as rows.
 *
 * ## The input is parsed by the run's own schema
 *
 * A simulation is sent with the input a run would be started with, so the
 * box is parsed by `routeInputSchema` -- the one the hub parses the frame's
 * input with, and the one a ROUTER's conditions evaluate against. A box the
 * schema refuses is refused here in a sentence, before anything is sent,
 * rather than sent and refused by the hub as a malformed frame.
 *
 * ## The sample
 *
 * A TRIGGER has no sample of its own to offer -- its only field is where a
 * run comes from -- so the sample is read off what the graph's routes read:
 * every field a condition names, set to the literal of the first route that
 * names it, and an empty `files` list when an `only` condition reads files.
 * The first route therefore holds against the sample, so the first thing a
 * person sees is the graph taking a branch rather than falling off its first
 * router, and the shape of what to type is in the box already.
 *
 * ## The rows
 *
 * One row per step, in the hub's order, which is the walk's: a SUB-GRAPH's
 * child steps follow it one depth down, and the row carries the depth for
 * the panel to indent by. A step of this graph is named by its label; a
 * child graph's step by its id, because this screen holds this graph's
 * document and not the child's, and a label guessed from the wrong document
 * would name the wrong node.
 */

export type SimulateInputParse =
  | { readonly ok: true; readonly input: RouteInput }
  | { readonly ok: false; readonly problem: string };

const NOT_AN_OBJECT = 'the input is one JSON object of named fields, like {"language": "rust"}';

export function parseSimulateInput(text: string): SimulateInputParse {
  if (text.trim().length === 0) return { ok: false, problem: NOT_AN_OBJECT };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `the input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problem: NOT_AN_OBJECT };
  }
  const parsed = routeInputSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues[0]?.message ?? NOT_AN_OBJECT };
  }
  return { ok: true, input: parsed.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Sets a dotted field in `target` unless a route before this one already set it. */
function setField(target: Record<string, unknown>, field: string, literal: string): void {
  const segments = field.split('.');
  const last = segments.pop();
  if (last === undefined) return;
  let current = target;
  for (const segment of segments) {
    if (!Object.hasOwn(current, segment)) current[segment] = {};
    const child = current[segment];
    // A shorter field already holds a value here; the first route wins.
    if (!isRecord(child)) return;
    current = child;
  }
  if (!Object.hasOwn(current, last)) current[last] = literal;
}

/** An input shaped by what the graph's routes read, which the first route holds against. */
export function sampleInput(document: GraphDocument): RouteInput {
  const sample: Record<string, unknown> = {};
  for (const node of document.nodes) {
    if (node.kind !== 'router') continue;
    for (const route of node.routes) {
      const parsed = parseRouteCondition(route.condition);
      if (!parsed.ok) continue;
      const condition = parsed.condition;
      if (condition.kind === 'only') {
        if (!Object.hasOwn(sample, 'files')) sample.files = [];
      } else {
        setField(sample, condition.field, condition.literal);
      }
    }
  }
  // Parsed rather than cast: a sample is a claim like any other input, and a
  // graph whose routes read a hundred fields could make one past the bound.
  const parsed = routeInputSchema.safeParse(sample);
  return parsed.success ? parsed.data : {};
}

/** The sample as the box shows it. */
export function sampleInputText(document: GraphDocument): string {
  return JSON.stringify(sampleInput(document), null, 2);
}

/** One step of the path, as drawn. */
export interface SimulatedRow {
  /** Unique within the path: a node a cycle reaches twice is two rows. */
  readonly key: string;
  /** The step's node id, in its own graph. */
  readonly nodeId: string;
  readonly depth: number;
  /** The kind in the canvas's capitals. */
  readonly kind: string;
  /** The node's label in this graph, or its id in a child graph. */
  readonly label: string;
  /** `would run`, `would wait` or `would stop`. */
  readonly outcome: string;
  readonly why: string;
  readonly tone: Tone;
}

const OUTCOME_WORDS: Record<SimulatedOutcome, string> = {
  'would-run': 'would run',
  'would-wait': 'would wait',
  'would-stop': 'would stop',
};

const OUTCOME_TONES: Record<SimulatedOutcome, Tone> = {
  'would-run': 'running',
  'would-wait': 'needs-you',
  'would-stop': 'blocked',
};

export function simulatedRows(
  path: readonly GraphSimulatedStep[],
  document: GraphDocument | null,
): SimulatedRow[] {
  const labels = new Map(
    (document?.nodes ?? []).map((node) => [
      node.id,
      node.label.trim().length > 0 ? node.label : node.id,
    ]),
  );
  return path.map((step, index) => ({
    key: `${String(index)}:${String(step.depth)}:${step.nodeId}`,
    nodeId: step.nodeId,
    depth: step.depth,
    kind: KIND_WORDS[step.kind],
    label: step.depth === 0 ? (labels.get(step.nodeId) ?? step.nodeId) : step.nodeId,
    outcome: OUTCOME_WORDS[step.outcome],
    why: step.why,
    tone: OUTCOME_TONES[step.outcome],
  }));
}

/** One line over the rows: where the walk ended, and how often a run would wait on a person. */
export function simulationSummary(
  path: readonly GraphSimulatedStep[],
  reason: string | null,
): string {
  if (reason !== null) return `would stop: ${reason}`;
  const waits = path.filter((step) => step.outcome === 'would-wait').length;
  const steps = `would reach the end in ${String(path.length)} step${path.length === 1 ? '' : 's'}`;
  if (waits === 0) return steps;
  return `${steps}, waiting on a person ${waits === 1 ? 'once' : `${String(waits)} times`}`;
}
