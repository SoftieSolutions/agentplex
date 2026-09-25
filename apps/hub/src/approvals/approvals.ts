import {
  assertNever,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSubject,
  type GraphRunApproval,
  type GraphRunApprovalSubject,
  type GraphRunId,
  type NodeId,
  type PendingApproval,
  type RefusalCode,
  type ServerRegistrationId,
  type ServerToHubFrame,
  type SessionRef,
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
 * ## Two origins, one feature
 *
 * A graph run reaching a HUMAN node also stops and asks, and it asks through
 * this file rather than through a second one. The request is the same shape,
 * the tap that answers it is the same tap, and deciding once is the same rule
 * -- two clients answering a run's question at one moment is the race this
 * file already resolves. What differs is who holds the blocked thing, and that
 * is one field on the entry: a machine, which is told the decision and later
 * says what it did with it, or the hub itself, which is the authority on its
 * own run and so ends the request the moment it is decided. Everything below
 * that switches on the origin ends in `assertNever`, so a third thing that
 * asks is a type error here and not a request nobody routes.
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

/** No run waiting on a person, which is what a hub usually has. */
export const NO_RUN_WAITING: readonly GraphRunApproval[] = [];

/** The subject of a request a run raised: the one kind `requestedByHub` takes. */
export type GraphRunSubject = GraphRunApprovalSubject;

/** What a person reads beside a run's request: which graph, which number, which node. */
export interface GraphRunAbout {
  readonly graph: NodeId;
  readonly number: number;
  readonly nodeLabel: string;
}

/**
 * Who is holding the blocked thing a request is about.
 *
 * A machine, which reported the request and is the only one that can apply an
 * answer to it; or this hub, whose run raised it and is waiting on `resolve`.
 * The hub origin carries what a client is shown beside the request -- the
 * graph and the run number -- because that is display and travels with the
 * list, where the subject inside the request is identity and travels back.
 */
export type ApprovalOrigin =
  | { readonly kind: 'machine'; readonly registrationId: ServerRegistrationId }
  | {
      readonly kind: 'hub';
      readonly about: GraphRunAbout;
      readonly resolve: (outcome: ApprovalOutcome) => void;
    };

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

/** What a client asked for: this subject's request, answered this way. */
export interface DecideRequest {
  readonly subject: ApprovalSubject;
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
   * Called with every change to the runs waiting on a person, as the whole
   * list, oldest request first.
   *
   * Its own channel rather than `onChanged` with a run where the session
   * goes, because the reducer files those under a session row and a run has
   * none. The composition root wires it to `FleetState.applyGraphRunApprovals`,
   * which publishes it beside the stores.
   */
  readonly onGraphRunChanged: (waiting: readonly GraphRunApproval[]) => void;
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
   * Answers one open request, once, and resolves when whoever holds it says
   * what happened: the machine, on its settlement, or this hub, at once.
   *
   * Never on the instruction being accepted: see the note at the top on why
   * thirty seconds is the wrong deadline for a ten-minute tool call.
   */
  decide(request: DecideRequest): Promise<ApprovalAnswer>;
  /**
   * A run of this hub's own is waiting on a person. Held like a machine's
   * request, answered by the same tap, and resolved with what became of it.
   *
   * The approval id is the caller's to mint. This feature has no id source --
   * every id it has ever held was minted where the blocked hook was -- and
   * the run is the thing holding the blocked step, so the rule that the id is
   * minted at the block still holds.
   *
   * Resolves `granted` or `denied` on a decision, `withdrawn` when
   * `withdrawnByHub` takes it back, and never rejects: a run waiting on this
   * has nothing to do with an exception but fail, and the word is the answer.
   */
  requestedByHub(
    subject: GraphRunSubject,
    request: ApprovalRequest,
    about: GraphRunAbout,
  ): Promise<ApprovalOutcome>;
  /**
   * A run is not asking any more -- it was cancelled, or its wait ran out --
   * so every request it raised ends `withdrawn`, and the promise each returned
   * resolves with that word.
   */
  withdrawnByHub(runId: GraphRunId): void;
}

/**
 * The key a subject's open requests are filed under.
 *
 * JSON rather than a joined string, for the reason the attention table's key is
 * JSON: every id here is opaque, any may contain whatever separator was
 * chosen, and two subjects colliding on one key would put one's pending
 * approval on another. The kind leads the tuple so a session and a run whose
 * ids happened to agree could never share one.
 */
function keyOf(subject: ApprovalSubject): string {
  switch (subject.kind) {
    case 'session':
      return JSON.stringify(['session', subject.storeId, subject.sessionId]);
    case 'graphRun':
      return JSON.stringify(['graphRun', subject.runId, subject.nodeId]);
    default:
      return assertNever(subject, 'approval subject');
  }
}

/** The key one ended request is remembered under, subject and all. */
function endingKey(subject: ApprovalSubject, approvalId: ApprovalId): string {
  return JSON.stringify([keyOf(subject), approvalId]);
}

/** The words for a subject in a refusal a person reads. */
function wordsFor(subject: ApprovalSubject): string {
  switch (subject.kind) {
    case 'session':
      return 'that session';
    case 'graphRun':
      return 'that run';
    default:
      return assertNever(subject, 'approval subject');
  }
}

/** One open request, with the things only this hub knows about it. */
interface OpenApproval {
  readonly subject: ApprovalSubject;
  /**
   * The row as every client reads it, replaced rather than mutated when a rule
   * answers: the list handed to `onChanged` is what a client is sent, so the
   * mark saying nobody was asked has to be on the object that travels.
   */
  pending: PendingApproval;
  /** Who holds the blocked thing, and so who applies an answer to it. */
  readonly origin: ApprovalOrigin;
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
   * decision a person got to first, and cleared again if the machine refuses
   * the decision it produced -- a rule that answered nothing did not answer
   * this. It is what makes an auto-grant attributable: the log line for the
   * settlement names the project and the rule, rather than reporting a grant
   * with nobody's name on it.
   */
  grantedByPolicy: ApprovalPolicyGrant | null;
}

export function createApprovals({
  clock,
  logger: parent,
  onChanged,
  onGraphRunChanged,
  dispatch,
  policy,
}: ApprovalsDependencies): Approvals {
  const logger = parent.child({ part: 'approvals' });

  /** Open requests, by subject and then by id. A subject usually has none. */
  const open = new Map<string, Map<ApprovalId, OpenApproval>>();
  /** What became of the requests that are not open any more. Bounded. */
  const endings = new Map<string, ApprovalOutcome>();

  /** Every request a run raised, as the wire lists them: oldest first. */
  const runsWaiting = (): readonly GraphRunApproval[] => {
    const waiting: GraphRunApproval[] = [];
    for (const held of open.values()) {
      for (const entry of held.values()) {
        if (entry.origin.kind !== 'hub' || entry.subject.kind !== 'graphRun') continue;
        waiting.push({
          ...entry.origin.about,
          approval: { ...entry.pending, subject: entry.subject },
        });
      }
    }
    waiting.sort((a, b) => a.approval.requestedAt - b.approval.requestedAt);
    return waiting.length === 0 ? NO_RUN_WAITING : waiting;
  };

  /**
   * Tells the reducer what changed, on the channel the subject's kind takes:
   * a session's whole list to its row, or the whole list of waiting runs.
   */
  const announce = (subject: ApprovalSubject): void => {
    switch (subject.kind) {
      case 'session': {
        const held = open.get(keyOf(subject));
        onChanged(
          { storeId: subject.storeId, sessionId: subject.sessionId },
          held === undefined ? NOTHING_PENDING : [...held.values()].map((entry) => entry.pending),
        );
        return;
      }
      case 'graphRun':
        onGraphRunChanged(runsWaiting());
        return;
      default:
        assertNever(subject, 'approval subject');
    }
  };

  const remember = (
    subject: ApprovalSubject,
    approvalId: ApprovalId,
    outcome: ApprovalOutcome,
  ): void => {
    endings.set(endingKey(subject, approvalId), outcome);
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
    const key = keyOf(entry.subject);
    const held = open.get(key);
    held?.delete(entry.pending.approvalId);
    if (held !== undefined && held.size === 0) open.delete(key);
    remember(entry.subject, entry.pending.approvalId, outcome);

    // The run that asked is told the word first, before any client is: it is
    // the thing that was blocked, and the clients are told about it.
    switch (entry.origin.kind) {
      case 'hub':
        entry.origin.resolve(outcome);
        break;
      case 'machine':
        break;
      default:
        assertNever(entry.origin, 'approval origin');
    }

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

    announce(entry.subject);
  };

  const lookup = (subject: ApprovalSubject, approvalId: ApprovalId): OpenApproval | undefined =>
    open.get(keyOf(subject))?.get(approvalId);

  const sessionSubject = (ref: SessionRef): ApprovalSubject => ({
    kind: 'session',
    storeId: ref.storeId,
    sessionId: ref.sessionId,
  });

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
    const entry = lookup(sessionSubject(ref), approvalId);
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
    // A session's request only ever has a machine behind it, so the hub
    // origin here is unreachable by construction; it is still a case rather
    // than a cast, so that the switch says so.
    switch (entry.origin.kind) {
      case 'machine':
        if (entry.origin.registrationId === source) return entry;
        logger.warn('a server spoke about an approval another machine is holding', {
          ...ref,
          approvalId,
          what,
          source,
          holder: entry.origin.registrationId,
        });
        return undefined;
      case 'hub':
        logger.warn('a server spoke about an approval this hub raised itself', {
          ...ref,
          approvalId,
          what,
          source,
        });
        return undefined;
      default:
        return assertNever(entry.origin, 'approval origin');
    }
  };

  return {
    requested(source: ServerRegistrationId, frame: ApprovalRequestedFrame): void {
      const ref: SessionRef = { storeId: frame.storeId, sessionId: frame.sessionId };
      const subject = sessionSubject(ref);
      const key = keyOf(subject);
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
        subject,
        // The hub's own clock, because the frame carries no date: two machines'
        // clocks disagree, and a client rendering "waiting four minutes" is
        // comparing this with its own notion of now.
        pending: { ...frame.approval, subject, requestedAt: clock.now(), answeredBy: null },
        origin: { kind: 'machine', registrationId: source },
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
      announce(subject);
      // Consulted for a session and never for a run: a standing rule is a
      // project's decision about a tool call, and a run's question is not one.
      // There is no branch for the other kind here because a machine frame
      // is always about a session; `requestedByHub` is the other path.
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
          // A request the hub raised has no machine to lose: a run waiting on
          // a person goes on waiting whatever the fleet does.
          if (entry.origin.kind !== 'machine') continue;
          if (entry.origin.registrationId !== registrationId) continue;
          logger.info('approval withdrawn: its machine is gone', {
            ...entry.subject,
            approvalId: entry.pending.approvalId,
            source: registrationId,
          });
          end(entry, 'withdrawn');
        }
      }
    },

    decide,

    requestedByHub(
      subject: GraphRunSubject,
      request: ApprovalRequest,
      about: GraphRunAbout,
    ): Promise<ApprovalOutcome> {
      const key = keyOf(subject);
      const held = open.get(key) ?? new Map<ApprovalId, OpenApproval>();
      open.set(key, held);

      const existing = held.get(request.approvalId);
      if (existing !== undefined) {
        // The caller mints the id per wait, so a repeat is a bug on its side.
        // Said in words to the run rather than thrown at it, because a run
        // that ends failed with a sentence is still a run somebody can read.
        logger.warn('a run asked twice under one approval id', {
          ...subject,
          approvalId: request.approvalId,
        });
        return Promise.resolve('withdrawn');
      }

      return new Promise<ApprovalOutcome>((resolve) => {
        held.set(request.approvalId, {
          subject,
          pending: { ...request, subject, requestedAt: clock.now(), answeredBy: null },
          origin: { kind: 'hub', about, resolve },
          claimed: false,
          waiting: [],
          grantedByPolicy: null,
        });
        logger.info('approval requested by a run', {
          ...subject,
          approvalId: request.approvalId,
          graph: about.graph,
          number: about.number,
        });
        announce(subject);
      });
    },

    withdrawnByHub(runId: GraphRunId): void {
      for (const held of [...open.values()]) {
        for (const entry of [...held.values()]) {
          if (entry.origin.kind !== 'hub') continue;
          if (entry.subject.kind !== 'graphRun' || entry.subject.runId !== runId) continue;
          logger.info('approval withdrawn: its run stopped asking', {
            ...entry.subject,
            approvalId: entry.pending.approvalId,
          });
          end(entry, 'withdrawn');
        }
      }
    },
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
    const entry = lookup(request.subject, request.approvalId);
    if (entry === undefined) {
      const remembered = endings.get(endingKey(request.subject, request.approvalId));
      if (remembered === undefined) {
        logger.info('approval decision refused', {
          ...request.subject,
          approvalId: request.approvalId,
          problem: 'no such approval',
        });
        return Promise.resolve({
          ok: false,
          outcome: null,
          answeredBy: null,
          code: 'refused',
          problem: `this hub is holding no approval by that id for ${wordsFor(request.subject)}`,
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

    switch (entry.origin.kind) {
      case 'hub':
        // The hub is the authority on its own run, so there is no machine to
        // ask and no settlement to wait for: the decision is the ending, and
        // it is applied here in the same tick that took the claim.
        logger.info('approval decided for a run', {
          ...request.subject,
          approvalId: request.approvalId,
          decision: request.decision,
        });
        end(entry, request.decision === 'grant' ? 'granted' : 'denied');
        return answered;
      case 'machine':
        break;
      default:
        return assertNever(entry.origin, 'approval origin');
    }

    // Watched rather than awaited, and that is what this function returning
    // here rather than below buys. The seam answers with a refusal or with
    // silence, and silence is only known to be silence once a deadline has
    // passed at the connection; an answer that waited for that would hold
    // every *working* decision open for it, although the settlement it is
    // really waiting for may already have arrived on the same socket.
    void dispatch({
      registrationId: entry.origin.registrationId,
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
   *
   * A request whose proposal was cut is never put to the policy at all, and
   * that is the first thing here rather than a check buried inside matching. A
   * bounded proposal does not identify the tool input it came from: every input
   * agreeing for its first few thousand rendered characters renders as the same
   * bytes, so a rule matched against one of them would stand for all of them --
   * including whatever the agent wrote past the cut, which nobody has read. No
   * reading of the text can tell those apart, so there is nothing to be clever
   * about: a cut request is a question, and it reaches a person exactly as one
   * no rule covers does.
   */
  async function consult(ref: SessionRef, approvalId: ApprovalId): Promise<void> {
    const subject = sessionSubject(ref);
    const pending = lookup(subject, approvalId);
    if (pending === undefined) return;
    if (pending.pending.truncated) {
      logger.info('a request too long to be shown whole is never matched, so somebody is asked', {
        ...ref,
        approvalId,
        tool: pending.pending.tool,
      });
      return;
    }

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
    const entry = lookup(subject, approvalId);
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
    announce(subject);
    logger.info('approval granted by a standing rule, with nobody asked', {
      ...ref,
      approvalId,
      tool: entry.pending.tool,
      project: grant.project,
      ruleId: grant.ruleId,
      rule: `${grant.rule.tool} ${grant.rule.proposal}`,
    });
    void decide({ subject, approvalId, decision: 'grant' });
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
   *
   * A grant a standing rule made is taken back off the row here for the same
   * reason the claim is released. The mark is published the moment the rule
   * takes the claim, before the decision leaves this hub, so a refusal leaves
   * every client drawing a request as answered by a rule while it is still
   * open -- and the person who then taps Allow would be told their tap lost to
   * a policy, about a grant that was theirs. Nothing was applied, so nothing
   * answered it, and the row has to say so.
   */
  function refuseDispatch(
    entry: OpenApproval,
    request: DecideRequest,
    code: RefusalCode,
    problem: string,
  ): void {
    const stillOpen = lookup(request.subject, request.approvalId) === entry;
    if (stillOpen) entry.claimed = false;
    if (entry.grantedByPolicy !== null) {
      entry.grantedByPolicy = null;
      entry.pending = { ...entry.pending, answeredBy: null };
      // Announced, not merely corrected in memory: the mark reached every
      // client on its own broadcast, so the retraction needs one too. Only
      // while the request is still this hub's to talk about -- one that ended
      // in the meantime has already been announced without it.
      if (stillOpen) announce(entry.subject);
    }
    logger.info('a server refused a decision', {
      ...request.subject,
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
