import {
  tokenDigest,
  type Clock,
  type IdGenerator,
  type Logger,
  type Timers,
  type TokenMinter,
} from '@agentplex/node-shared';
import {
  APPROVAL_SUGGESTIONS_MAX,
  approvalIdSchema,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ServerToHubFrame,
  type SessionId,
  type StoreId,
} from '@agentplex/protocol';
import {
  encodeClaudePermissionAnswer,
  parseClaudePermissionRequest,
  type ClaudePermissionRequest,
} from '@agentplex/providers';
import { z } from 'zod';

/**
 * The registry of blocked tool calls on this machine.
 *
 * A `PermissionRequest` hook fires before a tool call and blocks it until
 * something answers on its stdout, so between a hook connecting here and a
 * decision reaching it there is a real process waiting on a real socket. That
 * is the whole of what this file owns: which requests are open, what each one's
 * name is, and what happened to it. The socket underneath is the listener's
 * (`approval-hook.ts`), the settings file that points a hook at it is the
 * launch plan's, and the hub connection that carries the frames is the hub
 * connection's -- each injected or handed a callback, so that the rules about
 * deciding once are a unit test rather than something only a running pair of
 * daemons can demonstrate.
 *
 * **The id is minted here and nowhere else.** Nothing upstream identifies a
 * tool call: the captured payload has no `tool_use_id`, which step 1 of this
 * ticket took from a real `claude` rather than from a document. So the name a
 * decision travels under is made where the blocked process is, and deciding
 * once is a record per id in this map -- two clients answering the same
 * approval at the same moment reach the same record, and only one of them finds
 * it still pending.
 *
 * **It is not a source of session status.** A session is `awaiting-permission`
 * because the provider's own record of it says so, read by the transcript and
 * registry readers. An approval object that also set a status would be a second
 * authority on one word, free to claim a session is waiting after the provider
 * has recorded that it stopped, and the two would disagree exactly when it
 * mattered.
 *
 * **Every refusal is silence toward the hook, never a decision.** A connection
 * this gate will not hold is closed with nothing written, which is the hook's
 * third answer: exit 0 with an empty stdout means no decision was made and
 * Claude Code's own flow resumes, so the person is asked in the terminal. The
 * failure worth designing against is the opposite one -- an agentplex that
 * denies, or allows, something nobody answered.
 */

/**
 * The hook's own patience, in seconds, as the settings entry it is registered
 * in will carry it.
 *
 * Claude Code's default, stated here rather than only in the launch plan that
 * writes it, because the deadline below has to be shorter than it and two
 * numbers that must agree in two files eventually do not.
 */
export const APPROVAL_HOOK_TIMEOUT_SECONDS = 600;

/**
 * How much of the hook's patience this gate leaves itself.
 *
 * The gate must give up first. If the hook times out while this side still
 * believes the request is open, then a decision made a second later is written
 * to a process that has already stopped reading, the tool call has already
 * fallen through as though no hook had run, and a client is shown a grant or a
 * denial that did nothing. Giving up early costs a person the chance to answer
 * in the last half minute; giving up late costs the truth.
 *
 * The margin only has to cover this side noticing and closing, which is local
 * and immediate -- and the hook's own clock started before it connected here,
 * so the real gap is wider than the arithmetic.
 */
const APPROVAL_EXPIRY_MARGIN_MS = 30_000;

/** When this gate stops waiting, short of the hook by the margin above. */
export const APPROVAL_TIMEOUT_MS =
  APPROVAL_HOOK_TIMEOUT_SECONDS * 1_000 - APPROVAL_EXPIRY_MARGIN_MS;

/**
 * What a denied agent reads, composed here because here is where the hook is
 * answered.
 *
 * No client chooses these words. A denial does put a sentence into an agent's
 * context -- that is the difference between a denied tool call and a killed
 * session, the session stays alive and answerable -- and a free-text field on
 * the frame would be text chosen two hops away and delivered into a model's
 * input, which is the surface this protocol keeps shut everywhere else.
 *
 * It says the session is still running, because an agent told only "denied"
 * reasonably concludes something broke and tries the same thing again.
 */
export const APPROVAL_DENIAL_MESSAGE =
  'A person watching this session in agentplex denied this. The session is still running: ask before trying it again.';

/**
 * How many endings are remembered after the request itself is gone.
 *
 * A late answer is the ordinary race in this ticket -- a client that tapped
 * while a withdrawal was in flight, or one that reconnected having missed it --
 * and it is entitled to be told what happened rather than "no such approval".
 * Bounded because a server runs for weeks and an unbounded map of every
 * question ever asked is a leak; what falls out of it is only ever old enough
 * that nobody is still holding a screen showing it.
 */
