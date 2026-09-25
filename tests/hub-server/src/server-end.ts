import type { MessageSocket } from '@agentplex/node-shared';
import { createFakeGrantAuthority } from '@agentplex/providers/testing';
import { createDirectoryBrowser } from '../../../apps/server/src/directories/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/directories/fake-directory-reader.js';
import { createFakeProjectFiles } from '../../../apps/server/src/projects/fake-project-files.js';
import { createHubAudience } from '../../../apps/server/src/hub/hub-audience.js';
import { createProjectDocs } from '../../../apps/server/src/projects/project-docs.js';
import {
  serveHubConnection,
  type HubConnection,
  type HubConnectionDependencies,
} from '../../../apps/server/src/hub/hub-connection.js';

/**
 * The server end of a linked socket pair, with the per-connection wiring a test
 * about the hub does not care about filled in.
 *
 * Four of a connection's dependencies exist for cases a suite about the hub is
 * not about -- which grant a token resolves to, which other hubs are connected,
 * which connection this is, and what this machine will let anybody browse --
 * and a suite driving one hub against one server has an answer for none of them
 * that is more interesting than "the obvious one". Defaulting them here rather
 * than repeating them at every call site keeps those suites about what they were
 * written to be about, and keeps one place to change when the shape of a
 * connection does.
 *
 * The default grant is derived from the identity's own token, so a suite that
 * dials with the token it was given still connects and one that dials with
 * another still does not: the authorization is real, it is just not the subject.
 *
 * The document store defaults to the real rules over an in-memory disk under
 * a data root nothing here reads back, for the same reason: no suite in this
 * directory is about documents yet, and a connection carries the store
 * whether or not the hub asks it anything.
 *
 * The default browser has no roots, which is the default a server actually
 * ships with and the one that refuses every browse with that as the reason. A
 * suite whose subject *is* browsing passes its own. Approvals default to
 * `null` for the same reason: the connection holds none unless the suite is
 * about them.
 */
export type ServerEndDependencies = Omit<
  HubConnectionDependencies,
  'connectionId' | 'grants' | 'audience' | 'docs' | 'browse' | 'approvals'
> &
  Partial<
    Pick<
      HubConnectionDependencies,
      'connectionId' | 'grants' | 'audience' | 'docs' | 'browse' | 'approvals'
    >
  >;

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
    browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
    // No approvals by default, which is a server that could not open the
    // socket hooks connect to: it refuses a decision rather than appearing to
    // apply one. A suite whose subject is approvals passes its own gate.
    approvals: null,
    ...dependencies,
  });
}
