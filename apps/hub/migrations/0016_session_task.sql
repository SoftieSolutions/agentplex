-- The task a session was started to do: the prompt somebody typed into the
-- start form, kept as display text and nothing else.
--
-- It is here for the reason the attention columns are, and against the same
-- alternative. Everything else the hub knows about a session is a reading of a
-- transcript on somebody's disk, rebuilt by the next scan. This is not
-- rebuildable from anything: the prompt was placed as one argv element on a
-- machine that keeps no record of why, and the transcript that results opens
-- with whatever the agent said back. A label derived from those opening lines
-- would read as "what this session is for" while meaning "the first thing
-- anyone typed", which is wrong often enough to mislead on the screen people
-- scan to find the session they meant. So what is stored is the one sentence
-- the hub was actually told, by the person who started the session.
--
-- Keyed by `{ store_id, session_id }` and never by a machine, like every other
-- session-keyed table here: a session is the same session whichever box has
-- the volume mounted, and its task follows it across them. The pair is the
-- primary key rather than a surrogate id, because there is one task per
-- session and a second row would be a second answer to "what is this for".
--
-- No foreign key, for the reason 0009 gives: there is no sessions table to
-- point at. What bounds this table is that only a start this hub made writes
-- to it -- a client cannot name a session here, it can only ask for one to be
-- started -- and that a row is written once. The first task a session is given
-- is the one it keeps: a resume sends a new message to a conversation that is
-- still doing what it was started for, and letting the latest prompt overwrite
-- the label would make the panel say something different every time somebody
-- typed, under a heading that claims to say what the session is for.
--
-- A spawn has no session id at the moment it is started -- the provider mints
-- one and writes it, and the hub learns it from the next report -- so a row
-- appears here only once the pair exists. Nothing is written under a start
-- handle: a start is not a session, and a table keyed by one would need a
-- second write to become keyed by the other.
--
-- `task` is NOT NULL and non-empty by CHECK. "This session has no task" is the
-- absence of a row, not a row holding nothing: a start made at the provider's
-- own prompt, and every session this hub merely discovered, must read the same
-- way, and an empty string would be a third spelling of it that a reader could
-- draw as an empty panel. The length is bounded here as well as at the wire,
-- because a column with no bound is a column a long prompt fills.
CREATE TABLE session_task (
  store_id   text NOT NULL,
  session_id text NOT NULL,
  task       text NOT NULL,
  PRIMARY KEY (store_id, session_id),
  CHECK (length(task) > 0 AND length(task) <= 2000)
);
