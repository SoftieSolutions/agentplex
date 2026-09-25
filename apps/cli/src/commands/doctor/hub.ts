import { dirname } from 'node:path';
import { MIN_TOKEN_LENGTH } from '@agentplex/node-shared';
import { readServerIdentity, type StoreFileSystem } from '@agentplex/providers';
import type { HubConfig } from './config.js';

/**
 * What a hub needs before it can boot, asked without booting one.
 *
 * The doctor used to answer `usable: true` for `--role=hub` and check nothing,
 * which made it an honest report about a server and a claim it had no evidence
 * for about a hub: a database file nothing may write, a client token nobody
 * set, a port something else already holds, and a client package that is not
 * installed all read as a healthy machine. Each of those is a way the hub fails
 * at boot, and each is a line here.
 *
 * The checks are the hub's own rules restated, because this program may not
 * import that app -- see `config.ts` on borrowed configuration. Where the rule
 * is a constant the two can share, it is shared: `MIN_TOKEN_LENGTH` lives in
 * `@agentplex/node-shared` precisely so that the hub's floor and everything
 * that reports on it are one number.
 *
 * Read-only, with one bounded exception that is stated rather than hidden: the
 * port question can only be answered by asking the kernel for the address, so
 * the probe binds it and lets go. That leaves nothing behind, and it is a
 * point-in-time claim -- the port was free when this ran, which is not a
 * promise about the moment the unit starts.
 */

/**
 * Whether this process may write at a path that is already there.
 *
 * A seam, because a permission is exactly what a test cannot arrange: a suite
 * running as root can write everywhere and a suite in a container can write
 * nowhere, and neither is the machine the operator is asking about.
 *
 * It answers for the user running the doctor. On a machine where the unit runs
 * as somebody else, that is the honest answer to a different question, and the
 * report says whose it is by naming nothing: what an operator does with a
 * `denied` is check which user the unit runs as.
 */
export type WriteAccess =
  { readonly kind: 'writable' } | { readonly kind: 'denied'; readonly reason: string };

export type PathAccess = (path: string) => Promise<WriteAccess>;

/**
 * What the configured address turned out to be.
 *
 * `failed` is not `in-use`: a port held by another process is something to stop
 * or to move off, and an address this machine cannot bind at all -- a host that
 * is not one of its interfaces, a privileged port under an unprivileged user --
 * is something else to fix. A boolean would report both as the same shrug.
 */
export type PortState =
  | { readonly kind: 'free' }
  | { readonly kind: 'in-use' }
  | { readonly kind: 'failed'; readonly reason: string };

export type PortProbe = (host: string, port: number) => Promise<PortState>;

/**
 * Node's own resolver, as a seam, kept in the shape it answers in.
 *
 * `import.meta.resolve` is meaningful only in the module it is evaluated in --
 * it resolves against that file's URL -- so it is passed in from the entrypoint
 * rather than reached for here, which is the same reason the hub passes its own
 * in. It answers with a URL rather than a path and throws when there is nothing
 * to answer with.
 */
export type ModuleResolver = (specifier: string) => string;

export interface HubDependencies {
  /** The disk, for the one file this half reads: the local server's identity. */
  readonly files: StoreFileSystem;
  readonly access: PathAccess;
  readonly ports: PortProbe;
  readonly resolve: ModuleResolver;
}

/**
 * The client package, named again here rather than imported from the hub.
 *
 * `apps/hub/src/web/web-package.ts` carries the argument for the specifier and
 * for resolving a manifest rather than a path; this is that name restated in
 * the one other program that has to answer whether the client is on this
 * machine. Apps do not import each other, and a doctor that took the hub's copy
 * would be the import the lint rule exists to refuse.
 */
const WEB_PACKAGE = '@softiesolutions/agentplex-web';
const WEB_MANIFEST = `${WEB_PACKAGE}/package.json`;

/** The setting names, for a problem an operator has to act on. */
const DATABASE_SETTING = 'AGENTPLEX_DATABASE_FILE or pass --database-file';
const TOKEN_SETTING = 'AGENTPLEX_CLIENT_TOKEN or pass --client-token';

/**
 * Where the hub keeps its state, and whether this machine will let it.
 *
 * `path` is `null` when no setting names one, which is a state of the machine
 * and not a usage error: a hub with no database file does not start, and that
 * is the first line the operator needs rather than a message printed instead of
 * the report they asked for.
 */
export interface DatabaseCheck {
  readonly path: string | null;
  readonly state: 'ready' | 'missing' | 'unusable';
  /** What is wrong, in words, or `null` when nothing is. */
  readonly problem: string | null;
}

/**
 * The client credential, as a verdict and never as a value.
 *
 * Nothing on this type can carry the token. The check reads its length and the
 * report prints this, so there is no expression anywhere in the doctor that
 * could put a secret on stdout or into an issue somebody pasted it into.
 */
export interface TokenCheck {
  readonly state: 'ready' | 'missing' | 'unusable';
  readonly problem: string | null;
}

