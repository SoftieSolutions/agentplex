import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalOutcome,
  PendingApproval,
  RefusalCode,
  ServerRegistrationId,
  ServerToHubFrame,
  SessionRef,
} from '@agentplex/protocol';
import type { Clock, Logger } from '@agentplex/node-shared';
import type { ApprovalPolicyGrant } from '../approval-policy/approval-policy.js';

/**
 * The requests this hub is holding open on somebody's behalf.
 *
 * An agent blocks on a tool call, the machine it is on says so, and every
 * attached client can answer. This is the one place that says which requests
 * are open, which machine each belongs to, and what became of the ones that are
 * not open any more.
 *
 * ## No database, deliberately
 *
 * A pending approval is a claim about *now* -- the same argument `fleet-state`
 * makes about sessions, and here it is sharper. On the other side of every row
 * in this file there is a process parked on a socket with a timeout running.
 * A table read back after a restart would present questions whose hooks stopped
 * waiting minutes ago as answerable, and the answer a person then gave would
 * reach nobody: the tool call has already fallen through as though no hook had
 * run. What is lost by holding this in memory is the truth, and what is lost by
 * writing it down is a person's trust that tapping Allow allowed something.
 *
 * Boot therefore starts empty, and that is correct rather than merely cheap:
 * the hub redials, the servers' gates still hold whatever is open, and a
 * request that is still blocked is still blocked on the machine that minted it.
 *
 * ## Deciding once
 *
 * The ticket is the races, and all of them meet at `decide`. Two clients tap at
 * one moment; a client taps a request the agent already took back; a client
 * that reconnected taps one it never saw end. The rule is one claim per
 * `{ storeId, sessionId, approvalId }`, taken before anything is sent and
 * released only when nothing was applied. Every other answer is told what
 * actually happened, which is not the same as being told it was wrong.
 *
 * The far machine is the authority on what happened, and this file never
 * guesses in its place. A `grant` that reached a hook which had already stopped
 * waiting is `expired`, not `granted`, and only the machine holding the blocked
 * process can tell those apart -- so an answer here resolves on the
 * `approval-settled` that machine sends, never on the instruction being
 * accepted.
 *
 * ## Why a decision is not an instruction round trip
 *
 * `servers.ask` gives up after thirty seconds, and a granted command may run
 * for ten minutes. So the decide frame is dispatched and its *refusal* is the
 * only thing awaited on that path: silence from the server means the decision
 * was handed to the hook, and what the hook then did arrives unsolicited. A
 * caller waiting here waits for the settlement, the withdrawal, or its own
 * machine going away -- all three of which are bounded by the connection rather
 * than by a timer this feature would have to invent.
 */

/**
 * How many endings are remembered once the request itself is gone.
 *
 * The mirror of the server gate's own memory, and for the same reason: a late
 * answer is the ordinary race in this ticket, and it is owed the word for what
 * happened rather than "no such approval". Bounded because a hub runs for weeks
 * and every question ever asked of it is a leak; what falls out of the end is
 * old enough that nobody is still holding a screen showing it.
 */
const ENDINGS_REMEMBERED = 256;

/** Nothing open for a session, which is what most sessions have. */
export const NOTHING_PENDING: readonly PendingApproval[] = [];

/**
 * What one server says about an approval, typed by the frames themselves.
 *
 * Extracted from the protocol union rather than restated, so that a field added
 * to a frame is a type error here rather than a field silently dropped on the
 * way to a client. Three entry points rather than one taking the union, because
 * the caller is the frame router's own exhaustive switch: re-reading `type`
 * here would be the second hand-written check on a frame that this codebase
 * says there is exactly one of.
 */
export type ApprovalRequestedFrame = Extract<ServerToHubFrame, { type: 'approval-requested' }>;
export type ApprovalWithdrawnFrame = Extract<ServerToHubFrame, { type: 'approval-withdrawn' }>;
export type ApprovalSettledFrame = Extract<ServerToHubFrame, { type: 'approval-settled' }>;