const ENDINGS_REMEMBERED = 256;

/**
 * One blocked hook, as this gate deals with it.
 *
 * Deliberately not a socket. The line was read by the listener and the reply is
 * a string -- everything about framing, encoding and unix sockets is on the
 * other side of this interface, which is what lets the rules above be tested
 * without one.
 */
export interface ApprovalHookConnection {
  /** The line the hook sent: its secret and the payload it was handed, unparsed. */
  readonly sent: string;
  /** Writes the hook's stdout. Called at most once, and only for a decision. */
  write(answer: string): void;
  /** Ends the connection, flushing anything written first. Safe to call twice. */
  close(): void;
  /** The hook went away: its process died, or the session took the question back. */
  onClose(handler: () => void): void;
}

/** Where hook connections come from. One implementation listens on a socket. */
export interface ApprovalHookListener {
  /** Hands every connection to `accept`. The gate calls this once, at birth. */
  onConnection(accept: (connection: ApprovalHookConnection) => void): void;
  /** Stops listening. */
  close(): void;
}

/**
 * What the gate says to the hub, typed by the frames themselves.
 *
 * Extracted from the protocol union rather than restated, so that a field
 * added to a frame is a type error here and not a frame the hub refuses at
 * runtime. The gate emits and never sends: what a connected hub does with these
 * -- including having none to send to -- belongs to the hub connection.
 */
export type ApprovalEvent = Extract<
  ServerToHubFrame,
  { readonly type: 'approval-requested' | 'approval-withdrawn' | 'approval-settled' }
>;

/**
 * One launch's permission to speak to this gate.
 *
 * Per launch rather than per session, and that is forced rather than chosen:
 * Claude Code mints its own session id and writes it to disk, so a spawn has no
 * session id to key on -- naming one up front would mean `--session-id` and
 * agentplex deciding an identity the provider is the authority on. What the
 * secret binds is therefore the store the launch was made in; which session is
 * asking comes from the payload, which is the provider stating its own id.
 */
export interface ApprovalAdmission {
  /** The secret the hook presents, written into that launch's settings file. */
  readonly secret: string;
  /** Retires it when the launch ends, withdrawing whatever it left open. */
  close(): void;
}

/**
 * Why a decision was not applied.
 *
 * The outcomes are the protocol's own, so a hub can report what it is told
 * without a translation table: a client that answered a request which was
 * already granted, withdrawn or expired is told that word. `unknown` is the
 * one that is not an outcome -- this machine has no memory of the id at all,
 * which is a client naming something that never existed here or something old
 * enough to have fallen out of the endings above.
 */
export type ApprovalRefusal = ApprovalOutcome | 'unknown';

export type ApprovalDecideResult =
  | { readonly ok: true; readonly settlement: 'granted' | 'denied' }
  | { readonly ok: false; readonly reason: ApprovalRefusal };

export interface ApprovalGate {
  /** Admits one launch and mints the secret its hook will present. */
  admit(storeId: StoreId): ApprovalAdmission;
  /**
   * Answers a blocked hook, once.
   *
   * It returns as soon as the decision is written, and does not wait for the
   * tool: a granted command may run for ten minutes, and a caller holding a
   * round trip open for it would time out on every long tool call and call a
   * working decision a failure.
   */
  decide(approvalId: ApprovalId, decision: ApprovalDecision): ApprovalDecideResult;
  /** Stops listening and withdraws everything still open. */
  stop(): void;
}

export interface ApprovalGateDependencies {
  readonly listener: ApprovalHookListener;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly timers: Timers;
  /**
   * Separate from `ids`, because the two have different jobs: an approval id is
   * unique and travels to every client, a launch secret is unguessable and
   * appears in no frame. Anything on this machine can reach a unix socket.
   */
  readonly tokens: TokenMinter;
  readonly logger: Logger;
  readonly onEvent: (event: ApprovalEvent) => void;
  readonly timeoutMs?: number;
}

/**
 * The line a hook sends, read for the two fields that matter and loose about
 * the rest.
 *
 * Loose because the hook script and the daemon reading it are packaged
 * together but not necessarily upgraded together -- a server left running
 * across an install is answering hooks written by the version on disk -- and a
 * field a newer script added is not a reason to leave an agent blocked.
 *
 * The payload has no length bound here. Bounding the read is the listener's
 * job, and it has to be done there anyway; a bound repeated here would only
 * ever fire on a `Write` of a large file, which is precisely a request somebody
 * wants to see.
 */
