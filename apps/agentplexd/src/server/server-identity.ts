import { z } from 'zod';
import { serverIdSchema, type ServerId } from '@agentplex/protocol';
import type { IdGenerator } from '../shared/ids.js';
import type { TokenMinter } from '../shared/tokens.js';
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
 * The token is minted here rather than typed by the operator because the
 * minting side is the side that can get the entropy right. Pairing is still
 * always the user typing it into the hub; this only decides what they type.
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

export interface ServerIdentityDependencies {
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
}

export type ServerIdentityResult =
  | {
      readonly ok: true;
      readonly identity: ServerIdentity;
      /** True when this call created the file. The operator has a new token to paste. */
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
  { files, ids, tokens }: ServerIdentityDependencies,
): Promise<ServerIdentityResult> {
  const existing = await readServerIdentity(path, files);
  if (existing !== null) return existing;

  const serverId = serverIdSchema.safeParse(ids.newId());
  if (!serverId.success) {
    return { ok: false, path, problem: 'the id source produced no usable server id' };
  }
  const token = tokens.newToken();
  if (token.length === 0) {
    return { ok: false, path, problem: 'the token source produced an empty token' };
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
  return winner ?? { ok: false, path, problem: 'the identity file was created and then removed' };
}

/** `null` means there is no file yet, which is the one case that mints. */
async function readServerIdentity(
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
