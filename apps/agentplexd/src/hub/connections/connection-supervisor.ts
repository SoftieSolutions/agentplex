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
  type InstructionOutcome,
  type ServerConnection,
  type ServerConnectionReport,
  type ServerStoreReport,
  type SessionInstruction,
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
  /** Called with every store report any server sends. The reducer's other seam. */
  readonly onReport?: (report: ServerStoreReport) => void;
  readonly instructionTimeoutMs?: number;
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
  /**
   * Puts an instruction to one paired server, by registration.
   *
   * Addressed by `ServerRegistrationId` because that is the hub's own name for
   * a machine and the one every decision above here is made in: the scheduler
   * chose a registration, and a supervisor that took a `ServerId` would make
   * every caller translate between two names for one thing.
   *
   * A registration this hub is not supervising is a refusal rather than a
   * throw, for the same reason an unreachable one is: both are answers a client
   * is waiting for, and neither is exceptional.
   */
  ask(
    registrationId: ServerRegistrationId,
    instruction: SessionInstruction,
  ): Promise<InstructionOutcome>;
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
            ...(dependencies.onReport === undefined ? {} : { onReport: dependencies.onReport }),
            ...(dependencies.instructionTimeoutMs === undefined
              ? {}
              : { instructionTimeoutMs: dependencies.instructionTimeoutMs }),
          }),
        );
      }
    },

    snapshot(): readonly ServerConnectionReport[] {
      return [...connections.values()].map((connection) => connection.report);
    },

    ask(
      registrationId: ServerRegistrationId,
      instruction: SessionInstruction,
    ): Promise<InstructionOutcome> {
      const connection = connections.get(registrationId);
      if (connection === undefined) {
        return Promise.resolve({
          ok: false,
          code: 'refused',
          problem: 'this hub has no such server paired',
          hold: null,
        });
      }
      return connection.ask(instruction);
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
