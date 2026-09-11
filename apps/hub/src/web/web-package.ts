import { fileURLToPath } from 'node:url';
import type { WebAssetFileSystem } from './web-assets.js';

/**
 * Where the built client comes from, now that it is a package of its own.
 *
 * ## Why this is a resolution and not a path
 *
 * It used to be `new URL('../../web/dist', import.meta.url)`: one expression
 * that was correct in a checkout, in the image and in the tarball, because all
 * three kept the workspace layout and the client was cargo inside the hub's own
 * tree. Splitting the release into four packages ends that. A hub machine
 * installs `@softiesolutions/agentplex-hub` and `@softiesolutions/agentplex-web`
 * as siblings under `<prefix>/lib/node_modules`, so `../../web/dist` from the
 * hub's `dist/main.js` names a directory inside the hub's own package that
 * nothing puts anything in.
 *
 * A resolution is correct in all three homes for one reason each, and nothing
 * downstream has to know which one it is in:
 *
 * - **a checkout** -- pnpm links `apps/web` into `apps/hub/node_modules` because
 *   the hub declares it as a `workspace:*` dependency.
 * - **the runtime image** -- that link is copied in with the rest of
 *   `apps/hub/node_modules`, and it is relative, so it still lands on
 *   `/app/apps/web`.
 * - **an installed machine** -- Node walks up out of the hub's package to
 *   `<prefix>/lib` and finds `<prefix>/lib/node_modules`, which is where npm
 *   put the sibling. Run rather than reasoned about: a global install of two
 *   scoped packages resolves one from the other this way.
 *
 * The manifest is what gets resolved, and not `./dist/index.html` or a bare
 * specifier. A bare specifier needs a main entry, and the client has no module
 * to load -- it is bytes the hub reads and writes to a socket. A subpath into
 * `dist` would be gated by `exports` the day somebody adds one to the client's
 * manifest, and would name the shell in a second place besides `SHELL_FILE`.
 * `package.json` is the one file every package has at a path every resolver can
 * reach, and `apps/web` declares no `exports`, so nothing gates it.
 *
 * ## The hub does not import the client
 *
 * This is a file location, in the same sense as the migrations directory, and
 * not a module boundary being crossed: nothing here loads a module out of the
 * client package, and the lint rule that keeps the apps from importing each
 * other is untouched by it.
 */
export const WEB_PACKAGE = '@softiesolutions/agentplex-web';

/** The one file of it every layout has, at a path no `exports` field gates. */
const WEB_MANIFEST = `${WEB_PACKAGE}/package.json`;

/**
 * The build, beside the manifest.
 *
 * Beside is the whole of what this knows, and it is what makes one expression
 * true in all three homes: `apps/web/package.json` and `apps/web/dist` in a
 * checkout and in the image, `package.json` and `dist` at the published
 * package's root. The client's package is deliberately laid out as its app
 * rather than as the workspace so that this stays one expression -- see the
 * `WEB` target in `scripts/assemble-package.ts`, where staging it at
 * `apps/web/dist` resolved to an empty directory on an installed machine.
 */
const BUILD_DIRECTORY = 'dist';

/**
 * Node's own resolver, as a seam.
 *
 * `import.meta.resolve` answers with a URL rather than a path, and this keeps
 * that shape rather than flattening it: a resolver that answered with something
 * other than a `file:` URL -- a `node:` builtin, a `data:` module -- is a claim
 * this has to be able to refuse, and it can only refuse what it can still see.
 */
export type ModuleResolver = (specifier: string) => string;

/** Where the client is, or why the hub could not find out. */
export type WebRoot =
  { readonly ok: true; readonly root: string } | { readonly ok: false; readonly reason: string };

export function resolveWebRoot(resolve: ModuleResolver): WebRoot {
  let manifest: string;
  try {
    manifest = resolve(WEB_MANIFEST);
  } catch (error) {
    // The ordinary case on a machine that installed only the hub package, and
    // the reason is npm's rather than ours -- so it is carried through as it
    // arrived instead of being replaced with a guess about what happened.
    return { ok: false, reason: `${WEB_PACKAGE} is not installed here (${describe(error)})` };
  }

  try {
    // Relative to the manifest, which is a file, so this replaces
    // `package.json` with `dist` rather than appending to it.
    return { ok: true, root: fileURLToPath(new URL(`./${BUILD_DIRECTORY}`, manifest)) };
  } catch (error) {
    return { ok: false, reason: `${WEB_PACKAGE} resolved to ${manifest} (${describe(error)})` };
  }
}

/**
 * What the hub serves the client out of when there is no client package.
 *
 * It answers every read the way an empty directory does, which is deliberate
 * and not a shortcut. `answerWebAssetRequest` already turns a missing shell
 * into a 503 -- not a 404, which would claim the page does not exist, and not
 * a 500 -- and `hub.ts` already logs one line at startup saying there is no
 * client to serve. A hub with no client package is the same event as a hub
 * whose client was never built, and it costs itself: the API, the websocket and
 * the health check all answer exactly as before.
 *
 * The reason travels in `root`, which is the field that line names and is read
 * by nothing else. That field is a path everywhere else and a sentence here,
 * and that is the honest answer to "where do these files come from" when the
 * answer is "from a package that is not on this machine". No visitor ever sees
 * it: the 503 says there is no client and nothing about this filesystem.
 */
export function missingWebPackage(reason: string): WebAssetFileSystem {
  return {
    root: reason,
    read: async () => await Promise.resolve(null),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? String(error)) : String(error);
}
