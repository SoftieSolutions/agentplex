/**
 * The PWA, served by the hub.
 *
 * The hub serving the client is not packaging convenience. The MCP endpoint is
 * specified as same-origin and token-authed, and same-origin is a claim about
 * where the UI comes from: it means something only because these bytes and that
 * endpoint answer on one port, behind one certificate, under one token. The
 * client socket already lives there for the same reason.
 *
 * Everything below is decided as a value rather than written to a socket, the
 * way `client-auth.ts` decides the ticket exchange: `hub.ts` turns an answer
 * into HTTP and decides nothing. The two rules that carry the weight are the
 * ones a static server gets wrong quietly.
 *
 * **A miss falls back to the shell only when the path could be a route.** The
 * client owns its paths, so `/settings` is a screen and has no file. A missing
 * `index-abc123.js` is not a screen; answering it with HTML and a 200 turns a
 * half-copied build into a syntax error in the browser console, pointing at a
 * file that was never JavaScript. An extension is the line between the two:
 * the app owns paths, and the build owns filenames.
 *
 * **A fingerprinted asset is immutable and nothing else is.** Vite hashes
 * everything under `assets/`, so those may be cached for a year. The shell
 * names them, and a cached shell is a browser asking forever for the build that
 * was deployed the day it cached — with nothing a later deploy can do to reach
 * it. The service worker is the same hazard one layer up.
 */

/**
 * Where the built client is read from.
 *
 * A seam for the reason the migrations directory is one: no test in this
 * repository should need a built PWA on the disk running it, and the hub should
 * not know whether its files came from a workspace build, an image layer or a
 * published package.
 */
export interface WebAssetFileSystem {
  /**
   * Where these files come from, for the line the hub logs at startup.
   *
   * On the seam rather than passed beside it, so that there is exactly one
   * thing holding the web root and the answers below cannot accidentally name
   * it: a path on the hub's disk is not something an unauthenticated visitor
   * is owed.
   */
  readonly root: string;
  /**
   * The file's bytes, or `null` when there is no such file.
   *
   * Absence is an answer and not an exception, because it is the ordinary case
   * — every client route reaches this with a filename that does not exist. A
   * read that failed for any other reason throws: a file that is there and
   * cannot be read is not a missing file, and reporting it as one would tell a
   * browser the build is incomplete and tell the operator nothing.
   */
  read(file: string): Promise<Uint8Array | null>;
}

/** The one file the whole application is behind. */
export const SHELL_FILE = 'index.html';

/** Where vite puts everything it fingerprints, and the only cacheable prefix. */
const IMMUTABLE_DIRECTORY = 'assets';

const HTML = 'text/html; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';
const BYTES = 'application/octet-stream';

/**
 * A year, which is the maximum anything is allowed to mean, plus the promise
 * that the file will never change under this name. Both are true of a
 * fingerprinted asset and of nothing else here.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * Cache it, and ask every time whether it is still current. Not `no-store`:
 * revalidating a shell that has not changed is a 304, which is what makes the
 * app open instantly offline-adjacent networks and still never be stale.
 */
const REVALIDATE = 'no-cache';
/** A refusal is about this moment, and a deploy can change it a second later. */
const NO_STORE = 'no-store';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: HTML,
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  // Vite emits `.js.map` beside the bundle. It is JSON, and a browser only
  // fetches it when devtools are open.
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/vnd.microsoft.icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  txt: TEXT,
};

const NOT_FOUND = 'not found';
const NOT_A_READ = 'the client is served on GET';
/**
 * What a browser is told when the hub has no build beside it.
 *
 * 503 rather than 404, which would claim the page does not exist, or 500,
 * which would claim a fault. Nothing is broken: this hub is running and has
 * nothing to hand anybody. The directory it looked in is in the startup log
 * and not in here — a hub is a thing on the internet, and where its files live
 * is between it and its operator.
 */
const NO_CLIENT =
  'agentplex: this hub has no client to serve.\n' +
  'The built web application is not beside it. Build it, or run an image that ships it.\n';

