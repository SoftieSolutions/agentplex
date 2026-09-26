import type { CatalogueQuery, FrameId, Layout, ServerRegistrationId } from '@agentplex/protocol';
import type { CatalogueQueries, TreeChanged, TreeMutations } from '../catalogue/catalogue.js';
import type { Projects } from '../projects/projects.js';
import { refusal, reply, type ReplyContext } from './reply.js';

/**
 * Reads the stored layout and replies to the client that asked.
 *
 * The state check is repeated after the await, because the socket can close
 * while the tree is being read and sending on a closed socket is an error
 * this connection would then have to explain.
 *
 * A read that throws is `internal` rather than `refused`, and the difference
 * is what a client does next. `refused` says the hub understood and declined,
 * which invites nothing; `internal` says the hub broke and retrying may work,
 * which is true -- a busy timeout on the write lock is the ordinary cause.
 * The problem is logged here and not sent: what went wrong inside the hub's
 * database is not a client's to render.
 */
export function answerLayout(
  ctx: ReplyContext,
  readLayout: () => Promise<Layout>,
  replyTo: FrameId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not read the layout', failure: 'the hub could not read its layout' },
    readLayout,
    (nodes) => ({ type: 'layout', replyTo, nodes }),
  );
}

/**
 * Answers the stored pane layout — the characters of the last save, or
 * `null` when nothing was ever saved — to the client that asked. A throw is
 * `internal` for the reason `answerLayout` gives: the hub broke, retrying
 * may work, and what broke is not a client's to render.
 */
export function answerPaneLayout(
  ctx: ReplyContext,
  readPaneLayout: () => Promise<string | null>,
  replyTo: FrameId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not read the pane layout',
      failure: 'the hub could not read its pane layout',
    },
    readPaneLayout,
    (layout) => ({ type: 'pane-layout', replyTo, layout }),
  );
}

/**
 * Stores the pane layout, whole and unread, and acknowledges the client
 * that saved it. The parser already held the frame to the protocol's bound;
 * nothing here looks inside the characters, which is the contract that lets
 * a newer client save a pane type this build has never heard of.
 */
export function answerPaneLayoutSave(
  ctx: ReplyContext,
  writePaneLayout: (layout: string) => Promise<void>,
  replyTo: FrameId,
  layout: string,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not store the pane layout',
      failure: 'the hub could not store the pane layout',
    },
    () => writePaneLayout(layout),
    () => ({ type: 'pane-layout-saved', replyTo }),
  );
}

/**
 * Answers one page of the catalogue to the client that asked.
 *
 * Two kinds of no, and they are different things for a client to do. A stale
 * or foreign cursor is a `refusal` the client acts on -- it asks for the
 * first page again -- and it is `bad-request` rather than `refused` because
 * the frame named something this hub cannot serve, not a state of the world
 * that says no. A read that throws is `internal`, for the reason the layout
 * read gives: the hub broke, retrying may work, and what broke inside its
 * database is not a client's to render.
 */
export function answerCatalogueQuery(
  ctx: ReplyContext,
  catalogue: CatalogueQueries,
  replyTo: FrameId,
  request: CatalogueQuery,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not read the catalogue', failure: 'the hub could not read its catalogue' },
    () => catalogue.query(request),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'catalogue-page',
        replyTo,
        items: [...outcome.items],
        nextCursor: outcome.nextCursor,
        total: outcome.total,
        version: outcome.version,
      };
    },
  );
}

/**
 * Lists a directory on one server and answers the client that asked.
 *
 * A browse takes as long as another machine takes, and this socket may have
 * closed while it did.
 *
 * A refusal carries no holder, and that is not an omission: a directory has
 * no live process to name, and `holder` is the field that means "it is
 * running over here". `null` is the honest value and the one every refusal
 * but a session's carries.
 */
export function answerDirectoryList(
  ctx: ReplyContext,
  projects: Projects,
  replyTo: FrameId,
  server: ServerRegistrationId,
  directory: string | null,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not list a directory', failure: 'the hub could not list that directory' },
    () => projects.listDirectory(server, directory),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'directory-listing',
        replyTo,
        directory: outcome.directory,
        roots: [...outcome.roots],
        entries: [...outcome.entries],
        truncated: outcome.truncated,
      };
    },
  );
}

/**
 * Makes a project and answers the client that asked.
 *
 * The refusal carries no holder, like every refusal but a session's: a
 * project has no live process to name.
 */
export function answerProjectCreate(
  ctx: ReplyContext,
  projects: Projects,
  replyTo: FrameId,
  name: string,
  directory: string,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not create a project', failure: 'the hub could not create that project' },
    () => projects.create({ name, directory }),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'project-created', replyTo, nodeId: outcome.nodeId };
    },
  );
}

/**
 * Makes a folder and answers the client that asked.
 *
 * Its own function rather than a case of the one below, because the yes is
 * different: a create answers with the id of what it made, which is the one
 * thing the client could not have worked out for itself.
 */
export function answerCreateFolder(
  ctx: ReplyContext,
  catalogue: TreeMutations,
  replyTo: FrameId,
  request: Parameters<TreeMutations['createFolder']>[0],
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not create a folder', failure: 'the hub could not create that folder' },
    () => catalogue.createFolder(request),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
      return { type: 'node-created', replyTo, nodeId: outcome.nodeId };
    },
  );
}

/**
 * The other four tree edits, each answered by one word and nothing else.
 *
 * One function for four frames, and the reply name is an argument rather than
 * a branch, because the shape of the answer really is identical: the tree did
 * what was asked, and what the client reads next is the layout it asks for.
 * A refusal is passed through whole, `holder` included -- a removal refused
 * because a session is still running names the machine, so the client can
 * offer the stop rather than only the sentence.
 *
 * `doing` is the verb for the internal-error sentence, so a hub that broke
 * says which act broke rather than "something went wrong".
 */
export function answerTreeChange(
  ctx: ReplyContext,
  replyTo: FrameId,
  answer: 'node-renamed' | 'node-moved' | 'node-removed' | 'node-removal-forgotten',
  doing: string,
  pending: Promise<TreeChanged>,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: `could not ${doing}`, failure: `the hub could not ${doing}` },
    () => pending,
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem, outcome.holder);
      return { type: answer, replyTo };
    },
  );
}
