import { useState, type JSX } from 'react';
import type { NodeId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout } from '../store/use-hub-store.js';
import { Button, Group, Stack, Text, Title, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { docHash } from './doc-route.js';
import { projectDocuments, type ProjectDocs as ProjectDocsRow } from './doc-rows.js';
import { NewDocForm } from './new-doc-form.js';

/**
 * The projects in the tree, each with its documents and a New doc action.
 *
 * This is where the `doc` kind becomes something a person can see on this
 * branch. The catalogue's own screen is a later ticket; what exists today is
 * the layout the store already asks for, and the documents are in it -- so the
 * rows are drawn beside the sessions rather than waiting for a tree view.
 *
 * A row opens the document in the layout's focused pane, by the same route a
 * session opens with: the address names the node, the layout screen shows it.
 *
 * What a row deliberately does not say is which machine holds the file. The
 * layout carries no server on a document node and no client frame lists
 * documents with their machines, so a label here would be a guess -- and the
 * guess would be wrong in exactly the case that matters, two machines with the
 * same checkout each holding their own copy. The machine is named where this
 * client can name it: in the form that writes a new document, and in the
 * refusal when the machine holding one is away.
 */

export interface ProjectDocsProps {
  readonly store: HubStore;
  readonly scheme: Scheme;
  /** How a document route is entered, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

// Outside the component: it touches nothing but the browser it runs in.
function assignHash(hash: string): void {
  window.location.hash = hash;
}

export function ProjectDocuments({
  store,
  scheme,
  navigate = assignHash,
}: ProjectDocsProps): JSX.Element | null {
  // Interest in the tree, declared for as long as this section is mounted.
  const layout = useHubLayout(store);
  const [creatingIn, setCreatingIn] = useState<NodeId | null>(null);
  const projects = projectDocuments(layout);
  if (projects.length === 0) return null;
  const creating = projects.find((project) => project.projectId === creatingIn) ?? null;

  return (
    <Stack gap={8}>
      <Group gap={14} align="baseline">
        <Title order={2} fz={14}>
          Projects
        </Title>
        <Text fz={11} style={{ color: colorForRole('textFaint', scheme) }}>
          a document is a file on one machine; which machine is named when it opens
        </Text>
      </Group>
      {projects.map((project) => (
        <ProjectRow
          key={project.projectId}
          project={project}
          scheme={scheme}
          onNewDoc={() => setCreatingIn(project.projectId)}
          onOpen={(nodeId) => navigate(docHash(nodeId))}
        />
      ))}
      {creating === null ? null : (
        <NewDocForm
          key={creating.projectId}
          store={store}
          projectId={creating.projectId}
          projectLabel={creating.label}
          opened
          onClose={() => setCreatingIn(null)}
          scheme={scheme}
          navigate={navigate}
        />
      )}
    </Stack>
  );
}

interface ProjectRowProps {
  readonly project: ProjectDocsRow;
  readonly scheme: Scheme;
  readonly onNewDoc: () => void;
  readonly onOpen: (nodeId: NodeId) => void;
}

function ProjectRow({ project, scheme, onNewDoc, onOpen }: ProjectRowProps): JSX.Element {
  return (
    <Stack
      gap={6}
      p={10}
      style={{
        border: `1px solid ${colorForRole('border', scheme)}`,
        borderRadius: 7,
        background: colorForRole('surfaceAlt', scheme),
      }}
    >
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text fz={13} fw={600} style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {project.label}
        </Text>
        <Button size="compact-xs" variant="default" onClick={onNewDoc}>
          New doc
        </Button>
      </Group>
      {project.docs.length === 0 ? (
        <Text fz={12} style={{ color: colorForRole('textFaint', scheme) }}>
          no documents in this project yet
        </Text>
      ) : (
        <Group gap={6}>
          {project.docs.map((doc) => (
            <UnstyledButton
              key={doc.nodeId}
              onClick={() => onOpen(doc.nodeId)}
              fz={12}
              c={colorForRole('text', scheme)}
              bg={colorForRole('raised', scheme)}
              style={{ padding: '3px 9px', borderRadius: 5, whiteSpace: 'nowrap' }}
            >
              {doc.name}
            </UnstyledButton>
          ))}
        </Group>
      )}
    </Stack>
  );
}