/**
 * One decision on its way to one machine.
 *
 * Not the frame: a frame id is unique within a connection and only the
 * connection can mint one, which is the rule `ServerInstruction` states. What
 * this adds to the frame's own fields is the machine, because a decision goes
 * to the machine that reported the request and this feature is the only thing
 * that remembers which one that was.
 */
export interface ApprovalInstruction {
  readonly registrationId: ServerRegistrationId;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
}

/**
 * What came back about a decision that was put to a machine.
 *
 * `ok` is silence, which is what a server that accepted one says: the
 * settlement travels separately and is not this answer. A refusal is the only
 * thing that comes back on this path, and it means nothing was applied.
 */
export type ApprovalDispatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

/** What a client asked for: this session's request, answered this way. */
export interface DecideRequest {
  readonly ref: SessionRef;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
}

/**
 * What became of an answer, in the terms a client is answered in.
 *
 * `ok` is this answer having been the one applied. Everything else is
 * `ok: false`, and the `outcome` beside it is the difference between the two
 * refusals a person can meet: a word means the request ended and here is how --
 * somebody else's answer, the agent taking it back, or the hook giving up --
 * and `null` means there is no such request to have ended, which is the only
 * case where this hub has nothing to report.
 *
 * A settlement of `expired` is `ok: false` even for the client whose decision
 * was the one sent, because it is: the answer reached a hook that had stopped
 * waiting, and the tool call fell through as though nobody had answered.
 */
export type ApprovalAnswer =
  | {
      readonly ok: true;
      readonly outcome: ApprovalOutcome;
      readonly answeredBy: ApprovalPolicyGrant | null;
    }
  | {
      readonly ok: false;
      readonly outcome: ApprovalOutcome | null;
      readonly answeredBy: ApprovalPolicyGrant | null;
      readonly code: RefusalCode;
      readonly problem: string;
    };

export interface ApprovalsDependencies {
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Called with every change to what one session has open, as the whole list.
   *
   * A callback rather than the reducer itself, exactly as the attention
   * feature's is: the composition root wires this to
   * `FleetState.applyApprovals`, and nothing in this file imports the thing it
   * notifies. A whole list rather than an arrival or a departure, because that
   * is what a session row carries and a reducer applying "one ended" would be
   * keeping a second copy of an answer this file already has.
   *
   * It is also what moves the state's version: a request that appeared without
   * moving it would sit in a broadcast cache and reach nobody.
   */
  readonly onChanged: (ref: SessionRef, approvals: readonly PendingApproval[]) => void;
  /**
   * Puts one decision to one machine, and answers with the refusal or with
   * silence.
   *
   * A function rather than the connection registry, so that the rules above are
   * a unit test rather than something only a socket can demonstrate -- and so
   * that nothing here can reach a machine for any other purpose.
   */
  readonly dispatch: (instruction: ApprovalInstruction) => Promise<ApprovalDispatch>;
  /**
   * What the project this session is filed under has already decided about a
   * request like this one, or `null`: ask somebody.
   *
   * A function for the reason `dispatch` is one -- what this file does with a
   * standing grant is then a unit test rather than something only a populated
   * node tree and a migrated database could demonstrate -- and it takes the two
   * fields a person would have read rather than the whole request, so that
   * nothing a policy is ever handed can include an id or a decision.
   *
   * It is expected not to reject: `ApprovalPolicy.grantFor` answers `null` for
   * every way of not knowing, because a policy that fails closed asks a
   * question somebody already answered and a policy that fails open runs a
   * command nobody approved. A rejection is caught here anyway, and reaches a
   * person, because the alternative is an agent left blocked by an error
   * thrown in the code path whose job is to make sure somebody is asked.
   */
  readonly policy: (
    ref: SessionRef,
    request: { readonly tool: string; readonly proposal: string },
  ) => Promise<ApprovalPolicyGrant | null>;
}

