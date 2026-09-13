import { type JSX } from 'react';
import type { Layout } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { Box, Group, Stack, Text, Title } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { NodeMenu } from './node-menu.js';
import { projectNodes } from './tree-model.js';

/**
 * The projects in the tree, one row each, with what can be done to one.
 *
 * A list and not a tree, which is the honest shape for this milestone: AGX-134
 * draws the sidebar, and a half-tree here would be a second arrangement of the
 * same nodes for a user to reconcile with it. What a row is for is the menu on
 * it -- until this landed a project could be made and then never renamed,
 * moved or removed, which is a thing the hub could do and no screen could ask
 * for.
 *
 * Nothing is drawn at all when there are no projects. A heading over an empty
 * space is a promise that something belongs there.
 */
export interface ProjectRowsProps {
  readonly store: HubStore;
  readonly layout: Layout | null;
  readonly scheme: Scheme;
}

export function ProjectRows({ store, layout, scheme }: ProjectRowsProps): JSX.Element | null {
  const projects = projectNodes(layout);
  if (projects.length === 0) return null;

  return (
    <Stack gap={6}>
      <Title order={2} fz={13} c={colorForRole('textMuted', scheme)}>
        Projects
      </Title>
      {projects.map((project) => (
        <Box
          key={project.id}
          bg={colorForRole('surface', scheme)}
          style={{
            border: `1px solid ${colorForRole('border', scheme)}`,
            borderRadius: 8,
            padding: '7px 10px',
          }}
        >
          <Group justify="space-between" wrap="nowrap" gap={8}>
            <Text fz={13} truncate="end" c={colorForRole('text', scheme)}>
              {/* A project cannot be nameless -- the hub refuses a blank name --
                  so the id is a fallback that says something true rather than a
                  placeholder that invents one. */}
              {project.name ?? project.id}
            </Text>
            <NodeMenu
              store={store}
              nodeId={project.id}
              name={project.name ?? project.id}
              layout={layout}
              anchor={null}
              scheme={scheme}
            />
          </Group>
        </Box>
      ))}
    </Stack>
  );
}
