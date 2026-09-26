import type { FrameId, SessionRef } from '@agentplex/protocol';
import type { AttentionOutcome } from '../attention/attention.js';
import type { Sessions } from '../sessions/sessions.js';
import type { Terminal, TerminalClient } from '../terminal/terminal.js';
import { refusal, reply, type ReplyContext } from './reply.js';

/**
 * Starts a session and answers the client that asked.
 *
 * The state is checked again after the await for the reason the layout read
 * checks it: an instruction takes as long as another machine takes, and this
 * socket may have closed while it did. Nothing is undone in that case -- the
 * session really did start, and it will appear in the state every other
 * client is sent -- but there is nobody left to reply to.
 *
 * A throw is `internal` and not `refused`, and the difference is what the
 * client does next: `refused` says the hub understood and declined, which
 * invites nothing, and `internal` says the hub broke and retrying may work.
 */
export function answerStart(
  ctx: ReplyContext,
  sessions: Sessions,
  terminal: Terminal,
  watcher: TerminalClient,
  replyTo: FrameId,
  request: Parameters<Sessions['start']>[0],
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not start a session', failure: 'the hub could not start that session' },
    () => sessions.start(request),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
      // Before the reply, so that a client which subscribes the moment it reads
      // one finds the handle already written. The map from this client's frame
      // id to the name the hub minted lives in the relay and dies with this
      // socket: it is what lets a pane watch a spawn that has no session id
      // yet, and it is meaningless on any other connection.
      terminal.noteStart(watcher, replyTo, {
        registrationId: outcome.server,
        startId: outcome.startId,
        storeId: outcome.storeId,
      });
      return {
        type: 'session-started',
        replyTo,
        storeId: outcome.storeId,
        sessionId: outcome.sessionId,
        server: outcome.server,
      };
    },
  );
}

/** Stops a session and answers the client that asked. */
export function answerStop(
  ctx: ReplyContext,
  sessions: Sessions,
  replyTo: FrameId,
  request: Parameters<Sessions['stop']>[0],
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not stop a session', failure: 'the hub could not stop that session' },
    () => sessions.stop(request),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
      return {
        type: 'session-stopped',
        replyTo,
        storeId: outcome.storeId,
        // A stop names the session it stopped, and the outcome carries the id
        // the server answered with rather than the one asked for -- the two are
        // the same, and taking the server's is one fewer place to get it wrong.
        sessionId: outcome.sessionId ?? request.sessionId,
        server: outcome.server,
      };
    },
  );
}

/**
 * Pauses or resumes a session and answers the client that asked.
 *
 * The receipt carries the server's own pause word for a pause, because the
 * asker needs to know whether to say "pausing" or "paused" now; a resume's
 * receipt carries nothing but the fact, since the only word it could carry
 * is `none`.
 */
export function answerPause(
  ctx: ReplyContext,
  sessions: Sessions,
  replyTo: FrameId,
  instruction: 'session-pause' | 'session-resume',
  request: Parameters<Sessions['pause']>[0],
): Promise<void> {
  const verb = instruction === 'session-pause' ? 'pause' : 'resume';
  const words = {
    doing: `could not ${verb} a session`,
    failure: `the hub could not ${verb} that session`,
  };
  // Two calls rather than one behind a ternary: the outcomes are different
  // shapes -- only a pause's carries the word -- and a union of the two would
  // have the receipt below read a field the resume's does not have.
  if (instruction === 'session-pause') {
    return reply(
      ctx,
      replyTo,
      words,
      () => sessions.pause(request),
      (outcome) => {
        if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
        return {
          type: 'session-paused',
          replyTo,
          storeId: outcome.storeId,
          sessionId: outcome.sessionId,
          server: outcome.server,
          pause: outcome.pause,
        };
      },
    );
  }
  return reply(
    ctx,
    replyTo,
    words,
    () => sessions.resume(request),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
      return {
        type: 'session-resumed',
        replyTo,
        storeId: outcome.storeId,
        sessionId: outcome.sessionId,
        server: outcome.server,
      };
    },
  );
}

/**
 * Reads one session's transcript and answers the client that asked.
 *
 * The same shape a document open has, and nothing is stored on the way
 * through: the hub relays the activities and keeps none of them, so two
 * clients asking get two answers from the machine that has the file rather
 * than one answer and a copy.
 */
export function answerTranscript(
  ctx: ReplyContext,
  sessions: Sessions,
  replyTo: FrameId,
  request: Parameters<Sessions['transcript']>[0],
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not read a transcript',
      failure: 'the hub could not read that transcript',
      fields: { ...request },
    },
    () => sessions.transcript(request),
    (outcome) => {
      // `holder: null`, like every other no on this direction that is not
      // about a live process: an unreachable machine, a session the hub
      // cannot see and a transcript that would not be read are sentences.
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'session-transcript-read',
        replyTo,
        activities: [...outcome.activities],
        olderExist: outcome.olderExist,
      };
    },
  );
}

/**
 * Writes one attention fact and answers the client that asked with the whole
 * row.
 *
 * One function for both frames, taking the write as a thunk, because
 * everything around the write is identical: the same refusal rule, the same
 * reply, the same sentence when the disk fails. Two copies of it would be
 * two chances for a mute to be answered differently from an acknowledgement.
 *
 * The write still stands when the socket closes while the row is being
 * written; what is dropped is only the receipt for it.
 */
export function answerAttention(
  ctx: ReplyContext,
  replyTo: FrameId,
  ref: SessionRef,
  write: () => Promise<AttentionOutcome>,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not record attention', failure: 'the hub could not record that' },
    write,
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'session-attention',
        replyTo,
        storeId: ref.storeId,
        sessionId: ref.sessionId,
        acknowledgedThrough: outcome.attention.acknowledgedThrough,
        mutedAt: outcome.attention.mutedAt,
      };
    },
  );
}
