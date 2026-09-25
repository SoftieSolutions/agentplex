import { nodeIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeProjects } from '../projects/fake-projects.js';
import { listProjectsTool } from './list-projects.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `list_projects`, against the projects feature's own fake.
 *
 * The rows and their ordering are the feature's and are tested over a real
 * migrated schema in `projects.integration.test.ts`. What is under test here
 * is the projection -- which three fields an agent is handed, and that the
 * tool asks nothing of a machine -- and a database in the way would be asking
 * that suite's questions again.
 */

const HUB = nodeIdSchema.parse('node-hub');
const WEB = nodeIdSchema.parse('node-web');

function listing(projects: ReturnType<typeof createFakeProjects>): Promise<ToolCall> {
  return callTool(listProjectsTool({ projects }));
}

interface ProjectRowView {
  readonly projectId: string;
  readonly name: string;
  readonly directory: string;
}

function rowsOf(call: ToolCall): readonly ProjectRowView[] {
  return call.structured?.['projects'] as unknown as readonly ProjectRowView[];
}

describe('list_projects', () => {
  it('answers with the id a start names, the name a person gave it, and where it is', async () => {
    const projects = createFakeProjects();
    projects.hold(HUB, '/volumes/work/agentplex', 'agentplex');

    const rows = rowsOf(await listing(projects));

    // Three fields and no fourth. Which machines could run this project is not
    // among them: the hub holds no server's browse roots, and the first start
    // is where that is found out, in the words of the machine that refused.
    expect(rows).toEqual([
      { projectId: HUB, name: 'agentplex', directory: '/volumes/work/agentplex' },
    ]);
  });

  it('answers an empty hub with an empty list rather than a refusal', async () => {
    const result = await listing(createFakeProjects());

    // A hub nobody has made a project on is not a failure, and an agent told
    // "no" would have no way to tell that from a hub it could not read.
    expect(result.isError).toBe(false);
    expect(rowsOf(result)).toEqual([]);
  });

  it('carries every project, in the order the feature answers in', async () => {
    const projects = createFakeProjects();
    projects.hold(WEB, '/volumes/work/web', 'web');
    projects.hold(HUB, '/volumes/work/agentplex', 'agentplex');

    const rows = rowsOf(await listing(projects));

    // By name, which is the order the statement sorts in. An agent reading a
    // listing to pick one row should get the same listing twice.
    expect(rows.map((row) => row.name)).toEqual(['agentplex', 'web']);
  });

  it('takes nothing at all, which is what makes it safe to call first', async () => {
    const tool = listProjectsTool({ projects: createFakeProjects() });

    expect(Object.keys(tool.input)).toEqual([]);
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it('browses nothing and resolves nothing while answering', async () => {
    const projects = createFakeProjects();
    projects.hold(HUB, '/volumes/work/agentplex', 'agentplex');

    await listing(projects);

    // The listing reads rows this hub already has. It puts no instruction to a
    // machine and turns no node into a path, which are the two things the
    // narrowed seam in `mcp.ts` denies it in the first place.
    expect(projects.listed).toEqual([]);
    expect(projects.looked).toEqual([]);
  });
});
