-- Web push: the hub's VAPID key pair, and the browsers that asked to be told.
--
-- Push is the only thing in this system that reaches a person who is not
-- looking at the page, so both tables here are about the same question: which
-- hub is speaking, and to whom.
--
-- The key pair is in the database rather than in a file beside it, and that is
-- a decision rather than a convenience. This hub writes no file at runtime --
-- its configuration is argv and environment, and the one other secret it holds,
-- a paired server's token, is already a row (0002). A minted key pair in a file
-- would be the first thing on this daemon's disk that has to exist, has to have
-- the right mode, and has to be backed up separately from the database it
-- belongs to. Nothing in the hub knows where such a file should go.
--
-- The pair is minted once and never rotated by anything here. Rotating it is
-- not a maintenance task: a VAPID public key is baked into every subscription a
-- browser holds, so a new pair silently stops every existing subscription
-- working. That is why the single-row shape below makes a second pair
-- impossible rather than merely unlikely.
--
-- WITHOUT ROWID for exactly the reason 0001 gives for `hub_identity`, and it is
-- load-bearing here for the same reason. In a rowid table an `integer PRIMARY
-- KEY` column *is* the rowid, and SQLite fills an omitted rowid with the next
-- unused integer instead of the column's DEFAULT: the second
-- `INSERT ... ON CONFLICT (only_row) DO NOTHING` would arrive as row 2, fail
-- the CHECK, and turn an idempotent mint into a hub that throws on its second
-- boot. Without the rowid the column is an ordinary primary key, the DEFAULT
-- applies, and the second insert conflicts with the first and does nothing --
-- which is how two boots mint one pair.
--
-- `created_at` is epoch milliseconds with no default, for the reason every
-- earlier migration gives: time comes from an injected clock, and a schema
-- default would be the one reading of the wall clock no test could set.
CREATE TABLE push_vapid_keys (
  only_row    integer PRIMARY KEY DEFAULT 1 CHECK (only_row = 1),
  -- The half that travels: it goes to every client, and a browser hands it to
  -- its push service as the identity of whoever is allowed to push to it.
  public_key  text    NOT NULL,
  -- The half that never leaves this process. Nothing above the push feature
  -- can read it, because nothing above the push feature sends a push.
  private_key text    NOT NULL,
  created_at  integer NOT NULL
) WITHOUT ROWID;

-- One row per browser that has asked to be told, keyed by the endpoint its push
-- service issued.
--
-- The endpoint is the primary key because it *is* the subscription's identity:
-- it is the URL a push is POSTed to, a browser that subscribes twice gets the
-- same one back, and a browser whose subscription is replaced gets a different
-- one. A surrogate id with a unique index on the endpoint would say the same
-- thing in two places and let them disagree.
--
-- Not WITHOUT ROWID, unlike the table above, and for the opposite reason: the
-- key here is a URL of up to two kilobytes rather than the constant 1, and
-- SQLite's own advice against a large primary key in a WITHOUT ROWID table is
-- about exactly this shape -- the whole row lives in the index, and a key that
-- large starts spilling pages. This table is read in full on every fan-out and
-- written once per browser, so the ordinary rowid table with a unique index on
-- the endpoint is the right trade.
--
-- `p256dh` and `auth` are the two keys the browser generated and handed over,
-- carried in the shape `PushSubscription.toJSON()` produces and the shape the
-- sender wants, so nothing between the two reshapes them. They are not secrets
-- of this hub's: they belong to that browser, they are useless without its
-- private half, and their only job is to encrypt a payload nobody else can read
-- -- including the push service that relays it.
--
-- No foreign key and nothing session-keyed: a subscription is a browser, not a
-- session. There is deliberately no user column either, because this build has
-- one shared client token and no user identity at all: every subscription gets
-- every needs-you edge, exactly as every client sees every session today. When
-- accounts arrive, that column is the migration that adds them.
--
-- `created_at` is epoch milliseconds and has no default, for the reason every
-- earlier migration gives: time comes from an injected clock, and a schema
-- default would be the one reading of the wall clock no test could set. It
-- records when this browser first subscribed and is not touched by a later
-- re-subscription, so the age of a row stays the age of the subscription.
CREATE TABLE push_subscriptions (
  endpoint   text    PRIMARY KEY,
  p256dh     text    NOT NULL,
  auth       text    NOT NULL,
  created_at integer NOT NULL
);
