-- Attention: what the user has said about a session, as distinct from what a
-- machine reports about it.
--
-- Everything else the hub knows about a session is a reading of a transcript
-- on somebody's disk, rebuilt from scratch on the next scan and deliberately
-- not persisted (see features/fleet-state). These two columns are the
-- opposite: nothing on any server knows they exist, no scan can rebuild them,
-- and they are exactly the facts a person would be angry to lose to a restart
-- -- a hub that forgot every mute on a deploy would nag about the sessions it
-- had just been told to stop nagging about.
--
-- Keyed by `{ store_id, session_id }` and never by a machine, which is the
-- rule the whole protocol is built on: a session is the same session whichever
-- box has the volume mounted, so an acknowledgement follows it across them.
-- The pair is the primary key rather than a surrogate id with a unique index
-- on it, because there is exactly one attention row per session and a second
-- one would be a second answer to "has this been seen".
--
-- No foreign key, and that is the decision. There is no sessions table to
-- point at: session rows live in the reducer's memory and on servers' disks,
-- and a constraint against a table the hub does not keep cannot be written.
-- What bounds this table instead is the hub refusing an acknowledgement or a
-- mute for a session it cannot currently see.
--
-- Both moments are nullable and a row may hold either alone: acknowledging a
-- session that is not muted must not mute it, and muting one nobody has
-- acknowledged must not claim somebody has. A row with both columns null is
-- possible (a mute that was undone on a session nobody acknowledged) and is
-- left alone rather than deleted -- a sweep to reclaim a handful of bytes is a
-- second writer to this table, and the read treats null and absent alike.
--
-- Epoch milliseconds with no default, for the reason every earlier migration
-- gives: time comes from an injected clock, and a schema default is the one
-- reading of the wall clock no test could set.
CREATE TABLE session_attention (
  store_id        text    NOT NULL,
  session_id      text    NOT NULL,
  acknowledged_at integer,
  muted_at        integer,
  PRIMARY KEY (store_id, session_id)
);
