import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingWebPackage, resolveWebRoot, WEB_PACKAGE } from './web-package.js';

describe('resolveWebRoot', () => {
  it('reads the build out of the directory the package manifest sits in', () => {
    const manifest = pathToFileURL(
      '/prefix/lib/node_modules/@softiesolutions/agentplex-web/package.json',
    );

    const resolved = resolveWebRoot(() => manifest.href);

    expect(resolved).toEqual({
      ok: true,
      root: join('/prefix/lib/node_modules/@softiesolutions/agentplex-web/dist'),
    });
  });

  /**
   * The manifest and not a subpath into the build. A package that grows an
   * `exports` field gates every subpath under it and would refuse
   * `./dist/index.html` without refusing `./package.json`, which node reaches
   * outside `exports` by specification -- so the specifier that cannot be
   * broken from the other side is the one that gets used.
   */
  it('asks for the manifest rather than a path inside the build', () => {
    const asked: string[] = [];

    resolveWebRoot((specifier) => {
      asked.push(specifier);
      return pathToFileURL('/somewhere/package.json').href;
    });

    expect(asked).toEqual([`${WEB_PACKAGE}/package.json`]);
  });

  /**
   * The ordinary shape of a `--role=server` machine, and of a hub whose web
   * package failed to install: the answer is a reason, not a throw, because the
   * caller has something honest to do with it and nothing to do with a crash.
   */
  it('carries the reason the resolver gave back when there is no such package', () => {
    const resolved = resolveWebRoot(() => {
      throw new Error("Cannot find package '@softiesolutions/agentplex-web'\nimported from x");
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain(WEB_PACKAGE);
    expect(resolved.reason).toContain('Cannot find package');
    // One line. The resolver's message carries an `imported from` line that
    // names a path on this machine, and the log line this ends up in is read by
    // an operator rather than parsed.
    expect(resolved.reason).not.toContain('\n');
  });

  /** A resolver that answered with something that is not a file is refused, not cast. */
  it('refuses an answer that is not a file', () => {
    const resolved = resolveWebRoot(() => 'node:fs');

    expect(resolved.ok).toBe(false);
  });
});

describe('missingWebPackage', () => {
  /**
   * Absence, not an error. `answerWebAssetRequest` turns a missing shell into a
   * 503 and `hub.ts` logs one line about it at startup, so a hub with no client
   * package degrades exactly the way a hub whose client was never built does --
   * and the API, the websocket and the health check are untouched.
   */
  it('answers every read as absent, so the hub serves 503 rather than failing to start', async () => {
    const assets = missingWebPackage('a reason');

    await expect(assets.read('index.html')).resolves.toBeNull();
    await expect(assets.read('assets/index-abc123.js')).resolves.toBeNull();
  });

  /** The reason reaches the startup line, which is the only thing that reads it. */
  it('puts the reason where the startup line looks for it', () => {
    expect(missingWebPackage('no such package').root).toBe('no such package');
  });
});
