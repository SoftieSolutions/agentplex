import type { HubId, ServerRegistrationId } from '@agentplex/protocol';
import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';
import type { SocketDialer } from '../../shared/message-socket.js';
import type { Timers } from '../../shared/timers.js';
import type { Database } from '../db/database.js';
import { listServers } from '../pairing/server-registrations.js';
import { createExponentialBackoff, type BackoffPolicy } from './backoff.js';
import {
  startServerConnection,
  type ServerConnection,
  type ServerConnectionReport,
} from './server-connection.js';

/**
 * Every paired server, kept connected.
 *
 * One `ServerConnection` per live pairing and nothing more: the interesting
 * rules are all in there, and this is the part that knows which pairings exist
 * and owns their lifecycle. Keeping the two apart matters because they fail
 * differently -- one server being unreachable is normal and must cost only
 * itself, whereas the list of pairings being unreadable is the hub being
 * broken.
 *
 * There is no fleet-wide state here, deliberately. No "how many are up", no
 * shared backoff, no queue. Servers are independent by design: no
 * server-to-server coordination exists anywhere in this system, and a
 * supervisor that grew a shared notion of health would be the first place it
 * appeared.
 */

export interface ConnectionSupervisorDependencies {
  readonly database: Database;
  readonly dialer: SocketDialer;
  readonly hubId: HubId;
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Shared by every connection: it is a schedule, and it holds no state. */
  readonly backoff?: BackoffPolicy;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly refusedRetryMs?: number;
  /** Called whenever any server's connectivity changes. The reducer's seam. */
  readonly onChange?: (report: ServerConnectionReport) => void;
}

export interface ConnectionSupervisor {
  /**
   * Matches what is running to the pairings in the database: starts one for a
   * pairing that has none, and stops one whose pairing has been revoked or
   * deleted.
   *
   * Called at startup and by whatever changes a pairing. It reads rather than
   * being told what changed, because the database is the authority on which
   * servers this hub may dial and a supervisor that tracked that separately
   * would be a second answer to the same question.
   */
  sync(): Promise<void>;
  /** What every paired server's connectivity is, right now. */
  snapshot(): readonly ServerConnectionReport[];
  stop(): Promise<void>;
}

export async function startConnectionSupervisor(
  dependencies: ConnectionSupervisorDependencies,
): Promise<ConnectionSupervisor> {
  const { database, dialer, hubId, timers, clock } = dependencies;
  const logger = dependencies.logger.child({ part: 'connections' });
  const backoff = dependencies.backoff ?? createExponentialBackoff();

  const connections = new Map<ServerRegistrationId, ServerConnection>();
  let stopped = false;

  const supervisor: ConnectionSupervisor = {
    async sync(): Promise<void> {
      if (stopped) return;

      const registrations = await listServers(database);
      const live = new Set(registrations.map((registration) => registration.id));

      // Gone first: a revoked pairing must stop being dialled before anything
      // else happens, because the operator's revocation is the one instruction
      // here that is about denying access.
      const departing = [...connections].filter(([id]) => !live.has(id));
      for (const [id, connection] of departing) {
        connections.delete(id);
        logger.info('pairing gone; stopping', { registrationId: id });
        await connection.stop();
      }

      for (const registration of registrations) {
        if (connections.has(registration.id)) continue;
        // A revoked registration has no token, which is exactly the shape that
        // cannot be dialled; `listServers` excludes them, and this narrows the
        // union rather than asserting past it.
        if (registration.revokedAt !== null) continue;

        logger.info('dialling', {
          registrationId: registration.id,
          server: registration.label,
        });
        connections.set(
          registration.id,
          startServerConnection(registration, {
            database,
            dialer,
            hubId,
            timers,
            clock,
            logger,
            backoff,
            ...(dependencies.handshakeTimeoutMs === undefined
              ? {}
              : { handshakeTimeoutMs: dependencies.handshakeTimeoutMs }),
            ...(dependencies.heartbeatIntervalMs === undefined
              ? {}
              : { heartbeatIntervalMs: dependencies.heartbeatIntervalMs }),
            ...(dependencies.heartbeatTimeoutMs === undefined
              ? {}
              : { heartbeatTimeoutMs: dependencies.heartbeatTimeoutMs }),
            ...(dependencies.refusedRetryMs === undefined
              ? {}
              : { refusedRetryMs: dependencies.refusedRetryMs }),
            ...(dependencies.onChange === undefined ? {} : { onChange: dependencies.onChange }),
          }),
        );
      }
    },

    snapshot(): readonly ServerConnectionReport[] {
      return [...connections.values()].map((connection) => connection.report);
    },

    async stop(): Promise<void> {
      stopped = true;
      const running = [...connections.values()];
      connections.clear();
      // Together rather than one after another: they are independent, and a
      // shutdown that stopped them in series would wait for each in turn.
      await Promise.all(running.map((connection) => connection.stop()));
      logger.info('connections stopped', { servers: running.length });
    },
  };

  await supervisor.sync();
  return supervisor;
}
