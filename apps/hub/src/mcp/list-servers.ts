import { z } from 'zod';
import { serverShape, toServerRow, type FleetReads } from './fleet-view.js';
import { answers, defineMcpTool, readOnly, type McpTool } from './tool-registry.js';

/**
 * Which machines this hub is supervising, and what each of them can presently
 * do.
 *
 * Unfiltered and unbounded, alone among the read tools, because a fleet is the
 * number of machines a person paired by hand -- a handful, not a listing that
 * needs paging. If that stops being true it is `list_sessions` this tool should
 * borrow a `limit` from, not a page the model has to walk.
 *
 * It grants nothing a client lacks: every field below is in the `machine-state`
 * frame the hub broadcasts to every attached browser before it has asked for
 * anything. What it adds is that an agent can read it without holding a socket
 * open, which is the whole of what this endpoint is for.
 */
export function listServersTool({ state }: { readonly state: FleetReads }): McpTool {
  return defineMcpTool({
    name: 'list_servers',
    description:
      'Lists the machines this hub is paired with: how reachable each one is, which stores it has mounted, and which coding agents it can start.',
    input: {},
    output: {
      servers: z.array(z.object(serverShape)),
    },
    annotations: readOnly,
    run: () => answers({ servers: state.published().servers.map(toServerRow) }),
  });
}
