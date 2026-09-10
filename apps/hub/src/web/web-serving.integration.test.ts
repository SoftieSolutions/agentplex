import { afterEach, describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { createFakeDatabase } from '../db/fake-database.js';
import type { MigrationFileSystem } from '../db/migration-files.js';
import { createFakeBeaconSource } from '../discovery/fake-beacon-source.js';
import { startHub, type Hub } from '../hub.js';
import { createUnreachableDialer, createFakeTimers } from '@agentplex/node-shared/testing';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { CLIENT_TICKET_PATH } from '../clients/client-auth.js';
import { createFakeWebAssets, type FakeWebAssetsOptions } from './fake-web-assets.js';

/**
 * The client, over a real port.
 *
 * `web-assets.test.ts` covers what is answered; this file covers that the hub
 * answers it at all — that the PWA and the two authenticated routes share one
 * origin, which is the whole reason the hub serves the client rather than
 * something else doing it. The MCP endpoint is specified as same-origin, and
 * same-origin is a fact about this port or it is not a fact.
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

const built = {
  'index.html': '<!doctype html><title>agentplex</title>',
  'assets/index-Dtam4XWE.js': 'console.log(1)',
  'sw.js': 'self.addEventListener("fetch", () => {})',
};

let hub: Hub | undefined;

afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

async function startTestHub(
  assets: FakeWebAssetsOptions = { files: built },
  records: LogRecord[] = [],
): Promise<Hub> {
  hub = await startHub({
    database: createFakeDatabase({
      respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] }],
    }),
    logger: createLogger('debug', (record) => void records.push(record)),
    ids: { newId: () => 'hub-1' },
    clock: { now: () => 1_756_000_000_000 },
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'ticket-1' },
    dialer: createUnreachableDialer(),
    discovery: createFakeBeaconSource(),
    timers: createFakeTimers(),
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    webAssets: createFakeWebAssets(assets),
    host: HOST,
    port: 0,
    localServer: null,
    files: createFakeStoreFiles(),
  });
  return hub;
}

describe('the hub serving the client', () => {
  it('serves the shell on the port the client socket is on', async () => {
    const started = await startTestHub();

    const response = await fetch(`http://${HOST}:${String(started.port)}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(built['index.html']);
  });

  it('serves an asset with the headers a browser needs to cache it', async () => {
    const started = await startTestHub();

    const response = await fetch(`http://${HOST}:${String(started.port)}/assets/index-Dtam4XWE.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('leaves the hub routes to the hub', async () => {
    // The one ordering that matters. `/health` and the ticket exchange are
    // answered before anything looks at a disk, so a file dropped into the web
    // root can never take a route over.
    const started = await startTestHub();
    const base = `http://${HOST}:${String(started.port)}`;

    const health = await fetch(`${base}/health`);
    const ticket = await fetch(`${base}${CLIENT_TICKET_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });

    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await health.json()).toMatchObject({ status: 'ok', role: 'hub' });
    expect(ticket.status).toBe(200);
  });

  it('serves the shell for a route the client owns', async () => {
    const started = await startTestHub();

    const response = await fetch(`http://${HOST}:${String(started.port)}/settings`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(built['index.html']);
  });

  it('answers a hub with no client build honestly', async () => {
    const started = await startTestHub({});

    const response = await fetch(`http://${HOST}:${String(started.port)}/`);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('no client');
  });

  it('comes up and stays up with no client build', async () => {
    // A hub with nothing to serve still owns the database, still dials its
    // paired servers, and still answers a health check. Refusing to start
    // would take the fleet down over a missing directory.
    const records: LogRecord[] = [];
    const started = await startTestHub({ root: '/srv/agentplex/apps/web/dist' }, records);

    const health = await fetch(`http://${HOST}:${String(started.port)}/health`);

    expect(health.status).toBe(200);
    // And it says so once, at startup, naming the directory it looked in --
    // which is the fact an operator needs and the one the 503 deliberately
    // withholds from the internet.
    const warning = records.find((record) => record.level === 'warn');
    expect(warning?.fields).toMatchObject({ from: '/srv/agentplex/apps/web/dist' });
  });

  it('answers 500 when a file is there and cannot be read', async () => {
    const records: LogRecord[] = [];
    const started = await startTestHub({ files: built, unreadable: ['sw.js'] }, records);

    const response = await fetch(`http://${HOST}:${String(started.port)}/sw.js`);

    expect(response.status).toBe(500);
    expect(records.some((record) => record.level === 'error')).toBe(true);
  });
});
