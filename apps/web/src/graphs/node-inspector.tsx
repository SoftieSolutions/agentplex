import { useState, type CSSProperties, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import {
  providerSchema,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type ServerRegistrationId,
  type StoreId,
} from '@agentplex/protocol';
import {
  Box,
  Button,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import {
  addRoute,
  KIND_WORDS,
  removeNode,
  removeRoute,
  reorderRoute,
  ROUTER_MODELS,
  setNodeField,
  setRoute,
  type GraphEdit,
} from './graph-model.js';

/**
 * The inspector: the selected node's fields, one control each, as mockup 6d
 * draws the right-hand aside.
 *
 * It decides nothing about what a node may hold. Every control answers a
 * change with an edit from `graph-model.ts`, handed up through `onEdit` for
 * the store to apply, and the model's re-parse through the node schema is
 * what says no -- a retry of eleven is refused there in the schema's words,
 * and this file draws the sentence rather than duplicating the bound. Which
 * fields are drawn is the one thing decided here, by a switch on the kind
 * that the closed enum keeps exhaustive.
 *
 * The LAST OUTPUT slot is drawn and empty. A run's output is AGX-146's, and
 * the slot is here so that the aside already has the shape the mock gives it
 * and that ticket fills a region rather than inventing one.
 */

/** A machine the Pin control offers: the id it pins, worded by its label. */
export interface InspectorMachine {
  readonly registrationId: ServerRegistrationId;
  readonly label: string;
  /** The connectivity in words, beside the label so a stale box is chosen knowingly. */
  readonly words: string;
}

export type Edit = (document: GraphDocument) => GraphEdit;

export interface NodeInspectorProps {
  readonly node: GraphNode | null;
  readonly document: GraphDocument;
  readonly machines: readonly InspectorMachine[];
  /** Every store the fleet reports, for an AGENT to start in. */
  readonly stores: readonly StoreId[];
  readonly scheme: Scheme;
  readonly onEdit: (edit: Edit) => void;
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

/** The kind line above the label, as the mock letters it. */
function eyebrowStyle(scheme: Scheme, accent: boolean): CSSProperties {
  return {
    ...MONO,
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '.08em',
    color: accent ? colorForRole('accent', scheme) : colorForRole('textMuted', scheme),
  };
}

export function NodeInspector({
  node,
  document,
  machines,
  stores,
  scheme,
  onEdit,
}: NodeInspectorProps): JSX.Element {
  const border = `1px solid ${colorForRole('border', scheme)}`;
  const muted = colorForRole('textMuted', scheme);

  if (node === null) {
    return (
      <Stack gap={0} data-node-inspector style={{ height: '100%' }}>
        <Box p={16}>
          <Text fz={12} c={muted}>
            Select a node to edit it.
          </Text>
        </Box>
      </Stack>
    );
  }

  const set = (field: string, value: unknown): void => {
    onEdit((current) => setNodeField(current, node.id, field, value));
  };

  return (
    <Stack gap={0} data-node-inspector={node.id} style={{ height: '100%' }}>
      <Box px={16} py={14} style={{ borderBottom: border }}>
        <Text style={eyebrowStyle(scheme, true)}>{KIND_WORDS[node.kind]} · SELECTED</Text>
        <TextInput
          aria-label="Label"
          variant="unstyled"
          size="md"
          fw={800}
          value={node.label}
          onChange={(event) => set('label', event.currentTarget.value)}
        />
      </Box>
      <Stack gap={12} px={16} py={14} fz={12} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <KindFields
          node={node}
          document={document}
          stores={stores}
          scheme={scheme}
          set={set}
          onEdit={onEdit}
        />
        <PlacementFields node={node} machines={machines} set={set} />
        <RetryFields node={node} set={set} />
        <Button
          variant="default"
          size="xs"
          onClick={() => onEdit((current) => removeNode(current, node.id))}
        >
          Remove node
        </Button>
      </Stack>
      <Box px={16} py={12} style={{ borderTop: border }}>
        <Text style={eyebrowStyle(scheme, false)}>LAST OUTPUT</Text>
        <pre
          data-last-output
          style={{ ...MONO, margin: 0, fontSize: 11, lineHeight: 1.5, minHeight: 18 }}
        />
      </Box>
    </Stack>
  );
}

interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
}

function Field({ label, children }: FieldProps): JSX.Element {
  return (
    <Stack gap={5}>
      <Text fz={12} c="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

interface KindFieldsProps {
  readonly node: GraphNode;
  readonly document: GraphDocument;
  readonly stores: readonly StoreId[];
  readonly scheme: Scheme;
  readonly set: (field: string, value: unknown) => void;
  readonly onEdit: (edit: Edit) => void;
}

/** The fields one kind has and no other. Exhaustive over the closed enum. */
function KindFields({ node, document, stores, scheme, set, onEdit }: KindFieldsProps): JSX.Element {
  switch (node.kind) {
    case 'trigger':
      return (
        <Field label="Source">
          <Text fz={12} style={MONO}>
            {node.source}
          </Text>
        </Field>
      );
    case 'router':
      return (
        <>
          <Field label="Model">
            <Select
              aria-label="Model"
              data={withCurrent(ROUTER_MODELS, node.model)}
              value={node.model}
              onChange={(value) => {
                if (value !== null) set('model', value);
              }}
            />
          </Field>
          <RouteFields node={node} document={document} scheme={scheme} onEdit={onEdit} />
        </>
      );
    case 'agent':
      return (
        <>
          <Field label="Prompt">
            <Textarea
              aria-label="Prompt"
              autosize
              minRows={3}
              value={node.prompt}
              onChange={(event) => set('prompt', event.currentTarget.value)}
            />
          </Field>
          <Field label="Provider">
            <Select
              aria-label="Provider"
              data={[...providerSchema.options]}
              value={node.provider}
              onChange={(value) => {
                if (value !== null) set('provider', value);
              }}
            />
          </Field>
          <Field label="Store">
            <Select
              aria-label="Store"
              data={withCurrent(stores, node.storeId)}
              value={node.storeId}
              onChange={(value) => {
                if (value !== null) set('storeId', value);
              }}
            />
          </Field>
        </>
      );
    case 'subgraph':
      return (
        <>
          <Field label="Graph">
            <CommittedTextInput
              key={`${node.id}:graph`}
              label="Graph"
              value={node.graph}
              onCommit={(graph) => set('graph', graph)}
            />
          </Field>
          <Field label="Version">
            <NumberInput
              aria-label="Version"
              min={1}
              value={node.version}
              onChange={(value) => {
                if (typeof value === 'number') set('version', value);
              }}
            />
          </Field>
        </>
      );
    case 'human':
      return (
        <>
          <Field label="Approvers">
            <CommittedTextInput
              key={`${node.id}:approvers`}
              label="Approvers"
              placeholder="names, comma separated"
              value={node.approvers.join(', ')}
              onCommit={(text) => set('approvers', splitNames(text))}
            />
          </Field>
          <Field label="Timeout (minutes)">
            <NumberInput
              aria-label="Timeout"
              min={1}
              placeholder="waits as long as it takes"
              value={node.timeoutMinutes ?? ''}
              onChange={(value) => set('timeoutMinutes', value === '' ? null : value)}
            />
          </Field>
        </>
      );
    case 'action':
      return (
        <Field label="Action">
          <CommittedTextInput
            key={`${node.id}:name`}
            label="Action"
            value={node.name}
            onCommit={(name) => set('name', name)}
          />
        </Field>
      );
  }
}

/** The options, with the value the node already has among them even when the list has moved on. */
function withCurrent(options: readonly string[], current: string): string[] {
  return options.includes(current) ? [...options] : [current, ...options];
}

/** `robert, ana` as the list the schema takes; empty entries are typing, not people. */
function splitNames(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

interface CommittedTextInputProps {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
}

/**
 * A text field whose value reaches the document on blur or Enter rather than
 * on every keystroke, for the fields the schema refuses half-typed: a route
 * condition is not a condition until its last character, a node id is not an
 * id while it is being typed, and a controlled input the model refused would
 * be one nobody could type into. The draft is this control's own, and two
 * things reset it: the key the parent gives it, on the node and the field,
 * so selecting another node never shows the last one's typing or writes it
 * into the new one on blur; and the value moving underneath -- a save that
 * landed, a re-asked document -- which is caught during render by React's own
 * rule for state that follows a prop, never in an effect.
 */
function CommittedTextInput({
  label,
  value,
  placeholder,
  onCommit,
}: CommittedTextInputProps): JSX.Element {
  const [held, setHeld] = useState({ value, draft: value });
  let draft = held.draft;
  if (held.value !== value) {
    draft = value;
    setHeld({ value, draft });
  }
  const setDraft = (text: string): void => {
    setHeld({ value, draft: text });
  };
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return (
    <TextInput
      aria-label={label}
      size="xs"
      style={MONO}
      value={draft}
      {...(placeholder === undefined ? {} : { placeholder })}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

interface RouteFieldsProps {
  readonly node: Extract<GraphNode, { kind: 'router' }>;
  readonly document: GraphDocument;
  readonly scheme: Scheme;
  readonly onEdit: (edit: Edit) => void;
}

/**
 * The ordered routes, each a condition and a target, with up and down
 * controls because the order is the routing: the first condition that holds
 * wins. A new route matches everything and points at the first node that is
 * not the router, so it parses the moment it exists and the person narrows
 * it from there.
 */
function RouteFields({ node, document, scheme, onEdit }: RouteFieldsProps): JSX.Element {
  const targets = document.nodes
    .filter((each) => each.id !== node.id)
    .map((each) => ({ value: each.id, label: each.label }));
  const firstTarget = targets[0]?.value;
  const parseTarget = (value: string): GraphNodeId | null =>
    document.nodes.find((each) => each.id === value)?.id ?? null;
  const muted = colorForRole('textMuted', scheme);

  return (
    <Field label="Routes">
      {node.routes.map((route, index) => (
        <Box
          key={`${String(index)}:${route.to}:${route.condition}`}
          data-route={index}
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 4 }}
        >
          <CommittedTextInput
            label={`Route ${String(index + 1)} condition`}
            value={route.condition}
            onCommit={(condition) =>
              onEdit((current) => setRoute(current, node.id, index, { condition }))
            }
          />
          <Select
            aria-label={`Route ${String(index + 1)} target`}
            size="xs"
            data={targets}
            value={route.to}
            onChange={(value) => {
              const to = value === null ? null : parseTarget(value);
              if (to !== null) onEdit((current) => setRoute(current, node.id, index, { to }));
            }}
          />
          <Box style={{ display: 'flex', gap: 2 }}>
            <UnstyledButton
              aria-label={`Move route ${String(index + 1)} up`}
              disabled={index === 0}
              c={muted}
              onClick={() => onEdit((current) => reorderRoute(current, node.id, index, index - 1))}
            >
              ↑
            </UnstyledButton>
            <UnstyledButton
              aria-label={`Move route ${String(index + 1)} down`}
              disabled={index === node.routes.length - 1}
              c={muted}
              onClick={() => onEdit((current) => reorderRoute(current, node.id, index, index + 1))}
            >
              ↓
            </UnstyledButton>
            <UnstyledButton
              aria-label={`Remove route ${String(index + 1)}`}
              c={muted}
              onClick={() => onEdit((current) => removeRoute(current, node.id, index))}
            >
              ×
            </UnstyledButton>
          </Box>
        </Box>
      ))}
      <Field label="Otherwise">
        <Select
          aria-label="Otherwise"
          size="xs"
          clearable
          placeholder="no fallback"
          data={targets}
          value={node.otherwise}
          onChange={(value) =>
            onEdit((current) =>
              setNodeField(
                current,
                node.id,
                'otherwise',
                value === null ? null : parseTarget(value),
              ),
            )
          }
        />
      </Field>
      <UnstyledButton
        c={muted}
        fz={12}
        px={10}
        py={4}
        disabled={firstTarget === undefined}
        onClick={() => {
          const to = firstTarget === undefined ? null : parseTarget(firstTarget);
          if (to !== null) onEdit((current) => addRoute(current, node.id, 'only *', to));
        }}
      >
        + add route
      </UnstyledButton>
    </Field>
  );
}

interface PlacementFieldsProps {
  readonly node: GraphNode;
  readonly machines: readonly InspectorMachine[];
  readonly set: (field: string, value: unknown) => void;
}

/**
 * Cheapest or Pin machine, and which machine when pinned. Choosing Pin pins
 * the first machine the fleet lists, because a pin with no machine is not a
 * placement the schema has; the selector beside it is where the choice is
 * made. With no machine paired at all, Pin is a refusal in words.
 */
function PlacementFields({ node, machines, set }: PlacementFieldsProps): JSX.Element {
  const pinned = node.placement.kind === 'pin' ? node.placement.server : null;
  return (
    <Field label="Placement">
      <SegmentedControl
        size="xs"
        fullWidth
        data={[
          { value: 'cheapest', label: 'Cheapest' },
          { value: 'pin', label: 'Pin machine' },
        ]}
        value={node.placement.kind}
        onChange={(value) => {
          if (value === 'cheapest') {
            set('placement', { kind: 'cheapest' });
            return;
          }
          const first = machines[0];
          set(
            'placement',
            first === undefined ? { kind: 'pin' } : { kind: 'pin', server: first.registrationId },
          );
        }}
      />
      {pinned === null ? null : (
        <Select
          aria-label="Machine"
          size="xs"
          data={machines.map((machine) => ({
            value: machine.registrationId,
            label: machine.label,
          }))}
          value={pinned}
          onChange={(value) => {
            const machine = machines.find((each) => each.registrationId === value);
            if (machine !== undefined)
              set('placement', { kind: 'pin', server: machine.registrationId });
          }}
        />
      )}
    </Field>
  );
}

interface RetryFieldsProps {
  readonly node: GraphNode;
  readonly set: (field: string, value: unknown) => void;
}

function RetryFields({ node, set }: RetryFieldsProps): JSX.Element {
  return (
    <Field label="Retry">
      <Box style={{ display: 'flex', gap: 8 }}>
        <NumberInput
          aria-label="Retry max"
          size="xs"
          placeholder="max"
          min={0}
          max={10}
          value={node.retry.max}
          onChange={(value) => {
            if (typeof value === 'number') set('retry', { ...node.retry, max: value });
          }}
        />
        <NumberInput
          aria-label="Retry backoff"
          size="xs"
          placeholder="backoff, seconds"
          min={1}
          value={node.retry.backoff}
          onChange={(value) => {
            if (typeof value === 'number') set('retry', { ...node.retry, backoff: value });
          }}
        />
      </Box>
    </Field>
  );
}
