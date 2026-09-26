import { parseHubFrame, parseTextFrame, type FrameId, type HubFrame } from '@agentplex/protocol';
import { rememberAnswer, type Reply } from './answers.js';

/**
 * Captured hub replies as the values `answers` holds, for tests.
 *
 * Parsed from `hub-frames.fixture.ts` through the one hub-frame parser, so a
 * test holds what a real hub sent and not what its author imagined. A test
 * may still move a reply to another id with a spread: the id is the only
 * thing about a reply a test gets to choose.
 */

function isOfType<T extends Reply['type']>(
  frame: HubFrame,
  type: T,
): frame is Extract<HubFrame, { type: T }> {
  return frame.type === type;
}

/** One captured frame, which must be a reply of `type`. */
export function replyFrom<T extends Reply['type']>(
  text: string,
  type: T,
): Extract<HubFrame, { type: T }> {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(`the fixture does not parse: ${parsed.reason}`);
  if (!isOfType(parsed.value, type)) {
    throw new Error(`the fixture is a ${parsed.value.type} frame, not ${type}`);
  }
  return parsed.value;
}

/** The replies, remembered in order, as the store would hold them. */
export function answersOf(...replies: readonly Reply[]): ReadonlyMap<FrameId, Reply> {
  let answers: ReadonlyMap<FrameId, Reply> = new Map();
  for (const reply of replies) answers = rememberAnswer(answers, reply);
  return answers;
}
