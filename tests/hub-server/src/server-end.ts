import type { MessageSocket } from '@agentplex/node-shared';
import { createFakeGrantAuthority } from '@agentplex/providers/testing';
import { createFakeProjectFiles } from '../../../apps/server/src/fake-project-files.js';
import { createHubAudience } from '../../../apps/server/src/hub-audience.js';
import { createProjectDocs } from '../../../apps/server/src/project-docs.js';
import {
  serveHubConnection,
  type HubConnection,
  type HubConnectionDependencies,
} from '../../../apps/server/src/hub-connection.js';

/**
 * The server end of a linked socket pair, with the per-connection wiring a test
 * about the hub does not care about filled in.
 *
 * Three of a connection's dependencies exist for the multi-hub cases -- which
 * grant a token resolves to, which other hubs are connected, which connection
 * this is -- and a suite driving one hub against one server has an answer for
 * none of them that is more interesting than "the obvious one". Defaulting them
 * here rather than repeating them at every call site keeps those suites about
 * what they were written to be about, and keeps one place to change when the
 * shape of a connection does.
 *
 * The default grant is derived from the identity's own token, so a suite that
 * dials with the token it was given still connects and one that dials with
 * another still does not: the authorization is real, it is just not the subject.
 *
 * The document store defaults to the real rules over an in-memory disk under
 * a data root nothing here reads back, for the same reason: no suite in this
 * directory is about documents yet, and a connection carries the store
 * whether or not the hub asks it anything.
 */
export type ServerEndDependencies = Omit<
  HubConnectionDependencies,
  'connectionId' | 'grants' | 'audience' | 'docs'
> &
  Partial<Pick<HubConnectionDependencies, 'connectionId' | 'grants' | 'audience' | 'docs'>>;

let connections = 0;

export function serveServerEnd(
  socket: MessageSocket,
  dependencies: ServerEndDependencies,
): HubConnection {
  const { identity, sessions, logger } = dependencies;
  return serveHubConnection(socket, {
    connectionId: `connection-${(connections += 1)}`,
    grants: createFakeGrantAuthority({
      grants: { [identity.token]: `grant-for-${identity.serverId}` },
    }),
    audience: createHubAudience({ sessions, logger }),
    docs: createProjectDocs({
      dataRoot: '/var/lib/agentplex',
      files: createFakeProjectFiles(),
      logger,
    }),
    ...dependencies,
  });
}
