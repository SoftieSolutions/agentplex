import { z } from 'zod';
import { serverIdSchema, type ServerId } from '@agentplex/protocol';
import { tokenMatches, type IdGenerator, type TokenMinter } from '@agentplex/node-shared';
import type { StoreFileSystem } from './store-identity.js';

/**
 * Who this server is, and the one secret that proves it.
 *
 * The hub dials, so a server has to be able to say `serverId` and to verify a
 * token, and both facts have to survive a restart: a serverId that changed on
 * boot would orphan every placement the hub filed under the old one, and a
 * token that changed would silently break a pairing the user completed last
 * month. The server holds no database, so the only place durable enough is the
 * disk — the same conclusion `store-identity.ts` reaches, for the same reason,
 * and this file follows its shape deliberately.
 *
 * It is *not* the store file. A store is a volume that two servers may mount
 * at once, and an identity written there would hand both of them the same name
 * and the same secret. This file belongs to one server, and where it lives is
 * configuration.
 *
 * The token is minted here by default, rather than typed by the operator,
 * because the minting side is the side that can get the entropy right. That is
 * a default and not a rule, and the difference is the case it cannot serve: it
 * assumes a disk that outlives the process and an operator who can read a file
 * off it, and a container has the first only until the next deploy while CI has
 * nobody to do the second. A deployment that already holds the secret hands it
 * over as `configuredToken`, and nothing is minted.
 *
 * What does not change either way is where the token ends up: in this file,
 * under `token`, written exactly as a minted one is. A configured token is a
 * token source and not a second mechanism, which is what keeps everything that
 * reads a token off this file reading one -- the hub's local pairing on a
 * `--role=both` box, and the grant AGX-204 will migrate this record into.
 *
 * Pairing is still always the user typing it into the hub; this only decides
 * what they type, and whether they were told it in advance.
 */

/**
 * Non-strict, like the store file: a later version may add fields, and an older
 * build that meets one should read the two it knows and carry on.
 */
const serverIdentityFileSchema = z.object({
  serverId: serverIdSchema,
  token: z.string().min(1),
});

export interface ServerIdentity {
  readonly serverId: ServerId;
  /** Never logged and never in a frame the server sends. It only ever arrives. */
  readonly token: string;
}

/**
 * A pairing token the deployment chose, and the name of the setting that
 * carried it.
 *
 * The name travels with the value because the only sentence this module writes
 * about a configured token is a refusal an operator has to act on, and a
 * refusal that cannot name the variable to change is one that sends them
 * looking. This package does not own that name -- the server app does -- so it
 * arrives here rather than being spelled here.
 */
export interface ConfiguredToken {
  readonly token: string;
  readonly setting: string;
}

export interface ServerIdentityDependencies {
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
  /**
   * The token the deployment set, when it set one.
   *
   * Present means it *is* the token: `tokens` is never consulted, and a file
   * that already holds a different one stops the start rather than being
   * overwritten or quietly preferred. See `agreeingToken` for why neither of
   * those is the safe direction.
   */
  readonly configuredToken?: ConfiguredToken | undefined;
}

export type ServerIdentityResult =
  | {
      readonly ok: true;
      readonly identity: ServerIdentity;
      /**
       * True when this call created the file.
       *
       * It says the file is new, not that the token is: a deployment that
       * supplied one gets `true` here for a token it already had. What a
       * caller may conclude from it is that nothing was paired against this
       * file before now -- which is what the operator needs to be told, and is
       * true either way.
       */
      readonly minted: boolean;
    }
  | { readonly ok: false; readonly path: string; readonly problem: string };

/**
 * Reads this server's identity, minting one the first time it starts.
 *
 * A file that is there and unreadable is never minted over, and the caller is
 * expected to refuse to start rather than carry on. Both halves of that matter:
 * writing a fresh identity over a damaged one would present the machine to the
 * hub as a server nobody has ever paired, with a token the user has never seen,
 * and the symptom would be a paired server that silently stopped answering
 * rather than an error naming the file.
 */
