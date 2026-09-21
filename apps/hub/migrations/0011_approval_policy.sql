-- The standing policy: the requests a project has already answered, so that
-- nobody is asked about them again.
--
-- Everything else about an approval is deliberately not written down. A pending
-- request is a claim about now -- on the other side of it there is a process
-- parked on a socket with a timeout running -- and features/approvals argues at
-- length that a table of those would present dead questions as answerable. This
-- is the opposite fact and belongs on disk for the reason the attention columns
-- do: nothing on any server knows these rows exist, no scan can rebuild them,
-- and a hub that forgot every standing rule on a deploy would start asking
-- about the very things it had just been told to stop asking about.
--
-- Keyed by the project and never by the session, which is the decision this
-- table exists to hold. A rule is a thing a person means about a body of work
-- -- "in this repository, `pnpm test` does not need me" -- and a session is a
-- conversation that lasts an afternoon. Per-session rules would have to be
-- written again for every session, which means in practice they would be
-- written while a person was staring at a blocked agent and wanted it to
-- continue, which is the worst moment anybody ever decides a policy. A session
-- filed under no project therefore has no policy at all and is always asked
-- about, and that is the intended answer rather than a gap: the hub has nothing
-- a person said about that work, so it has nothing to act on.
--
-- `node_id` references `projects` and not `nodes`, so that "a rule belongs to a
-- project" is a fact the schema states rather than one the layer above
-- remembers. CASCADE because a rule about a project that is gone is a grant
-- nobody could find to revoke: removing the project removes what it had
-- decided, and the sessions that were under it go back to asking.
--
-- `tool` and `prefix` are the protocol's `approvalPolicyRule`, and the CHECKs
-- here are the bounds that parser states restated where the bytes live. They
-- are not the parser: what makes a rule safe -- no empty tool, no prefix
-- stopping at a field name, no control or bidirectional characters -- is a
-- sentence a person is shown, and SQL cannot produce a sentence. Every row is
-- put back through `parseApprovalPolicyRule` when it is read, and a row that
-- does not survive that costs itself and never the project's other rules.
--
-- There is no `behavior` column. This table holds grants and nothing else: a
-- rule in it means "do not ask about this", and the absence of a matching rule
-- means ask. A column with `allow` and `ask` in it would make the second of
-- those two things -- a row that means what no row already means -- and then
-- the order rules were evaluated in would decide what happened, which is a
-- language nobody asked for.
--
-- `created_at` is epoch milliseconds with no default, for the reason every
-- earlier migration gives: time comes from an injected clock, and a schema
-- default is the one reading of the wall clock no test could set.
CREATE TABLE approval_policy_rules (
  id         text    PRIMARY KEY,

  node_id    text    NOT NULL REFERENCES projects (node_id) ON DELETE CASCADE,

  tool       text    NOT NULL CHECK (length(tool) > 0 AND length(tool) <= 200),
  prefix     text    NOT NULL CHECK (length(prefix) > 0 AND length(prefix) <= 4000),

  created_at integer NOT NULL
) WITHOUT ROWID;

-- Reading one project's rules is the only read this table has, and it happens
-- on the path of every approval request that reaches the hub.
CREATE INDEX approval_policy_rules_project ON approval_policy_rules (node_id);

-- One rule per project per (tool, prefix), as a schema fact rather than a habit
-- of the code that happens to write it. Two identical rules are not two grants:
-- they are one grant a person would have to revoke twice, and the second
-- revocation would be a rule they had no memory of writing.
CREATE UNIQUE INDEX approval_policy_rules_unique
  ON approval_policy_rules (node_id, tool, prefix);
