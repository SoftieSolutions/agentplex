import { useState, useSyncExternalStore, type JSX } from 'react';
import { nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { projectChoices } from '../projects/new-project-model.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import { graphHash } from './graph-route.js';
import {
  createGraphCreation,
  graphCreateBlockedReason,
  parseGraphName,
} from './new-graph-model.js';

/**
 * The New graph form: a name, and the project the graph belongs to.
 *
 * No machine, unlike a document's form, because a graph is not a file on any
 * machine: the hub holds it, and where each step lands is the node's own
 * placement to say. The project is drawn as a choice only when there is one
 * to make; one project is named in words, since a control with a single
 * option is a decision nobody is being asked to take.
 *
 * Every rule is in `new-graph-model.ts`, including the one piece that is not
 * a pure function: the creation store that sends the frame and, when the hub
 * names the node, opens the graph. This component owns what the user typed
 * and which project they picked, and nothing else.
 */
export interface NewGraphFormProps {
  readonly store: HubStore;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
  /** How the graph route is entered, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

// Outside the component: it touches nothing but the browser it runs in.
function assignHash(hash: string): void {
  window.location.hash = hash;
}

export function NewGraphForm({
  store,
  opened,
  onClose,
  scheme,
  navigate = assignHash,
}: NewGraphFormProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  const layout = useHubLayout(store);
  // A form-lifetime collaborator, not render data: one creation store per
  // mounted form, listening to the hub for as long as a create is out.
  const [creation] = useState(() => createGraphCreation({ hub: store }));
  const { waiting, refused } = useSyncExternalStore(creation.subscribe, creation.getSnapshot);
  const [name, setName] = useState('');
  const [projectChoice, setProjectChoice] = useState<string | null>(null);

  const projects = projectChoices(layout);
  // The choice survives in state in case its option returns, but only a
  // project the current tree lists is used; one project needs no choosing.
  const offered = projectChoice !== null && projects.some((choice) => choice.id === projectChoice);
  const chosen: NodeId | null =
    projects.length === 1
      ? (nodeIdSchema.safeParse(projects[0]?.id).data ?? null)
      : offered
        ? (nodeIdSchema.safeParse(projectChoice).data ?? null)
        : null;

  const blocked = graphCreateBlockedReason(snapshot.phase, name, chosen);

  function close(): void {
    creation.reset();
    setName('');
    onClose();
  }

  function submit(): void {
    const parsed = parseGraphName(name);
    if (!parsed.ok || chosen === null) return;
    creation.submit(chosen, parsed.name, (nodeId) => {
      setName('');
      onClose();
      navigate(graphHash(nodeId));
    });
  }

  return (
    <Modal opened={opened} onClose={close} title="New graph" centered>
      <Stack gap="sm">
        <TextInput
          label="Name"
          aria-label="Name"
          placeholder="What this graph is called"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />

        {projects.length === 0 ? (
          <Text fz={13} c="dimmed">
            the tree has no project yet, and a graph belongs to one
          </Text>
        ) : projects.length === 1 ? (
          // One project is not a choice: it is named in words instead.
          <Text fz={13} c="dimmed">
            in {projects[0]?.label}
          </Text>
        ) : (
          <Select
            label="Project"
            aria-label="Project"
            placeholder="Which project this graph belongs to"
            data={projects.map((choice) => ({ value: choice.id, label: choice.label }))}
            value={chosen}
            onChange={setProjectChoice}
          />
        )}

        {blocked === null ? null : (
          <Text fz={13} c="dimmed">
            {blocked}
          </Text>
        )}
        {refused === null ? null : (
          <Text fz={13} style={{ color: colorForTone('blocked', scheme) }}>
            {refused}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          <Button onClick={submit} disabled={blocked !== null || waiting}>
            Create graph
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
