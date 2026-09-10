import { serverIdSchema } from '@agentplex/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type Clock, type IdGenerator, type LogRecord } from '@agentplex/node-shared';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import type { Queryable } from '../db/database.js';
import { loopbackServerAddress, serverAddressSchema } from './server-address.js';
import {
  listServers,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from './server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from './test-migrated-schema.js';
import {
  reconcileLocalServer,
  registerLocalServer,
  type LocalServerPairing,
} from './local-server.js';

/**
 * The hub's end of the pairing, against the schema the hub reads it back from.
 *
 * The row is the whole point, so it is asserted as a row: what a fake would
 * prove is that this file issued the statements this file expects. What matters
 * instead is that a second boot does not put the same machine on somebody's
 * screen twice, that a re-run of setup is caught up with, and that a pairing
 * the operator revoked is left exactly as they left it.
 */

const ADDRESS = loopbackServerAddress(8081);
const IDENTITY = '/home/dev/.agentplex/server.json';
const TOKEN = 'a-token-a-csprng-produced-for-this-machine';

const PAIRING: LocalServerPairing = {
  label: 'this machine',
  address: ADDRESS ?? serverAddressSchema.parse('wss://unreachable.example'),
  serverId: serverIdSchema.parse('server-under-test'),
  token: TOKEN,
  identityPath: IDENTITY,
};

const clock: Clock = { now: () => 1_700_000_000_000 };

let ids: IdGenerator;
let schema: MigratedSchema;
let database: Queryable;

beforeEach(async () => {
  let next = 0;
  ids = { newId: () => `registration-${(next += 1)}` };
  schema = await openMigratedSchema('local-server');
  database = schema.database;
});

afterEach(async () => {
  await schema.close();
});

async function live(): Promise<readonly LiveServerRegistration[]> {
  const servers = await listServers(database);
  return servers.filter((server): server is LiveServerRegistration => server.token !== null);
}

describe('reconcileLocalServer', () => {
  it('writes the pairing the hub dials its own server with', async () => {
    const outcome = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('registered');
    expect(await live()).toEqual([
      expect.objectContaining({ address: ADDRESS, token: TOKEN, label: 'this machine' }),
    ]);
  });

  it('leaves one pairing behind when the hub boots twice', async () => {
    // A second boot finds the row and leaves it. A second row would put the
    // same machine on the operator's screen twice and have the hub dial it twice.
    await reconcileLocalServer(database, ids, clock, PAIRING);
    const again = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(again.kind).toBe('unchanged');
    expect(await live()).toHaveLength(1);
  });

  it('catches up with a setup run that minted a new token', async () => {
    // The identity file was written again, so the server now presents a token
    // the hub has never held. The row is this machine's, by address, and it is
    // brought to what the file says rather than duplicated or left to fail at
    // every dial.
    await reconcileLocalServer(database, ids, clock, PAIRING);

    const outcome = await reconcileLocalServer(database, ids, clock, {
      ...PAIRING,
      token: 'the-token-the-file-holds-now',
    });

    expect(outcome).toMatchObject({ kind: 'reconciled', changed: ['token'] });
    expect(await live()).toEqual([
      expect.objectContaining({ address: ADDRESS, token: 'the-token-the-file-holds-now' }),
    ]);
  });

  it('catches up with a setup run that minted a new identity', async () => {
    // A deleted identity file comes back with a new id as well as a new token.
    // The row at the loopback address is still this machine's: there is one
    // 127.0.0.1:8081 on this host.
    const registered = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: PAIRING.address,
      token: 'the-previous-token',
    });
    await database.query('UPDATE servers SET server_id = ? WHERE id = ?', [
      'the-previous-server-id',
      registered.id,
    ]);

    const outcome = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(outcome).toMatchObject({ kind: 'reconciled', changed: ['token', 'serverId'] });
    expect(await live()).toEqual([
      expect.objectContaining({ id: registered.id, serverId: 'server-under-test', token: TOKEN }),
    ]);
  });

  it('follows the server when the port setting moves', async () => {
    // The machine is the machine: a row that has learned this server's id is
    // this server's pairing whatever address it holds, and the address is
    // brought to the port the settings now name.
    const registered = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: loopbackServerAddress(9091) ?? PAIRING.address,
      token: TOKEN,
    });
    await database.query('UPDATE servers SET server_id = ? WHERE id = ?', [
      PAIRING.serverId,
      registered.id,
    ]);

    const outcome = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(outcome).toMatchObject({ kind: 'reconciled', changed: ['address'] });
    expect(await live()).toEqual([
      expect.objectContaining({ id: registered.id, address: ADDRESS }),
    ]);
  });

  it('does not re-pair a machine the operator revoked', async () => {
    // A revoked pairing is a person having said no. A boot writing it back would
    // be the hub choosing, which is the one thing the exception does not cover.
    const registered = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: PAIRING.address,
      token: TOKEN,
    });
    await revokeServer(database, clock, registered.id);

    const outcome = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('left-alone');
    expect(outcome.kind === 'left-alone' ? outcome.problem : '').toContain('revoked');
    expect(await live()).toEqual([]);
  });

  it('pairs again a machine that was revoked and then paired again', async () => {
    // A live row wins over a revoked one for the same server: revoked and then
    // paired again is paired, and the revoked row is history.
    const revoked = await registerServer(database, ids, clock, {
      label: 'this machine',
      address: PAIRING.address,
      token: 'the-first-token',
    });
    await revokeServer(database, clock, revoked.id);
    await registerServer(database, ids, clock, {
      label: 'this machine',
      address: PAIRING.address,
      token: TOKEN,
    });

    const outcome = await reconcileLocalServer(database, ids, clock, PAIRING);

    expect(outcome.kind).toBe('unchanged');
    expect(await live()).toHaveLength(1);
  });

  it('never puts the token in what it reports', async () => {
    // Every outcome here is logged. The identity file is named, and what is in
    // it stays in it -- the same rule the server follows when it logs the path.
    const paired = await reconcileLocalServer(database, ids, clock, PAIRING);
    const again = await reconcileLocalServer(database, ids, clock, PAIRING);
    const rotated = await reconcileLocalServer(database, ids, clock, {
      ...PAIRING,
      token: 'the-token-the-file-holds-now',
    });

    expect(JSON.stringify([paired, again, rotated])).not.toContain(TOKEN);
    expect(JSON.stringify(rotated)).not.toContain('the-token-the-file-holds-now');
  });
});

