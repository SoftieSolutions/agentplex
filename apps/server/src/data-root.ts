import { DATA_PATH } from './config.js';

/**
 * The one directory this server writes into, and the rule for what may go in
 * it.
 *
 * Until this file there were two kinds of path and no third. A store path is a
 * provider's volume: `~/.claude/projects` is Claude Code's directory, this
 * server watches it and does not own it, and two servers may mount one at the
 * same time. The identity file is one file holding one server's `serverId` and
 * token. Everything else a server might want to keep had nowhere to be, which
 * is why scrollback dies with the process and why a per-project file or a
 * per-hub record has, so far, had to be argued about before it could be
 * written.
 *
 * This is that somewhere, and the reason it is one directory with a rule
 * rather than a setting per thing is that a setting per thing is how a
 * deployment ends up with four paths that have to agree.
 *
 * ## What belongs under it
 *
 * Two questions, and it belongs here only if the answers are yes and no:
 *
 * 1. Would losing it when the process restarts be a bug? A cache that is
 *    cheaper to recompute than to invalidate is not state; it can stay in
 *    memory and nobody is worse off.
 * 2. Does any program other than this server have to name the file? If one
 *    does, the path is a coordinate two programs must agree on, and it needs a
 *    setting of its own -- see below.
 *
 * Scrollback spilled out of memory, whatever a session accumulates per
 * project, the record of which hubs this server has authorized: all three are
 * this server's own, all three have to survive a restart, and nothing else on
 * the machine reads them. They belong here, in a subdirectory each names for
 * itself.
 *
 * ## What does not
 *
 * **Anything a provider owns.** A store is somebody else's directory. Writing
 * into it makes agentplex a program that leaves files in another program's
 * state, and a store mounted by two servers would collect both their writes.
 * The data root exists so that "I need to keep a file" never turns into that.
 *
 * **Anything another program on this machine has to find.** The identity file
 * is the case in point, and the reason it keeps its own setting rather than
 * folding in here as `<data root>/server.json`. `agentplex setup` writes it
 * before any server has started, the hub reads it at boot to pair the server
 * beside it (`AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE`), and `agentplex doctor`
 * reports on it. A path that three programs must agree on is part of the
 * deployment, not a private detail of one daemon, and deriving it from a
 * directory only one of those programs is configured with would mean teaching
 * the other two about this setting to buy nothing. That it is also the one
 * file every already-installed machine has an absolute path recorded for is
 * the second reason, not the first.
 *
 * **Anything belonging to a hub.** A hub has a database and this is not it. A
 * machine running both daemons runs two programs, and only one of them owns
 * what is under here.
 *
 * **Anything two servers would share.** One data root per server, for exactly
 * the argument `server-identity.ts` makes about the identity file: two servers
 * pointed at one directory share whatever is in it, and the moment any of it
 * is identity-shaped -- a token, a hub authorization, a claim on a session --
 * that is the same bug in a new place. Sharing it is not detected here, and
 * cannot usefully be: what protects the pairing is that the identity file
 * stayed outside, so two servers that share a data root are at least still two
 * servers.
 *
 * ## Who creates it, and what happens when it cannot be
 *
 * This server, at boot, with its parents, before it serves anything -- and it
 * refuses to start if it cannot create the directory or cannot write inside
 * one that is already there.
 *
 * That is deliberately not what a store path gets. A store that is not there
 * is legal and is reported honestly, because the server can do its whole job
 * against the stores it does have and a volume may be mounted later; refusing
 * to start over one would take the other four down with it. The data root is
 * not symmetrical. A server that comes up without it has nowhere to put what
 * it promises to remember, and the symptom arrives one restart later as
 * something forgotten, with nothing at the time saying why. Refusing at boot
 * converts that into a sentence naming the directory, at the moment somebody
 * is watching.
 *
 * It is a refusal the unit may retry, not the exit code that stops it: the
 * configuration was well-formed and the disk was not, and a disk can become
 * writable without anybody editing a settings file.
 */

/**
 * The disk seam, for the reason `store-identity.ts` gives for its own: errno
 * becomes a value rather than an exception, so that the rule above can
 * distinguish a directory it may create from one it must not, without matching
 * on the text of an error.
 */
export type DirectoryCreate =
  | { readonly kind: 'created' }
  /** It was already there. The ordinary case on every boot after the first. */
  | { readonly kind: 'exists' }
  /** Something is at that path and it is not a directory: a file, a stray link. */
  | { readonly kind: 'not-a-directory' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Whether this process could write in a directory that is already there.
 *
 * Asked rather than demonstrated. Creating a probe file to find out would be
 * this module writing something, which is the one thing it does not do, and
 * would leave a file behind on the path where the answer is yes. The kernel is
 * asked the same question the first real write will ask.
 */
export type WriteAccess =
  { readonly kind: 'writable' } | { readonly kind: 'denied'; readonly reason: string };

export interface DataRootFileSystem {
  /** Creates the directory and every parent, and succeeds on one already there. */
  createDirectory(path: string): Promise<DirectoryCreate>;
  checkWritable(path: string): Promise<WriteAccess>;
}

export type DataRootResult =
  | {
      readonly ok: true;
      readonly path: string;
      /** True when this call made it. Log-worthy on a first start; nothing branches on it. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly path: string; readonly problem: string };

/**
 * The data root, ready to be written into, or the reason it is not.
 *
 * Every refusal names the setting as well as the path. The operator reading
 * this line is one of two people: the one whose machine has the wrong
 * directory configured, who needs the setting, and the one whose directory is
 * right and whose permissions are not, who needs the path. Naming both costs a
 * clause.
 */
export async function ensureDataRoot(
  path: string,
  files: DataRootFileSystem,
): Promise<DataRootResult> {
  const created = await files.createDirectory(path);

  if (created.kind === 'not-a-directory') {
    return {
      ok: false,
      path,
      problem:
        `the data root ${path} is not a directory: ` +
        `something else is in the way, at that path or above it, ` +
        `so point ${DATA_PATH.env} somewhere this server can own`,
    };
  }

  if (created.kind === 'failed') {
    return {
      ok: false,
      path,
      problem:
        `cannot create the data root ${path}: ${created.reason} -- ` +
        `create it by hand, or point ${DATA_PATH.env} at a directory this server can create`,
    };
  }

  const access = await files.checkWritable(path);
  if (access.kind === 'denied') {
    // Checked even on the directory this call just made: a `mkdir` that
    // succeeds under a umask or a parent's setgid bit can still leave a
    // directory this process cannot write in, and finding that out at the
    // first write means finding it out after the server has already told a hub
    // it is serving.
    return {
      ok: false,
      path,
      problem:
        `cannot write in the data root ${path}: ${access.reason} -- ` +
        `this server must own it, so fix its permissions or point ${DATA_PATH.env} elsewhere`,
    };
  }

  return { ok: true, path, created: created.kind === 'created' };
}
