-- Runs: what happened each time a graph was run, kept as history.
--
-- A run is the one thing the runtime writes down. Everything else it touches
-- is somebody else's fact -- a session on a machine, a row in the fleet state
-- that the next scan rebuilds -- but "run 38 of release-pipeline failed at
-- Rust reviewer on its third try" is a fact nothing on any machine records,
-- and the inspector's LAST OUTPUT reads it back after the run is long over.
-- So it is a table here, in the hub's own database, beside the graph it ran.
--
-- ## Numbered per graph, allocated in the insert's transaction
--
-- `number` counts from 1 per graph and is what a person says: "run 38 broke".
-- It is allocated by reading the graph's highest number inside the same
-- transaction that inserts the row, and the UNIQUE below is what makes two
-- runs started in the same instant come out as 38 and 39 rather than two
-- 38s -- the second insert either sees the first's row or is refused by the
-- constraint, and there is no third outcome. `id` is the hub-minted opaque
-- name every frame files the run under; the number is for people.
--
-- ## What a row names
--
-- A run is of one published version, and the composite foreign key says so:
-- a row cannot name a version the graph never had, and removing the graph
-- takes its runs with it -- history of a graph nobody can open is a row
-- nothing can name. The version is stored rather than inferred from
-- `started_at`, because a publish between two runs is exactly the case a
-- person comparing them wants stated.
--
-- ## Text columns, parsed on read
--
-- `input` is the object the run was started with and `steps` is the list of
-- attempts as the protocol's `graphRunStepSchema` states one; both are JSON
-- held as text and parsed by that schema on every read, for the reason 0017
-- gives for the document: the runtime is the one reader of their shape, and a
-- row that does not parse is a refusal on read rather than a cast.
--
-- `status` is the run's, and `reason` is the sentence it ended with -- NULL
-- while it runs and for a run that succeeded, a sentence naming the node for
-- one that failed. `ended_at` is NULL exactly while `status` is `running`.
--
-- A row left `running` at boot is a run the previous process was walking
-- when it stopped, and nothing resumes it: the boot sweep ends it `failed`
-- with a reason naming the restart. The human decision behind that is
-- recorded in the plan for this epic -- a run waiting on a person or a
-- machine does not survive a restart, because a hub that came back and
-- claimed a step was still in flight would be claiming a wait nobody held.
--
-- Every timestamp is epoch milliseconds on the hub's clock, for the reason
-- 0017 gives: the hub is the machine that runs a graph.

CREATE TABLE graph_runs (
  id             text    PRIMARY KEY,
  graph_node_id  text    NOT NULL REFERENCES graphs (node_id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version > 0),
  number         integer NOT NULL CHECK (number > 0),

  -- The JSON of a route input: what the run was started with.
  input          text    NOT NULL,
  -- The JSON of a list of `GraphRunStep`, one per attempt at a node.
  steps          text    NOT NULL,

  status         text    NOT NULL
                   CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  reason         text,
  started_at     integer NOT NULL,
  ended_at       integer,

  UNIQUE (graph_node_id, number),
  FOREIGN KEY (graph_node_id, version)
    REFERENCES graph_versions (graph_node_id, version) ON DELETE CASCADE
) WITHOUT ROWID;

-- The history list reads one graph's runs newest first, and the boot sweep
-- reads whatever is still running.
CREATE INDEX graph_runs_by_graph ON graph_runs (graph_node_id, number DESC);
CREATE INDEX graph_runs_running ON graph_runs (status) WHERE status = 'running';