export async function ensureServerIdentity(
  path: string,
  { files, ids, tokens, configuredToken }: ServerIdentityDependencies,
): Promise<ServerIdentityResult> {
  const existing = await readServerIdentity(path, files);
  if (existing !== null) return agreeingToken(existing, path, configuredToken);

  const serverId = serverIdSchema.safeParse(ids.newId());
  if (!serverId.success) {
    return { ok: false, path, problem: 'the id source produced no usable server id' };
  }
  const token = configuredToken?.token ?? tokens.newToken();
  if (token.length === 0) {
    return {
      ok: false,
      path,
      problem:
        configuredToken === undefined
          ? 'the token source produced an empty token'
          : `${configuredToken.setting} is set to an empty pairing token`,
    };
  }

  const identity: ServerIdentity = { serverId: serverId.data, token };
  const created = await files.createFile(path, serializeIdentity(identity));
  if (created.kind === 'created') return { ok: true, identity, minted: true };
  if (created.kind === 'failed') {
    return { ok: false, path, problem: `cannot write the identity file: ${created.reason}` };
  }

  // Something created it between the read and the create — a second copy of
  // this server started against the same file. Its identity is the one on
  // disk; the one minted above never existed.
  const winner = await readServerIdentity(path, files);
  if (winner === null) {
    return { ok: false, path, problem: 'the identity file was created and then removed' };
  }
  return agreeingToken(winner, path, configuredToken);
}

/**
 * The identity that is on disk, checked against the token the deployment set.
 *
 * A disagreement stops the start rather than being resolved, and both ways of
 * resolving it are the argument. Preferring the file leaves a server answering
 * to a credential the operator believes they replaced, and the only symptom is
 * that the replacement never took -- the failure nobody sees. Preferring the
 * setting rewrites an identity a pairing was completed against, which is the
 * one rule this module has held since it was written: it never mints over a
 * file it found. A refusal naming both costs one restart and cannot be
 * misread.
 *
 * A caller with no configured token is unaffected, which is every caller that
 * existed before this: the check is the identity function when there is nothing
 * to disagree with.
 */
function agreeingToken(
  result: ServerIdentityResult,
  path: string,
  configured: ConfiguredToken | undefined,
): ServerIdentityResult {
  if (!result.ok || configured === undefined) return result;
  // `tokenMatches` rather than `===`, though nothing is being authenticated
  // here. There is one way two secrets are compared in this codebase, and a
  // second spelling of it is how that stops being true.
  if (tokenMatches(result.identity.token, configured.token)) return result;

  // Neither token, for the reason the result never carries one: this sentence
  // is handed to a logger and a log is a scrollback.
  return {
    ok: false,
    path,
    problem:
      `${path} holds a pairing token that is not the one ${configured.setting} sets, and a ` +
      'server may not answer to both: stop setting it to keep the token this machine is ' +
      'already paired under, or delete the file to take the configured one and pair this ' +
      'server again afterwards',
  };
}

/**
 * Reads the identity that is there, and never mints one. `null` means there is
 * no file yet, which is the one case `ensureServerIdentity` mints in.
 *
 * Exported for the caller that must not be able to mint: setup pairs the local
 * server with the token the identity file already holds, so what it needs is a
 * read that cannot become a write. Reaching for `ensureServerIdentity` there
 * would put a second minting path a step away from a hub row, and the machine
 * would end up paired under a token nothing else on it has ever seen.
 */
export async function readServerIdentity(
  path: string,
  files: StoreFileSystem,
): Promise<ServerIdentityResult | null> {
  const read = await files.readFile(path);
  if (read.kind === 'missing') return null;
  if (read.kind === 'failed') {
    return { ok: false, path, problem: `cannot read the identity file: ${read.reason}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(read.contents);
  } catch (error) {
    return { ok: false, path, problem: `the identity file is not JSON: ${String(error)}` };
  }

  const parsed = serverIdentityFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, path, problem: `the identity file is not a server identity: ${issues}` };
  }

  return {
    ok: true,
    identity: { serverId: parsed.data.serverId, token: parsed.data.token },
    minted: false,
  };
}

/**
 * Indented with a trailing newline. This file gets opened by a person: it is
 * where the operator reads the token to paste into the hub, which is why the
 * server logs its path and never its contents.
 */
function serializeIdentity(identity: ServerIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}
