-- Parents: which run, at which step, started a run as its SUB-GRAPH child.
--
-- A SUB-GRAPH node runs another graph at a pinned published version, and that
-- run is a run of the other graph in every way that matters: its own row, its
-- own number counted in its own graph, its own place in that graph's history.
-- What it has that a run somebody pressed Run on does not is a parent, and
-- the two columns here say which: the run whose step started it, and the node
-- that step was at. Both NULL for a run a person started.
--
-- ## Why the parent is on the child, not the child on the parent
--
-- The parent's step names its child in the step list already, as the protocol
-- states a step. The columns are the other direction -- from a child up to
-- where it was started -- which is what reading "the children of this step"
-- off the table needs without parsing every run's JSON, and what keeps a child
-- findable from its parent after the parent's step list is long gone from
-- memory.
--
-- ## A removed parent graph leaves the child where it is
--
-- `parent_run_id` is SET NULL when the parent run goes, and a parent run goes
-- when its graph is removed (0018's cascade). The child is a run of the child
-- graph and is that graph's history: removing some other graph does not reach
-- into it. `parent_node_id` stays as it was, a trace of the step a child came
-- from with no run left to open it in, which is why there is no CHECK pairing
-- the two columns.
--
-- ## Steps written before this migration
--
-- 0018's step lists were written before a step named its child, and every
-- step now does -- `null` on each one that started none. The protocol states
-- `child` as required, and a row that fails to parse is a refusal on read, so
-- the stored lists are rewritten here to carry `"child": null` on every step
-- rather than the schema growing a second shape for old rows.
--
-- ## Indexes
--
-- The history list reads one graph's runs newest first, parents or not: a run
-- started by a parent's step is still that graph's run and is listed in its
-- history under its own number. 0018's `graph_runs_by_graph` on
-- (graph_node_id, number DESC) serves that read already, so it is not built
-- twice. What is new is the read up from a step: the children one step of one
-- run started, in the order they were started, which a retried SUB-GRAPH node
-- makes more than one of.

ALTER TABLE graph_runs
  ADD COLUMN parent_run_id text REFERENCES graph_runs (id) ON DELETE SET NULL;
ALTER TABLE graph_runs
  ADD COLUMN parent_node_id text;

UPDATE graph_runs
   SET steps = (
         SELECT coalesce(json_group_array(json_set(step.value, '$.child', json('null'))), '[]')
           FROM json_each(graph_runs.steps) AS step
       );

CREATE INDEX graph_runs_by_parent_step
  ON graph_runs (parent_run_id, parent_node_id, number)
  WHERE parent_run_id IS NOT NULL;