export interface Approvals {
  /** A machine says one of its agents is blocked. Stamped and held. */
  requested(source: ServerRegistrationId, frame: ApprovalRequestedFrame): void;
  /** The agent is not asking any more, and nothing was decided. */
  withdrawn(source: ServerRegistrationId, frame: ApprovalWithdrawnFrame): void;
  /** What actually happened at the hook, which only that machine can say. */
  settled(source: ServerRegistrationId, frame: ApprovalSettledFrame): void;
  /**
   * A machine is no longer connected, so nothing it was holding can be
   * answered.
   *
   * Every request it reported is withdrawn: the question may well still be open
   * over there, but no answer given here can reach it, and a row offering a
   * button that cannot work is the over-claim this whole path is shaped
   * against. It surfaces again if the machine comes back and its gate says so.
   */
  serverGone(registrationId: ServerRegistrationId): void;
  /**
   * Answers one open request, once, and resolves when the machine holding it
   * says what happened.
   *
   * Never on the instruction being accepted: see the note at the top on why
   * thirty seconds is the wrong deadline for a ten-minute tool call.
   */
  decide(request: DecideRequest): Promise<ApprovalAnswer>;
}

/**
 * The key a session's open requests are filed under.
 *
 * JSON rather than a joined string, for the reason the attention table's key is
 * JSON: a store id and a session id are opaque, either may contain whatever
 * separator was chosen, and two sessions colliding on one key would put one
 * session's pending approval on another.
 */
function keyOf(ref: SessionRef): string {
  return JSON.stringify([ref.storeId, ref.sessionId]);
}

/** The key one ended request is remembered under, session and all. */
function endingKey(ref: SessionRef, approvalId: ApprovalId): string {
  return JSON.stringify([ref.storeId, ref.sessionId, approvalId]);
}

/** One open request, with the two things only this hub knows about it. */
interface OpenApproval {
  readonly ref: SessionRef;
  /**
   * The row as every client reads it, replaced rather than mutated when a rule
   * answers: the list handed to `onChanged` is what a client is sent, so the
   * mark saying nobody was asked has to be on the object that travels.
   */
  pending: PendingApproval;
  /** The machine that reported it, which is the only one that can answer it. */
  readonly source: ServerRegistrationId;
  /**
   * Whether a decision has been sent for it, and everybody waiting on what
   * became of it.
   *
   * The claim is the whole of deciding once: it is taken before the instruction
   * is dispatched, so a second client arriving while the first frame is in the
   * socket finds it taken. It is released only when nothing was applied -- a
   * machine that refused the decision -- because a request nobody could answer
   * must not be left holding a claim no second tap can ever get past.
   */
  claimed: boolean;
  readonly waiting: ((answer: ApprovalAnswer) => void)[];
  /**
   * The standing rule that answered this, when nobody was asked.
   *
   * Set in the one tick that also takes the claim, so it can never describe a
   * decision a person got to first. It is what makes an auto-grant
   * attributable: the log line for the settlement names the project and the
   * rule, rather than reporting a grant with nobody's name on it.
   */
  grantedByPolicy: ApprovalPolicyGrant | null;
}