export interface WebAssetRequest {
  readonly method: string | undefined;
  /** The path, with the query already gone. `requestPath` in `client-auth.ts`. */
  readonly path: string;
}

export interface WebAssetAnswer {
  readonly status: 200 | 404 | 405 | 503;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: Uint8Array;
}

/** What file a request is for, once it has been decided that it is for one. */
interface AssetPlan {
  /** Relative to the web root, and known to stay inside it. */
  readonly file: string;
  readonly contentType: string;
  readonly cacheControl: string;
  /** Whether a miss is a client route rather than a missing file. */
  readonly shellOnMiss: boolean;
}

const encoder = new TextEncoder();

/**
 * Answers a request for the client, or refuses it.
 *
 * The filesystem is the only thing consulted and the only thing that can fail,
 * so every rule here is exercised against a root a test wrote down.
 */
export async function answerWebAssetRequest(
  request: WebAssetRequest,
  files: WebAssetFileSystem,
): Promise<WebAssetAnswer> {
  // Before the path is looked at, and before anything is read. A HEAD is a GET
  // whose body Node drops on the way out, so the two are one case; everything
  // else is asking a static file server to do something it does not do.
  if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(405, NOT_A_READ);

  const plan = planFor(request.path);
  if (plan === null) return refusal(404, NOT_FOUND);

  const bytes = await files.read(plan.file);
  if (bytes !== null) {
    return {
      status: 200,
      contentType: plan.contentType,
      cacheControl: plan.cacheControl,
      body: bytes,
    };
  }

  // A filename that is not there is not there. Only a path that could be a
  // route reaches the shell.
  if (!plan.shellOnMiss && plan.file !== SHELL_FILE) return refusal(404, NOT_FOUND);

  // The shell was already the file that missed when the request was for `/`,
  // so it is not read a second time to learn the same thing.
  const shell = plan.file === SHELL_FILE ? null : await files.read(SHELL_FILE);
  if (shell !== null) {
    return { status: 200, contentType: HTML, cacheControl: REVALIDATE, body: shell };
  }

  return refusal(503, NO_CLIENT);
}

function refusal(status: 404 | 405 | 503, message: string): WebAssetAnswer {
  return {
    status,
    contentType: TEXT,
    cacheControl: NO_STORE,
    body: encoder.encode(message),
  };
}

/**
 * The file a path names, or `null` if it names nothing this hub will read.
 *
 * Decoded first and validated afterwards, which is the only order that is
 * safe: `%2e%2e` is `..` to a filesystem and an ordinary segment to a
 * comparison made before decoding. `hub.ts` has already collapsed `..` through
 * `URL`, and this checks again anyway — the two are independent, and a
 * containment rule that holds only because something upstream normalized is a
 * rule that stops holding the day the caller changes.
 */
function planFor(path: string): AssetPlan | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed percent-encoding. Not a path, so not a file.
    return null;
  }

  if (!decoded.startsWith('/')) return null;
  const relative = decoded.slice(1);

  // The root, and any directory: the client is one page, and there are no
  // listings here to serve.
  if (relative === '' || relative.endsWith('/')) return shellPlan();

  const segments = relative.split('/');
  for (const segment of segments) {
    // An empty segment is a doubled separator, `.` and `..` are traversal, a
    // NUL truncates a path inside a syscall, and a backslash is a separator on
    // one of the platforms this may run on.
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.includes('\0') || segment.includes('\\')) return null;
  }

  const name = segments.at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  // A leading dot is a dotfile and not an extension.
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();

  return {
    file: relative,
    contentType: CONTENT_TYPES[extension] ?? BYTES,
    cacheControl: segments[0] === IMMUTABLE_DIRECTORY ? IMMUTABLE : REVALIDATE,
    shellOnMiss: extension === '',
  };
}

function shellPlan(): AssetPlan {
  return {
    file: SHELL_FILE,
    contentType: HTML,
    cacheControl: REVALIDATE,
    shellOnMiss: false,
  };
}