describe('registerLocalServer at boot', () => {
  const records: LogRecord[] = [];
  const logger = createLogger('debug', (record) => void records.push(record));

  beforeEach(() => records.splice(0));

  it('registers nothing and says nothing for a hub whose settings name no local server', async () => {
    // Most hubs are this hub. Configuration, not discovery: an identity file
    // that happens to be on the disk is not consulted.
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: TOKEN }) },
    });

    const outcome = await registerLocalServer(null, { database, files, ids, clock, logger });

    expect(outcome).toBeNull();
    expect(await live()).toEqual([]);
    expect(records).toEqual([]);
  });

  it('pairs the server the settings name from the identity file it wrote, and logs it', async () => {
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: TOKEN }) },
    });

    const outcome = await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      { database, files, ids, clock, logger },
    );

    expect(outcome?.kind).toBe('registered');
    expect(await live()).toEqual([expect.objectContaining({ address: ADDRESS, token: TOKEN })]);
    expect(records).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'local server paired',
        fields: { address: ADDRESS, identityPath: IDENTITY },
      }),
    ]);
  });

  it('logs the reconciliation when the token on disk has changed', async () => {
    await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      {
        database,
        files: createFakeStoreFiles({
          files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: TOKEN }) },
        }),
        ids,
        clock,
        logger,
      },
    );
    records.splice(0);

    await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      {
        database,
        files: createFakeStoreFiles({
          files: {
            [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: 'rotated' }),
          },
        }),
        ids,
        clock,
        logger,
      },
    );

    expect(records).toEqual([
      expect.objectContaining({
        message: 'local server pairing reconciled',
        fields: { address: ADDRESS, identityPath: IDENTITY, changed: ['token'] },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('rotated');
  });

  it('warns and comes up unpaired when the identity file is not there', async () => {
    // A hub that is up without its local server is a hub an operator can read
    // the log of. The boot is not failed over a file setup has not written yet.
    const outcome = await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      { database, files: createFakeStoreFiles(), ids, clock, logger },
    );

    expect(outcome).toBeNull();
    expect(await live()).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'local server not paired',
        fields: expect.objectContaining({ identityPath: IDENTITY, port: 8081 }),
      }),
    ]);
  });

  it('never logs the token', async () => {
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: TOKEN }) },
    });

    await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      { database, files, ids, clock, logger },
    );
    await registerLocalServer(
      { identityPath: IDENTITY, port: 8081 },
      { database, files, ids, clock, logger },
    );

    expect(JSON.stringify(records)).not.toContain(TOKEN);
  });
});
