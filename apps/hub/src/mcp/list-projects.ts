import { z } from 'zod';
import type { ProjectSummary } from '../projects/projects.js';
import { answers, defineMcpTool, readOnly, type McpTool } from './tool-registry.js';

/**
 * The projects this hub holds: what each is called, and where it is.
 *
 * `start_session` takes a project by node id, and a tool that takes an id is
 * not much use without the tool that says which ids there are. That is the
 * whole of why this exists, and it is why it lists projects rather than
 * searching the tree: an agent needs the one row it is about to name, and the
 * shape of the tree around it is a screen's problem.
 *
 * ## The directory is on the row, and it travels one way
 *
 * It is here because it is how a person -- and a model reading for a person --
 * tells which checkout a project is. Two projects called "hub" are told apart
 * by nothing else.
 *
 * What makes that safe is not this file, it is that there is nowhere to send
 * it back. No tool on this endpoint has an input property called `directory`,
 * `cwd` or `path`, and `mcp.integration.test.ts` asserts that over every
 * published input schema on this build and every later one. So an agent can
 * read a directory, quote it and compare it, and cannot spawn in it: the only
 * handle it has on a project is the id, which names a directory somebody
 * already browsed and chose.
 *
 * ## There is no list of machines on a row, and that is the honest answer
 *
 * The obvious fourth column would be which servers can run a project, and this
 * hub cannot answer it. A project is not tied to a machine -- migration 0006
 * argues that at length -- and whether a machine will spawn in a directory is
 * decided by the browse roots that machine's own operator configured, which
 * this hub holds no copy of and would be wrong about the moment one was
 * edited. Asking every connected machine per call is the other option: a round
 * trip per machine, for an answer that is only true for as long as it takes to
 * arrive, on a tool whose whole value is that it reads out of rows the hub
 * already has.
 *
 * So that fact is found out where it is known: at the first start, in the
 * words of the machine that refused. An agent that starts in a project no
 * machine will open is told which machine said no and why, which is the
 * sentence somebody can act on. A column that guessed would be this hub
 * over-claiming about another box's disk.
 *
 * ## Unbounded
 *
 * Like `list_servers` and `doc_list`, and for the same reason: a project is a
 * repository somebody went and picked by hand, so the list is as long as the
 * work a person has set up. If that stops being true it is `list_sessions`
 * this should borrow a limit from.
 */

/** What this tool needs of the projects feature: the listing, and nothing else. */
export interface ProjectIndex {
  list(): Promise<readonly ProjectSummary[]>;
}

/** One project, as `list_projects` answers. */
export const projectShape = {
  projectId: z
    .string()
    .describe('The node id of this project. What start_session and doc_list name it by.'),
  name: z.string().describe('What the person who made the project called it.'),
  directory: z
    .string()
    .describe(
      'Where the project is, as the person who made it browsed to it. It is here to tell two projects apart and to say which one you mean; no tool on this hub takes one back, so name the project by projectId.',
    ),
};

export type ProjectRow = z.infer<z.ZodObject<typeof projectShape>>;

/**
 * One row, projected rather than cast.
 *
 * An explicit return type for the reason `fleet-view.ts` gives for every
 * projection in it: a field added to `ProjectSummary` is a field somebody
 * decides an agent should see, here, rather than one that appears in an
 * agent's context because a feature grew it.
 */
function toProjectRow(summary: ProjectSummary): ProjectRow {
  return { projectId: summary.nodeId, name: summary.name, directory: summary.directory };
}

export function listProjectsTool({ projects }: { readonly projects: ProjectIndex }): McpTool {
  return defineMcpTool({
    name: 'list_projects',
    description:
      'Lists the projects this hub holds: the id start_session takes, the name somebody gave it, and where it is. Which machines will run a project is not known until a start is tried, so it is not on a row.',
    input: {},
    output: {
      projects: z.array(z.object(projectShape)),
    },
    annotations: readOnly,
    run: async () => answers({ projects: (await projects.list()).map(toProjectRow) }),
  });
}