const hookLineSchema = z
  .object({
    secret: z.string().min(1).max(1_000),
    payload: z.string().min(1),
  })
  .loose();

interface PendingApprovalRecord {
  readonly approvalId: ApprovalId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly connection: ApprovalHookConnection;
  /** By this machine's clock, and only ever used to say how long a wait was. */
  readonly requestedAt: number;
  readonly cancelTimer: () => void;
  /** Which admission let it in, so retiring a launch can find its own. */
  readonly admission: string;
}

export function createApprovalGate({
  listener,
  clock,
  ids,
  timers,
  tokens,
  logger,
  onEvent,
  timeoutMs = APPROVAL_TIMEOUT_MS,
}: ApprovalGateDependencies): ApprovalGate {
  /**
   * Admissions by the digest of their secret, never by the secret.
   *
   * The plaintext is returned once, to be written into a settings file, and is
   * not kept: a digest is a lookup key that leaks nothing if this process is
   * dumped, and looking one up costs the same whatever was presented, which a
   * scan of string comparisons would not.
   */
  const admissions = new Map<string, StoreId>();
  const pending = new Map<ApprovalId, PendingApprovalRecord>();
  const endings = new Map<ApprovalId, ApprovalOutcome>();

  const remember = (approvalId: ApprovalId, outcome: ApprovalOutcome): void => {
    endings.set(approvalId, outcome);
    while (endings.size > ENDINGS_REMEMBERED) {
      const oldest = endings.keys().next();
      if (oldest.done === true) break;
      endings.delete(oldest.value);
    }
  };

  /** Ends a request without answering it, and says so. */
  const withdraw = (approvalId: ApprovalId, why: string): void => {
    const record = pending.get(approvalId);
    if (record === undefined) return;
    pending.delete(approvalId);
    record.cancelTimer();
    remember(approvalId, 'withdrawn');
    record.connection.close();
    logger.info('approval withdrawn', {
      approvalId,
      sessionId: record.sessionId,
      why,
      waitedMs: clock.now() - record.requestedAt,
    });
    onEvent({
      type: 'approval-withdrawn',
      storeId: record.storeId,
      sessionId: record.sessionId,
      approvalId,
    });
  };

  const expire = (approvalId: ApprovalId): void => {
    const record = pending.get(approvalId);
    if (record === undefined) return;
    pending.delete(approvalId);
    remember(approvalId, 'expired');
    // Closed with nothing written. The hook is about to stop waiting on its own
    // and Claude Code will ask in the terminal, which is the one place an
    // answer can still change what runs.
    record.connection.close();
    logger.info('approval expired', {
      approvalId,
      sessionId: record.sessionId,
      waitedMs: clock.now() - record.requestedAt,
    });
    onEvent({
      type: 'approval-settled',
      storeId: record.storeId,
      sessionId: record.sessionId,
      approvalId,
      outcome: 'expired',
    });
  };

  /** Closed with nothing written, which is the hook's "nobody decided". */
  const refuse = (connection: ApprovalHookConnection, problem: string): void => {
    // Loud. A hook that cannot be held is an agent that will block at a
    // terminal prompt nobody is watching, and the operator reading this log is
    // the only person who can tell a mis-wired launch from an intruder.
    logger.warn('hook connection refused', { problem });
    connection.close();
  };

  const accept = (connection: ApprovalHookConnection): void => {
    let line: unknown;
    try {
      line = JSON.parse(connection.sent);
    } catch {
      refuse(connection, 'the hook sent something that is not json');
      return;
    }

    const parsedLine = hookLineSchema.safeParse(line);
    if (!parsedLine.success) {
      refuse(connection, z.prettifyError(parsedLine.error));
      return;
    }

    const storeId = admissions.get(tokenDigest(parsedLine.data.secret));
    if (storeId === undefined) {
      // Anything running as this user can reach the socket, so this is the one
      // check standing between a local process and every session on the box.
      // The problem never names what was presented.
      refuse(connection, 'the secret presented belongs to no live launch');
      return;
    }

    const parsed = parseClaudePermissionRequest(parsedLine.data.payload);
    if (!parsed.ok) {
      refuse(connection, parsed.reason === 'not-json' ? 'the payload is not json' : parsed.problem);
      return;
    }

    const approvalId = approvalIdSchema.parse(ids.newId());
    const record: PendingApprovalRecord = {
      approvalId,
      storeId,
      sessionId: parsed.request.sessionId,
      connection,
      requestedAt: clock.now(),
      cancelTimer: timers.schedule(timeoutMs, () => void expire(approvalId)),
      admission: tokenDigest(parsedLine.data.secret),
    };
    pending.set(approvalId, record);
    connection.onClose(() => void withdraw(approvalId, 'the hook closed'));

    logger.info('approval requested', {
      approvalId,
      storeId,
      sessionId: record.sessionId,
      tool: parsed.request.tool,
    });
    onEvent({
      type: 'approval-requested',
      storeId,
      sessionId: record.sessionId,
      approval: toApprovalRequest(approvalId, parsed.request),
    });
  };

  listener.onConnection(accept);

  return {
    admit(storeId: StoreId): ApprovalAdmission {
      const secret = tokens.newToken();
      const digest = tokenDigest(secret);
      admissions.set(digest, storeId);
      return {
        secret,
        close(): void {
          admissions.delete(digest);
          // A retired launch is a dead process, so its hooks are normally gone
          // already and this finds nothing. It is here for the case that is not
          // true -- a child that outlived its supervisor -- where leaving a
          // request pending would leave a client offering to answer a question
          // whose secret no longer opens anything.
          for (const record of [...pending.values()]) {
            if (record.admission === digest) withdraw(record.approvalId, 'the launch ended');
          }
        },
      };
    },

    decide(approvalId: ApprovalId, decision: ApprovalDecision): ApprovalDecideResult {
      const record = pending.get(approvalId);
      if (record === undefined) {
        return { ok: false, reason: endings.get(approvalId) ?? 'unknown' };
      }

      // Removed before anything is written, so that a second decision arriving
      // while this one is in the socket finds nothing to answer. Deciding once
      // is this line.
      pending.delete(approvalId);
      record.cancelTimer();

      const settlement = decision === 'grant' ? 'granted' : 'denied';
      try {
        record.connection.write(
          encodeClaudePermissionAnswer(
            decision === 'grant'
              ? { behavior: 'allow' }
              : { behavior: 'deny', message: APPROVAL_DENIAL_MESSAGE },
          ),
        );
      } catch (error) {
        // The hook is gone and nobody's answer reached the agent. Reporting the
        // decision we meant to apply would be the over-claim this whole path is
        // shaped against, so it is a withdrawal, which is what it is.
        remember(approvalId, 'withdrawn');
        logger.warn('the decision could not reach the hook', {
          approvalId,
          problem: String(error),
        });
        onEvent({
          type: 'approval-withdrawn',
          storeId: record.storeId,
          sessionId: record.sessionId,
          approvalId,
        });
        return { ok: false, reason: 'withdrawn' };
      }

      remember(approvalId, settlement);
      record.connection.close();
      logger.info('approval settled', {
        approvalId,
        sessionId: record.sessionId,
        outcome: settlement,
        waitedMs: clock.now() - record.requestedAt,
      });
      onEvent({
        type: 'approval-settled',
        storeId: record.storeId,
        sessionId: record.sessionId,
        approvalId,
        outcome: settlement,
      });
      return { ok: true, settlement };
    },

    stop(): void {
      listener.close();
      admissions.clear();
      // Said rather than dropped: a hub still connected during a shutdown would
      // otherwise go on showing approvals nobody can answer any more.
      for (const record of [...pending.values()]) {
        withdraw(record.approvalId, 'the server is stopping');
      }
    },
  };
}

