import type { ServerToHubFrame, SessionStartTag, StoreId } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { GrantId } from '@agentplex/providers';
import type { SessionController } from './session-control.js';

/**
 * Every hub currently connected to this server, and the two things a server
 * with more than one of them has to be able to do.
 *
 * **Tell all of them what changed.** A hub sends `session-stop` for a session
 * the other hub started and is watching. It is stopped -- see below for why
 * that is allowed -- and before this file the second hub learned its session
 * had died from whenever it next happened to scan, with nothing saying who did
 * it. A reply cannot help: `session-stopped` carries `replyTo`, and there is no
 * frame to reply to on a connection that asked nothing. What every hub can be
 * told is the fact rather than the answer, and there is already a frame that is
 * exactly that: `store-report` is unsolicited, whole, and one server's entire
 * view of one store. So anything that changes what is running in a store sends
 * one to every connected hub, and the hub that asked gets its answer after it,
 * in the order the socket already guarantees.
 *
 * One scan feeds all of them. Reporting per connection would put N scans of a
 * store behind one stop, which is the same disk read repeated for an answer
 * that cannot differ between hubs -- a store report says what is in a store,
 * and a store does not look different depending on who is asking.
 *
 * **Close the connections one grant holds.** A grant revoked while a hub is
 * connected has to reach that hub now rather than whenever it happens to
 * reconnect, and the connection is reachable precisely because the handshake
 * resolved a grant the server minted and kept it. Two connections may share one
 * grant -- a hub reconnecting before the old socket has finished closing -- so
 * this closes every connection holding it, not the first.
 *
 * ## Who may do what to whose session
 *
 * Any paired hub may start, stop and watch any session on this server, and
 * nothing here checks which hub started one.
 *
 * That is the decision and not the default. A session's identity is
 * `{ storeId, sessionId }` and never the machine, and a hub is further from a
 * session than the machine is: a store is a volume both hubs mounted, both can
 * read the transcript off it, and the hub that happened to send the start is
 * not part of what the session *is*. Two paired hubs are also one trust domain
 * in the only sense that matters here -- each holds a credential this server
 * minted for it, and neither was minted with less authority than the other,
 * because grants carry no scopes yet.
 *
 * What changes when there is a reason to say no is the grant record, which is
 * where a scope goes. What does not change is the machinery here: telling every
 * hub what happened is right whether or not they were all allowed to cause it,
 * and it is what stops a permitted action from looking like an unexplained one.
 */

/**
 * One store's whole view as this server holds it, before any one hub's start
 * handles are put on it. Everything in here is the same for every hub.
 */
type StoreReport = Omit<Extract<ServerToHubFrame, { type: 'store-report' }>, 'starts'>;

/** One connected hub, as this server can reach it. */
export interface HubMember {
  /**
   * This connection, as the terminal manager's watcher set names it.
   *
   * Per connection rather than per grant: one grant may hold two sockets, and
   * one of them closing must not drop the other's watchers.
   */
  readonly connectionId: string;
  /** The grant this connection authenticated with. What a revocation names. */
  readonly grantId: GrantId;
  send(frame: ServerToHubFrame): void;
  /**
   * The start provenance this connection owes the next report of a store.
   *
   * Asked of the member rather than carried on the scan, because a start
   * handle is the id of a frame on *this* socket: it identifies nothing on
   * another hub's connection, and putting one hub's handles in another hub's
   * report would name a start that hub never made. So the store is scanned
   * once for everybody and the tags are taken once per hub, at the moment that
   * hub's copy is actually sent -- taking them is what stops a start being
   * reported twice, and a tag consumed by a report that never went out would
   * be a pairing the hub was never told.
   */
  takeStartTags(storeId: StoreId): readonly SessionStartTag[];
  /** Ends this connection, with a reason only an authenticated peer ever reads. */
  close(reason: string): void;
}

export interface HubAudience {
  /** Adds a member and returns the removal. Idempotent, like every detach here. */
  join(member: HubMember): () => void;
  /** One scan of a store, sent to every connected hub. */
  reportToAll(storeId: StoreId): Promise<void>;
  /**
   * One scan of a store, sent to one hub.
   *
   * What a hub that has only now connected is owed: it knows what this machine
   * has mounted and nothing about what is in it. The hubs that were already
   * here know both and are not sent it again.
   */
  reportTo(member: HubMember, storeId: StoreId): Promise<void>;
  /** Closes every connection holding this grant, and says how many there were. */
  disconnect(grantId: GrantId, reason: string): number;
  /** The grants the live connections authenticated with, each once. */
  readonly grants: readonly GrantId[];
}

export interface HubAudienceDependencies {
  readonly sessions: SessionController;
  readonly logger: Logger;
  /**
   * Called when a member leaves, whatever ended it.
   *
   * The server hangs the terminal manager's `release` on this, which is what
   * takes a dead socket's watchers off every terminal it was holding against
   * eviction. It is a callback rather than a dependency on the manager, because
   * nothing about reaching connected hubs should need to know that terminals
   * exist.
   */
  readonly onLeave?: ((member: HubMember) => void) | undefined;
}

export function createHubAudience({
  sessions,
  logger,
  onLeave,
}: HubAudienceDependencies): HubAudience {
  const members = new Set<HubMember>();

  /**
   * One store's whole view, or `null` when there is nothing honest to send.
   *
   * A scan that failed costs the report and nothing else. Every hub keeps the
   * last one it had, labelled with its age, which is the true state of a store
   * this server could not read just now.
   */
  const scan = async (storeId: StoreId): Promise<StoreReport | null> => {
    try {
      const report = await sessions.report(storeId);
      if (report === null) return null;
      return {
        type: 'store-report',
        storeId: report.storeId,
        sessions: [...report.sessions],
        holding: [...report.holding],
      };
    } catch (error) {
      logger.warn('could not report a store', { storeId, problem: String(error) });
      return null;
    }
  };

  /** One hub's copy of a scan: everybody's facts, and this hub's own starts. */
  const deliver = (member: HubMember, report: StoreReport): void => {
    member.send({ ...report, starts: [...member.takeStartTags(report.storeId)] });
  };

  return {
    join(member: HubMember): () => void {
      members.add(member);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        members.delete(member);
        onLeave?.(member);
      };
    },

    async reportToAll(storeId: StoreId): Promise<void> {
      const frame = await scan(storeId);
      if (frame === null) return;
      // Read after the await, not before: a hub that connected while the store
      // was being scanned is owed this report, and one that left is not there
      // to be sent it.
      for (const member of [...members]) deliver(member, frame);
    },

    async reportTo(member: HubMember, storeId: StoreId): Promise<void> {
      const frame = await scan(storeId);
      if (frame === null || !members.has(member)) return;
      deliver(member, frame);
    },

    disconnect(grantId: GrantId, reason: string): number {
      const holders = [...members].filter((member) => member.grantId === grantId);
      // The close is what removes them: a member leaves through the same path
      // whether its socket ended on its own or was ended here, so nothing has
      // to remember to do both.
      for (const member of holders) member.close(reason);
      return holders.length;
    },

    get grants(): readonly GrantId[] {
      return [...new Set([...members].map((member) => member.grantId))];
    },
  };
}
