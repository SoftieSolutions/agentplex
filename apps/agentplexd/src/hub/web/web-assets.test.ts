import { describe, expect, it } from 'vitest';
import { createFakeWebAssets } from './fake-web-assets.js';
import { answerWebAssetRequest, SHELL_FILE, type WebAssetAnswer } from './web-assets.js';

/**
 * What the hub answers for everything that is not one of its own routes.
 *
 * The rules being asserted here are the ones a static server gets wrong
 * quietly: an unknown path that is a client route rather than a typo, a missing
 * asset that must not come back as HTML, a fingerprinted file that may be
 * cached forever beside a shell that may not be cached at all, and a hub with
 * no build on disk, which has to say so rather than serve something.
 */

const built = {
  'index.html': '<!doctype html><title>agentplex</title>',
  'assets/index-Dtam4XWE.js': 'console.log(1)',
  'assets/index-B2y3jiJ8.css': ':root{}',
  'sw.js': 'self.addEventListener("fetch", () => {})',
  'manifest.webmanifest': '{"name":"agentplex"}',
  'icons/icon-192.png': 'PNG',
};

function get(path: string, files = createFakeWebAssets({ files: built })): Promise<WebAssetAnswer> {
  return answerWebAssetRequest({ method: 'GET', path }, files);
}

function text(answer: WebAssetAnswer): string {
  return new TextDecoder().decode(answer.body);
}

describe('answerWebAssetRequest', () => {
  it('serves the shell at the root', async () => {
    const answer = await get('/');

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('text/html; charset=utf-8');
    expect(text(answer)).toBe(built['index.html']);
  });

  it('never lets the shell be cached', async () => {
    // The shell names the fingerprinted bundle. A cached one is a browser that
    // keeps asking for the assets of a build that is no longer deployed, and
    // there is nothing the next deploy can do to reach it.
    const answer = await get('/');

    expect(answer.cacheControl).toBe('no-cache');
  });

  it('serves a fingerprinted asset as immutable', async () => {
    const answer = await get('/assets/index-Dtam4XWE.js');

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('text/javascript; charset=utf-8');
    expect(answer.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(text(answer)).toBe(built['assets/index-Dtam4XWE.js']);
  });

  it('makes everything outside assets revalidate', async () => {
    // The service worker above all. A worker cached for a year is a client
    // pinned to a strategy nobody can change, and the icons and the manifest
    // are not fingerprinted either.
    for (const path of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
      const answer = await get(path);
      expect([path, answer.status, answer.cacheControl]).toEqual([path, 200, 'no-cache']);
    }
  });

  it('types the manifest and the icons the way a browser needs them', async () => {
    expect((await get('/manifest.webmanifest')).contentType).toBe('application/manifest+json');
    expect((await get('/icons/icon-192.png')).contentType).toBe('image/png');
  });

  it('serves the shell for a client route', async () => {
    // Routing is the client's, so a path with no file behind it is a screen
    // and not a mistake. Extensionless is the whole test for that: the app
    // owns paths, and the build owns filenames.
    const answer = await get('/settings');

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('text/html; charset=utf-8');
    expect(text(answer)).toBe(built['index.html']);
  });

  it('refuses a missing file rather than answering it with the shell', async () => {
    // The failure this prevents: a stale or half-copied build asks for a
    // bundle that is not there, gets HTML with a 200 on it, and surfaces in
    // the browser as a syntax error in a file that was never JavaScript.
    const answer = await get('/assets/index-gone.js');

    expect(answer.status).toBe(404);
    expect(answer.contentType).toBe('text/plain; charset=utf-8');
    expect(answer.cacheControl).toBe('no-store');
  });

  it('refuses a path that climbs out of the web root', async () => {
    const files = createFakeWebAssets({ files: built });

    for (const path of ['/../secrets', '/assets/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const answer = await get(path, files);
      expect([path, answer.status]).toEqual([path, 404]);
    }

    // Not "the read returned nothing" — the read never happened. A traversal
    // that reaches the filesystem is one containment bug away from being served.
    expect(files.reads).toEqual([]);
  });

  it('refuses a path carrying a NUL or a backslash', async () => {
    const files = createFakeWebAssets({ files: built });

    for (const path of ['/assets/index%00.js', '/assets%5c..%5cetc']) {
      const answer = await get(path, files);
      expect([path, answer.status]).toEqual([path, 404]);
    }

    expect(files.reads).toEqual([]);
  });

  it('decodes a path before it validates it', async () => {
    const files = createFakeWebAssets({ files: { 'assets/a b.css': 'body{}' } });

    const answer = await get('/assets/a%20b.css', files);

    expect(answer.status).toBe(200);
    expect(files.reads).toEqual(['assets/a b.css']);
  });

  it('refuses a path that is not valid percent-encoding', async () => {
    expect((await get('/assets/%zz.js')).status).toBe(404);
  });

  it('says an unknown file type is bytes rather than guessing', async () => {
    const files = createFakeWebAssets({ files: { 'thing.xyz': 'contents' } });

    expect((await get('/thing.xyz', files)).contentType).toBe('application/octet-stream');
  });

  it('says so when there is no client build to serve', async () => {
    // The honest degradation. A hub is running, it has nothing to hand a
    // browser, and 503 is the one status that says exactly that: not a 404,
    // which claims the page does not exist, and not a 500, which claims a
    // fault.
    const answer = await answerWebAssetRequest({ method: 'GET', path: '/' }, createFakeWebAssets());

    expect(answer.status).toBe(503);
    expect(answer.contentType).toBe('text/plain; charset=utf-8');
    expect(text(answer)).toContain('no client');
  });

  it('says the same for a client route when there is no build', async () => {
    const answer = await answerWebAssetRequest(
      { method: 'GET', path: '/settings' },
      createFakeWebAssets(),
    );

    expect(answer.status).toBe(503);
  });

  it('never puts the web root in what it tells a caller', async () => {
    // A hub is a thing on the internet, and where its files live on disk is
    // between it and its log. The startup line names the directory; the body
    // an unauthenticated visitor reads does not.
    const files = createFakeWebAssets({ root: '/srv/agentplex/apps/web/dist' });

    const answer = await answerWebAssetRequest({ method: 'GET', path: '/' }, files);

    expect(text(answer)).not.toContain('/srv/agentplex');
  });

  it('reads the shell only once when the shell itself is missing', async () => {
    const files = createFakeWebAssets();

    await answerWebAssetRequest({ method: 'GET', path: '/' }, files);

    expect(files.reads).toEqual([SHELL_FILE]);
  });

  it('answers a HEAD the way it answers a GET', async () => {
    const answer = await answerWebAssetRequest(
      { method: 'HEAD', path: '/assets/index-Dtam4XWE.js' },
      createFakeWebAssets({ files: built }),
    );

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('refuses anything that is not a read', async () => {
    const files = createFakeWebAssets({ files: built });

    const answer = await answerWebAssetRequest({ method: 'POST', path: '/' }, files);

    expect(answer.status).toBe(405);
    expect(files.reads).toEqual([]);
  });

  it('lets a read that failed for a reason other than absence out', async () => {
    // A file that is there and cannot be read is not a missing file. Answering
    // 404 would tell a browser the build is incomplete and tell the operator
    // nothing; the hub logs it and answers 500 instead.
    const files = createFakeWebAssets({ files: built, unreadable: ['assets/index-B2y3jiJ8.css'] });

    await expect(get('/assets/index-B2y3jiJ8.css', files)).rejects.toThrow('EACCES');
  });
});
