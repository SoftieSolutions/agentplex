import { z } from 'zod';

/**
 * The pane layout as it crosses the wire: characters the hub never parses.
 *
 * The split-pane arrangement is a client concern from end to end — what a
 * pane is, how a split divides, what a ratio means. Those rules live in the
 * web app's own parser, and the hub stores and answers the characters
 * verbatim, so a new pane type is a client release and never a service one.
 * The one thing the protocol does state is a bound: a blob this size is not a
 * layout anybody arranged by hand, and an unbounded column filled by a bug
 * would grow without anything ever objecting.
 */
export const PANE_LAYOUT_MAX_CHARS = 65_536;
export const paneLayoutTextSchema = z.string().max(PANE_LAYOUT_MAX_CHARS);
