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
-- The two columns are nullable and a row may hold either alone: acknowledging
-- a session that is not muted must not mute it, and muting one nobody has
-- acknowledged must not claim somebody has. A row with both columns null is
-- possible (a mute that was undone on a session nobody acknowledged) and is
-- left alone rather than deleted -- a sweep to reclaim a handful of bytes is a
-- second writer to this table, and the read treats null and absent alike.
--
-- `acknowledged_through` is deliberately not a moment on this hub's clock, and
-- the name says so. It holds the session's own `updated_at` as the hub saw it
-- when the acknowledgement arrived -- a number a *provider* wrote into a
-- transcript on some other machine. It exists to be compared against the next
-- such number, and the whole point is that both sides of that comparison come
-- off one clock. Stamping the hub's own time here instead would compare a hub
-- clock with a provider clock: a hub five seconds fast would read a second
-- prompt two seconds after the acknowledgement as already seen, silently,
-- which is exactly the failure a timestamp was chosen over a boolean to avoid.
--
-- `muted_at` *is* this hub's clock, because it is not compared with anything.
-- It answers "since when" for a person and nothing reads it as a threshold.
-- Epoch milliseconds with no default, for the reason every earlier migration
-- gives: time comes from an injected clock, and a schema default is the one
-- reading of the wall clock no test could set.
CREATE TABLE session_attention (
  store_id             text    NOT NULL,
  session_id           text    NOT NULL,
  acknowledged_through integer,
  muted_at             integer,
  PRIMARY KEY (store_id, session_id)
);