/**
 * The provider's request as the wire's, cut to the wire's bounds.
 *
 * A copy rather than a pass-through, although the fields agree today. The two
 * shapes answer to different owners -- one to whatever Claude Code sends, one
 * to a parser at the hub -- and the cut is the reason this function exists:
 * the provider's parser bounds a proposal's length but not how many shortcuts
 * came with it, and a list one item over the wire's cap is a frame the hub
 * refuses whole. Dropping the surplus costs a shortcut. Refusing the frame
 * costs the request, and with it an agent nobody can unblock.
 */
function toApprovalRequest(
  approvalId: ApprovalId,
  request: ClaudePermissionRequest,
): ApprovalRequest {
  return {
    approvalId,
    tool: request.tool,
    proposal: request.proposal,
    // Copied, never re-derived. Whether the text was cut is a fact about what
    // the parser did with the tool input, and this side no longer holds the
    // input to check it against -- so a length test here would be a guess that
    // an agent ending its command in the marker's words could make wrong.
    truncated: request.truncated,
    suggestions: request.suggestions.slice(0, APPROVAL_SUGGESTIONS_MAX).map((suggestion) => ({
      behavior: suggestion.behavior,
      destination: suggestion.destination,
      rules: suggestion.rules
        .slice(0, APPROVAL_SUGGESTIONS_MAX)
        .map((rule) => ({ tool: rule.tool, content: rule.content })),
    })),
  };
}