export interface PortCheck {
  readonly host: string;
  readonly port: number;
  readonly state: 'free' | 'in-use' | 'unusable';
  readonly problem: string | null;
}

/**
 * The built client, which is a warning and not a failure.
 *
 * A hub with no client package starts, serves its API and its websocket, and
 * answers every page with 503 -- it costs itself and not the hub. Reporting
 * that as a failure would make a working hub exit non-zero in a script.
 */
export interface ClientCheck {
  readonly state: 'present' | 'missing';
  /** The reason the resolver gave, or `null` when it resolved. */
  readonly problem: string | null;
}

/**
 * The server on this same machine, when the settings name one.
 *
 * A failure rather than a warning, unlike the client package, and the
 * difference is what an operator would otherwise be told. A hub whose local
 * server does not pair boots and logs one `warn` line, and then the machine
 * quietly does not do the thing its settings say it does: the server beside the
 * hub never appears. Nothing else on the machine ever says so again.
 */
export interface LocalServerCheck {
  readonly path: string;
  readonly state: 'ready' | 'unusable';
  readonly problem: string | null;
}

/** Everything the hub half looked at. `localServer` is `null` when none is configured. */
export interface HubChecks {
  readonly database: DatabaseCheck;
  readonly clientToken: TokenCheck;
  readonly port: PortCheck;
  readonly client: ClientCheck;
  readonly localServer: LocalServerCheck | null;
}

export async function inspectHub(
  config: HubConfig,
  host: string,
  { files, access, ports, resolve }: HubDependencies,
): Promise<HubChecks> {
  const [database, port, localServer] = await Promise.all([
    checkDatabase(config.databaseFile, files, access),
    checkPort(host, config.port, ports),
    checkLocalServer(config.localServer?.identityPath ?? null, files),
  ]);

  return {
    database,
    clientToken: checkClientToken(config.clientToken),
    port,
    client: checkClient(resolve),
    localServer,
  };
}

/**
 * Whether every hub check that can fail did not.
 *
 * The client package is left out on purpose: it is the one warning here, and a
 * warning that moved the exit code would be a failure wearing another word.
 */
export function hubUsable(checks: HubChecks): boolean {
  return (
    checks.database.state === 'ready' &&
    checks.clientToken.state === 'ready' &&
    checks.port.state === 'free' &&
    (checks.localServer === null || checks.localServer.state === 'ready')
  );
}

/**
 * The database file, without opening it.
 *
 * Opening is what the hub does at boot, and it is also what *creates* the file
 * and the `-wal` beside it. A doctor that opened one would mint a database on
 * the machine it was asked to describe -- and on a machine where the path was
 * mistyped, it would mint the wrong one and report it healthy.
 *
 * So the question is asked of the two things that are already there: the file,
 * when there is one, and otherwise the directory the hub would create it in.
 * The hub creates the file and never the directory above it.
 */
async function checkDatabase(
  path: string | null,
  files: StoreFileSystem,
  access: PathAccess,
): Promise<DatabaseCheck> {
  if (path === null) {
    return {
      path: null,
      state: 'missing',
      problem: `the hub needs a database file: set ${DATABASE_SETTING} (an absolute path)`,
    };
  }

  const entry = await files.statDirectory(path);
  switch (entry.kind) {
    case 'directory':
      return {
        path,
        state: 'unusable',
        problem: 'that path is a directory, and a database is a file',
      };
    case 'failed':
      return { path, state: 'unusable', problem: entry.reason };
    // `statDirectory` answers this for anything that is there and is not a
    // directory, which for this path is the ordinary case: the database.
    case 'not-a-directory':
      return await writableAt(path, path, access, 'the hub could not write to the database file');
    case 'missing':
      return await checkDatabaseDirectory(path, access, files);
  }
}

/** The directory the hub would create the database in, which it does not create. */
async function checkDatabaseDirectory(
  path: string,
  access: PathAccess,
  files: StoreFileSystem,
): Promise<DatabaseCheck> {
  const directory = dirname(path);
  const entry = await files.statDirectory(directory);
  switch (entry.kind) {
    case 'directory':
      return await writableAt(
        path,
        directory,
        access,
        `the hub could not create the database in ${directory}`,
      );
    case 'missing':
      return {
        path,
        state: 'missing',
        problem: `${directory} is not there, and the hub creates the database file and not the directory above it`,
      };
    case 'not-a-directory':
      return { path, state: 'unusable', problem: `${directory} is not a directory` };
    case 'failed':
      return { path, state: 'unusable', problem: entry.reason };
  }
}

async function writableAt(
  path: string,
  target: string,
  access: PathAccess,
  problem: string,
): Promise<DatabaseCheck> {
  const writable = await access(target);
  return writable.kind === 'writable'
    ? { path, state: 'ready', problem: null }
    : { path, state: 'unusable', problem: `${problem}: ${writable.reason}` };
}

/**
 * The client token, by its length alone.
 *
 * Absent and too short are two states rather than the one message the hub's own
 * reader gives them, because the two sentences an operator reads are different:
 * one says nothing is set here, and the other says what is set will be refused.
 * The hub's rule -- at least `MIN_TOKEN_LENGTH` characters -- is the same
 * number in both programs because it is the same constant.
 */
