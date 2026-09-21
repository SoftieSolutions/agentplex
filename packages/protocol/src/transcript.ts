import { z } from 'zod';
import { activitySchema, TRANSCRIPT_ACTIVITIES_MAX } from './activity.js';

/**
 * One session's transcript as it crosses a wire: a bounded count going out, a
 * bounded list of activities coming back.
 *
 * Both legs share these two schemas, which is the point of the file. What a
 * client may ask the hub for is exactly what the hub may ask a server for, and
 * what a server may answer is exactly what the hub may relay -- so a count the
 * hub accepts and a server refuses, or a list a server sends and the hub cannot
 * pass on, is a state neither end can reach. `doc.ts` makes the same argument
 * for a document's name and content.
 *
 * What crosses is *activities* and never transcript lines. The parser that
 * turns a provider's own file into this vocabulary stays in `packages/providers`
 * on the machine that has the file, so raw transcript bytes -- prompts, tool
 * output, whatever the agent pasted -- never reach the wire at all, and neither
 * the hub nor a browser ever learns a provider's format. That is the same split
 * `activity.ts` describes for the one line a card shows, asked for a page at a
 * time instead of riding every scan.
 *
 * There is no cursor and no page token. A transcript request is the tail of one
 * session's work for somebody looking at it now, and the honest bound is a
 * count with "there is more behind this" beside it; a cursor would be a promise
 * to hold a position in a file that another process is appending to.
 */

/**
 * How many activities may be asked for, and answered with.
 *
 * Positive, because asking for none is asking for nothing and a frame that
 * means nothing is a frame with no reader. Capped by the protocol's own
 * ceiling, whose comment carries the arithmetic that makes a maximal answer fit
 * the socket's 1 MB frame limit by construction rather than by hope.
 *
 * The same schema bounds the request on both legs and the answer on both legs,
 * so the arithmetic is checked four times against one number.
 */
export const transcriptCountSchema = z.int().positive().max(TRANSCRIPT_ACTIVITIES_MAX);

/**
 * The activities themselves, each parsed by `activitySchema`.
 *
 * Parsed per item rather than trusted as a block: an activity is a claim about
 * what an agent did, it arrives from a provider's own file by way of another
 * machine, and the union it has to satisfy is strict -- an unknown key is a
 * refusal rather than a field that is silently dropped. The array is bounded by
 * the same count the request carries, so a peer that answered with more than it
 * was asked for is refused here rather than overrunning a frame nobody sized.
 */
export const transcriptActivitiesSchema = z.array(activitySchema).max(TRANSCRIPT_ACTIVITIES_MAX);