export function createApprovals({
  clock,
  logger: parent,
  onChanged,
  dispatch,
  policy,
}: ApprovalsDependencies): Approvals {
  const logger = parent.child({ part: 'approvals' });

  /** Open requests, by session and then by id. A session usually has none. */
  const open = new Map<string, Map<ApprovalId, OpenApproval>>();
  /** What became of the requests that are not open any more. Bounded. */
  const endings = new Map<string, ApprovalOutcome>();

  const announce = (ref: SessionRef): void => {
    const held = open.get(keyOf(ref));
    onChanged(
      ref,
      held === undefined ? NOTHING_PENDING : [...held.values()].map((entry) => entry.pending),
    );
  };

  const remember = (ref: SessionRef, approvalId: ApprovalId, outcome: ApprovalOutcome): void => {
    endings.set(endingKey(ref, approvalId), outcome);
    while (endings.size > ENDINGS_REMEMBERED) {
      const oldest = endings.keys().next();
      if (oldest.done === true) break;
      endings.delete(oldest.value);
    }
  };

  /**
   * Ends one request: it leaves the row, its ending is remembered, and everyone
   * waiting on it is told.
   *
   * One function for all four endings, because the difference between them is a
   * word and the bookkeeping is not. Everything waiting is answered here rather
   * than where each ending arrives, which is what makes "answered once, told
   * once" a property of this file and not of its callers.
   */
  const end = (entry: OpenApproval, outcome: ApprovalOutcome): void => {
    const key = keyOf(entry.ref);
    const held = open.get(key);
    held?.delete(entry.pending.approvalId);
    if (held !== undefined && held.size === 0) open.delete(key);
    remember(entry.ref, entry.pending.approvalId, outcome);

    const waiting = entry.waiting.splice(0);
    for (const [index, answer] of waiting.entries()) {
      // The first waiter is the one whose decision was sent. It is told `ok`
      // only when something was actually applied: a grant that met a hook which
      // had given up changed nothing, and calling that a success is the
      // over-claim this feature exists to avoid.
      const applied = index === 0 && (outcome === 'granted' || outcome === 'denied');
      answer(
        applied
          ? { ok: true, outcome, answeredBy: entry.grantedByPolicy }
          : {
              ok: false,
              outcome,
              // Told to the losers of the race as well as to the winner: a
              // person who tapped Allow a moment after a rule did is owed the
              // rule, rather than a bare `granted` they would read as theirs.
              answeredBy: entry.grantedByPolicy,
              code: 'refused',
              problem:
                index === 0
                  ? `that approval is ${outcome}`
                  : `that approval was already answered, and is ${outcome}`,
            },
      );
    }

    announce(entry.ref);
  };

  const lookup = (ref: SessionRef, approvalId: ApprovalId): OpenApproval | undefined =>
    open.get(keyOf(ref))?.get(approvalId);

  /**
   * The request a server frame names, when that server is the one holding it.
   *
   * A machine may only speak about its own: two servers can have one volume
   * mounted and therefore see one session, but a blocked process belongs to the
   * box it is running on, and taking one machine's word for what became of
   * another's request would clear a row while an agent was still waiting.
   */
  const heldBy = (
    source: ServerRegistrationId,
    ref: SessionRef,
    approvalId: ApprovalId,
    what: string,
  ): OpenApproval | undefined => {
    const entry = lookup(ref, approvalId);
    if (entry === undefined) {
      // Not a warning: a withdrawal chasing a settlement across the wire is
      // ordinary, and so is either arriving for a request a redial already
      // cleared.
      logger.debug('a server spoke about an approval this hub is not holding', {
        ...ref,
        approvalId,
        what,
      });
      return undefined;
    }
    if (entry.source !== source) {
      logger.warn('a server spoke about an approval another machine is holding', {
        ...ref,
        approvalId,
        what,
        source,
        holder: entry.source,
      });
      return undefined;
    }
    return entry;
  };

  return {
    requested(source: ServerRegistrationId, frame: ApprovalRequestedFrame): void {
      const ref: SessionRef = { storeId: frame.storeId, sessionId: frame.sessionId };
      const key = keyOf(ref);
      const held = open.get(key) ?? new Map<ApprovalId, OpenApproval>();
      open.set(key, held);

      if (held.has(frame.approval.approvalId)) {
        // The id is minted per blocked hook on one machine, so a repeat is a
        // machine restating something already on the row. Stamping it again
        // would move the wait it is about to be drawn with.
        logger.debug('an approval was reported twice', {
          ...ref,
          approvalId: frame.approval.approvalId,
        });
        return;
      }

      held.set(frame.approval.approvalId, {
        ref,
        // The hub's own clock, because the frame carries no date: two machines'
        // clocks disagree, and a client rendering "waiting four minutes" is
        // comparing this with its own notion of now.
        pending: { ...frame.approval, requestedAt: clock.now(), answeredBy: null },
        source,
        claimed: false,
        waiting: [],
        grantedByPolicy: null,
      });
      logger.info('approval requested', {
        ...ref,
        approvalId: frame.approval.approvalId,
        tool: frame.approval.tool,
        source,
      });
      // Announced before the policy is consulted, and that order is the
      // decision. The row appears on every client's screen either way; what a
      // matching rule then does is answer it a moment later, exactly as a
      // person tapping would. The other order -- hold the request back until
      // the policy has been read -- would mean a read of this hub's disk
      // sitting between a blocked agent and the screen that shows it, so a
      // database that had gone slow would look like an agent that had gone
      // quiet.
      announce(ref);
      void consult(ref, frame.approval.approvalId);
    },

    withdrawn(source: ServerRegistrationId, frame: ApprovalWithdrawnFrame): void {
      const ref: SessionRef = { storeId: frame.storeId, sessionId: frame.sessionId };
      const entry = heldBy(source, ref, frame.approvalId, 'withdrawn');
      if (entry === undefined) return;
      logger.info('approval withdrawn', { ...ref, approvalId: frame.approvalId });
      end(entry, 'withdrawn');
    },

    settled(source: ServerRegistrationId, frame: ApprovalSettledFrame): void {
      const ref: SessionRef = { storeId: frame.storeId, sessionId: frame.sessionId };
      const entry = heldBy(source, ref, frame.approvalId, 'settled');
      if (entry === undefined) return;
      logger.info('approval settled', {
        ...ref,
        approvalId: frame.approvalId,
        outcome: frame.outcome,
        // Named on the way out as well as on the way in, so that one line in
        // the log says both that a tool call ran and that nobody was asked
        // about it. An auto-grant that appeared only as a settlement would be
        // the silent half of this feature.
        ...(entry.grantedByPolicy === null
          ? {}
          : {
              grantedBy: 'policy',
              project: entry.grantedByPolicy.project,
              ruleId: entry.grantedByPolicy.ruleId,
            }),
      });
      end(entry, frame.outcome);
    },

    serverGone(registrationId: ServerRegistrationId): void {
      for (const held of [...open.values()]) {
        for (const entry of [...held.values()]) {
          if (entry.source !== registrationId) continue;
          logger.info('approval withdrawn: its machine is gone', {
            ...entry.ref,
            approvalId: entry.pending.approvalId,
            source: registrationId,
          });
          end(entry, 'withdrawn');
        }
      }
    },

    decide,
  };

  /**
   * Answers one open request, once, and resolves when the machine holding it
   * says what happened.
   *
   * Hoisted rather than written into the object above, because it has two
   * callers now: a client, through the interface, and this hub's own standing
   * policy through `consult`. One function for both is the whole of "a policy
   * grant goes through the same decide-once path as a person's" -- a second
   * path that also dispatched would be a second place the claim could be
   * skipped.
   */
  function decide(request: DecideRequest): Promise<ApprovalAnswer> {
    const entry = lookup(request.ref, request.approvalId);
    if (entry === undefined) {
      const remembered = endings.get(endingKey(request.ref, request.approvalId));
      if (remembered === undefined) {
        logger.info('approval decision refused', {
          ...request.ref,
          approvalId: request.approvalId,
          problem: 'no such approval',
        });
        return Promise.resolve({
          ok: false,
          outcome: null,
          answeredBy: null,
          code: 'refused',
          problem: 'this hub is holding no approval by that id for that session',
        });
      }
      return Promise.resolve({
        ok: false,
        outcome: remembered,
        // The request is gone and so is the rule that answered it. What is
        // remembered is the word, bounded; a rule kept alongside would be this
        // hub holding a copy of a policy that may since have been revoked.
        answeredBy: null,
        code: 'refused',
        problem: `that approval is ${remembered}`,
      });
    }

    const answered = new Promise<ApprovalAnswer>((resolve) => entry.waiting.push(resolve));

    // Claimed before anything is sent, so that a second client arriving while
    // this frame is in the socket finds it taken. Deciding once is this line.
    if (entry.claimed) return answered;
    entry.claimed = true;

    // Watched rather than awaited, and that is what this function returning
    // here rather than below buys. The seam answers with a refusal or with
    // silence, and silence is only known to be silence once a deadline has
    // passed at the connection; an answer that waited for that would hold
    // every *working* decision open for it, although the settlement it is
    // really waiting for may already have arrived on the same socket.
    void dispatch({
      registrationId: entry.source,
      approvalId: request.approvalId,
      decision: request.decision,
    }).then(
      (put) => {
        if (put.ok) return;
        refuseDispatch(entry, request, put.code, put.problem);
      },
      (error: unknown) => {
        // The hub's own side failed on the way to the socket. Nothing was
        // applied, which is exactly what a refusal states, so it is said the
        // same way rather than thrown at whoever tapped.
        refuseDispatch(
          entry,
          request,
          'internal',
          `the hub could not put that decision to the server: ${String(error)}`,
        );
      },
    );
    return answered;
  }

  /**
   * Asks the standing policy about one request the moment it arrives, and
   * grants it if a rule already covers it.
   *
   * Read here and nowhere else, with nothing cached, which is what makes a
   * rule removed while a request is pending stop applying to it: there is no
   * decision held anywhere that a rule produced earlier.
   *
   * Everything that is not an unambiguous match falls through to a person --
   * the policy answering `null`, the request having ended while the policy was
   * read, a person having tapped first, and the seam rejecting at all.
   */
  async function consult(ref: SessionRef, approvalId: ApprovalId): Promise<void> {
    const pending = lookup(ref, approvalId);
    if (pending === undefined) return;

    let grant: ApprovalPolicyGrant | null;
    try {
      grant = await policy(ref, { tool: pending.pending.tool, proposal: pending.pending.proposal });
    } catch (error) {
      logger.warn('the standing policy could not be consulted, so somebody will be asked', {
        ...ref,
        approvalId,
        problem: String(error),
      });
      return;
    }
    if (grant === null) return;

    // Read again rather than trusting the entry from before the await: the
    // agent may have taken the request back, or its machine may have gone,
    // while this hub was reading its own disk.
    const entry = lookup(ref, approvalId);
    if (entry === undefined || entry !== pending) return;
    if (entry.claimed) {
      // A person got there first, in the window the policy read opened. Their
      // answer is the one that counts, and this is not a second decision.
      logger.info('a standing rule matched an approval somebody had already answered', {
        ...ref,
        approvalId,
        project: grant.project,
        ruleId: grant.ruleId,
      });
      return;
    }

    // Set and claimed in one tick -- `decide` takes the claim synchronously --
    // so this can never end up describing a decision somebody else made.
    entry.grantedByPolicy = grant;
    // Put on the row and announced before the decision leaves this hub, which
    // is how every client learns a grant was automatic. The request is drawn as
    // answered-by-a-rule for as long as the machine holding the hook takes to
    // confirm, and then leaves the row like any other. The alternative -- a
    // frame of its own, broadcast -- would be a second channel saying something
    // about a request the row is already carrying.
    entry.pending = { ...entry.pending, answeredBy: grant };
    announce(ref);
    logger.info('approval granted by a standing rule, with nobody asked', {
      ...ref,
      approvalId,
      tool: entry.pending.tool,
      project: grant.project,
      ruleId: grant.ruleId,
      rule: `${grant.rule.tool} ${grant.rule.proposal}`,
    });
    void decide({ ref, approvalId, decision: 'grant' });
  }

  /**
   * Nothing was applied: the request goes back to being answerable and
   * everybody waiting on it is told.
   *
   * The claim is released because the far side may still be holding a blocked
   * hook, and a row nobody can tap again would be worse than one that can be
   * tapped twice. Everyone waiting is answered and not only the caller whose
   * frame it was: nothing happened, so nobody is owed an outcome and nobody
   * may be left holding a promise that only an answer which never happened
   * could settle.
   */
  function refuseDispatch(
    entry: OpenApproval,
    request: DecideRequest,
    code: RefusalCode,
    problem: string,
  ): void {
    if (lookup(request.ref, request.approvalId) === entry) entry.claimed = false;
    logger.info('a server refused a decision', {
      ...request.ref,
      approvalId: request.approvalId,
      problem,
    });
    const refusal: ApprovalAnswer = {
      ok: false,
      outcome: null,
      answeredBy: null,
      code,
      problem,
    };
    for (const resolve of entry.waiting.splice(0)) resolve(refusal);
  }
}