function checkClientToken(token: string | null): TokenCheck {
  if (token === null) {
    return {
      state: 'missing',
      problem:
        `the hub needs a client token of at least ${MIN_TOKEN_LENGTH} characters: ` +
        `set ${TOKEN_SETTING} (generate one with: openssl rand -base64 32)`,
    };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      state: 'unusable',
      problem:
        `the client token is ${token.length} characters and the hub refuses anything under ` +
        `${MIN_TOKEN_LENGTH}: generate one with openssl rand -base64 32`,
    };
  }
  return { state: 'ready', problem: null };
}

/**
 * Whether anything already holds the address the hub would bind.
 *
 * Asked by binding it and closing it again, which is the only answer a portable
 * program can get: everything else -- `ss`, `lsof`, `/proc/net/tcp` -- is a
 * spawn or a Linux file, and a doctor that shelled out to answer this would
 * have to route the spawn through the operation registry to learn less.
 *
 * It is a reading and not a reservation. Something can take the port between
 * this line and the unit starting, and the report says `free` about the moment
 * it ran.
 */
async function checkPort(host: string, port: number, ports: PortProbe): Promise<PortCheck> {
  const state = await ports(host, port);
  switch (state.kind) {
    case 'free':
      return { host, port, state: 'free', problem: null };
    case 'in-use':
      return {
        host,
        port,
        state: 'in-use',
        problem: 'something already listens there, and the hub would fail to bind it',
      };
    case 'failed':
      return { host, port, state: 'unusable', problem: state.reason };
  }
}

/**
 * Whether the client package is on this machine, resolved the way the hub
 * resolves it: the manifest, by name, from the asking module's own position.
 *
 * The position is the caveat, and it is why this is a warning in both halves of
 * its meaning. On an installed machine the two packages are siblings under one
 * global root and this resolves exactly as the hub's does. In a checkout pnpm
 * links `apps/web` into the *hub's* `node_modules`, because the hub is what
 * declares it, so a doctor run out of `apps/cli/dist` reports it missing on a
 * machine whose hub serves it perfectly well. A line that cannot fail a run is
 * the right weight for an answer that carries that caveat.
 */
function checkClient(resolve: ModuleResolver): ClientCheck {
  try {
    resolve(WEB_MANIFEST);
    return { state: 'present', problem: null };
  } catch (error) {
    // The resolver's own sentence, first line only, for the reason the hub
    // carries it through as it arrived: what happened is npm's to say.
    return {
      state: 'missing',
      problem: `${WEB_PACKAGE} is not installed here (${describe(error)})`,
    };
  }
}

/**
 * The identity file of the server on this machine, read through the parser that
 * cannot mint one.
 *
 * `readServerIdentity` is the same read the hub's local pairing does at boot,
 * and it is exported for exactly this: a caller that must not be able to write.
 * The hub applies one more parser to the token afterwards, its own, which lives
 * in the app and is not reachable from here -- so a file this reports as
 * `ready` is one the hub will get as far as parsing the token out of.
 */
async function checkLocalServer(
  path: string | null,
  files: StoreFileSystem,
): Promise<LocalServerCheck | null> {
  if (path === null) return null;

  const identity = await readServerIdentity(path, files);
  if (identity === null) {
    return {
      path,
      state: 'unusable',
      problem: 'there is no server identity there: this machine has no token to pair with',
    };
  }
  return identity.ok
    ? { path, state: 'ready', problem: null }
    : { path, state: 'unusable', problem: identity.problem };
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? String(error)) : String(error);
}

/**
 * The hub half of the report, as lines to print.
 *
 * One column of names, one of states, one of the thing each is about. The
 * problem goes underneath the line it belongs to rather than beside it, so a
 * sentence is never the reason a column stops lining up.
 */
export function hubLines(checks: HubChecks): readonly string[] {
  const lines = [
    checkLine(
      'database',
      checks.database.state,
      checks.database.path ?? '-',
      checks.database.problem,
    ),
    checkLine('client token', checks.clientToken.state, null, checks.clientToken.problem),
    checkLine(
      'port',
      checks.port.state,
      `${checks.port.host}:${String(checks.port.port)}`,
      checks.port.problem,
    ),
    checkLine('web client', checks.client.state, null, checks.client.problem),
  ];

  // Said in the line itself, because a `missing` in a report is read as
  // something to fix and this one is something to know.
  if (checks.client.state === 'missing') {
    lines.push('    the hub starts without it and answers every page with 503');
  }

  if (checks.localServer !== null) {
    lines.push(
      checkLine(
        'local server',
        checks.localServer.state,
        checks.localServer.path,
        checks.localServer.problem,
      ),
    );
  }

  return lines;
}

function checkLine(
  name: string,
  state: string,
  detail: string | null,
  problem: string | null,
): string {
  const line = `  ${name.padEnd(13)} ${state.padEnd(9)} ${detail ?? ''}`.trimEnd();
  return problem === null ? line : `${line}\n    ${problem}`;
}
